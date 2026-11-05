import type { Config } from './config'
import type { RelayRepository, PendingFile } from '../db/repository'
import { cleanFileName, newFileId } from '../lib/id'
import { decodeAndVerify, record } from './webhook-auth'
import { UpstreamError, readSmallText, type FeishuClient } from './feishu'
import { deliverBotJob } from './card-delivery'
import { canUpload } from './intake-policy'
import { revokeButtonName } from './cards/file-card'

export interface IntakeContext {
  repository: RelayRepository
  feishu: FeishuClient
  signal: AbortSignal
  waitUntil(promise: Promise<unknown>): void
  wake(): void
  shouldStop(): boolean
}

function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error('Invalid event field')
  return value
}

function log(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

type IntakeAction =
  | { kind: 'ignore' }
  | { kind: 'card'; fileId: string; openId: string; messageId: string; chatId: string }
  | { kind: 'recall'; eventId: string; messageId: string }
  | { kind: 'file'; eventId: string; messageId: string; chatId: string; openId: string; fileKey: string; fileName: string }
  | { kind: 'command'; eventId: string; messageId: string; chatId: string; openId: string; argument: string }

function parseAction(payload: Record<string, unknown>, env: Config): IntakeAction {
  const header = record(payload.header)
  const eventId = text(header.event_id)
  const eventType = text(header.event_type)
  const event = record(payload.event)
  if (eventType === 'card.action.trigger') {
    const action = record(event.action)
    const value = record(action.value)
    const context = record(event.context)
    const fileId = text(value.file_id)
    if (payload.schema !== '2.0' || event.host !== 'im_message' || action.tag !== 'button' ||
        action.name !== revokeButtonName || value.action !== 'revoke_file' || !/^[A-Za-z0-9]{22}$/.test(fileId)) {
      throw new Error('Invalid card action')
    }
    return { kind: 'card', fileId, openId: text(record(event.operator).open_id),
      messageId: text(context.open_message_id), chatId: text(context.open_chat_id) }
  }
  if (eventType === 'im.message.recalled_v1') return { kind: 'recall', eventId, messageId: text(event.message_id) }
  if (eventType !== 'im.message.receive_v1') return { kind: 'ignore' }
  const sender = record(event.sender)
  const openId = text(record(sender.sender_id).open_id)
  const message = record(event.message)
  if (sender.sender_type !== 'user' || !canUpload(env, openId)) {
    log('intake_ignored', { reason: 'sender_not_allowed' })
    return { kind: 'ignore' }
  }
  if (message.chat_type !== 'p2p') return { kind: 'ignore' }
  const messageId = text(message.message_id)
  const chatId = text(message.chat_id)
  if (message.message_type === 'file') {
    const content = record(JSON.parse(text(message.content, 256 * 1024)))
    return { kind: 'file', eventId, messageId, chatId, openId, fileKey: text(content.file_key), fileName: cleanFileName(text(content.file_name, 4096)) }
  }
  let argument = '__unsupported__'
  if (message.message_type === 'text') {
    const content = record(JSON.parse(text(message.content, 256 * 1024)))
    argument = text(content.text, 256 * 1024).trim().slice(0, 4096)
  }
  return { kind: 'command', eventId, messageId, chatId, openId, argument }
}

export async function handleWebhook(request: Request, env: Config, ctx: IntakeContext): Promise<Response> {
  const callbackDeadline = Date.now() + 2400
  let payload: Record<string, unknown>
  try {
    if (Number(request.headers.get('Content-Length')) > 1024 * 1024) return new Response('Payload too large', { status: 413 })
    const raw = await readSmallText(new Response(request.body), 1024 * 1024)
    payload = await decodeAndVerify(raw, request, env)
  } catch {
    return new Response('Invalid callback', { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  if (payload.type === 'url_verification') {
    if (typeof payload.challenge !== 'string' || payload.challenge.length > 1024) return new Response('Invalid challenge', { status: 400 })
    return Response.json({ challenge: payload.challenge })
  }
  let action: IntakeAction
  try {
    action = parseAction(payload, env)
  } catch {
    return new Response('Invalid event', { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  try {
    if (action.kind === 'card') {
      const toast = (type: 'info' | 'error' | 'success', content: string) =>
        Response.json({ toast: { type, content } }, { headers: { 'Cache-Control': 'no-store' } })
      const uncertain = () => toast('info', '暂时无法确认撤销结果，请稍后重试。')
      if (!canUpload(env, action.openId)) return toast('error', '无权操作此分享。')
      const remaining = callbackDeadline - Date.now()
      if (remaining <= 0) return uncertain()
      const operation = ctx.repository.revokeCard(action.fileId, action.openId, action.messageId, action.chatId)
        .then((result) => {
          if (result === 'denied') return toast('error', '无权操作此分享。')
          ctx.wake()
          return result === 'revoked' ? toast('success', '已撤销分享。') : toast('info', '该分享已撤销。')
        }, uncertain)
      // D1 超时不代表事务回滚；请求结束后跟踪原操作，成功时唤醒持久任务。
      ctx.waitUntil(operation)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([operation, new Promise<Response>((resolve) => {
          timer = setTimeout(() => resolve(uncertain()), remaining)
        })])
      } finally { clearTimeout(timer) }
    }
    if (action.kind === 'recall') {
      await ctx.repository.recallFile(action.eventId, action.messageId)
      ctx.wake()
      log('message_recalled')
    } else if (action.kind !== 'ignore') {
      if (action.kind === 'file') {
        await ctx.repository.registerFile(action.eventId, { id: newFileId(), message_id: action.messageId, file_key: action.fileKey, file_name: action.fileName, uploader_open_id: action.openId, chat_id: action.chatId })
        log('file_registered_pending')
      } else {
        await ctx.repository.createCommand(action.eventId, { id: `command:${action.messageId}`, message_id: action.messageId, uploader_open_id: action.openId, chat_id: action.chatId, argument: action.argument })
      }
      // 先持久化再 ACK；进程崩溃后由数据库中的待办恢复。
      ctx.wake()
    }
    return Response.json({ code: 0 })
  } catch {
    // D1 故障必须让飞书重送，不能先返回成功再丢失撤回事件。
    return new Response('Callback persistence failed', { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } })
  }
}

async function probeFile(env: Config, file: PendingFile, ctx: IntakeContext): Promise<{ size: number; mimeType: string | null }> {
  // 单字节探测须连同响应体设置期限，防止源站只发响应头后一直不结束。
  const configuredTimeout = Number(env.UPSTREAM_READ_TIMEOUT_MS || '8000')
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(8000, configuredTimeout) : 8000
  const response = await ctx.feishu.fetchResource(file, 0, 0, AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]))
  const range = /^bytes 0-0\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
  const size = range ? Number(range[1]) : NaN
  if (response.status !== 206 || !Number.isSafeInteger(size) || size <= 0 || !response.body || (response.headers.has('Content-Length') && response.headers.get('Content-Length') !== '1')) {
    if (response.body) ctx.waitUntil(response.body.cancel().catch(() => undefined))
    throw new UpstreamError('Untrusted resource size')
  }
  const reader = response.body.getReader()
  let count = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > 1) throw new UpstreamError('Invalid probe length')
    }
    if (count !== 1) throw new UpstreamError('Incomplete probe')
    // 只采用已验证的资源响应中的具体 MIME 类型；文件扩展名和通用流类型不能证明格式。
    const mime = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
    const mimeType = mime && mime !== 'application/octet-stream' && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime) ? mime : null
    return { size, mimeType }
  } finally {
    // 上游连接损坏时 cancel 本身也可能悬挂，状态迁移不能等待清理完成。
    ctx.waitUntil(reader.cancel().catch(() => undefined))
    reader.releaseLock()
  }
}

