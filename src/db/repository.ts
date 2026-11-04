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

export type Registration = Pick<FileRecord, 'id' | 'message_id' | 'file_key' | 'file_name' | 'uploader_open_id' | 'chat_id'>
export type Command = Pick<BotJob, 'id' | 'message_id' | 'uploader_open_id' | 'chat_id' | 'argument'>
export type FileListItem = Pick<FileRecord, 'id' | 'file_name' | 'download_count'>

export interface RelayRepository {
  getFile(id: string): Promise<FileRecord | null>
  getDownloadFile(id: string): Promise<FileRecord | null>
  markUnavailable(id: string): Promise<boolean>
  countDownload(id: string): Promise<void>
  registerFile(eventId: string, file: Registration): Promise<void>
  recallFile(eventId: string, messageId: string): Promise<void>
  createCommand(eventId: string, job: Command): Promise<void>
  queueNotification(id: string, file: Pick<FileRecord, 'id' | 'uploader_open_id' | 'chat_id'>, text: string): Promise<void>
  claimPending(id: string): Promise<PendingFile | null>
  finishValidation(file: PendingFile, size: number | null, reason: string | null, text: string): Promise<boolean>
  retryValidation(file: PendingFile, reason: string): Promise<void>
  dueFiles(): Promise<PendingFile[]>
  claimJob(id: string): Promise<BotJob | null>
  dueJobs(): Promise<BotJob[]>
  finishJob(job: BotJob): Promise<void>
  retryJob(job: BotJob): Promise<void>
  listFiles(uploader: string): Promise<FileListItem[]>
  revokeFile(id: string, uploader: string, allowAdmin?: boolean): Promise<boolean>
  cleanupEvents(): Promise<void>
  health(): Promise<void>
  close(): Promise<void>
}
