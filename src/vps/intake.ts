import type { Config } from './config'
import type { RelayRepository, PendingFile } from '../db/repository'
import { cleanFileName, newFileId } from '../lib/id'
import { decodeAndVerify, record } from './webhook-auth'
import { messageUuid, UpstreamError, readSmallText, type FeishuClient } from './feishu'
import { executeCommand } from './commands'
import { canUpload } from './intake-policy'

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
  | { kind: 'recall'; eventId: string; messageId: string }
  | { kind: 'file'; eventId: string; messageId: string; chatId: string; openId: string; fileKey: string; fileName: string }
  | { kind: 'command'; eventId: string; messageId: string; chatId: string; openId: string; argument: string }

function parseAction(payload: Record<string, unknown>, env: Config): IntakeAction {
  const header = record(payload.header)
  const eventId = text(header.event_id)
  const eventType = text(header.event_type)
  const event = record(payload.event)
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
    if (action.kind === 'recall') {
      await ctx.repository.recallFile(action.eventId, action.messageId)
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

async function probeSize(env: Config, file: PendingFile, ctx: IntakeContext): Promise<number> {
  // 单字节探测须连同响应体设置期限，防止源站只发响应头后一直不结束。
  const configuredTimeout = Number(env.UPSTREAM_READ_TIMEOUT_MS || '8000')
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(8000, configuredTimeout) : 8000
  const response = await ctx.feishu.fetchResource( file, 0, 0, AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]))
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
    return size
  } finally {
    // 上游连接损坏时 cancel 本身也可能悬挂，状态迁移不能等待清理完成。
    ctx.waitUntil(reader.cancel().catch(() => undefined))
    reader.releaseLock()
  }
}

function publishedText(env: Config, file: PendingFile, size: number): string {
  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/f/${file.id}`
  return `文件已发布：${file.file_name}（${(size / 1024 / 1024).toFixed(2)} MiB）\n下载地址：${url}\n⚠️ 该链接公开，任何拿到链接的人都可下载，请仅发送允许对外分享的文件。\n撤回本条文件消息，或发送「撤销 ${url}」，可使链接失效。\n文件可用性取决于飞书资源保留与权限，不保证永久可用。`
}

async function validateFile(env: Config, file: PendingFile, ctx: IntakeContext): Promise<void> {
  if (file.attempts >= 4) {
    await ctx.repository.finishValidation(file, null, 'validation_interrupted', `文件 ${file.file_name} 登记失败：飞书暂时无法读取，请稍后重发。`)
    return
  }
  const claimed = await ctx.repository.claimPending(file.id)
  if (!claimed) return
  try {
    const size = await probeSize(env, claimed, ctx)
    const maximum = Number(env.MAX_FILE_SIZE || '1073741824')
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error('Invalid maximum file size')
    if (size > maximum) {
      await ctx.repository.finishValidation(claimed, null, 'file_too_large', `文件 ${claimed.file_name} 登记失败：大小超过上限 ${maximum} 字节，请压缩或拆分后重发。`)
      return
    }
    if (await ctx.repository.finishValidation(claimed, size, null, publishedText(env, claimed, size))) {
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
      if (claimed.id.startsWith('active:') && claimed.file_id) {
        const file = await ctx.repository.getFile(claimed.file_id)
        if (file?.status !== 'active') {
          await ctx.repository.finishJob(claimed)
          continue
        }
      }
      const message = claimed.kind === 'command' ? await executeCommand(env, ctx.repository, claimed) : claimed.argument
      await ctx.feishu.sendText(claimed.chat_id, message, messageUuid(claimed.id), AbortSignal.any([ctx.signal, AbortSignal.timeout(45000)]))
      await ctx.repository.finishJob(claimed)
    } catch {
      await ctx.repository.retryJob(claimed)
      log('bot_reply_retry')
    }
  }
}

export async function runScheduled(env: Config, ctx: IntakeContext): Promise<void> {
  // 每轮有界处理；停止领取后保留未完成租约供重启恢复。
  for (const file of await ctx.repository.dueFiles()) { if (ctx.shouldStop()) break; await validateFile(env, file, ctx) }
  await processJobs(env, ctx)
}