async function validateFile(env: Config, file: PendingFile, ctx: IntakeContext): Promise<void> {
  if (file.attempts >= 4) {
    await ctx.repository.finishValidation(file, null, 'validation_interrupted', `文件 ${file.file_name} 登记失败：飞书暂时无法读取，请稍后重发。`)
    return
  }
  const claimed = await ctx.repository.claimPending(file.id)
  if (!claimed) return
  try {
    const { size, mimeType } = await probeFile(env, claimed, ctx)
    const maximum = Number(env.MAX_FILE_SIZE || '1073741824')
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Invalid maximum file size')
    if (size > maximum) {
      await ctx.repository.finishValidation(claimed, null, 'file_too_large', `文件 ${claimed.file_name} 登记失败：大小超过上限 ${maximum} 字节，请压缩或拆分后重发。`)
      return
    }
    const publicUrl = `${env.PUBLIC_BASE_URL}/f/${claimed.id}`
    if (await ctx.repository.finishValidation(claimed, size, null, publicUrl, mimeType)) {
      log('file_active', { file_id: claimed.id, bytes: size })
    }
  } catch (error) {
    const permanent = error instanceof UpstreamError && error.permanent
    if (claimed.attempts >= 4 || permanent) {
      await ctx.repository.finishValidation(claimed, null, permanent ? 'source_unavailable' : 'validation_failed', `文件 ${claimed.file_name} 登记失败：飞书暂时无法读取，请检查源文件权限并稍后重发。`)
    } else {
      await ctx.repository.retryValidation(claimed, 'source_temporarily_unreadable')
      log('validation_retry', { file_id: claimed.id, attempts: claimed.attempts })
    }
  }
}

async function processJobs(env: Config, ctx: IntakeContext): Promise<void> {
  for (const job of await ctx.repository.dueJobs()) {
    if (ctx.shouldStop()) break
    const claimed = await ctx.repository.claimJob(job.id)
    if (!claimed) continue
    try {
      await deliverBotJob(env, ctx, claimed)
    } catch {
      await ctx.repository.retryJob(claimed)
      log(claimed.attempts >= 8 ? 'bot_reply_failed' : 'bot_reply_retry', { file_id: claimed.file_id ?? '', attempts: claimed.attempts })
    }
  }
}

export async function runScheduled(env: Config, ctx: IntakeContext): Promise<void> {
  // 每轮有界处理；停止领取后保留未完成租约供重启恢复。
  for (const file of await ctx.repository.dueFiles()) { if (ctx.shouldStop()) break; await validateFile(env, file, ctx) }
  await processJobs(env, ctx)
}
