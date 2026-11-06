import { unsentCardPrefix, type BotJob } from '../db/repository'
import type { FileRecord } from '../types'
import { buildFileCard } from './cards/file-card'
import { buildFirstDownloadCard, readFirstDownloadPayload } from './cards/first-download-card'
import { executeCommand } from './commands'
import type { Config } from './config'
import { CardDeliveryError, CardNotSentError, messageUuid } from './feishu'
import type { IntakeContext } from './intake'

const deliveryTimeoutMs = 45_000
const messageDeduplicationMs = 60 * 60_000

function canRepeatCreate(job: BotJob): boolean {
  if (job.attempts === 1) return true
  // 旧租约可能已经发送过消息。用任务创建时间作保守下界，给整个请求留出飞书的一小时去重窗口。
  const created = Date.parse(job.created_at.replace(' ', 'T') + 'Z')
  return Date.now() + deliveryTimeoutMs < created + messageDeduplicationMs
}

function fallbackText(file: FileRecord, url: string) {
  return `文件已发布：${file.file_name}（${(file.file_size! / 1024 / 1024).toFixed(2)} MiB）\n下载地址：${url}\n⚠️ 此链接公开，任何持有链接的人均可下载。请仅分享允许对外发送的文件。\n文件可用性取决于飞书源文件，不保证永久有效。\n撤回原文件消息，或发送「撤销 ${url}」，可使链接失效。`
}

async function failDelivery(ctx: IntakeContext, job: BotJob, reason: string) {
  await ctx.repository.failJob(job)
  console.warn(JSON.stringify({ event: 'card_delivery_failed', file_id: job.file_id, reason }))
}

async function publishCard(ctx: IntakeContext, job: BotJob, file: FileRecord, signal: AbortSignal) {
  const markedUnsent = job.argument.startsWith(unsentCardPrefix)
  const knownUnsent = markedUnsent || job.attempts === 1
  const url = markedUnsent ? job.argument.slice(unsentCardPrefix.length) : job.argument
  if (knownUnsent && file.status !== 'active') {
    await ctx.repository.finishJob(job)
    return
  }
  if (!knownUnsent && !canRepeatCreate(job)) {
    await failDelivery(ctx, job, 'create_deduplication_expired')
    return
  }
  // 已尝试发送的任务必须用原 URL、原卡片及原 UUID 追回回执。若期间撤销，由同一回执事务安排更新。
  const card = buildFileCard(file, 'active', url)
  // 发起 POST 前在租约与 active 条件下清除“尚未发送”标记。此后崩溃只能按回执未知处理。
  if (markedUnsent && !await ctx.repository.beginUnsentCard(job, url)) {
    await ctx.repository.finishJob(job)
    return
  }
  let receipt: string
  try {
    receipt = await ctx.feishu.sendCard(job.chat_id, card, messageUuid(job.id), signal)
  } catch (error) {
    if (error instanceof CardNotSentError && knownUnsent) {
      await ctx.repository.retryUnsentCard(job, url)
      console.warn(JSON.stringify({ event: job.attempts >= 8 ? 'card_delivery_failed' : 'card_delivery_retry', file_id: job.file_id, reason: 'not_sent' }))
      return
    }
    if (!(error instanceof CardDeliveryError)) throw error
    if (error.reason === 'invalid_card' && knownUnsent) {
      await ctx.repository.fallbackCardPublication(job)
      ctx.wake()
      console.warn(JSON.stringify({ event: 'card_text_fallback', file_id: job.file_id, reason: error.reason }))
    } else {
      await failDelivery(ctx, job, error.reason)
    }
    return
  }
  await ctx.repository.finishCardPublication(job, receipt)
  ctx.wake()
}

