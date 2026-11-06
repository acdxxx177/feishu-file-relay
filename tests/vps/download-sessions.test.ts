import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApplication } from '../../src/vps/app'
import { readConfig } from '../../src/vps/config'
import { DownloadSessions } from '../../src/vps/download-sessions'
import { CHUNK_SIZE } from '../../src/vps/chunks'
import { databaseFixture } from './database-fixture'
import type { FeishuClient } from '../../src/vps/feishu'

const origin = 'https://relay.invalid'
const id = 'S'.repeat(22)
type Fault = 'none' | 'short' | 'long' | 'error'
const base = { FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_VERIFICATION_TOKEN: 'fake', FEISHU_ENCRYPT_KEY: 'fake',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'fake',
  PUBLIC_BASE_URL: origin, FIRST_DOWNLOAD_NOTIFICATION_ENABLED: 'true', DOWNLOAD_RATE_LIMIT: '10000' }

async function harness(size = 64, eligible = 1, extra: NodeJS.ProcessEnv = {}) {
  const f = databaseFixture()
  await f.repository.registerFile('registered', { id, message_id: 'source', file_key: 'key', file_name: '测试 <file>.zip', uploader_open_id: 'owner', chat_id: 'original-chat', first_download_notification: eligible })
  await f.repository.finishValidation((await f.repository.claimPending(id))!, size, null, `${origin}/f/${id}`)
  let fault: Fault = 'none'
  let sourceReads = 0
  const feishu: FeishuClient = {
    async fetchResource(_file, start, end) {
      sourceReads++
      const failure = fault
      let offset = start
      const limit = end + 1 + (failure === 'short' ? -1 : failure === 'long' ? 1 : 0)
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (failure === 'error') { controller.error(new Error('source failure')); return }
        if (offset >= limit) { controller.close(); return }
        const bytes = new Uint8Array(Math.min(65536, limit - offset)).fill(42)
        offset += bytes.length; controller.enqueue(bytes)
      } }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } })
    },
    async sendCard() { throw new Error('No external delivery') }, async updateCard() {}, async sendText() {}, close() {},
  }
  const config = readConfig({ ...base, ...extra })
  const app = createApplication(config, f.repository, feishu)
  app.scheduler.stop()
  const request = (path: string, init: RequestInit = {}, remote = '127.0.0.1') => app.app.request(origin + path, init,
    { incoming: { socket: { remoteAddress: remote } } } as never)
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const start = async (method = 'native') => {
    const result = await post(`/api/files/${id}/download-session`, { method, etag: `"${id}-v1"` })
    assert.equal(result.status, 200)
    return (await result.json()).token as string
  }
  const complete = (token: string, method = 'native', headers: Record<string, string> = {}) =>
    post(`/api/files/${id}/download-complete`, { method }, { 'X-Download-Session': token, ...headers })
  const chunk = (token: string, start = 0, end = Math.min(size, start + CHUNK_SIZE) - 1, extraHeaders: Record<string, string> = {}) => request(`/api/files/${id}/chunk`, {
    headers: { Range: `bytes=${start}-${end}`, 'If-Match': `"${id}-v1"`, 'X-Download-Session': token, ...extraHeaders },
  })
  const jobs = () => f.db.prepare("SELECT * FROM bot_jobs WHERE id LIKE 'first-download:%'").all()
  return { ...f, config, request, post, start, complete, chunk, jobs, get sourceReads() { return sourceReads }, setFault(value: Fault) { fault = value },
    async close() { await f.repository.close(); f.db.close() } }
}

