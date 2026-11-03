import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers'
import { fetchResource, UpstreamError } from '../services/feishu'
import type { BackgroundContext, SourceFile } from '../types'

export const CHUNK_SIZE = 16 * 1024 * 1024

// 只共享完成信号，不跨请求共享 Response/ReadableStream，避免 Workers 的 I/O 所有权错误。
const inFlight = new Map<string, Promise<void>>()

async function readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, abort: AbortController, milliseconds: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (abort.signal.aborted) throw abort.signal.reason
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort!: () => void
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Upstream read timeout')), milliseconds)
    onAbort = () => reject(abort.signal.reason)
    abort.signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([reader.read(), deadline]) }
  finally {
    if (timer !== undefined) clearTimeout(timer)
    abort.signal.removeEventListener('abort', onAbort)
  }
}

export function checkedBody(response: Response, start: number, end: number, total: number, abort: AbortController, ctx: BackgroundContext, idleMilliseconds = 30_000): ReadableStream<Uint8Array> {
  const expected = end - start + 1
  const range = response.headers.get('Content-Range')
  const length = response.headers.get('Content-Length')
  const encoding = response.headers.get('Content-Encoding')
  if (response.status !== 206 || range !== `bytes ${start}-${end}/${total}` ||
    (length !== null && length !== String(expected)) || (encoding && encoding !== 'identity') || !response.body) {
    abort.abort()
    if (response.body) ctx.waitUntil(response.body.cancel().catch(() => {}))
    throw new Error('Invalid upstream range')
  }
  const reader = response.body.getReader()
  let received = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await readWithDeadline(reader, abort, idleMilliseconds)
        if (done) {
          if (received !== expected) throw new Error('Truncated upstream range')
          controller.close()
          return
        }
        received += value.byteLength
        if (received > expected) throw new Error('Oversized upstream range')
        // 保留最后一段直至确认 EOF；不能让客户端在完整性检查前收到声明的全部长度。
        if (received === expected) {
          const extra = await readWithDeadline(reader, abort, idleMilliseconds)
          if (!extra.done) throw new Error('Oversized upstream range')
          controller.enqueue(value)
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        // 先把错误交给客户端；上游取消确认可能因半开连接迟迟不返回。
        controller.error(error)
        abort.abort()
        ctx.waitUntil(reader.cancel().catch(() => {}))
      }
    },
    cancel(reason) {
      abort.abort()
      ctx.waitUntil(reader.cancel(reason).catch(() => {}))
    },
  }, { highWaterMark: 0 })
}

function cacheKey(env: Env, file: SourceFile, index: number): string {
  return new URL(`/chunks/${file.id}/v${file.version}/${index}`, env.PUBLIC_BASE_URL).href
}

async function openCached(key: string, expected: number): Promise<Response | undefined> {
  // Cache API 故障只降低命中率，不能阻断仍然可读的飞书源文件。
  const marker = await caches.default.match(`${key}/complete`).catch(() => undefined)
  if (!marker) return undefined
  const generation = marker.headers.get('X-Chunk-Generation')
  const verifiedLength = marker.headers.get('X-Chunk-Length')
  await marker.body?.cancel().catch(() => {})
  if (marker.status !== 200 || !generation || verifiedLength !== String(expected)) return undefined
  const cached = await caches.default.match(key).catch(() => undefined)
  if (!cached) return undefined
  if (cached.status === 200 && cached.headers.get('Content-Length') === String(expected) && cached.headers.get('X-Chunk-Generation') === generation) {
    return new Response(cached.body, { headers: { 'Content-Length': String(expected), 'X-Chunk-Cache': 'HIT' } })
  }
  await cached.body?.cancel()
  await caches.default.delete(key).catch(() => false)
  return undefined
}

