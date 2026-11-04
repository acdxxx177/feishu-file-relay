import { getFile, markUnavailable } from '../db/files'
import { notifyUnavailable } from '../services/feishu'
import { publicError } from './headers'
import type { FileRecord } from '../types'

export type DownloadContext = Pick<ExecutionContext, 'waitUntil'> & { exports?: Cloudflare.Exports }

export async function authorizeFile(env: Env, id: string, head = false): Promise<FileRecord | Response> {
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return publicError(404, head)
  let file: FileRecord | null
  try { file = await getFile(env.DB, id) } catch { return publicError(503, head) }
  if (!file) return publicError(404, head)
  if (file.status === 'deleted' || file.status === 'unavailable') return publicError(410, head)
  if (file.status !== 'active' || file.file_size === null) return publicError(404, head)
  return file
}

export async function sourceUnavailable(env: Env, file: FileRecord, ctx: DownloadContext): Promise<void> {
  if (await markUnavailable(env.DB, file.id)) {
    ctx.waitUntil(notifyUnavailable(env, file).catch(() => {
      console.log(JSON.stringify({ event: 'notification_failed', file_id: file.id }))
    }))
  }
}
