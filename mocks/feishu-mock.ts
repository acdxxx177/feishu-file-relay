import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { patternBytesAt, patternStream } from './file-pattern.ts'

export type MockMode = 'ok' | 'throttle' | 'missing' | 'forbidden' | 'bad-range' | 'truncate' | 'oversize' | 'ignore-range'
export interface MockFile { size: number; mode?: MockMode; mimeType?: string; headerDelayMs?: number; readDelayMs?: number }

export function bytesAt(start: number, length: number): Buffer {
  return Buffer.from(patternBytesAt(start, length))
}

export function byteStream(start: number, length: number): ReadableStream<Uint8Array> {
  return patternStream(start, length)
}

export function createMock() {
  const files = new Map<string, MockFile>()
  const replies: Array<Record<string, unknown>> = []
  const ranges: Array<{ key: string; range: string | null }> = []
  const abortedRanges: string[] = []
  let tokenCalls = 0
  let replyFailures = 0
  let tokenFailures = 0
  const requestUuids = new Set<string>()
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/oauth/v3/token') {
      tokenCalls++
      if (tokenFailures-- > 0) return Response.json({ error: 'server_error' }, { status: 503 })
      const body = await request.json() as Record<string, unknown>
      if (body.grant_type !== 'client_credentials' || !body.client_id || !body.client_secret) {
        return Response.json({ error: 'invalid_client' }, { status: 400 })
      }
      return Response.json({ access_token: 'mock-tenant-access-token', expires_in: 7200, token_type: 'Bearer' })
    }
    if (request.headers.get('Authorization') !== 'Bearer mock-tenant-access-token') {
      return Response.json({ code: 99991663 }, { status: 401 })
    }
    const resource = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/.exec(url.pathname)
    if (resource) {
      const key = decodeURIComponent(resource[2])
      const file = files.get(key)
      const range = request.headers.get('range')
      ranges.push({ key, range })
      if (!file || file.mode === 'missing') return new Response(null, { status: 404 })
      if (file.mode === 'forbidden') return new Response(null, { status: 403 })
      if (file.mode === 'throttle') return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
      if (!match) return new Response(null, { status: 400 })
      const start = Number(match[1])
      const end = Math.min(Number(match[2]), file.size - 1)
      if (start > end) return new Response(null, { status: 416 })
      const length = end - start + 1
      if (file.headerDelayMs) await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer)
          abortedRanges.push(key)
          reject(new Error('模拟源站观察到请求取消'))
        }
        const timer = setTimeout(() => {
          request.signal.removeEventListener('abort', onAbort)
          resolve()
        }, file.headerDelayMs)
        request.signal.addEventListener('abort', onAbort, { once: true })
        if (request.signal.aborted) onAbort()
      })
      const headers: Record<string, string> = {
        'Content-Type': file.mimeType ?? 'application/octet-stream',
        'Content-Range': `bytes ${file.mode === 'bad-range' ? start + 1 : start}-${end}/${file.size}`,
        'Content-Length': String(length),
      }
      // 超长体用分块传输：HTTP桥接层会按Content-Length截断，多余字节必须让Worker实际可见。
      if (file.mode === 'oversize') delete headers['Content-Length']
      if (file.mode === 'ignore-range') return new Response(byteStream(0, file.size), { status: 200 })
      const actual = file.mode === 'truncate' ? Math.max(0, length - 1) : file.mode === 'oversize' ? length + 1 : length
      if (file.mode === 'truncate') {
        const partial = byteStream(start, actual).getReader()
        const broken = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await partial.read()
            if (done) controller.error(new Error('模拟源站在 Content-Length 之前断开'))
            else controller.enqueue(value)
          },
          cancel(reason) { return partial.cancel(reason) },
        })
        return new Response(broken, { status: 206, headers })
      }
      let body = byteStream(start, actual)
      if (file.readDelayMs) {
        const source = body.getReader()
        body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, file.readDelayMs))
            const { value, done } = await source.read()
            if (done) controller.close()
            else controller.enqueue(value)
          },
          cancel: (reason) => source.cancel(reason),
        }, { highWaterMark: 0 })
      }
      return new Response(body, { status: 206, headers })
    }
    if (/\/open-apis\/im\/v1\/messages(?:\/[^/]+\/reply)?$/.test(url.pathname)) {
      if (replyFailures-- > 0) return Response.json({ code: 1 }, { status: 503 })
      const body = await request.json() as Record<string, unknown>
      const uuid = typeof body.uuid === 'string' ? body.uuid : ''
      if (!uuid || !requestUuids.has(uuid)) replies.push(body)
      if (uuid) requestUuids.add(uuid)
      return Response.json({ code: 0, data: { message_id: `reply-${replies.length}` } })
    }
    return new Response(null, { status: 404 })
  }
  return {
    files, replies, ranges, abortedRanges, handle,
    get tokenCalls() { return tokenCalls },
    failReplies(count: number) { replyFailures = count },
    failTokens(count: number) { tokenFailures = count },
  }
}

export async function startMock(port = 8790) {
  const mock = createMock()
  mock.files.set('file-demo', { size: 100 * 1024 * 1024 })
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      })
      const response = await mock.handle(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) {
        const source = Readable.from(response.body)
        res.on('close', () => source.destroy())
        source.on('error', () => res.destroy())
        source.pipe(res)
      } else res.end()
    } catch { res.destroy() }
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return { ...mock, server }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/feishu-mock.ts') && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMock()
  console.log('模拟飞书已启动：http://127.0.0.1:8790；file-demo 为 100 MiB 可重复数据')
}
