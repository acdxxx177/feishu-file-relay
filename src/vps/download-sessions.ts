import { randomBytes } from 'node:crypto'
import type { FileRecord } from '../types'
import type { FirstDownloadSnapshot, RelayRepository } from '../db/repository'
import { fileHeaders } from '../lib/headers'
import { securityHeaders } from '../lib/download-page-response'
import { CHUNK_SIZE } from './chunks'

export type DownloadLocation = FirstDownloadSnapshot['location']
type SaveMethod = FirstDownloadSnapshot['method']
interface Session {
  fileId: string
  version: number
  size: number
  fileName: string
  method: SaveMethod
  expires: number
  offset: number
  snapshot?: FirstDownloadSnapshot
  persisted?: boolean
  pending?: Promise<boolean>
}

export function isPrefetch(request: Request): boolean {
  return ['Purpose', 'Sec-Purpose', 'X-Purpose', 'X-Moz'].some(name => /prefetch|prerender/i.test(request.headers.get(name) ?? ''))
}

function response(status: number, retry?: string): Response {
  const headers = securityHeaders()
  if (retry) headers.set('Retry-After', retry)
  return new Response(null, { status, headers })
}

async function smallJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
      Number(request.headers.get('Content-Length')) > 1024 || !request.body) throw new Error('Invalid body')
  const reader = request.body.getReader()
  let expired = false
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, 2000)
  const parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (expired || request.signal.aborted) throw new Error('Body timeout')
      if (done) break
      length += value.length
      if (length > 1024) throw new Error('Body too large')
      parts.push(value)
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON')
    return value as Record<string, unknown>
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** 只保留完整范围的连续进度；不持久化访客会话，不把内存记录当下载授权。 */
export class DownloadSessions {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => number
  constructor(private readonly options: {
    enabled: boolean
    origin: string
    repository: Pick<RelayRepository, 'getDownloadFile' | 'recordFirstDownload'>
    wake(): void
    now?: () => number
    capacity?: number
    ttlMs?: number
  }) { this.now = options.now ?? Date.now }

  eligible(file: FileRecord): boolean {
    return this.options.enabled && file.first_download_notification === 1
  }

  private prune() {
    for (const [key, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(key)
  }

  private allowed(request: Request): boolean {
    return request.headers.get('Origin') === this.options.origin && !isPrefetch(request) &&
      (!request.headers.has('Sec-Fetch-Site') || request.headers.get('Sec-Fetch-Site') === 'same-origin')
  }

  async start(request: Request, id: string): Promise<Response> {
    if (!this.allowed(request)) return response(403)
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return response(404)
    if (!this.options.enabled) return response(204)
    let body: Record<string, unknown>
    try { body = await smallJson(request) } catch { return response(400) }
    if ((body.method !== 'native' && body.method !== 'blob') || typeof body.etag !== 'string') return response(400)
    this.prune()
    if (this.sessions.size >= (this.options.capacity ?? 1000)) return response(204)
    let file: FileRecord | null
    try { file = await this.options.repository.getDownloadFile(id) } catch { return response(503, '10') }
    if (!file) return response(404)
    if (file.status === 'deleted' || file.status === 'unavailable') return response(410)
    if (file.status !== 'active' || !Number.isSafeInteger(file.file_size) || file.file_size! <= 0) return response(404)
    if (!this.eligible(file)) return response(204)
    if (body.etag !== fileHeaders(file).get('ETag')) return response(412)
    if (body.method === 'blob' && file.file_size! > 20 * 1024 * 1024) return response(400)
    // 数据库读取会让出事件循环，容量必须在真正插入前再检查。
    if (this.sessions.size >= (this.options.capacity ?? 1000)) return response(204)
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, { fileId: id, version: file.version, size: file.file_size!, fileName: file.file_name,
      method: body.method, expires: this.now() + (this.options.ttlMs ?? 86_400_000), offset: 0 })
    return Response.json({ token }, { headers: securityHeaders() })
  }

  /** 返回轻量 EOF 回调，跟踪失败不影响原本的二进制传输。 */
  observe(request: Request, file: FileRecord, start: number, end: number): (() => void) | undefined {
    if (!this.eligible(file) || isPrefetch(request) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return
    const token = request.headers.get('X-Download-Session')
    if (!token) return
    const session = this.sessions.get(token)
    if (!session || session.expires <= this.now() || session.fileId !== file.id || session.version !== file.version ||
        session.size !== file.file_size || session.offset !== start || session.snapshot ||
        start % CHUNK_SIZE !== 0 || end !== Math.min(start + CHUNK_SIZE, session.size) - 1) return
    return () => {
      if (!request.signal.aborted && this.sessions.get(token) === session && session.expires > this.now() && session.offset === start) {
        session.offset = end + 1
      }
    }
  }

  async complete(request: Request, id: string, location: DownloadLocation): Promise<Response> {
    if (!this.allowed(request)) return response(403)
    if (!this.options.enabled) return response(204)
    this.prune()
    const token = request.headers.get('X-Download-Session')
    const session = token && this.sessions.get(token)
    if (!session || session.fileId !== id) return response(410)
    let body: Record<string, unknown>
    try { body = await smallJson(request) } catch { return response(400) }
    if (body.method !== session.method) return response(400)
    if (session.offset !== session.size) return response(409, '2')
    if (session.persisted) return response(204)
    // 首次有效回执的时间/地点在未知提交结果后的重试中保持不变。
    session.snapshot ??= { schema: 1, fileName: session.fileName, confirmedAt: new Date(this.now()).toISOString(), method: session.method, location }
    try {
      session.pending ??= this.options.repository.recordFirstDownload(id, session.version, session.snapshot)
      if (!await session.pending) return response(410)
      session.persisted = true
      this.options.wake()
      return response(204)
    } catch {
      return response(503, '10')
    } finally { session.pending = undefined }
  }
}
