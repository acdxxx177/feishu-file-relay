import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDownloadConfirmation, startDownloadSession } from '../../src/browser/download-confirmation'
import { createBlobSink, downloadChunks, type DownloadMetadata, type DownloadSink } from '../../src/browser/download-controller'

const token = 'a'.repeat(43)
const metadata: DownloadMetadata = { id: 'f'.repeat(22), name: '文件.bin', size: 8, status: 'active', etag: '"v1"', chunkSize: 4, blobLimit: 20 * 1024 * 1024, firstDownloadNotification: true }
const signal = () => new AbortController().signal

test('tracking is optional, bounded, and never puts its token in a URL', async () => {
  let calls = 0
  const fetcher: typeof fetch = async (input, init) => {
    calls++
    assert.equal(input, `/api/files/${metadata.id}/download-session`)
    assert.equal(init?.credentials, 'omit')
    assert.deepEqual(JSON.parse(String(init?.body)), { method: 'native', etag: metadata.etag })
    return Response.json({ token })
  }
  assert.equal(await startDownloadSession({ ...metadata, firstDownloadNotification: undefined }, 'native', { signal: signal(), fetcher }), undefined)
  assert.equal(calls, 0)
  assert.equal(await startDownloadSession(metadata, 'native', { signal: signal(), fetcher }), token)
  for (const response of [new Response(null, { status: 204 }), new Response(null, { status: 503 }), Response.json({ token: 'bad\nheader' })]) {
    assert.equal(await startDownloadSession(metadata, 'native', { signal: signal(), fetcher: async () => response }), undefined)
  }
  assert.equal(await startDownloadSession(metadata, 'native', { signal: signal(), fetcher: async () => { throw new Error('offline') } }), undefined)
  const abort = new AbortController()
  const pending = startDownloadSession(metadata, 'native', { signal: abort.signal, fetcher: async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }) })
  abort.abort()
  assert.equal(await pending, undefined)
})

test('browser chunks retain exact ranges and session identity across a failed-chunk retry', async () => {
  const ranges: string[] = []
  const sink = createBlobSink(8)
  await downloadChunks(metadata, sink, { signal: signal(), sessionToken: token, wait: async () => {}, fetcher: async (input, init) => {
    assert.equal(input, `/api/files/${metadata.id}/chunk`)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('X-Download-Session'), token)
    assert.equal(headers.get('If-Match'), metadata.etag)
    const range = headers.get('Range')!
    ranges.push(range)
    if (ranges.length === 2) return new Response(new Uint8Array([4, 5]), { status: 206, headers: { 'Content-Range': 'bytes 4-7/8', 'Content-Length': '4', ETag: metadata.etag } })
    const start = range === 'bytes=0-3' ? 0 : 4
    return new Response(new Uint8Array([start, start + 1, start + 2, start + 3]), { status: 206, headers: { 'Content-Range': `bytes ${start}-${start + 3}/8`, 'Content-Length': '4', ETag: metadata.etag } })
  } })
  assert.deepEqual(ranges, ['bytes=0-3', 'bytes=4-7', 'bytes=4-7'])
  assert.deepEqual(new Uint8Array(await sink.blob().arrayBuffer()), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
})

test('session creation deadline gives up tracking without blocking the download indefinitely', { timeout: 5000 }, async () => {
  let timedOut = false
  const result = await startDownloadSession(metadata, 'native', { signal: signal(), fetcher: async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { timedOut = true; reject(new Error('deadline')) }, { once: true })
  }) })
  assert.equal(result, undefined)
  assert.equal(timedOut, true)
})

test('native commit failure cannot submit a completion and report failure never aborts saved bytes', async () => {
  for (const closeFails of [true, false]) {
    let reports = 0
    let aborts = 0
    const sink: DownloadSink = { async write() {}, async truncate() {}, async close() { if (closeFails) throw new Error('disk failure') }, async abort() { aborts++ } }
    const confirmation = createDownloadConfirmation(metadata.id, token, 'native', { signal: signal(), fetcher: async () => { reports++; return new Response(null, { status: 410 }) } })
    const save = async () => {
      await downloadChunks({ ...metadata, chunkSize: 8 }, sink, { signal: signal(), fetcher: async () => new Response(new Uint8Array(8), { status: 206, headers: { 'Content-Range': 'bytes 0-7/8', 'Content-Length': '8', ETag: metadata.etag } }) })
      await confirmation.downloaded()
    }
    if (closeFails) await assert.rejects(save(), /disk failure/)
    else await save()
    assert.equal(reports, closeFails ? 0 : 1)
    assert.equal(aborts, closeFails ? 1 : 0)
  }
})

test('Blob needs verified readiness and a trusted save click; repeated clicks share one report', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const confirmation = createDownloadConfirmation(metadata.id, token, 'blob', { signal: signal(), fetcher: async (_input, init) => {
    calls++
    assert.deepEqual(JSON.parse(String(init?.body)), { method: 'blob' })
    await gate
    return new Response(null, { status: 204 })
  } })
  await confirmation.save({ isTrusted: true })
  await confirmation.downloaded()
  await confirmation.save({ isTrusted: false })
  assert.equal(calls, 0)
  const first = confirmation.save({ isTrusted: true })
  const second = confirmation.save({ isTrusted: true })
  assert.equal(first, second)
  release()
  await first
  await confirmation.save({ isTrusted: true })
  assert.equal(calls, 1)
})

test('completion retries preserve method/token and respect server retry hints', async () => {
  let calls = 0
  let now = 0
  const delays: number[] = []
  const confirmation = createDownloadConfirmation(metadata.id, token, 'native', { signal: signal(), now: () => now,
    wait: async delay => { delays.push(delay); now += delay },
    fetcher: async (input, init) => {
      assert.equal(input, `/api/files/${metadata.id}/download-complete`)
      assert.equal(new Headers(init?.headers).get('X-Download-Session'), token)
      assert.deepEqual(JSON.parse(String(init?.body)), { method: 'native' })
      calls++
      if (calls === 1) throw new Error('ack lost')
      if (calls === 2) return new Response(null, { status: 409 })
      if (calls === 3) return new Response(null, { status: 429, headers: { 'Retry-After': '120' } })
      return new Response(null, { status: 204 })
    },
  })
  await confirmation.downloaded()
  assert.deepEqual(delays, [2000, 10_000, 120_000])
  assert.equal(calls, 4)
})

test('completion retry stops at ten minutes, permanent failures, and page lifetime abort', async () => {
  let now = 0
  let calls = 0
  await createDownloadConfirmation(metadata.id, token, 'native', { signal: signal(), now: () => now,
    wait: async delay => { now += delay }, fetcher: async () => { calls++; return new Response(null, { status: 503 }) },
  }).downloaded()
  assert.ok(now < 600_000)
  assert.equal(calls, 12)
  for (const status of [400, 403, 404, 410, 412]) {
    let attempts = 0
    await createDownloadConfirmation(metadata.id, token, 'native', { signal: signal(), fetcher: async () => { attempts++; return new Response(null, { status }) } }).downloaded()
    assert.equal(attempts, 1)
  }
  const page = new AbortController()
  let attempts = 0
  await createDownloadConfirmation(metadata.id, token, 'native', { signal: page.signal,
    fetcher: async () => { attempts++; return new Response(null, { status: 503 }) },
    wait: async () => { page.abort(); throw new Error('page hidden') },
  }).downloaded()
  assert.equal(attempts, 1)
})
