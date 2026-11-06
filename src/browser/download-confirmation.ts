import { retryAfterMilliseconds, type DownloadMetadata } from './download-controller.ts'

export type SaveMethod = 'native' | 'blob'
type FetchOptions = { signal: AbortSignal; fetcher?: typeof fetch }
type ConfirmationOptions = FetchOptions & {
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function requestSignal(signal: AbortSignal, milliseconds: number) {
  const deadline = new AbortController()
  const abort = () => deadline.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() => deadline.abort(), milliseconds)
  return { signal: deadline.signal, clear() { clearTimeout(timer); signal.removeEventListener('abort', abort) } }
}

export async function startDownloadSession(metadata: DownloadMetadata, method: SaveMethod, options: FetchOptions): Promise<string | undefined> {
  if (metadata.firstDownloadNotification !== true || options.signal.aborted) return
  const deadline = requestSignal(options.signal, 2000)
  try {
    const response = await (options.fetcher ?? fetch)(`/api/files/${encodeURIComponent(metadata.id)}/download-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, etag: metadata.etag }),
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: deadline.signal,
    })
    if (!response.ok || response.status === 204) { void response.body?.cancel().catch(() => {}); return }
    const result: unknown = await response.json()
    if (result && typeof result === 'object' && 'token' in result && typeof result.token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(result.token)) return result.token
  } catch {
    // 跟踪不可用时继续原有下载；会话创建失败不能变成文件保存失败。
  } finally { deadline.clear() }
}

async function reportCompletion(id: string, token: string, method: SaveMethod, options: ConfirmationOptions): Promise<void> {
  const now = options.now ?? Date.now
  const expires = now() + 10 * 60_000
  for (let attempt = 0; !options.signal.aborted && now() < expires; attempt++) {
    let retryAfter = 0
    const deadline = requestSignal(options.signal, Math.min(8000, expires - now()))
    try {
      const response = await (options.fetcher ?? fetch)(`/api/files/${encodeURIComponent(id)}/download-complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Download-Session': token },
        body: JSON.stringify({ method }), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: deadline.signal,
      })
      void response.body?.cancel().catch(() => {})
      if (response.status === 204) return
      if (response.status !== 409 && response.status !== 429 && response.status < 500) return
      retryAfter = retryAfterMilliseconds(response.headers.get('Retry-After'), now())
    } catch {
      if (options.signal.aborted) return
    } finally { deadline.clear() }
    const delay = Math.max([2000, 10_000, 60_000][Math.min(attempt, 2)], retryAfter)
    if (delay >= expires - now()) return
    await (options.wait ?? wait)(delay, options.signal)
  }
}

export function createDownloadConfirmation(id: string, token: string, method: SaveMethod, options: ConfirmationOptions) {
  let complete = false
  let reporting: Promise<void> | undefined
  const report = () => reporting ??= reportCompletion(id, token, method, options).catch(() => {})
  return {
    downloaded(): Promise<void> {
      complete = true
      return method === 'native' ? report() : Promise.resolve()
    },
    save(event: Pick<Event, 'isTrusted'>): Promise<void> {
      // Blob 的完整接收不等于保存；只在已就绪链接的真实点击后报告，且重复点击共用一次确认。
      return complete && method === 'blob' && event.isTrusted ? report() : Promise.resolve()
    },
  }
}