function cacheWhileSending(source: ReadableStream<Uint8Array>, key: string, expected: number, ttl: number, ctx: BackgroundContext): { body: ReadableStream<Uint8Array>; complete: Promise<void> } {
  // Workers 会移除未知长度流上手写的 Content-Length，必须使用原生定长流。
  const outgoing = new FixedLengthStream(expected)
  const cached = new FixedLengthStream(expected)
  const output = outgoing.writable.getWriter()
  const cacheWriter = cached.writable.getWriter()
  const reader = source.getReader()
  const generation = crypto.randomUUID()
  let cacheFailed = false
  const put = caches.default.put(key, new Response(cached.readable, {
    headers: { 'Content-Length': String(expected), 'Cache-Control': `public, max-age=${ttl}`, 'Content-Type': 'application/octet-stream', 'X-Chunk-Generation': generation },
  })).catch(async () => {
    cacheFailed = true
    await cacheWriter.abort(new Error('Cache unavailable')).catch(() => {})
  })
  const complete = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        // 双分支都施加背压，慢客户端不会让 tee 的另一个分支把整片积存在内存中。
        await Promise.all([
          output.write(value),
          cacheFailed ? Promise.resolve() : cacheWriter.write(value).catch(() => { cacheFailed = true }),
        ])
      }
      await Promise.all([output.close(), cacheFailed ? Promise.resolve() : cacheWriter.close().catch(() => { cacheFailed = true })])
      await put
      if (!cacheFailed) {
        // 原生定长流被取消时，平台可能留下声明长度正确的残片；只有完整结束才发布匹配的完成标记。
        // 随机代次防止旧标记与后续未完成的同键写入组合，误把残片当成有效缓存。
        await caches.default.put(`${key}/complete`, new Response(null, { headers: {
          'Cache-Control': `public, max-age=${ttl}`,
          'X-Chunk-Generation': generation,
          'X-Chunk-Length': String(expected),
        } })).catch(() => {})
      }
    } catch (error) {
      await Promise.allSettled([reader.cancel(error), output.abort(error), cacheWriter.abort(error)])
      await put
      await caches.default.delete(key).catch(() => false)
      throw error
    }
  })()
  ctx.waitUntil(complete.catch(() => {}))
  return { body: outgoing.readable, complete }
}

async function waitForChunk(running: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { await Promise.race([running, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

async function getChunk(env: Env, ctx: BackgroundContext, file: SourceFile, index: number, abort: AbortController): Promise<Response> {
  if (abort.signal.aborted) throw abort.signal.reason
  const start = index * CHUNK_SIZE
  const end = Math.min(start + CHUNK_SIZE, file.file_size) - 1
  if (!Number.isSafeInteger(index) || index < 0 || start > end) return new Response(null, { status: 416 })
  const key = cacheKey(env, file, index)
  const expected = end - start + 1
  const hit = await openCached(key, expected)
  if (hit) {
    console.log(JSON.stringify({ event: 'chunk', file_id: file.id, index, cache: 'HIT', origin_calls: 0, bytes: expected }))
    return hit
  }
  const running = inFlight.get(key)
  if (running) {
    await waitForChunk(running, abort.signal)
    const coalesced = await openCached(key, expected)
    if (coalesced) return coalesced
  }
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  inFlight.set(key, finished)
  const clear = () => {
    if (inFlight.get(key) === finished) inFlight.delete(key)
    finish()
  }
  try {
    const response = await fetchResource(env, file, start, end, abort.signal)
    const body = checkedBody(response, start, end, file.file_size, abort, ctx, Number(env.UPSTREAM_READ_TIMEOUT_MS) || 30_000)
    const ttl = Number(env.CHUNK_CACHE_TTL_SECONDS) || 604800
    const sending = cacheWhileSending(body, key, expected, ttl, ctx)
    ctx.waitUntil(sending.complete.then(clear, clear))
    console.log(JSON.stringify({ event: 'chunk', file_id: file.id, index, cache: 'MISS', origin_calls: 1, bytes: expected }))
    return new Response(sending.body, { headers: { 'Content-Length': String(expected), 'X-Chunk-Cache': 'MISS' } })
  } catch (error) {
    clear()
    return new Response(null, { status: error instanceof UpstreamError && error.permanent ? 410 : 503 })
  }
}

export class ChunkRequest extends RpcTarget {
  #env: Env
  #ctx: BackgroundContext
  #file: SourceFile
  #index: number
  #abort = new AbortController()
  #started = false

  constructor(env: Env, ctx: BackgroundContext, file: SourceFile, index: number) {
    super()
    this.#env = env
    this.#ctx = ctx
    this.#file = file
    this.#index = index
  }

  response(): Promise<Response> {
    if (this.#started) throw new Error('Chunk response already consumed')
    this.#started = true
    return getChunk(this.#env, this.#ctx, this.#file, this.#index, this.#abort)
  }

  cancel(): void { this.#abort.abort(new Error('Client disconnected')) }

  [Symbol.dispose](): void { this.cancel() }
}

export class ChunkEntry extends WorkerEntrypoint<Env> {
  openChunk(file: SourceFile, index: number): ChunkRequest {
    // 先返回可取消的能力句柄，再开始回源；等待响应头时也能立即取消。
    return new ChunkRequest(this.env, this.ctx, file, index)
  }
}
