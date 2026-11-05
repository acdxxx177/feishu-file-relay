import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { setup, register, recall, eventually, digest } from './helpers.ts'
import { createHash } from 'node:crypto'
import { bytesAt } from '../mocks/feishu-mock.ts'
import { createBlobSink, downloadChunks, DownloadError, retryAfterMilliseconds, type DownloadMetadata } from '../src/browser/download-controller.ts'

test('下载页无回源/统计，公开元数据安全，分片精确读取和撤回门禁', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const file = await register(h, 'page-file', 20 * 1024 * 1024)
  const calls = h.mock.ranges.length
  const page = await h.request(`/f/${file.id}`, { headers: { 'Accept-Language': 'fr, es-ES;q=0.8' } })
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type')!, /text\/html/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/)
  const html = await page.text()
  assert.match(html, /<html lang="es">/)
  assert.ok(html.includes('&lt;手册&gt;'))
  for (const secret of ['file_key', 'message_id', 'mock-tenant-access-token', 'mock-secret']) assert.ok(!html.includes(secret))
  const metadata = await (await h.request(`/api/files/${file.id}`)).json() as DownloadMetadata
  assert.deepEqual(Object.keys(metadata).sort(), ['blobLimit', 'chunkSize', 'etag', 'id', 'name', 'size', 'status'])
  assert.equal(h.mock.ranges.length, calls)
  assert.equal((await h.db.prepare('SELECT download_count FROM files WHERE id=?').bind(file.id).first<{ download_count: number }>())?.download_count, 0)
  const path = `/api/files/${file.id}/chunk`
  const headers = { 'If-Match': metadata.etag, Range: 'bytes=13-65550' }
  const chunkHead = await h.request(path, { method: 'HEAD', headers })
  assert.equal(chunkHead.status, 206)
  assert.equal(h.mock.ranges.length, calls)
  for (const range of ['', 'bytes=0-16777216', 'bytes=0-1,3-4', 'bytes=20971520-', 'invalid']) {
    const response = await h.request(path, { headers: { ...headers, Range: range } })
    assert.equal(response.status, 416, range)
    await response.body?.cancel()
  }
  assert.equal((await h.request(path, { headers: { Range: 'bytes=0-1' } })).status, 428)
  assert.equal((await h.request(path, { headers: { ...headers, 'If-Match': '"old"' } })).status, 412)
  const first = await h.request(path, { headers })
  assert.equal(first.status, 206)
  assert.equal(first.headers.get('content-range'), `bytes 13-65550/${metadata.size}`)
  const expected = createHash('sha256').update(bytesAt(13, 65538)).digest('hex')
  assert.deepEqual(await digest(first), { size: 65538, sha256: expected })
  assert.equal(h.mock.ranges.at(-1)?.range, 'bytes=13-65550')
  const repeat = await h.request(path, { headers })
  assert.equal(repeat.headers.get('x-chunk-cache'), 'HIT')
  assert.equal((await digest(repeat)).sha256, expected)
  await h.post(recall('page-file'))
  for (const route of [`/f/${file.id}`, `/api/files/${file.id}`, path]) {
    const response = await h.request(route, { headers: { ...headers, 'Accept-Language': 'hi-IN' } })
    assert.equal(response.status, 410)
    if (route.startsWith('/f/')) {
      const gone = await response.text()
      assert.match(gone, /<html lang="hi">/)
      assert.match(gone, /data-text="gone"/)
    } else await response.body?.cancel()
  }
  assert.equal((await h.request('/api/files/invalid')).status, 404)
})

