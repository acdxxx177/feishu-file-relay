import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createDownloadHandlers } from '../../src/vps/download'
import { CHUNK_SIZE, ChunkService } from '../../src/vps/chunks'
import type { FileRecord } from '../../src/types'

function fixture(size = 4096, cacheEnabled = false) {
  const file: FileRecord = { id: 'A'.repeat(22), message_id: 'message', file_key: 'key', file_name: '测试.zip', file_size: size,
    mime_type: null, uploader_open_id: 'user', chat_id: 'chat', version: 1, status: 'active', fail_reason: null, delete_reason: null,
    attempts: 1, download_count: 0, last_downloaded_at: null, created_at: '2026-11-04 00:00:00', updated_at: '2026-11-04 00:00:00', deleted_at: null }
  const calls: [number, number][] = []
  let reads = 0
  let fault: 'none' | 'short' | 'long' | 'range' | 'encoding' | 'missing' = 'none'
  const repository = {
    async getFile() { reads++; return file },
    async countDownload() { file.download_count++ },
    async markUnavailable() { file.status = 'unavailable'; return true },
  }
  const handlers = createDownloadHandlers({ repository, cacheEnabled, async fetchResource(_file, start, end) {
    calls.push([start, end])
    if (fault === 'missing') return new Response(null, { status: 404 })
    const length = end - start + 1
    let offset = start
    const stop = end + (fault === 'short' ? -1 : fault === 'long' ? 1 : 0)
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset > stop) { controller.close(); return }
      const block = new Uint8Array(Math.min(65536, stop - offset + 1))
      for (let i = 0; i < block.length; i++) block[i] = ((offset + i) * 31 + Math.floor((offset + i) / 65536)) % 251
      offset += block.length
      controller.enqueue(block)
    } }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${fault === 'range' ? end + 1 : end}/${size}`, 'Content-Length': String(length), ...(fault === 'encoding' ? { 'Content-Encoding': 'gzip' } : {}) } })
  } })
  const request = (headers: Record<string, string> = {}, method = 'GET') => new Request('https://relay.test/f/' + file.id, { method, headers })
  return { file, handlers, calls, request, get reads() { return reads }, set fault(value: typeof fault) { fault = value } }
}

test('D1 gate, HEAD, page and metadata never read source; range contracts remain intact', async () => {
  const f = fixture()
  assert.equal((await f.handlers.raw(f.request({}, 'HEAD'), f.file.id)).headers.get('Content-Length'), '4096')
  assert.equal((await f.handlers.page(f.request(), f.file.id)).status, 200)
  const metadata = await (await f.handlers.page(f.request(), f.file.id, true)).json()
  assert.equal(metadata.chunkSize, CHUNK_SIZE)
  assert.equal(metadata.file_key, undefined)
  assert.equal(f.calls.length, 0)
  const one = await f.handlers.raw(f.request({ Range: 'bytes=0-0' }), f.file.id)
  assert.equal(one.status, 206)
  assert.equal((await one.arrayBuffer()).byteLength, 1)
  assert.deepEqual(f.calls, [[0, 0]])
  assert.equal((await f.handlers.raw(f.request({ Range: 'bytes=4096-' }), f.file.id)).status, 416)
  for (const headers of [{ Range: 'bytes=0-0,2-3' }, { Range: 'bytes=0-0', 'If-Range': '"wrong"' }] as Record<string, string>[]) {
    const response = await f.handlers.raw(f.request(headers), f.file.id)
    assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 4096)
  }
  f.file.status = 'deleted'
  const before = f.calls.length
  assert.equal((await f.handlers.raw(f.request(), f.file.id)).status, 410)
  assert.equal(f.calls.length, before)
  assert.equal((await f.handlers.raw(f.request(), 'bad')).status, 404)
})

test('browser preconditions, precise resumed reads and counts', async () => {
  const f = fixture()
  assert.equal((await f.handlers.chunk(f.request({ Range: 'bytes=0-1' }), f.file.id)).status, 428)
  assert.equal((await f.handlers.chunk(f.request({ Range: 'bytes=0-1', 'If-Match': 'wrong' }), f.file.id)).status, 412)
  const match = `"${f.file.id}-v1"`
  assert.equal((await f.handlers.chunk(f.request({ 'If-Match': match }), f.file.id)).status, 416)
  const response = await f.handlers.chunk(f.request({ Range: 'bytes=8-99', 'If-Match': match }), f.file.id)
  assert.equal(response.headers.get('Content-Range'), 'bytes 8-99/4096')
  assert.equal((await response.arrayBuffer()).byteLength, 92)
  assert.deepEqual(f.calls, [[8, 99]])
  assert.equal(f.file.download_count, 0)
  await (await f.handlers.chunk(f.request({ Range: 'bytes=0-9', 'If-Match': match }), f.file.id)).arrayBuffer()
  assert.equal(f.file.download_count, 1)
})

test('malformed headers fail before success; truncated and overlong bodies cannot finish', async () => {
  for (const fault of ['range', 'encoding', 'missing', 'short', 'long'] as const) {
    const f = fixture(); f.fault = fault
    const response = await f.handlers.raw(f.request(), f.file.id)
    if (fault === 'short' || fault === 'long') await assert.rejects(response.arrayBuffer())
    else assert.equal(response.status, fault === 'missing' ? 410 : 503)
    if (fault === 'missing') assert.equal(f.file.status, 'unavailable')
  }
})

test('bounded memory cache is optional, complete-only, and cannot bypass recall', async () => {
  const f = fixture(CHUNK_SIZE + 1, true)
  const headers = { Range: 'bytes=0-65535', 'If-Match': `"${f.file.id}-v1"` }
  const first = await f.handlers.chunk(f.request(headers), f.file.id)
  const expected = createHash('sha256').update(new Uint8Array(await first.arrayBuffer())).digest('hex')
  const second = await f.handlers.chunk(f.request(headers), f.file.id)
  assert.equal(second.headers.get('X-Chunk-Cache'), 'HIT')
  assert.equal(createHash('sha256').update(new Uint8Array(await second.arrayBuffer())).digest('hex'), expected)
  assert.equal(f.calls.length, 1)
  f.file.status = 'deleted'
  assert.equal((await f.handlers.chunk(f.request(headers), f.file.id)).status, 410)
  assert.equal(f.calls.length, 1)
  const small = fixture(4096, true)
  await (await small.handlers.raw(small.request(), small.file.id)).arrayBuffer()
  await (await small.handlers.raw(small.request(), small.file.id)).arrayBuffer()
  assert.equal(small.calls.length, 2)
})

test('header-wait cancellation reaches source and database failure never reaches source', async () => {
  const f = fixture()
  const controller = new AbortController()
  let cancelled = false
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const handlers = createDownloadHandlers({ repository: { async getFile() { return f.file }, async countDownload() {}, async markUnavailable() { return false } },
    fetchResource: async (_file, _start, _end, signal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')) }, { once: true }); started()
    }) })
  const pending = handlers.raw(new Request('https://relay.test', { signal: controller.signal }), f.file.id)
  await ready; controller.abort()
  assert.equal((await pending).status, 503)
  assert.equal(cancelled, true)
  const broken = createDownloadHandlers({ repository: { async getFile() { throw new Error('db down') }, async countDownload() {}, async markUnavailable() { return false } }, fetchResource: async () => { throw new Error('must not call') } })
  assert.equal((await broken.raw(f.request(), f.file.id)).status, 503)
})

test('stream read deadline and downstream cancellation abort upstream; partial cache never hits', async () => {
  const file = { id: 'T'.repeat(22), message_id: 'm', file_key: 'k', version: 1, file_size: CHUNK_SIZE + 1 }
  let aborted = 0
  let calls = 0
  const service = new ChunkService(async (_file, start, end, signal) => {
    calls++
    signal.addEventListener('abort', () => { aborted++ }, { once: true })
    return new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}) } }), {
      status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.file_size}`, 'Content-Length': String(end - start + 1) },
    })
  }, { cacheEnabled: true, readTimeoutMs: 20 })
  const timed = await service.open(file, 0, 9, new AbortController().signal)
  await assert.rejects(new Response(timed.body).arrayBuffer())
  assert.equal(aborted, 1)
  const cancelled = await service.open(file, 0, 9, new AbortController().signal)
  assert.equal(cancelled.hit, false)
  await cancelled.body.cancel()
  assert.equal(aborted, 2)
  assert.equal(calls, 2)
})

