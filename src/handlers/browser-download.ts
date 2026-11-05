import type { RpcStub } from 'cloudflare:workers'
import { CHUNK_SIZE, type ChunkRequest } from '../cache/chunk-entry'
import { countDownload } from '../db/files'
import { authorizeFile, sourceUnavailable, type DownloadContext } from '../lib/file-access'
import { fileHeaders, publicError } from '../lib/headers'
import { parseRange } from '../lib/http-range'
import { downloadPageResponse, securityHeaders } from '../lib/download-page-response'

const blobLimit = 20 * 1024 * 1024

export function recommendedChunkSize(env: Env): number {
  const configured = Number(env.BROWSER_CHUNK_SIZE)
  return [1, 4, 8, 16].some((size) => size * 1024 * 1024 === configured) ? configured : CHUNK_SIZE
}

export async function handleFilePage(request: Request, env: Env, id: string, metadata = false): Promise<Response> {
  const file = await authorizeFile(env, id)
  if (file instanceof Response) {
    if (metadata) return file
    return downloadPageResponse(request, null, file.status, file.headers.get('Retry-After'))
  }
  const publicFile = { id: file.id, name: file.file_name, size: file.file_size!, status: 'active', etag: fileHeaders(file).get('ETag')!, chunkSize: recommendedChunkSize(env), blobLimit }
  if (metadata) return Response.json(publicFile, { headers: securityHeaders() })
  return downloadPageResponse(request, publicFile)
}

export async function handleBrowserChunk(request: Request, env: Env, ctx: DownloadContext, id: string): Promise<Response> {
  const head = request.method === 'HEAD'
  const file = await authorizeFile(env, id, head)
  if (file instanceof Response) return file
  const headers = fileHeaders(file)
  headers.set('Cache-Control', 'no-store')
  const etag = headers.get('ETag')!
  if (!request.headers.has('If-Match')) return publicError(428, head)
  if (request.headers.get('If-Match') !== etag) return publicError(412, head)
  const rangeHeader = request.headers.get('Range')
  const range = parseRange(rangeHeader, file.file_size!)
  if (!rangeHeader || rangeHeader.includes(',') || !range?.partial || range.end - range.start + 1 > CHUNK_SIZE) {
    return publicError(416, head, { 'Content-Range': `bytes */${file.file_size}` })
  }
  const { start, end } = range
  const length = end - start + 1
  headers.set('Content-Range', `bytes ${start}-${end}/${file.file_size}`)
  headers.set('Content-Length', String(length))
  if (head) return new Response(null, { status: 206, headers })
  if (!ctx.exports || request.signal.aborted) return publicError(503)
  let handle: RpcStub<ChunkRequest> | undefined
  const dispose = () => { handle?.[Symbol.dispose](); handle = undefined }
  const abort = () => {
    if (handle) ctx.waitUntil(handle.cancel().catch(() => {}))
    dispose()
  }
  request.signal.addEventListener('abort', abort, { once: true })
  const started = Date.now()
  try {
    handle = await ctx.exports.ChunkEntry.openRange({ id: file.id, message_id: file.message_id, file_key: file.file_key, version: file.version, file_size: file.file_size! }, start, end, env.BROWSER_CHUNK_CACHE_ENABLED !== 'false')
    if (request.signal.aborted) throw new Error('Client disconnected')
    const chunk = await handle.response()
    if (chunk.status === 410) {
      await sourceUnavailable(env, file, ctx)
      dispose()
      request.signal.removeEventListener('abort', abort)
      return publicError(410)
    }
    if (chunk.status !== 200 || !chunk.body || chunk.headers.get('Content-Length') !== String(length)) throw new Error('Invalid chunk')
    headers.set('X-Chunk-Cache', chunk.headers.get('X-Chunk-Cache') ?? 'MISS')
    const output = new FixedLengthStream(length)
    // 原生管道只追踪完成/取消；Gateway 不再逐段读取或复制文件字节。
    ctx.waitUntil(chunk.body.pipeTo(output.writable, { signal: request.signal }).then(async () => {
      if (start === 0) await countDownload(env.DB, id).catch(() => {})
      console.log(JSON.stringify({ event: 'browser_chunk', file_id: id, status: 206, bytes: length, duration_ms: Date.now() - started }))
    }, () => {
      abort()
      console.log(JSON.stringify({ event: 'browser_chunk_interrupted', file_id: id, duration_ms: Date.now() - started }))
    }).finally(() => {
      dispose()
      request.signal.removeEventListener('abort', abort)
    }))
    return new Response(output.readable, { status: 206, headers })
  } catch {
    abort()
    request.signal.removeEventListener('abort', abort)
    return publicError(503)
  }
}