test('only verified browser completion creates one durable event; raw, metadata, HEAD and prefetch do not', async t => {
  const h = await harness(); t.after(() => h.close())
  const metadata = await (await h.request(`/api/files/${id}`)).json()
  assert.equal(metadata.firstDownloadNotification, true)
  await (await h.request(`/f/${id}`)).text()
  for (const path of [`/f/${id}`, `/f/${id}/download`, `/api/files/${id}/chunk`]) await h.request(path, { method: 'HEAD' })
  assert.equal(h.sourceReads, 0)
  const token = await h.start()
  assert.equal((await h.complete(token)).status, 409)
  for (const headers of [{}, { Range: 'bytes=0-0' }, { Range: 'bytes=20-' }, { Range: 'bytes=0-63' }, { Range: 'bytes=20-', 'If-Range': 'wrong' }] as Record<string, string>[]) {
    await (await h.request(`/f/${id}/download`, { headers: { ...headers, 'X-Download-Session': token } })).arrayBuffer()
  }
  await (await h.chunk(token, 0, 63, { 'Sec-Purpose': 'prefetch' })).arrayBuffer()
  assert.equal((await h.complete(token)).status, 409)
  assert.equal(h.jobs().length, 0)
  await (await h.chunk(token)).arrayBuffer()
  const replies = await Promise.all(Array.from({ length: 8 }, () => h.complete(token)))
  assert.ok(replies.every(reply => reply.status === 204))
  assert.equal(h.jobs().length, 1)
  const job = h.jobs()[0]
  assert.equal(job.chat_id, 'original-chat')
  assert.equal(job.uploader_open_id, 'owner')
  assert.ok(String(job.argument).includes('测试 <file>.zip'))
  assert.ok(!String(job.argument).includes(token))
})

test('missing, out-of-order and separate-session chunks cannot combine; retried full coverage can complete', async t => {
  const h = await harness(CHUNK_SIZE + 64); t.after(() => h.close())
  const a = await h.start(), b = await h.start()
  await (await h.chunk(a, CHUNK_SIZE)).arrayBuffer()
  await (await h.chunk(a, 0)).arrayBuffer()
  await (await h.chunk(a, 0)).arrayBuffer()
  await (await h.chunk(b, CHUNK_SIZE)).arrayBuffer()
  assert.equal((await h.complete(a)).status, 409)
  assert.equal((await h.complete(b)).status, 409)
  await (await h.chunk(a, CHUNK_SIZE)).arrayBuffer()
  assert.equal((await h.complete(a)).status, 204)
  assert.equal(h.jobs().length, 1)
})

test('truncated, overlong, failed and canceled streams do not advance completion; retry preserves download functionality', async t => {
  const h = await harness(CHUNK_SIZE + 64); t.after(() => h.close())
  const token = await h.start()
  for (const fault of ['short', 'long', 'error'] as const) {
    h.setFault(fault)
    const result = await h.chunk(token)
    if (result.status === 206) await assert.rejects(result.arrayBuffer())
    assert.equal((await h.complete(token)).status, 409)
  }
  h.setFault('none')
  const result = await h.chunk(token)
  const reader = result.body!.getReader()
  await reader.read(); await reader.cancel()
  assert.equal((await h.complete(token)).status, 409)
  await (await h.chunk(token)).arrayBuffer()
  await (await h.chunk(token, CHUNK_SIZE)).arrayBuffer()
  assert.equal((await h.complete(token)).status, 204)
})