function smallCache(options: { maxCacheBytes?: number; cacheTtlMs?: number } = {}) {
  let calls = 0
  const service = new ChunkService(async (file, start, end) => {
    calls++
    return new Response(new Uint8Array(end - start + 1).fill(start), {
      status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.file_size}`, 'Content-Length': String(end - start + 1) },
    })
  }, { cacheEnabled: true, maxCacheBytes: 8, ...options })
  return {
    get calls() { return calls },
    open(id: string, start = 0, version = 1) {
      return service.open({ id, version, message_id: 'm', file_key: 'k', file_size: CHUNK_SIZE + 1 }, start, start + 3, new AbortController().signal)
    },
  }
}

async function drainChunk(chunk: { body: ReadableStream<Uint8Array> }): Promise<void> {
  assert.equal((await new Response(chunk.body).arrayBuffer()).byteLength, 4)
}

test('cache byte budget evicts completed entries and keeps only one range per file', async () => {
  const cache = smallCache()
  for (const id of ['a', 'b', 'c']) await drainChunk(await cache.open(id))
  const latest = await cache.open('c')
  assert.equal(latest.hit, true)
  await drainChunk(latest)
  const evicted = await cache.open('a')
  assert.equal(evicted.hit, false, 'three four-byte entries cannot fit an eight-byte cache')
  await evicted.body.cancel()
  const changedRange = await cache.open('c', 4)
  assert.equal(changedRange.hit, false)
  await drainChunk(changedRange)
  const oldRange = await cache.open('c', 0)
  assert.equal(oldRange.hit, false, 'a second range replaces the previous range for this file')
  await oldRange.body.cancel()
})

test('in-flight reservations consume cache budget and cancellation releases it', async () => {
  const cache = smallCache()
  const heldA = await cache.open('a')
  const heldB = await cache.open('b')
  // 两个尚未读取完成的分片已经占满缓存预算；第三个必须正常流式返回但不能缓存。
  await drainChunk(await cache.open('c'))
  const uncached = await cache.open('c')
  assert.equal(uncached.hit, false)
  await drainChunk(uncached)
  assert.equal(cache.calls, 4)
  await heldA.body.cancel()
  await drainChunk(await cache.open('c'))
  const admitted = await cache.open('c')
  assert.equal(admitted.hit, true, 'cancelled reservation must free capacity')
  await drainChunk(admitted)
  await drainChunk(heldB)
  const completedB = await cache.open('b')
  assert.equal(completedB.hit, true)
  await drainChunk(completedB)
  assert.equal(cache.calls, 5)
})

test('cache TTL and file version prevent stale hits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const cache = smallCache({ cacheTtlMs: 10 })
  await drainChunk(await cache.open('a'))
  t.mock.timers.setTime(1009)
  const warm = await cache.open('a')
  assert.equal(warm.hit, true)
  await drainChunk(warm)
  t.mock.timers.setTime(1010)
  const expired = await cache.open('a')
  assert.equal(expired.hit, false)
  await drainChunk(expired)
  const changed = await cache.open('a', 0, 2)
  assert.equal(changed.hit, false)
  await drainChunk(changed)
  assert.equal(cache.calls, 3)
})

test('evicted entries held by active cache readers remain charged until all readers release', async () => {
  const cache = smallCache({ maxCacheBytes: 4 })
  await drainChunk(await cache.open('a'))
  const slowA = await cache.open('a')
  const secondA = await cache.open('a')
  assert.equal(slowA.hit, true)
  assert.equal(secondA.hit, true)
  await drainChunk(await cache.open('b'))
  await slowA.body.cancel()
  const stillUncached = await cache.open('b')
  assert.equal(stillUncached.hit, false, 'remaining reader still retains the four-byte cache allocation')
  await drainChunk(stillUncached)
  await drainChunk(secondA)
  await drainChunk(await cache.open('b'))
  const admitted = await cache.open('b')
  assert.equal(admitted.hit, true, 'last retired-entry reader releases cache budget')
  await drainChunk(admitted)
  assert.equal(cache.calls, 4)
})
