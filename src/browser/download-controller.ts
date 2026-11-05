export const MAX_BLOB_BYTES = 20 * 1024 * 1024

export interface DownloadMetadata { id: string; name: string; size: number; status: string; etag: string; chunkSize: number; blobLimit: number }
export interface DownloadSink {
  write(position: number, bytes: Uint8Array): Promise<void>
  truncate(size: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
export type DownloadErrorCode =
  | 'badMetadata' | 'timeout' | 'missing' | 'gone' | 'versionChanged' | 'rateLimited' | 'http'
  | 'badRange' | 'overflow' | 'writeFailed' | 'incomplete' | 'rollbackFailed' | 'network'
  | 'longWait' | 'tooLarge' | 'badPosition' | 'badLength' | 'notComplete' | 'metadataFailed' | 'saveFailed'

export type TransferEvent = { type: 'retry'; seconds: number; attempt: number } | { type: 'committing' }

export class DownloadError extends Error {
  readonly code: DownloadErrorCode
  readonly httpStatus: number
  retryable: boolean
  retryAfter: number
  constructor(code: DownloadErrorCode, retryable = false, retryAfter = 0, httpStatus = 0) {
    super(code)
    this.code = code
    this.httpStatus = httpStatus
    this.retryable = retryable
    this.retryAfter = retryAfter
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function downloadChunks(metadata: DownloadMetadata, sink: DownloadSink, options: {
  signal: AbortSignal
  fetcher?: typeof fetch
  progress?: (bytes: number) => void
  status?: (event: TransferEvent) => void
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  chunkUrl?: string
}): Promise<void> {
  const { signal } = options
  try {
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || !Number.isSafeInteger(metadata.chunkSize) || metadata.chunkSize < 1 || metadata.chunkSize > 16 * 1024 * 1024) throw new DownloadError('badMetadata')
    for (let start = 0; start < metadata.size; start += metadata.chunkSize) {
      const end = Math.min(start + metadata.chunkSize, metadata.size) - 1
      const expected = end - start + 1
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        const requestAbort = new AbortController()
        const abort = () => requestAbort.abort(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = () => { timer = setTimeout(() => requestAbort.abort(new DownloadError('timeout', true)), 45_000) }
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          deadline()
          const response = await (options.fetcher ?? fetch)(options.chunkUrl ?? `/api/files/${encodeURIComponent(metadata.id)}/chunk`, {
            headers: { Range: `bytes=${start}-${end}`, 'If-Match': metadata.etag },
            cache: 'no-store', credentials: 'omit', redirect: 'error', signal: requestAbort.signal,
          })
          clearTimeout(timer)
          if (response.status !== 206) {
            void response.body?.cancel().catch(() => {})
            const codes: Partial<Record<number, DownloadErrorCode>> = { 404: 'missing', 410: 'gone', 412: 'versionChanged', 429: 'rateLimited' }
            throw new DownloadError(codes[response.status] ?? 'http', response.status === 429 || response.status >= 500, retryAfterMilliseconds(response.headers.get('Retry-After')), response.status)
          }
          if (response.headers.get('Content-Range') !== `bytes ${start}-${end}/${metadata.size}` || response.headers.get('Content-Length') !== String(expected) || response.headers.get('ETag') !== metadata.etag || !response.body || (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity')) {
            void response.body?.cancel().catch(() => {})
            throw new DownloadError('badRange')
          }
          reader = response.body.getReader()
          let received = 0
          while (true) {
            signal.throwIfAborted()
            deadline()
            const { value, done } = await reader.read()
            clearTimeout(timer)
            if (done) break
            if (received + value.byteLength > expected) throw new DownloadError('overflow')
            try { await sink.write(start + received, value) } catch { throw new DownloadError('writeFailed') }
            received += value.byteLength
            options.progress?.(start + received)
          }
          if (received !== expected) throw new DownloadError('incomplete', true)
          break
        } catch (error) {
          if (reader) void reader.cancel().catch(() => {})
          requestAbort.abort()
          signal.throwIfAborted()
          try { await sink.truncate(start) } catch { throw new DownloadError('rollbackFailed') }
          options.progress?.(start)
          const failure = error instanceof DownloadError ? error : new DownloadError('network', true)
          if (!failure.retryable || attempt >= 3) throw failure
          const delay = Math.max(failure.retryAfter, Math.floor((options.random ?? Math.random)() * 500 * 2 ** attempt))
          if (delay > 60_000) throw new DownloadError('longWait')
          options.status?.({ type: 'retry', seconds: Math.ceil(delay / 1000), attempt: attempt + 1 })
          await (options.wait ?? sleep)(delay, signal)
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          reader?.releaseLock()
        }
      }
    }
    signal.throwIfAborted()
    await sink.truncate(metadata.size)
    signal.throwIfAborted()
    options.status?.({ type: 'committing' })
    await sink.close()
  } catch (error) {
    await sink.abort().catch(() => {})
    throw error
  }
}

export function createBlobSink(size: number, limit = MAX_BLOB_BYTES): DownloadSink & { blob(): Blob } {
  if (size > Math.min(limit, MAX_BLOB_BYTES) || size < 0) throw new DownloadError('tooLarge')
  let parts: Uint8Array<ArrayBuffer>[] = []
  let length = 0
  let complete = false
  return {
    async write(position, bytes) {
      if (position !== length || position + bytes.byteLength > size) throw new DownloadError('badPosition')
      parts.push(new Uint8Array(bytes))
      length += bytes.byteLength
    },
    async truncate(target) {
      if (target > length) throw new DownloadError('badLength')
      const kept: Uint8Array<ArrayBuffer>[] = []
      let offset = 0
      for (const part of parts) {
        if (offset >= target) break
        kept.push(part.subarray(0, Math.min(part.byteLength, target - offset)))
        offset += part.byteLength
      }
      parts = kept
      length = target
    },
    async close() { if (length !== size) throw new DownloadError('incomplete'); complete = true },
    async abort() { parts = []; length = 0; complete = false },
    blob() { if (!complete) throw new DownloadError('notComplete'); return new Blob(parts, { type: 'application/octet-stream' }) },
  }
}