test('Worker rate-limited file page returns localized HTML, HEAD and raw keep empty bodies', async (t) => {
  const h = await setup({ downloadRateLimit: 1 })
  t.after(() => h.mf.dispose())
  const headers = { 'CF-Connecting-IP': '192.0.2.4', 'Accept-Language': 'hi' }
  const path = '/f/invalid'
  const missing = await h.request(path, { headers })
  assert.equal(missing.status, 404)
  assert.match(await missing.text(), /data-text="missing"/)
  const limited = await h.request(path, { headers })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  assert.match(limited.headers.get('content-security-policy')!, /script-src 'self'/)
  const html = await limited.text()
  assert.match(html, /<html lang="hi">/)
  assert.match(html, /data-text="rateLimited"/)
  for (const [route, method] of [[path, 'HEAD'], [path + '/download', 'GET'], ['/api/files/invalid', 'GET']]) {
    const binary = await h.request(route, { method, headers })
    assert.equal(binary.status, 429)
    assert.equal(await binary.text(), '')
  }
  assert.equal(h.mock.ranges.length, 0)
})

test('分片故障拒绝、缓存关闭、首尾范围与版本变化', { timeout: 90000 }, async (t) => {
  const h = await setup({ bindings: { BROWSER_CHUNK_CACHE_ENABLED: 'false', BROWSER_CHUNK_SIZE: '1048576' } })
  t.after(() => h.mf.dispose())
  const file = await register(h, 'fault-chunk', 1024 * 1024 + 3)
  const metadata = await (await h.request(`/api/files/${file.id}`)).json() as DownloadMetadata
  assert.equal(metadata.chunkSize, 1048576)
  const path = `/api/files/${file.id}/chunk`
  for (const [start, end] of [[0, 0], [1048576, 1048578]]) {
    const response = await h.request(path, { headers: { 'If-Match': metadata.etag, Range: `bytes=${start}-${end}` } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('x-chunk-cache'), 'BYPASS')
    assert.equal((await digest(response)).size, end - start + 1)
  }
  for (const mode of ['bad-range', 'truncate', 'oversize', 'ignore-range', 'throttle'] as const) {
    h.mock.files.set('fault-chunk', { size: metadata.size, mode })
    const response = await h.request(path, { headers: { 'If-Match': metadata.etag, Range: 'bytes=0-999' } })
    if (response.status === 206) await assert.rejects(() => digest(response))
    else assert.equal(response.status, 503)
  }
  await h.db.prepare('UPDATE files SET version=2 WHERE id=?').bind(file.id).run()
  assert.equal((await h.request(path, { headers: { 'If-Match': metadata.etag, Range: 'bytes=0-1' } })).status, 412)
  await h.db.prepare("UPDATE files SET status='unavailable' WHERE id=?").bind(file.id).run()
  assert.equal((await h.request(path, { headers: { 'If-Match': metadata.etag, Range: 'bytes=0-1' } })).status, 410)
})

function metadata(size = 10): DownloadMetadata { return { id: 'a'.repeat(22), name: 'test.bin', size, status: 'active', etag: '"v1"', chunkSize: 4, blobLimit: 20 * 1024 * 1024 } }
function response(start: number, end: number, size: number, actual = end - start + 1): Response {
  return new Response(Uint8Array.from({ length: actual }, (_, index) => start + index), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), ETag: '"v1"' } })
}

test('模拟浏览器控制器：短体回滚、只重试失败分片且无重复字节', async () => {
  const sink = createBlobSink(10)
  const requests: string[] = []
  let failed = false
  await downloadChunks(metadata(), sink, { signal: new AbortController().signal, wait: async () => {}, fetcher: async (_input, init) => {
    const range = new Headers(init?.headers).get('Range')!
    requests.push(range)
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!
    const start = Number(a), end = Number(b)
    if (start === 4 && !failed) { failed = true; return response(start, end, 10, 2) }
    return response(start, end, 10)
  } })
  assert.deepEqual(requests, ['bytes=0-3', 'bytes=4-7', 'bytes=4-7', 'bytes=8-9'])
  assert.deepEqual(new Uint8Array(await sink.blob().arrayBuffer()), Uint8Array.from({ length: 10 }, (_, index) => index))
})

