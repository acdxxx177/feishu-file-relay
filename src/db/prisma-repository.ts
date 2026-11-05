import { PrismaClient, type Prisma } from '../generated/prisma/client'
import type { FileRecord } from '../types'
import type { BotJob, Command, PendingFile, Registration, RelayRepository } from './repository'
import { unsentCardPrefix } from './repository'
import { D1HttpTransport, type D1HttpOptions, type Statement } from './d1-http'
import { RelayPrismaD1Adapter } from './prisma-d1-adapter'

function safeNumber(value: bigint | number): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Unsafe metadata integer')
  return number
}

function fileRecord(row: Prisma.FileGetPayload<Record<string, never>>): PendingFile {
  if (!['pending', 'active', 'failed', 'unavailable', 'deleted'].includes(row.status)) throw new Error('Invalid file status')
  return {
    id: row.id, message_id: row.messageId, file_key: row.fileKey, file_name: row.fileName,
    file_size: row.fileSize, mime_type: row.mimeType, uploader_open_id: row.uploaderOpenId,
    chat_id: row.chatId, version: row.version, status: row.status as FileRecord['status'],
    fail_reason: row.failReason, delete_reason: row.deleteReason, attempts: row.attempts,
    download_count: safeNumber(row.downloadCount), last_downloaded_at: row.lastDownloadedAt,
    created_at: row.createdAt, updated_at: row.updatedAt, deleted_at: row.deletedAt,
    next_attempt_at: safeNumber(row.nextAttemptAt), lease_until: safeNumber(row.leaseUntil),
  }
}

function botJob(row: Prisma.BotJobGetPayload<Record<string, never>>): BotJob {
  if (!['command', 'notification'].includes(row.kind) || !['pending', 'sent', 'failed'].includes(row.state)) throw new Error('Invalid job state')
  return { id: row.id, kind: row.kind as BotJob['kind'], message_id: row.messageId,
    file_id: row.fileId, uploader_open_id: row.uploaderOpenId, chat_id: row.chatId,
    argument: row.argument, state: row.state as BotJob['state'], attempts: row.attempts,
    next_attempt_at: safeNumber(row.nextAttemptAt), lease_until: safeNumber(row.leaseUntil), created_at: row.createdAt }
}