async function updateCard(ctx: IntakeContext, job: BotJob, file: FileRecord, publicUrl: string, signal: AbortSignal) {
  if (!job.message_id || (file.status !== 'deleted' && file.status !== 'unavailable')) {
    await failDelivery(ctx, job, 'invalid_update_target')
    return
  }
  const card = buildFileCard(file, file.status === 'deleted' ? 'revoked' : 'unavailable', publicUrl)
  try {
    await ctx.feishu.updateCard(job.message_id, card, signal)
  } catch (error) {
    if (!(error instanceof CardDeliveryError)) throw error
    await failDelivery(ctx, job, error.reason)
    return
  }
  await ctx.repository.finishCardUpdate(job, file.status)
}

async function firstDownloadCard(ctx: IntakeContext, job: BotJob, signal: AbortSignal) {
  let payload: ReturnType<typeof readFirstDownloadPayload>
  try { payload = readFirstDownloadPayload(job.argument) } catch {
    await failDelivery(ctx, job, 'invalid_first_download_snapshot')
    return
  }
  const knownUnsent = payload.delivery === 'unsent'
  if (!knownUnsent && !canRepeatCreate(job)) {
    await ctx.repository.failFirstDownloadNotification(job, 'create_deduplication_expired')
    console.warn(JSON.stringify({ event: 'first_download_delivery_failed', file_id: job.file_id, reason: 'create_deduplication_expired' }))
    return
  }
  const card = buildFirstDownloadCard(payload.snapshot)
  if (!await ctx.repository.beginFirstDownloadNotification(job)) return
  let receipt: string
  try {
    receipt = await ctx.feishu.sendCard(job.chat_id, card, messageUuid(job.id), signal)
  } catch (error) {
    if (error instanceof CardDeliveryError) {
      await ctx.repository.failFirstDownloadNotification(job, error.reason)
      console.warn(JSON.stringify({ event: 'first_download_delivery_failed', file_id: job.file_id, reason: error.reason }))
    } else {
      // 后一次请求未发送，不能消除前一次请求可能已送达的不确定性。
      const unsent = knownUnsent && error instanceof CardNotSentError
      await ctx.repository.retryFirstDownloadNotification(job, unsent, unsent ? 'not_sent' : 'delivery_unknown')
      console.warn(JSON.stringify({ event: job.attempts >= 8 ? 'first_download_delivery_failed' : 'first_download_delivery_retry',
        file_id: job.file_id, reason: unsent ? 'not_sent' : 'delivery_unknown' }))
    }
    return
  }
  await ctx.repository.finishFirstDownloadNotification(job, receipt)
}

export async function deliverBotJob(env: Config, ctx: IntakeContext, job: BotJob): Promise<void> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(deliveryTimeoutMs)])
  let message = job.argument
  if (job.kind === 'command') {
    message = await executeCommand(env, ctx.repository, job)
  } else if (job.file_id && job.id === `first-download:card:${job.file_id}`) {
    return firstDownloadCard(ctx, job, signal)
  } else if (job.file_id && (job.id.startsWith('active:') || job.id.startsWith('card:') || job.id.startsWith('fallback:'))) {
    const file = await ctx.repository.getFile(job.file_id)
    if (!file) return failDelivery(ctx, job, 'missing_file')
    if (job.id === `active:card:${file.id}`) return publishCard(ctx, job, file, signal)
    if (job.id === `card:unavailable:${file.id}` || job.id === `card:deleted:${file.id}`) {
      return updateCard(ctx, job, file, `${env.PUBLIC_BASE_URL}/f/${file.id}`, signal)
    }
    if (file.status !== 'active') return ctx.repository.finishJob(job)
    if (job.id === `fallback:${file.id}`) {
      if (!canRepeatCreate(job)) return failDelivery(ctx, job, 'fallback_deduplication_expired')
      message = fallbackText(file, job.argument)
    }
    // 升级前已入队的 active:<id> 仍用原文和原 UUID，防止把已送达的文本误当作卡片。
  }
  await ctx.feishu.sendText(job.chat_id, message, messageUuid(job.id), signal)
  await ctx.repository.finishJob(job)
}
