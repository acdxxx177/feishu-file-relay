import { countDownload, getFile } from '../db/files'
import { fetchResource, UpstreamError } from '../services/feishu'
import { authorizeFile, sourceUnavailable, type DownloadContext } from '../lib/file-access'
import type { RpcStub } from 'cloudflare:workers'
import { CHUNK_SIZE, checkedBody, type ChunkRequest } from '../cache/chunk-entry'
import { fileHeaders, publicError } from '../lib/headers'
import { ifRangeMatches, parseRange } from '../lib/http-range'
import type { FileRecord, SourceFile } from '../types'

export async function handleDownload(request: Request, env: Env, ctx: DownloadContext, id: string): Promise<Response> {
  const head = request.method === 'HEAD'
  const authorized = await authorizeFile(env, id, head)
  if (authorized instanceof Response) return authorized
  const file: FileRecord = authorized
  const source: SourceFile = {
    id: file.id,
    message_id: file.message_id,
    file_key: file.file_key,
    version: file.version,
    file_size: file.file_size!,
  }
  const headers = fileHeaders(file)
  const useRange = ifRangeMatches(request.headers.get('If-Range'), headers.get('ETag')!, headers.get('Last-Modified')!)
  const range = parseRange(useRange ? request.headers.get('Range') : null, source.file_size)
  if (!range) return publicError(416, head, { 'Content-Range': `bytes */${source.file_size}` })
  const selected = range
  const length = range.end - range.start + 1
  headers.set('Content-Length', String(length))
  if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${source.file_size}`)
  const status = range.partial ? 206 : 200
  if (head || length === 0) return new Response(null, { status, headers })
  if (!ctx.exports) return publicError(503)
  const chunkEntry = ctx.exports.ChunkEntry
  const startTime = Date.now()
  let first: Response | undefined
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let currentHandle: RpcStub<ChunkRequest> | undefined
  let probeAbort: AbortController | undefined
  let cancelled = request.signal.aborted
  let counted = false
  let sent = 0
  const disposeHandle = () => {
    currentHandle?.[Symbol.dispose]()
    currentHandle = undefined
  }
  const cancel = async () => {
    cancelled = true
    probeAbort?.abort()
    const remote = currentHandle?.cancel().catch(() => {})
    // 先释放 RPC 能力；网络取消确认可能不返回，不能把句柄释放排在其后。
    disposeHandle()
    const cleanup = [remote, currentReader?.cancel().catch(() => {})]
    if (first?.body && !first.body.locked) cleanup.push(first.body.cancel().catch(() => {}))
    ctx.waitUntil(Promise.allSettled(cleanup))
  }
  const onAbort = () => { ctx.waitUntil(cancel()) }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const nextChunk = async (index: number): Promise<Response> => {
    currentHandle = await chunkEntry.openChunk(source, index)
    if (cancelled || request.signal.aborted) {
      await currentHandle.cancel()
      disposeHandle()
      throw new Error('Client disconnected')
    }
    return currentHandle.response()
  }
  const probe = range.partial && range.start === 0 && range.end === 0
  const firstIndex = Math.floor(range.start / CHUNK_SIZE)
  const lastIndex = Math.floor(range.end / CHUNK_SIZE)
  try {
    if (probe) {
      // D1 不存文件字节，单字节探测只能精确回源 1 字节，绝不为预取拉取 16 MiB。
      probeAbort = new AbortController()
      if (request.signal.aborted) probeAbort.abort()
      const response = await fetchResource(env, source, 0, 0, probeAbort.signal)
      first = new Response(checkedBody(response, 0, 0, source.file_size, probeAbort, ctx, Number(env.UPSTREAM_READ_TIMEOUT_MS) || 30_000))
    } else {
      first = await nextChunk(firstIndex)
      if (first.status === 410) {
        await sourceUnavailable(env, file, ctx)
        disposeHandle()
        request.signal.removeEventListener('abort', onAbort)
        return publicError(410)
      }
      if (first.status !== 200 || !first.body) {
        disposeHandle()
        request.signal.removeEventListener('abort', onAbort)
        return publicError(503)
      }
    }
  } catch (error) {
    await cancel()
    disposeHandle()
    request.signal.removeEventListener('abort', onAbort)
    if (error instanceof UpstreamError && error.permanent) {
      await sourceUnavailable(env, file, ctx)
      return publicError(410)
    }
    return publicError(503)
  }
  const initialChunk = first
  async function* slices(): AsyncGenerator<Uint8Array> {
    try {
      for (let index = firstIndex; index <= lastIndex; index++) {
        if (cancelled) throw new Error('Client disconnected')
        if (index > firstIndex && (index - firstIndex) % 8 === 0) {
          const latest = await getFile(env.DB, id)
          if (latest?.status !== 'active' || latest.version !== file!.version) throw new Error('File no longer active')
        }
        const chunk = index === firstIndex ? initialChunk : await nextChunk(index)
        if (chunk.status === 410) {
          await sourceUnavailable(env, file!, ctx)
          throw new Error('Source unavailable')
        }
        if (chunk.status !== 200 || !chunk.body) throw new Error('Chunk unavailable')
        currentReader = chunk.body.getReader()
        let offset = probe ? 0 : index * CHUNK_SIZE
        let tail: Uint8Array | undefined
        while (true) {
          const { value, done } = await currentReader.read()
          if (done) break
          const start = Math.max(selected.start - offset, 0)
          const end = Math.min(selected.end - offset + 1, value.byteLength)
          offset += value.byteLength
          if (end > start) {
            if (tail) yield tail
            tail = value.subarray(start, end)
          }
        }
        // 读尽边界分片并通过完整性检查后，才发出其最后一段选中字节。
        if (tail) yield tail
        currentReader.releaseLock()
        currentReader = undefined
        disposeHandle()
      }
    } finally {
      disposeHandle()
      if (currentReader) ctx.waitUntil(currentReader.cancel().catch(() => {}))
      request.signal.removeEventListener('abort', onAbort)
    }
  }
  // 普通 JS ReadableStream 的长度未知，Workers 会忽略手写的 Content-Length。
  const output = new FixedLengthStream(length, { highWaterMark: 0 })
  const writer = output.writable.getWriter()
  ctx.waitUntil(writer.closed.catch(() => cancel()))
  ctx.waitUntil((async () => {
    try {
      for await (const value of slices()) {
        if (cancelled) throw new Error('Client disconnected')
        await writer.write(value)
        sent += value.byteLength
        // 等下游成功接受第一段后再计数，避免仅启动内部预读就把断开的客户计入下载。
        if (!counted && selected.start === 0) {
          counted = true
          ctx.waitUntil(countDownload(env.DB, id).catch(() => {}))
        }
      }
      if (sent !== length) throw new Error('Incomplete download')
      await writer.close()
      console.log(JSON.stringify({ event: 'download', file_id: id, status, bytes: sent, duration_ms: Date.now() - startTime }))
    } catch (error) {
      ctx.waitUntil(cancel())
      ctx.waitUntil(writer.abort(error).catch(() => {}))
      console.log(JSON.stringify({ event: 'download_interrupted', file_id: id, bytes: sent, duration_ms: Date.now() - startTime }))
    } finally {
      disposeHandle()
      request.signal.removeEventListener('abort', onAbort)
    }
  })())
  return new Response(output.readable, { status, headers })
}
