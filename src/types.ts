export interface FileRecord {
  id: string
  message_id: string
  file_key: string
  file_name: string
  file_size: number | null
  mime_type: string | null
  uploader_open_id: string
  chat_id: string
  version: number
  status: 'pending' | 'active' | 'failed' | 'unavailable' | 'deleted'
  fail_reason: string | null
  delete_reason: string | null
  attempts: number
  download_count: number
  last_downloaded_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type SourceFile = Pick<FileRecord, 'id' | 'message_id' | 'file_key' | 'version'> & { file_size: number }

export interface BackgroundContext {
  waitUntil(promise: Promise<unknown>): void
}