test('origin, intent, body, method, version and token bindings fail closed without source reads', async t => {
  const h = await harness(); t.after(() => h.close())
  const path = `/api/files/${id}/download-session`
  const body = { method: 'native', etag: `"${id}-v1"` }
  for (const headers of [{ Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { 'Sec-Purpose': 'prefetch;prerender' }, { Purpose: 'prefetch' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await h.post(path, body, headers)).status, 403)
  }
  assert.equal((await h.post(path, { ...body, etag: 'old' })).status, 412)
  assert.equal((await h.post(path, { ...body, padding: 'x'.repeat(1100) })).status, 400)
  assert.equal((await h.post(path, body, { 'Content-Type': 'text/plain' })).status, 400)
  const token = await h.start('blob')
  await (await h.chunk(token)).arrayBuffer()
  assert.equal((await h.complete(token, 'native')).status, 400)
  assert.equal((await h.complete('invented', 'blob')).status, 410)
  assert.equal((await h.post(`/api/files/${'Z'.repeat(22)}/download-complete`, { method: 'blob' }, { 'X-Download-Session': token })).status, 410)
  assert.equal(h.jobs().length, 0)
  h.db.prepare('UPDATE files SET version=2 WHERE id=?').run(id)
  assert.equal((await h.complete(token, 'blob')).status, 410)
})

test('legacy files and disabled feature remain downloadable with no notification capability', async t => {
  for (const [eligible, extra] of [[0, {}], [1, { FIRST_DOWNLOAD_NOTIFICATION_ENABLED: 'false' }]] as const) {
    const h = await harness(64, eligible, extra); t.after(() => h.close())
    assert.equal((await (await h.request(`/api/files/${id}`)).json()).firstDownloadNotification, undefined)
    assert.equal((await h.post(`/api/files/${id}/download-session`, { method: 'native', etag: `"${id}-v1"` })).status, 204)
    await (await h.chunk('none')).arrayBuffer()
    assert.equal(h.jobs().length, 0)
  }
})

test('recall before persistence suppresses notification even with cached bytes; ambiguous committed confirmation is idempotent', async t => {
  const h = await harness(64); t.after(() => h.close())
  const token = await h.start()
  await (await h.chunk(token)).arrayBuffer()
  h.loseReply()
  assert.equal((await h.complete(token)).status, 503)
  const stored = h.jobs()[0].argument
  h.loseReply(false)
  await h.repository.recallFile('recall', 'source')
  assert.equal((await h.complete(token)).status, 204)
  assert.equal(h.jobs().length, 1)
  assert.equal(h.jobs()[0].argument, stored)
  const other = await harness(CHUNK_SIZE + 64, 1, { CHUNK_CACHE_ENABLED: 'true' }); t.after(() => other.close())
  const next = await other.start()
  await (await other.chunk(next)).arrayBuffer()
  await (await other.chunk(next, CHUNK_SIZE)).arrayBuffer()
  await other.repository.recallFile('before-complete', 'source')
  assert.equal((await other.complete(next)).status, 410)
  assert.equal((await other.chunk(next)).status, 410)
  assert.equal(other.jobs().length, 0)
})

test('session capacity, lifetime and process restart affect tracking only; frozen confirmation survives local retries', async t => {
  const h = await harness(); t.after(() => h.close())
  let now = Date.parse('2026-11-06T02:00:00Z')
  const sessions = new DownloadSessions({ enabled: true, origin, repository: h.repository, wake() {}, now: () => now, capacity: 1, ttlMs: 1000 })
  const request = () => new Request(origin, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'native', etag: `"${id}-v1"` }) })
  const token = (await (await sessions.start(request(), id)).json()).token as string
  assert.equal((await sessions.start(request(), id)).status, 204)
  const completeRequest = () => new Request(origin, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Download-Session': token }, body: '{"method":"native"}' })
  const file = (await h.repository.getFile(id))!
  sessions.observe(new Request(origin, { headers: { 'X-Download-Session': token } }), file, 0, 63)!()
  const original = h.repository.recordFirstDownload.bind(h.repository)
  let fail = true
  h.repository.recordFirstDownload = (...args) => fail ? Promise.reject(new Error('offline')) : original(...args)
  assert.equal((await sessions.complete(completeRequest(), id, { country: 'CN', city: '上海' })).status, 503)
  fail = false; now += 100
  assert.equal((await sessions.complete(completeRequest(), id, { country: 'US' })).status, 204)
  const stored = String(h.jobs()[0].argument)
  assert.ok(stored.includes('2026-11-06T02:00:00.000Z'))
  assert.ok(stored.includes('上海'))
  assert.ok(!stored.includes('US'))
  const restarted = new DownloadSessions({ enabled: true, origin, repository: h.repository, wake() {} })
  assert.equal((await restarted.complete(completeRequest(), id, {})).status, 410)
  now += 1000
  assert.equal((await sessions.complete(completeRequest(), id, {})).status, 410)
  assert.equal((await sessions.start(request(), id)).status, 200)
})