test('模拟浏览器控制器：Retry-After、永久错误、超长体、取消和 Blob 上限', async () => {
  assert.equal(retryAfterMilliseconds('2'), 2000)
  assert.equal(retryAfterMilliseconds(new Date(10000).toUTCString(), 1000), 9000)
  assert.throws(() => createBlobSink(20 * 1024 * 1024 + 1))
  let attempts = 0
  const waits: number[] = []
  const sink = createBlobSink(4)
  await downloadChunks(metadata(4), sink, { signal: new AbortController().signal, random: () => 0, wait: async (ms) => { waits.push(ms) }, fetcher: async () => ++attempts === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } }) : response(0, 3, 4) })
  assert.deepEqual(waits, [2000])
  for (const code of [404, 410, 412]) {
    let calls = 0
    const target = createBlobSink(4)
    await assert.rejects(() => downloadChunks(metadata(4), target, { signal: new AbortController().signal, fetcher: async () => { calls++; return new Response(null, { status: code }) } }))
    assert.equal(calls, 1)
    assert.throws(() => target.blob())
  }
  let failures = 0
  await assert.rejects(() => downloadChunks(metadata(4), createBlobSink(4), { signal: new AbortController().signal, wait: async () => {}, fetcher: async () => { failures++; throw new TypeError('network') } }))
  assert.equal(failures, 4)
  await assert.rejects(() => downloadChunks(metadata(4), createBlobSink(4), { signal: new AbortController().signal, fetcher: async () => response(0, 3, 4, 5) }))
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(() => downloadChunks(metadata(4), createBlobSink(4), { signal: abort.signal, fetcher: async () => { throw new Error('must not fetch') } }))
})

test('最终截断等待期间取消不得提交文件', async () => {
  const controller = new AbortController()
  let closed = false
  let aborted = false
  await assert.rejects(() => downloadChunks(metadata(0), {
    async write() {},
    async truncate() { controller.abort() },
    async close() { closed = true },
    async abort() { aborted = true },
  }, { signal: controller.signal }))
  assert.equal(closed, false)
  assert.equal(aborted, true)
})

test('每片重新查 D1：中途撤回终止组装，D1 故障不读热缓存', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const file = await register(h, 'between-chunks', 2 * 1024 * 1024)
  const metadata = await (await h.request(`/api/files/${file.id}`)).json() as DownloadMetadata
  metadata.chunkSize = 1024 * 1024
  const sink = createBlobSink(metadata.size)
  let calls = 0
  await assert.rejects(() => downloadChunks(metadata, sink, {
    signal: new AbortController().signal,
    fetcher: async (_input, init) => {
      if (++calls === 2) await h.post(recall('between-chunks'))
      const response = await h.request(`/api/files/${file.id}/chunk`, { headers: Object.fromEntries(new Headers(init?.headers)) })
      const reader = response.body!.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) { const { done, value } = await reader.read(); if (done) controller.close(); else controller.enqueue(value) },
        cancel: () => reader.cancel(),
      })
      return new Response(body, { status: response.status, headers: Object.fromEntries(response.headers) })
    },
  }), (error) => error instanceof DownloadError && error.code === 'gone')
  assert.equal(calls, 2)
  assert.throws(() => sink.blob())
  const before = h.mock.ranges.length
  // 仅删除测试实例中的索引表以注入 D1 读故障，不涉及真实数据库。
  await h.db.prepare('DROP TABLE files').run()
  const page = await h.request(`/f/${file.id}`, { headers: { 'Accept-Language': 'es' } })
  assert.equal(page.status, 503)
  assert.equal(page.headers.get('retry-after'), '10')
  assert.match(await page.text(), /<html lang="es">/)
  const response = await h.request(`/api/files/${file.id}/chunk`, { headers: { 'If-Match': metadata.etag, Range: 'bytes=0-1048575' } })
  assert.equal(response.status, 503)
  assert.equal(h.mock.ranges.length, before)
})

