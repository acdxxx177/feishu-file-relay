import { PrismaClient, type Prisma } from '../generated/prisma/client'
import type { FileRecord } from '../types'
import type { BotJob, Command, PendingFile, Registration, RelayRepository } from './repository'
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
    next_attempt_at: safeNumber(row.nextAttemptAt), lease_until: safeNumber(row.leaseUntil) }
}

function statement(sql: string, ...params: (string | number | null)[]): Statement { return { sql, params } }
function utcText(timestamp = Date.now()): string { return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ') }

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
    const result = await this.client.file.updateMany({ where: { id, status: { not: 'deleted' }, ...(allowAdmin ? {} : { uploaderOpenId: uploader }) },
      data: { status: 'deleted', deleteReason: 'revoked', deletedAt: utcText(), updatedAt: utcText() } })
    return result.count > 0
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
      statement(`INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument)
        SELECT 'unavailable:'||id,'notification',id,uploader_open_id,chat_id,'文件 '||file_name||' 的飞书源文件已无法读取，链接已失效。'
        FROM files WHERE id=? AND changes()>0`, id),
    ])
    return result[0].meta.changes > 0
  }

  async claimPending(id: string): Promise<PendingFile | null> {
    const now = Date.now()
    const result = await this.transport.query(statement("UPDATE files SET attempts=attempts+1,lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND attempts<4 AND lease_until<=? AND next_attempt_at<=? RETURNING *", now + 60_000, id, now, now))
    return result.results[0] as unknown as PendingFile ?? null
  }

  async finishValidation(file: PendingFile, size: number | null, reason: string | null, text: string): Promise<boolean> {
    const status = size === null ? 'failed' : 'active'
    const result = await this.transport.batch([
      statement("UPDATE files SET status=?,file_size=?,fail_reason=?,lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND attempts=? AND lease_until=?", status, size, reason, file.id, file.attempts, file.lease_until),
      statement("INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument) SELECT ?,'notification',?,?,?,? WHERE changes()>0", `${status}:${file.id}`, file.id, file.uploader_open_id, file.chat_id, text),
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
    const result = await this.transport.query(statement("UPDATE bot_jobs SET attempts=attempts+1,lease_until=? WHERE id=? AND state='pending' AND lease_until<=? AND next_attempt_at<=? RETURNING *", now + 60_000, id, now, now))
    return result.results[0] as unknown as BotJob ?? null
  }

  async dueJobs(): Promise<BotJob[]> {
    const now = BigInt(Date.now())
    return (await this.client.botJob.findMany({ where: { state: 'pending', leaseUntil: { lte: now }, nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 20 })).map(botJob)
  }

  async finishJob(job: BotJob): Promise<void> {
    await this.client.botJob.updateMany({ where: { id: job.id, state: 'pending', attempts: job.attempts, leaseUntil: BigInt(job.lease_until) }, data: { state: 'sent', leaseUntil: 0n } })
  }

  async retryJob(job: BotJob): Promise<void> {
    await this.client.botJob.updateMany({ where: { id: job.id, state: 'pending', attempts: job.attempts, leaseUntil: BigInt(job.lease_until) },
      data: { state: job.attempts >= 8 ? 'failed' : 'pending', leaseUntil: 0n, nextAttemptAt: BigInt(Date.now() + Math.min(60_000 * 2 ** job.attempts, 3_600_000)) } })
  }

  async cleanupEvents(): Promise<void> {
    await this.client.processedEvent.deleteMany({ where: { processedAt: { lt: utcText(Date.now() - 7 * 86_400_000) } } })
  }
  async health(): Promise<void> { await this.transport.query(statement('SELECT 1 AS healthy')) }
  async close(): Promise<void> { await this.client.$disconnect() }
}
