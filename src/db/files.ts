import type { FileRecord } from '../types'

export interface PendingFile extends FileRecord {
  next_attempt_at: number
  lease_until: number
}

export interface BotJob {
  id: string
  kind: 'command' | 'notification'
  message_id: string | null
  file_id: string | null
  uploader_open_id: string
  chat_id: string
  argument: string
  state: 'pending' | 'sent' | 'failed'
  attempts: number
  next_attempt_at: number
  lease_until: number
}

export function getFile(db: D1Database, id: string): Promise<FileRecord | null> {
  // 显式读主库，不能让跨地区副本的短暂滞后绕过撤回。
  return db.withSession('first-primary').prepare('SELECT * FROM files WHERE id = ?').bind(id).first<FileRecord>()
}

export async function markUnavailable(db: D1Database, id: string): Promise<boolean> {
  const result = await db.batch([
    db.prepare("UPDATE files SET status='unavailable', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").bind(id),
    db.prepare(`INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument)
      SELECT 'unavailable:'||id,'notification',id,uploader_open_id,chat_id,
        '文件 '||file_name||' 的飞书源文件已无法读取，链接已失效。' FROM files WHERE id=? AND changes()>0`).bind(id),
  ])
  return result[0].meta.changes > 0
}

export async function countDownload(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE files SET download_count=download_count+1, last_downloaded_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'").bind(id).run()
}

export async function registerFile(db: D1Database, eventId: string, file: Pick<FileRecord, 'id' | 'message_id' | 'file_key' | 'file_name' | 'uploader_open_id' | 'chat_id'>): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO files (id,message_id,file_key,file_name,uploader_open_id,chat_id)
      SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM recalled_messages WHERE message_id=?)
      AND NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id=?)
      ON CONFLICT(message_id) DO NOTHING`).bind(file.id, file.message_id, file.file_key, file.file_name, file.uploader_open_id, file.chat_id, file.message_id, eventId),
    db.prepare('INSERT OR IGNORE INTO processed_events(event_id) VALUES(?)').bind(eventId),
  ])
}

export async function recallFile(db: D1Database, eventId: string, messageId: string): Promise<void> {
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO recalled_messages(message_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id=?)').bind(messageId, eventId),
    db.prepare("UPDATE files SET status='deleted', delete_reason='recalled', deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE message_id=? AND status!='deleted' AND NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id=?)").bind(messageId, eventId),
    db.prepare('INSERT OR IGNORE INTO processed_events(event_id) VALUES(?)').bind(eventId),
  ])
}

export async function createCommand(db: D1Database, eventId: string, job: Pick<BotJob, 'id' | 'message_id' | 'uploader_open_id' | 'chat_id' | 'argument'>): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO bot_jobs(id,kind,message_id,uploader_open_id,chat_id,argument) SELECT ?,'command',?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id=?)").bind(job.id, job.message_id, job.uploader_open_id, job.chat_id, job.argument, eventId),
    db.prepare('INSERT OR IGNORE INTO processed_events(event_id) VALUES(?)').bind(eventId),
  ])
}

export async function queueNotification(db: D1Database, id: string, file: Pick<FileRecord, 'id' | 'uploader_open_id' | 'chat_id'>, text: string): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument) VALUES(?,'notification',?,?,?,?)")
    .bind(id, file.id, file.uploader_open_id, file.chat_id, text).run()
}

export async function claimPending(db: D1Database, id: string): Promise<PendingFile | null> {
  const now = Date.now()
  return db.prepare(`UPDATE files SET attempts=attempts+1, lease_until=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending' AND attempts<4 AND lease_until<=? AND next_attempt_at<=? RETURNING *`)
    .bind(now + 60_000, id, now, now).first<PendingFile>()
}

export async function finishValidation(db: D1Database, file: PendingFile, size: number | null, reason: string | null, text: string): Promise<boolean> {
  const status = size === null ? 'failed' : 'active'
  // 状态变更和通知出站箱属于同一事务；撤回抢先提交时不产生发布通知。
  const result = await db.batch([
    db.prepare("UPDATE files SET status=?,file_size=?,fail_reason=?,lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND attempts=?")
      .bind(status, size, reason, file.id, file.attempts),
    db.prepare(`INSERT OR IGNORE INTO bot_jobs(id,kind,file_id,uploader_open_id,chat_id,argument)
      SELECT ?,'notification',?,?,?,? WHERE changes()>0`)
      .bind(`${status}:${file.id}`, file.id, file.uploader_open_id, file.chat_id, text),
  ])
  return result[0].meta.changes > 0
}

export async function retryValidation(db: D1Database, file: PendingFile, reason: string): Promise<void> {
  const delay = [2_000, 10_000, 60_000][file.attempts - 1] ?? 60_000
  await db.prepare("UPDATE files SET fail_reason=?,lease_until=0,next_attempt_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending' AND attempts=?")
    .bind(reason, Date.now() + delay, file.id, file.attempts).run()
}

export async function dueFiles(db: D1Database): Promise<PendingFile[]> {
  const result = await db.prepare("SELECT * FROM files WHERE status='pending' AND lease_until<=? AND next_attempt_at<=? ORDER BY created_at LIMIT 20")
    .bind(Date.now(), Date.now()).all<PendingFile>()
  return result.results
}

export async function claimJob(db: D1Database, id: string): Promise<BotJob | null> {
  const now = Date.now()
  return db.prepare(`UPDATE bot_jobs SET attempts=attempts+1, lease_until=?
    WHERE id=? AND state='pending' AND lease_until<=? AND next_attempt_at<=? RETURNING *`)
    .bind(now + 60_000, id, now, now).first<BotJob>()
}

export async function dueJobs(db: D1Database): Promise<BotJob[]> {
  const result = await db.prepare("SELECT * FROM bot_jobs WHERE state='pending' AND lease_until<=? AND next_attempt_at<=? ORDER BY created_at LIMIT 20")
    .bind(Date.now(), Date.now()).all<BotJob>()
  return result.results
}

export async function finishJob(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE bot_jobs SET state='sent',lease_until=0 WHERE id=?").bind(id).run()
}

export async function retryJob(db: D1Database, job: BotJob): Promise<void> {
  await db.prepare("UPDATE bot_jobs SET state=?,lease_until=0,next_attempt_at=? WHERE id=?")
    .bind(job.attempts >= 8 ? 'failed' : 'pending', Date.now() + Math.min(60_000 * 2 ** job.attempts, 3_600_000), job.id).run()
}