function statement(sql: string, ...params: (string | number | null)[]): Statement { return { sql, params } }
function utcText(timestamp = Date.now()): string { return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ') }

// 在同一个 D1 batch 中紧随状态迁移或发布回执。员工附件 ID 永远不作机器人卡片的更新目标。
function queueCardUpdate(column: 'id' | 'message_id', value: string): Statement {
  return statement(`INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,message_id,uploader_open_id,chat_id,argument)
    SELECT 'card:'||f.status||':'||f.id,'notification',f.id,p.message_id,f.uploader_open_id,f.chat_id,''
    FROM files f JOIN bot_jobs p ON p.id='active:card:'||f.id AND p.file_id=f.id
    WHERE f.${column}=? AND f.status IN ('unavailable','deleted')
      AND p.state='sent' AND p.message_id IS NOT NULL AND changes()>0`, value)
}

function queueUnavailableText(fileId: string): Statement {
  return statement(`INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument)
    SELECT 'unavailable:'||f.id,'notification',f.id,f.uploader_open_id,f.chat_id,
      '文件 '||f.file_name||' 的飞书源文件已无法读取，链接已失效。' FROM files f
    WHERE f.id=? AND f.status='unavailable' AND NOT EXISTS (
      SELECT 1 FROM bot_jobs p WHERE p.id='active:card:'||f.id AND (p.state='pending' OR p.message_id IS NOT NULL)
    )`, fileId)
}

function isCardPublication(job: BotJob): job is BotJob & { file_id: string } {
  return job.file_id !== null && job.id === `active:card:${job.file_id}`
}

const claimedJob = "id=? AND state='pending' AND attempts=? AND lease_until=?"

function completeJob(job: BotJob, state: 'failed' | 'sent', messageId: string | null = null): Statement {
  return statement(`UPDATE bot_jobs SET state=?,lease_until=0,message_id=COALESCE(?,message_id) WHERE ${claimedJob}`,
    state, messageId, job.id, job.attempts, job.lease_until)
}

export function createRemoteRepository(options: D1HttpOptions): RelayRepository {
  return new PrismaRelayRepository(new D1HttpTransport(options))
}

export class PrismaRelayRepository implements RelayRepository {
  private readonly client: PrismaClient
  constructor(private readonly transport: D1HttpTransport) {
    this.client = new PrismaClient({ adapter: new RelayPrismaD1Adapter(transport), log: [] })
  }

  async getFile(id: string): Promise<FileRecord | null> {
    const row = await this.client.file.findUnique({ where: { id } })
    return row ? fileRecord(row) : null
  }

  async getDownloadFile(id: string): Promise<FileRecord | null> {
    return this.transport.download(() => this.getFile(id))
  }

  async listFiles(uploader: string) {
    const rows = await this.client.file.findMany({ where: { uploaderOpenId: uploader, status: 'active' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10,
      select: { id: true, fileName: true, downloadCount: true } })
    return rows.map((row) => ({ id: row.id, file_name: row.fileName, download_count: safeNumber(row.downloadCount) }))
  }

  async countDownload(id: string): Promise<void> {
    await this.transport.download(() => this.client.file.updateMany({ where: { id, status: 'active' }, data: { downloadCount: { increment: 1 }, lastDownloadedAt: utcText() } }))
  }

  async revokeFile(id: string, uploader: string, allowAdmin = false): Promise<boolean> {
    const result = await this.transport.batch([
      statement(`UPDATE files SET status='deleted',delete_reason='revoked',deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status!='deleted' AND (uploader_open_id=? OR ?=1)`, id, uploader, Number(allowAdmin)),
      queueCardUpdate('id', id),
    ])
    return result[0].meta.changes > 0
  }

  async revokeCard(fileId: string, uploaderOpenId: string, cardMessageId: string, chatId: string): Promise<'revoked' | 'already_revoked' | 'denied'> {
    // 对已撤销文件也要重验卡片、会话和上传者，不能通过重放探测别人的状态。
    const binding = `id=? AND uploader_open_id=? AND chat_id=? AND EXISTS(
      SELECT 1 FROM bot_jobs p WHERE p.id='active:card:'||files.id AND p.file_id=files.id
        AND p.message_id=? AND p.state='sent' AND p.chat_id=files.chat_id AND p.uploader_open_id=files.uploader_open_id)`
    const params = [fileId, uploaderOpenId, chatId, cardMessageId]
    const [update, , receipt] = await this.transport.batch([
      statement(`UPDATE files SET status='deleted',delete_reason='revoked',deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE status IN ('active','unavailable') AND ${binding}`, ...params),
      queueCardUpdate('id', fileId),
      statement(`SELECT status FROM files WHERE ${binding}`, ...params),
    ])
    if (update.meta.changes === 1) return 'revoked'
    return receipt.results[0]?.status === 'deleted' ? 'already_revoked' : 'denied'
  }

  async registerFile(eventId: string, file: Registration): Promise<void> {
    await this.transport.batch([
      statement(`INSERT INTO files(id,message_id,file_key,file_name,uploader_open_id,chat_id)
        SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM recalled_messages WHERE message_id=?)
        AND NOT EXISTS(SELECT 1 FROM processed_events WHERE event_id=?) ON CONFLICT(message_id) DO NOTHING`,
      file.id, file.message_id, file.file_key, file.file_name, file.uploader_open_id, file.chat_id, file.message_id, eventId),
      statement('INSERT OR IGNORE INTO processed_events(event_id) VALUES(?)', eventId),
    ])
  }

  async recallFile(eventId: string, messageId: string): Promise<void> {
    await this.transport.batch([
      statement('INSERT OR IGNORE INTO recalled_messages(message_id) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM processed_events WHERE event_id=?)', messageId, eventId),
      statement("UPDATE files SET status='deleted',delete_reason='recalled',deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE message_id=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM processed_events WHERE event_id=?)", messageId, eventId),
      queueCardUpdate('message_id', messageId),
      statement('INSERT OR IGNORE INTO processed_events(event_id) VALUES(?)', eventId),
    ])
  }

  async createCommand(eventId: string, job: Command): Promise<void> {
    await this.transport.batch([
      statement("INSERT OR IGNORE INTO bot_jobs(id,kind,message_id,uploader_open_id,chat_id,argument) SELECT ?,'command',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM processed_events WHERE event_id=?)", job.id, job.message_id, job.uploader_open_id, job.chat_id, job.argument, eventId),
      statement('INSERT OR IGNORE INTO processed_events(event_id) VALUES(?)', eventId),
    ])
  }

  async queueNotification(id: string, file: Pick<FileRecord, 'id' | 'uploader_open_id' | 'chat_id'>, text: string): Promise<void> {
    await this.transport.query(statement("INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument) VALUES(?,'notification',?,?,?,?)", id, file.id, file.uploader_open_id, file.chat_id, text))
  }

  async markUnavailable(id: string): Promise<boolean> {
    const result = await this.transport.batch([
      statement("UPDATE files SET status='unavailable',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'", id),
      queueCardUpdate('id', id),
      queueUnavailableText(id),
    ])
    return result[0].meta.changes > 0
  }

  async claimPending(id: string): Promise<PendingFile | null> {
    const now = Date.now()
    const result = await this.transport.query(statement("UPDATE files SET attempts=attempts+1,lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND attempts<4 AND lease_until<=? AND next_attempt_at<=? RETURNING *", now + 60_000, id, now, now))
    return result.results[0] as unknown as PendingFile ?? null
  }

  async finishValidation(file: PendingFile, size: number | null, reason: string | null, argument: string, mimeType: string | null = null): Promise<boolean> {
    const status = size === null ? 'failed' : 'active'
    const jobId = size === null ? `failed:${file.id}` : `active:card:${file.id}`
    const jobArgument = size === null ? argument : unsentCardPrefix + argument
    const result = await this.transport.batch([
      statement("UPDATE files SET status=?,file_size=?,mime_type=?,fail_reason=?,lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND attempts=? AND lease_until=?", status, size, size === null ? null : mimeType, reason, file.id, file.attempts, file.lease_until),
      statement("INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument) SELECT ?,'notification',?,?,?,? WHERE changes()>0", jobId, file.id, file.uploader_open_id, file.chat_id, jobArgument),
    ])
    return result[0].meta.changes > 0
  }

  async retryValidation(file: PendingFile, reason: string): Promise<void> {
    const delay = [2_000, 10_000, 60_000][file.attempts - 1] ?? 60_000
    await this.client.file.updateMany({ where: { id: file.id, status: 'pending', attempts: file.attempts, leaseUntil: BigInt(file.lease_until) },
      data: { failReason: reason, leaseUntil: 0n, nextAttemptAt: BigInt(Date.now() + delay), updatedAt: utcText() } })
  }

  async dueFiles(): Promise<PendingFile[]> {
    const now = BigInt(Date.now())
    return (await this.client.file.findMany({ where: { status: 'pending', leaseUntil: { lte: now }, nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 20 })).map(fileRecord)
  }

  async claimJob(id: string): Promise<BotJob | null> {
    const now = Date.now()
    // 同一消息的两个终态 PATCH 共用互斥租约。过期恢复时发送方会重新读取 D1 的最新状态。
    const result = await this.transport.query(statement(`UPDATE bot_jobs SET attempts=attempts+1,lease_until=?
      WHERE id=? AND state='pending' AND lease_until<=? AND next_attempt_at<=? AND NOT EXISTS(
        SELECT 1 FROM bot_jobs peer WHERE peer.id=CASE
          WHEN bot_jobs.id='card:deleted:'||bot_jobs.file_id THEN 'card:unavailable:'||bot_jobs.file_id
          WHEN bot_jobs.id='card:unavailable:'||bot_jobs.file_id THEN 'card:deleted:'||bot_jobs.file_id END
        AND peer.state='pending' AND peer.lease_until>?
      ) RETURNING *`, now + 60_000, id, now, now, now))
    return result.results[0] as unknown as BotJob ?? null
  }

  async dueJobs(): Promise<BotJob[]> {
    const now = BigInt(Date.now())
    return (await this.client.botJob.findMany({ where: { state: 'pending', leaseUntil: { lte: now }, nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 20 })).map(botJob)
  }

  async finishJob(job: BotJob): Promise<void> {
    await this.completeWithoutCard(job, 'sent')
  }

  async failJob(job: BotJob): Promise<void> {
    await this.completeWithoutCard(job, 'failed')
  }

  private async completeWithoutCard(job: BotJob, state: 'sent' | 'failed'): Promise<void> {
    const done = completeJob(job, state)
    if (isCardPublication(job)) {
      // 如果失效恰逢发布，发布流程最后确认没有可更新的卡片时才发文字通知。
      await this.transport.batch([done, queueUnavailableText(job.file_id)])
    } else {
      await this.transport.query(done)
    }
  }

  async finishCardPublication(job: BotJob, messageId: string): Promise<void> {
    if (!isCardPublication(job) || !messageId) throw new Error('Invalid card publication receipt')
    await this.transport.batch([
      completeJob(job, 'sent', messageId),
      queueCardUpdate('id', job.file_id),
    ])
  }

  async retryUnsentCard(job: BotJob, url: string): Promise<void> {
    if (!isCardPublication(job)) throw new Error('Invalid card publication job')
    await this.delayJob(job, unsentCardPrefix + url)
  }

  async beginUnsentCard(job: BotJob, url: string): Promise<boolean> {
    if (!isCardPublication(job)) throw new Error('Invalid card publication job')
    // 只有确定上次没有送达才写入 unsent 标记。新请求前先清除标记，崩溃恢复按送达未知处理。
    const result = await this.transport.query(statement(`UPDATE bot_jobs SET argument=? WHERE ${claimedJob}
      AND argument=? AND EXISTS(SELECT 1 FROM files f WHERE f.id=bot_jobs.file_id AND f.status='active')`,
    url, job.id, job.attempts, job.lease_until, unsentCardPrefix + url))
    return result.meta.changes === 1
  }

  async fallbackCardPublication(job: BotJob): Promise<void> {
    if (!isCardPublication(job)) throw new Error('Invalid card publication job')
    await this.transport.batch([
      completeJob(job, 'failed'),
      statement(`INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument)
        SELECT 'fallback:'||p.file_id,'notification',p.file_id,p.uploader_open_id,p.chat_id,p.argument
        FROM bot_jobs p JOIN files f ON f.id=p.file_id WHERE p.id=? AND f.status='active' AND changes()>0`, job.id),
      queueUnavailableText(job.file_id),
    ])
  }

  async finishCardUpdate(job: BotJob, renderedStatus: 'deleted' | 'unavailable'): Promise<void> {
    const done = completeJob(job, 'sent')
    if (renderedStatus === 'deleted' || Date.now() < job.lease_until) {
      await this.transport.query(done)
      return
    }
    // 较旧的失效 PATCH 可能晚于撤销 PATCH 到达飞书。使已有完成记录和正在发送的旧租约失效，
    // 让调度器在它之后再次写入撤销状态。此补偿也适用于持有过期租约但 PATCH 已成功的进程。
    await this.transport.batch([
      done,
      statement(`UPDATE bot_jobs SET state='pending',lease_until=0,next_attempt_at=0
        WHERE id='card:deleted:'||? AND message_id=? AND EXISTS(SELECT 1 FROM files WHERE id=? AND status='deleted')`,
      job.file_id, job.message_id, job.file_id),
    ])
  }

  async retryJob(job: BotJob): Promise<void> {
    await this.delayJob(job)
  }

  private async delayJob(job: BotJob, argument?: string): Promise<void> {
    if (job.attempts >= 8) {
      await this.failJob(job)
      return
    }
    await this.client.botJob.updateMany({ where: { id: job.id, state: 'pending', attempts: job.attempts, leaseUntil: BigInt(job.lease_until) },
      data: { ...(argument === undefined ? {} : { argument }), leaseUntil: 0n, nextAttemptAt: BigInt(Date.now() + Math.min(60_000 * 2 ** job.attempts, 3_600_000)) } })
  }

  async cleanupEvents(): Promise<void> {
    await this.client.processedEvent.deleteMany({ where: { processedAt: { lt: utcText(Date.now() - 7 * 86_400_000) } } })
  }
  async health(): Promise<void> { await this.transport.query(statement('SELECT 1 AS healthy')) }
  async close(): Promise<void> { await this.client.$disconnect() }
}
