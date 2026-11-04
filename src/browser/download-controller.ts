export interface DownloadMetadata { id: string; name: string; size: number; status: string; etag: string; chunkSize: number; blobLimit: number }
export interface DownloadSink {
  write(position: number, bytes: Uint8Array): Promise<void>
  truncate(size: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
export class DownloadError extends Error {
  retryable: boolean
  retryAfter: number
  constructor(message: string, retryable = false, retryAfter = 0) {
    super(message)
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
  status?: (message: string) => void
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  chunkUrl?: string
}): Promise<void> {
  const { signal } = options
  try {
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || !Number.isSafeInteger(metadata.chunkSize) || metadata.chunkSize < 1 || metadata.chunkSize > 16 * 1024 * 1024) throw new DownloadError('文件元数据无效。')
    for (let start = 0; start < metadata.size; start += metadata.chunkSize) {
      const end = Math.min(start + metadata.chunkSize, metadata.size) - 1
      const expected = end - start + 1
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        const requestAbort = new AbortController()
        const abort = () => requestAbort.abort(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = () => { timer = setTimeout(() => requestAbort.abort(new DownloadError('网络长时间无响应。', true)), 45_000) }
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
            const messages: Record<number, string> = { 404: '文件不存在。', 410: '文件链接已撤销或源文件已失效。', 412: '文件版本已变化，请刷新页面重新下载。', 429: '请求过于频繁。' }
            throw new DownloadError(messages[response.status] ?? `下载请求失败（${response.status}）。`, response.status === 429 || response.status >= 500, retryAfterMilliseconds(response.headers.get('Retry-After')))
          }
          if (response.headers.get('Content-Range') !== `bytes ${start}-${end}/${metadata.size}` || response.headers.get('Content-Length') !== String(expected) || response.headers.get('ETag') !== metadata.etag || !response.body || (response.headers.has('Content-Encoding') && response.headers.get('Content-Encoding') !== 'identity')) {
            void response.body?.cancel().catch(() => {})
            throw new DownloadError('服务器返回的分片范围、长度或版本不一致。')
          }
          reader = response.body.getReader()
          let received = 0
          while (true) {
            signal.throwIfAborted()
            deadline()
            const { value, done } = await reader.read()
            clearTimeout(timer)
            if (done) break
            if (received + value.byteLength > expected) throw new DownloadError('分片包含超出范围的数据。')
            try { await sink.write(start + received, value) } catch { throw new DownloadError('无法写入文件，请检查磁盘空间和写入权限。') }
            received += value.byteLength
            options.progress?.(start + received)
          }
          if (received !== expected) throw new DownloadError('分片传输不完整。', true)
          break
        } catch (error) {
          if (reader) void reader.cancel().catch(() => {})
          requestAbort.abort()
          signal.throwIfAborted()
          try { await sink.truncate(start) } catch { throw new DownloadError('无法回滚未完成分片，请重新开始下载。') }
          options.progress?.(start)
          const failure = error instanceof DownloadError ? error : new DownloadError('网络连接中断。', true)
          if (!failure.retryable || attempt >= 3) throw failure
          const delay = Math.max(failure.retryAfter, Math.floor((options.random ?? Math.random)() * 500 * 2 ** attempt))
          if (delay > 60_000) throw new DownloadError('服务要求较长等待，请稍后重新下载。')
          options.status?.(`连接中断，${Math.ceil(delay / 1000)} 秒后重试当前分片（${attempt + 1}/3）…`)
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
    options.status?.('正在提交文件…')
    await sink.close()
  } catch (error) {
    await sink.abort().catch(() => {})
    throw error
  }
}

export function createBlobSink(size: number, limit = 20 * 1024 * 1024): DownloadSink & { blob(): Blob } {
  if (size > Math.min(limit, 20 * 1024 * 1024) || size < 0) throw new DownloadError('此浏览器无法安全保存该大小的文件。请复制链接，使用支持流式保存的浏览器打开。')
  let parts: Uint8Array<ArrayBuffer>[] = []
  let length = 0
  let complete = false
  return {
    async write(position, bytes) {
      if (position !== length || position + bytes.byteLength > size) throw new DownloadError('文件写入位置不一致。')
      parts.push(new Uint8Array(bytes))
      length += bytes.byteLength
    },
    async truncate(target) {
      if (target > length) throw new DownloadError('文件长度不一致。')
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
    async close() { if (length !== size) throw new DownloadError('文件不完整。'); complete = true },
    async abort() { parts = []; length = 0; complete = false },
    blob() { if (!complete) throw new DownloadError('文件尚未完成。'); return new Blob(parts, { type: 'application/octet-stream' }) },
  }
}

interface FileWritable {
  write(data: { type: 'write'; position: number; data: Uint8Array }): Promise<void>
  truncate(size: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
type PickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileWritable> }> }

function boot(): void {
  const button = document.querySelector<HTMLButtonElement>('#download')!
  const cancel = document.querySelector<HTMLButtonElement>('#cancel')!
  const status = document.querySelector<HTMLElement>('#status')!
  const error = document.querySelector<HTMLElement>('#error')!
  const save = document.querySelector<HTMLAnchorElement>('#save')!
  const picker = (window as PickerWindow).showSaveFilePicker
  const supportsPicker = window.isSecureContext && typeof picker === 'function'
  let active: AbortController | undefined
  let blobUrl: string | undefined
  const mode = document.querySelector<HTMLElement>('#mode')!
  mode.textContent = supportsPicker ? '流式保存：逐片写入文件，全部完成后提交。' : '此浏览器仅支持 20 MiB 以内文件。更大的文件请复制链接，使用支持流式保存的浏览器（例如桌面 Chrome 或 Edge）打开。'
  const releaseBlob = () => { if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = undefined; save.hidden = true }
  cancel.addEventListener('click', () => active?.abort())
  window.addEventListener('pagehide', () => { active?.abort(); releaseBlob() })
  window.addEventListener('beforeunload', (event) => { if (active) event.preventDefault() })
  document.querySelector('#copy')!.addEventListener('click', () => {
    if (!navigator.clipboard?.writeText) { error.textContent = '此浏览器不支持复制，请从地址栏复制链接。'; return }
    void navigator.clipboard.writeText(location.href).then(() => { status.textContent = '链接已复制。' }, () => { error.textContent = '复制失败，请从地址栏复制链接。' })
  })
  button.addEventListener('click', async () => {
    if (active || button.disabled) return
    const abort = new AbortController()
    active = abort
    button.disabled = true
    cancel.disabled = false
    error.textContent = ''
    releaseBlob()
    document.querySelector<HTMLProgressElement>('#progress')!.value = 0
    document.querySelector('#amount')!.textContent = '0% · 0 字节'
    let sink: DownloadSink | undefined
    try {
      // 必须先在点击的激活上下文内打开 picker，不能先等待网络元数据。
      const handlePromise = supportsPicker ? picker!.call(window, { suggestedName: document.querySelector('#filename')!.textContent || 'download' }) : undefined
      const handle = await handlePromise
      abort.signal.throwIfAborted()
      status.textContent = '正在确认文件状态…'
      const id = location.pathname.split('/')[2]
      const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { cache: 'no-store', signal: abort.signal })
      if (!response.ok) throw new DownloadError(response.status === 410 ? '文件链接已撤销或源文件已失效。' : '无法读取文件信息，请稍后重试。')
      const metadata = await response.json() as DownloadMetadata
      let blobSink: ReturnType<typeof createBlobSink> | undefined
      if (handle) {
        const writable = await handle.createWritable()
        sink = { write: (position, bytes) => writable.write({ type: 'write', position, data: bytes }), truncate: (size) => writable.truncate(size), close: () => writable.close(), abort: () => writable.abort() }
      } else {
        blobSink = createBlobSink(metadata.size, metadata.blobLimit)
        sink = blobSink
      }
      await downloadChunks(metadata, sink, {
        signal: abort.signal,
        progress(bytes) {
          const percent = metadata.size ? bytes / metadata.size * 100 : 100
          document.querySelector<HTMLProgressElement>('#progress')!.value = percent
          document.querySelector('#amount')!.textContent = `${percent.toFixed(1)}% · ${bytes.toLocaleString('zh-CN')} / ${metadata.size.toLocaleString('zh-CN')} 字节`
          status.textContent = '正在下载，请保持页面打开…'
        },
        status(message) { status.textContent = message; if (message === '正在提交文件…') cancel.disabled = true },
      })
      if (blobSink) {
        blobUrl = URL.createObjectURL(blobSink.blob())
        save.href = blobUrl
        save.download = metadata.name
        save.hidden = false
        status.textContent = '文件已下载并验证，请点击“保存已下载文件”。浏览器将负责保存。'
      } else status.textContent = '下载完成，文件已提交到所选位置。'
      document.querySelector<HTMLProgressElement>('#progress')!.value = 100
    } catch (failure) {
      await sink?.abort().catch(() => {})
      const cancelled = abort.signal.aborted || failure instanceof DOMException && failure.name === 'AbortError'
      status.textContent = cancelled ? '下载已取消。重新下载将从头开始。' : '下载未完成，未提交文件。'
      error.textContent = cancelled ? '' : failure instanceof DownloadError ? failure.message : '无法保存文件，请检查浏览器权限后重试。'
    } finally {
      active = undefined
      button.disabled = false
      button.textContent = '重新下载'
      cancel.disabled = true
    }
  })
}

if (typeof document !== 'undefined') boot()
