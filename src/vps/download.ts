import type { FileRecord, SourceFile } from '../types'
import { fileHeaders, publicError } from '../lib/headers'
import { ifRangeMatches, parseRange } from '../lib/http-range'
import { renderDownloadPage } from '../browser/page'
import { CHUNK_SIZE, ChunkService, type ResourceFetcher } from './chunks'

export interface DownloadDependencies {
  repository: {
    getFile(id: string): Promise<FileRecord | null>
    markUnavailable(id: string): Promise<boolean>
    countDownload(id: string): Promise<void>
  }
  fetchResource: ResourceFetcher
  readTimeoutMs?: number
  cacheEnabled?: boolean
  onUnavailable?: () => void
}

export function securityHeaders(): Headers {
  return new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' })
}

function pageHeaders(): Headers {
  const headers = securityHeaders()
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  headers.set('X-Frame-Options', 'DENY')
  return headers
}

export function createDownloadHandlers(deps: DownloadDependencies) {
  const chunks = new ChunkService(deps.fetchResource, deps)
  async function authorize(id: string, head: boolean): Promise<FileRecord | Response> {
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return publicError(404, head)
    let file: FileRecord | null
    try { file = await deps.repository.getFile(id) } catch { return publicError(503, head) }
    if (!file) return publicError(404, head)
    if (file.status === 'deleted' || file.status === 'unavailable') return publicError(410, head)
    if (file.status !== 'active' || !Number.isSafeInteger(file.file_size) || file.file_size! <= 0) return publicError(404, head)
    return file
  }

  async function unavailable(error: unknown, file: FileRecord): Promise<boolean> {
    if (!error || typeof error !== 'object' || !('permanent' in error) || error.permanent !== true) return false
    if (await deps.repository.markUnavailable(file.id)) deps.onUnavailable?.()
    return true
  }

  async function transfer(request: Request, id: string, browser: boolean): Promise<Response> {
    const started = Date.now()
    const head = request.method === 'HEAD'
    const file = await authorize(id, head)
    if (file instanceof Response) return file
    const headers = fileHeaders(file)
    if (browser) headers.set('Cache-Control', 'no-store')
    const rangeHeader = request.headers.get('Range')
    if (browser && !request.headers.has('If-Match')) return publicError(428, head)
    if (browser && request.headers.get('If-Match') !== headers.get('ETag')) return publicError(412, head)
    const useRange = browser || ifRangeMatches(request.headers.get('If-Range'), headers.get('ETag')!, headers.get('Last-Modified')!)
    const range = parseRange(useRange ? rangeHeader : null, file.file_size!)
    if (!range || (browser && (!rangeHeader || rangeHeader.includes(',') || !range.partial || range.end - range.start + 1 > CHUNK_SIZE))) {
      return publicError(416, head, { 'Content-Range': `bytes */${file.file_size}` })
    }
    const length = range.end - range.start + 1
    headers.set('Content-Length', String(length))
    if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.file_size}`)
    const status = range.partial ? 206 : 200
    if (head) return new Response(null, { status, headers })
    const abort = new AbortController()
    const onAbort = () => abort.abort(request.signal.reason)
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    const source: SourceFile = { id, message_id: file.message_id, file_key: file.file_key, version: file.version, file_size: file.file_size! }
    // 精确范围逐片获取，不为单字节探测或边界续传多读整个分片。
    const firstEnd = Math.min(range.end, range.start + CHUNK_SIZE - 1)
    let current: ReadableStreamDefaultReader<Uint8Array> | undefined
    let first: Awaited<ReturnType<ChunkService['open']>>
    try { first = await chunks.open(source, range.start, firstEnd, abort.signal) }
    catch (error) {
      abort.abort(); request.signal.removeEventListener('abort', onAbort)
      try { return publicError(await unavailable(error, file) ? 410 : 503) } catch { return publicError(503) }
    }
    if (browser) headers.set('X-Chunk-Cache', first.hit ? 'HIT' : 'MISS')
    let offset = range.start
    let piece = 0
    let sent = 0
    let finished = false
    let counted = false
    let logged = false
    const log = (completed: boolean) => {
      if (logged) return
      logged = true
      console.log(JSON.stringify({ event: completed ? 'download' : 'download_interrupted', file_id: id, status,
        bytes: sent, duration_ms: Date.now() - started, path: browser ? 'browser' : 'raw', cache: first.hit ? 'HIT' : 'MISS' }))
    }
    current = first.body.getReader()
    const cleanup = () => {
      log(false)
      abort.abort()
      request.signal.removeEventListener('abort', onAbort)
      if (current) void current.cancel().catch(() => {})
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (abort.signal.aborted) throw abort.signal.reason
          while (true) {
            const next = await current!.read()
            if (!next.done) {
              sent += next.value.byteLength
              if (sent > length) throw new Error('Unexpected transfer length')
              controller.enqueue(next.value)
              if (!browser && range.start === 0 && !counted) {
                counted = true
                void deps.repository.countDownload(id).catch(() => {})
              }
              return
            }
            current!.releaseLock(); current = undefined
            offset = Math.min(range.end + 1, offset + CHUNK_SIZE)
            piece++
            if (offset > range.end) {
              if (sent !== length) throw new Error('Incomplete transfer')
              finished = true
              request.signal.removeEventListener('abort', onAbort)
              if (browser && range.start === 0) await deps.repository.countDownload(id).catch(() => {})
              log(true)
              controller.close()
              return
            }
            if (piece % 8 === 0) {
              const latest = await deps.repository.getFile(id)
              if (latest?.status !== 'active' || latest.version !== file.version) throw new Error('File no longer active')
            }
            const nextChunk = await chunks.open(source, offset, Math.min(range.end, offset + CHUNK_SIZE - 1), abort.signal)
            current = nextChunk.body.getReader()
          }
        } catch (error) {
          cleanup()
          controller.error(error)
          // 输出先失败，通知持久化不能延迟向客户传播中断。
          void unavailable(error, file).catch(() => {})
        }
      },
      cancel() { if (!finished) cleanup() },
    }, { highWaterMark: 0 })
    return new Response(body, { status, headers })
  }

  return {
    raw: (request: Request, id: string) => transfer(request, id, false),
    chunk: (request: Request, id: string) => transfer(request, id, true),
    async page(request: Request, id: string, metadata = false): Promise<Response> {
      const file = await authorize(id, request.method === 'HEAD')
      if (file instanceof Response) {
        if (metadata) return file
        const headers = pageHeaders()
        if (file.headers.has('Retry-After')) headers.set('Retry-After', file.headers.get('Retry-After')!)
        return new Response(request.method === 'HEAD' ? null : renderDownloadPage(null, file.status), { status: file.status, headers })
      }
      const publicFile = { id, name: file.file_name, size: file.file_size!, status: 'active', etag: fileHeaders(file).get('ETag')!, chunkSize: CHUNK_SIZE, blobLimit: 20 * 1024 * 1024 }
      if (metadata) return Response.json(publicFile, { headers: securityHeaders() })
      return new Response(request.method === 'HEAD' ? null : renderDownloadPage(publicFile), { headers: pageHeaders() })
    },
  }
}