test('新分片入口注入响应头前取消，及时返回且不重试或计数', { timeout: 60000 }, async (t) => {
  const h = await setup({ injectAbort: true })
  t.after(() => h.mf.dispose())
  const file = await register(h, 'browser-abort', 1024 * 1024)
  const metadata = await (await h.request(`/api/files/${file.id}`)).json() as DownloadMetadata
  h.mock.files.get('browser-abort')!.headerDelayMs = 2000
  const calls = h.mock.ranges.length
  const started = Date.now()
  const response = await h.request(`/api/files/${file.id}/chunk`, { headers: { 'X-Test-Abort': '1', 'If-Match': metadata.etag, Range: 'bytes=0-1048575' } })
  assert.equal(response.status, 503)
  assert.ok(Date.now() - started < 1500)
  // Miniflare 的 Node outbound 桥接无法可靠观察源请求断开；这里只证明运行时取消和不重试。
  await delay(2300)
  assert.equal(h.mock.ranges.length, calls + 1)
  assert.equal((await h.db.prepare('SELECT download_count FROM files WHERE id=?').bind(file.id).first<{ download_count: number }>())?.download_count, 0)
})

test('BYOB 聚合期限内供数不足则失败，恢复后不能命中未完成缓存', { timeout: 60000 }, async (t) => {
  const h = await setup({ bindings: { UPSTREAM_READ_TIMEOUT_MS: '100' } })
  t.after(() => h.mf.dispose())
  const file = await register(h, 'slow-window', 1024 * 1024)
  const metadata = await (await h.request(`/api/files/${file.id}`)).json() as DownloadMetadata
  h.mock.files.get('slow-window')!.readDelayMs = 60
  const path = `/api/files/${file.id}/chunk`
  const headers = { 'If-Match': metadata.etag, Range: 'bytes=0-1048575' }
  const slow = await h.request(path, { headers })
  assert.equal(slow.status, 206)
  await assert.rejects(() => digest(slow))
  h.mock.files.get('slow-window')!.readDelayMs = 0
  const restored = await h.request(path, { headers })
  assert.equal(restored.headers.get('x-chunk-cache'), 'MISS')
  assert.equal((await digest(restored)).size, 1048576)
})

test('BYOB 缓冲边界、慢消费、截断/超长与取消后重新读取保持精确字节', { timeout: 90000 }, async (t) => {
  const h = await setup({ bindings: { BROWSER_CHUNK_CACHE_ENABLED: 'false', UPSTREAM_READ_TIMEOUT_MS: '1000' } })
  t.after(() => h.mf.dispose())
  const file = await register(h, 'buffer-boundaries', 4 * 1024 * 1024)
  const metadata = await (await h.request(`/api/files/${file.id}`)).json() as DownloadMetadata
  const path = `/api/files/${file.id}/chunk`
  const read = (length: number) => h.request(path, { headers: { 'If-Match': metadata.etag, Range: `bytes=13-${12 + length}` } })
  for (const length of [131071, 131072, 131073, 262145, 1048577]) {
    const received = await read(length)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const value of received.body!) {
      await delay(2)
      hash.update(value)
      bytes += value.length
    }
    assert.equal(bytes, length)
    assert.equal(hash.digest('hex'), createHash('sha256').update(bytesAt(13, length)).digest('hex'))
  }
  for (const mode of ['truncate', 'oversize'] as const) {
    h.mock.files.get('buffer-boundaries')!.mode = mode
    await assert.rejects(() => read(1048577).then(digest))
  }
  h.mock.files.get('buffer-boundaries')!.mode = 'ok'
  const cancelled = await read(3 * 1024 * 1024)
  const reader = cancelled.body!.getReader()
  assert.equal((await reader.read()).done, false)
  await reader.cancel()
  assert.deepEqual(await digest(await read(1048577)), { size: 1048577, sha256: createHash('sha256').update(bytesAt(13, 1048577)).digest('hex') })
})
