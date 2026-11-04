import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createMock } from '../../mocks/feishu-mock'
import { readConfig, type Config } from '../../src/vps/config'
import { createFeishuClient } from '../../src/vps/feishu'
import { startServer } from '../../src/vps/server'
import { databaseFixture } from './database-fixture'

const token = 'fake-verification'
const encryptKey = 'fake-encryption-key'
const config = (extra: Partial<Config> = {}): Config => ({ ...readConfig({
  FEISHU_APP_ID: 'mock-app', FEISHU_APP_SECRET: 'mock-secret', FEISHU_VERIFICATION_TOKEN: token,
  FEISHU_ENCRYPT_KEY: encryptKey, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'fake',
  PORT: '0', JOB_POLL_MS: '1000', SHUTDOWN_TIMEOUT_MS: '1000', DOWNLOAD_RATE_LIMIT: '1000',
}), ...extra })

function event(messageId: string, options: { sender?: string; chatType?: string; text?: string; appId?: string } = {}) {
  return { schema: '2.0', header: { event_id: `event-${messageId}`, event_type: 'im.message.receive_v1', create_time: String(Date.now()), token, app_id: options.appId ?? 'mock-app' },
    event: { sender: { sender_type: 'user', sender_id: { open_id: options.sender ?? 'owner' } },
      message: { message_id: messageId, chat_id: 'chat', chat_type: options.chatType ?? 'p2p', message_type: options.text ? 'text' : 'file',
        content: JSON.stringify(options.text ? { text: options.text } : { file_key: messageId, file_name: '../测试.zip' }) } } }
}
function recall(messageId: string) { return { schema: '2.0', header: { event_id: `recall-${messageId}`, event_type: 'im.message.recalled_v1', create_time: String(Date.now()), token, app_id: 'mock-app' }, event: { message_id: messageId } } }

async function eventually(read: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index++) { if (await read()) return; await delay(20) }
  assert.fail('Timed out waiting for persisted state')
}

async function harness(overrides: Partial<Config> = {}, prepare?: (f: ReturnType<typeof databaseFixture>, mock: ReturnType<typeof createMock>) => Promise<void>) {
  const f = databaseFixture()
  const mock = createMock()
  const settings = config(overrides)
  if (prepare) await prepare(f, mock)
  const feishu = createFeishuClient(settings, (input, init) => mock.handle(new Request(input, init)))
  const runtime = startServer(settings, f.repository, feishu)
  if (!runtime.server.listening) await once(runtime.server, 'listening')
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const request = (path: string, init?: RequestInit) => fetch(base + path, init)
  async function post(payload: unknown, options: { encrypted?: boolean; badSignature?: boolean; stale?: boolean } = {}) {
    let body = JSON.stringify(payload)
    if (options.encrypted) {
      const iv = randomBytes(16)
      const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv)
      body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(body), cipher.final()]).toString('base64') })
    }
    const timestamp = String(Math.floor(Date.now() / 1000) - (options.stale ? 1000 : 0))
    const nonce = 'nonce'
    const signature = createHash('sha256').update(timestamp + nonce + encryptKey + body).digest('hex')
    return request('/webhook/feishu', { method: 'POST', body, headers: { 'Content-Type': 'application/json',
      'X-Lark-Request-Timestamp': timestamp, 'X-Lark-Request-Nonce': nonce,
      'X-Lark-Signature': options.badSignature ? '0'.repeat(64) : signature } })
  }
  const row = (messageId: string) => f.db.prepare('SELECT * FROM files WHERE message_id=?').get(messageId) as { id: string; status: string; download_count: number } | undefined
  async function register(messageId: string, size = 10000) {
    mock.files.set(messageId, { size })
    assert.equal((await post(event(messageId), { encrypted: true })).status, 200)
    await eventually(() => row(messageId)?.status === 'active')
    return row(messageId)!
  }
  return { ...f, mock, runtime, request, post, row, register, close: async () => { await runtime.close(); f.db.close() } }
}

test('Node HTTP verifies encrypted callbacks, signature, token, app and replay before persistence', async () => {
  const h = await harness()
  try {
    assert.equal((await h.request('/health')).status, 200)
    assert.equal((await h.request('/ready')).status, 200)
    const challenge = await h.post({ type: 'url_verification', token, challenge: 'challenge' }, { encrypted: true })
    assert.equal(challenge.status, 200)
    assert.deepEqual(await challenge.json(), { challenge: 'challenge' })
    assert.equal((await h.post(event('bad'), { badSignature: true })).status, 401)
    assert.equal((await h.post(event('old'), { stale: true })).status, 401)
    assert.equal((await h.post(event('app', { appId: 'other' }))).status, 401)
    const wrongToken = event('token'); wrongToken.header.token = 'wrong'
    assert.equal((await h.post(wrongToken)).status, 401)
    assert.equal((h.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n, 0)
    h.setPrimary(false)
    // readiness 短缓存不应改变每次文件授权的主库检查。
    assert.equal((await h.request('/f/' + 'A'.repeat(22), { method: 'HEAD' })).status, 503)
  } finally { await h.close() }
})

test('readiness burst coalesces health I/O, caches failure and denies non-loopback callers', async () => {
  const h = await harness()
  try {
    h.runtime.application.scheduler.stop()
    await h.runtime.application.scheduler.drain()
    h.setPrimary(false)
    const before = h.calls()
    const responses = await Promise.all(Array.from({ length: 20 }, () => h.request('/ready')))
    assert.ok(responses.every((response) => response.status === 503))
    assert.equal(h.calls() - before, 1)
    const external = await h.runtime.application.app.request('/ready', {}, { incoming: { socket: { remoteAddress: '203.0.113.1' } } } as never)
    assert.equal(external.status, 404)
    assert.equal(h.calls() - before, 1)
  } finally { await h.close() }
})

test('Node HTTP platform intake publishes once, counts downloads, lists and enforces uploader-only revoke', async () => {
  const h = await harness()
  try {
    const file = await h.register('file')
    await eventually(() => h.mock.replies.length === 1)
    assert.equal((await h.post(event('file'))).status, 200)
    await delay(100)
    assert.equal(h.mock.replies.length, 1)
    const sourceBefore = h.mock.ranges.length
    assert.equal((await h.request(`/f/${file.id}`, { method: 'HEAD' })).status, 200)
    assert.equal(h.mock.ranges.length, sourceBefore)
    const download = await h.request(`/f/${file.id}/download`)
    assert.equal(download.status, 200)
    assert.equal((await download.arrayBuffer()).byteLength, 10000)
    await eventually(() => h.row('file')?.download_count === 1)
    await h.post(event('list', { text: '我的链接' }))
    await eventually(() => h.mock.replies.some((reply) => JSON.stringify(reply).includes(file.id) && JSON.stringify(reply).includes('下载 1 次')))
    await h.post(event('denied', { sender: 'other', text: `撤销 ${file.id}` }))
    await eventually(() => h.mock.replies.some((reply) => JSON.stringify(reply).includes('无权撤销')))
    assert.equal(h.row('file')?.status, 'active')
    await h.post(event('revoke', { text: `撤销 ${file.id}` }))
    await eventually(() => h.row('file')?.status === 'deleted')
    const before = h.mock.ranges.length
    assert.equal((await h.request(`/f/${file.id}/download`)).status, 410)
    assert.equal((await h.request(`/f/${file.id}`, { method: 'HEAD' })).status, 410)
    assert.equal(h.mock.ranges.length, before)
  } finally { await h.close() }
})

test('recall tombstone, group restriction and allowlist denial survive Node migration', async () => {
  const h = await harness({ FEISHU_INTAKE_POLICY: 'allowlist', ALLOWED_OPEN_IDS: 'owner' })
  try {
    await h.post(recall('early'))
    await h.post(event('early'))
    await h.post(event('group', { chatType: 'group' }))
    await h.post(event('denied', { sender: 'other' }))
    assert.equal((h.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n, 0)
    const file = await h.register('allowed')
    await h.post(recall('allowed'))
    assert.equal(h.row('allowed')?.status, 'deleted')
    assert.equal((await h.request(`/api/files/${file.id}`)).status, 410)
  } finally { await h.close() }
})

test('scheduler recovers persisted pending work at startup without another callback', async () => {
  const h = await harness({}, async (f, mock) => {
    mock.files.set('recovery', { size: 100 })
    await f.repository.registerFile('recovery-event', { id: 'R'.repeat(22), message_id: 'recovery', file_key: 'recovery', file_name: 'file.zip', uploader_open_id: 'owner', chat_id: 'chat' })
  })
  try {
    await eventually(() => h.row('recovery')?.status === 'active')
    await eventually(() => h.mock.replies.length === 1)
    assert.equal(h.mock.ranges[0].range, 'bytes=0-0')
  } finally { await h.close() }
})

test('actual socket disconnect cancels upstream before headers and frees download admission', async () => {
  const h = await harness({ maxDownloads: 1 })
  try {
    const file = await h.register('cancel')
    h.mock.files.set('cancel', { size: 10000, headerDelayMs: 3000 })
    const controller = new AbortController()
    const pending = h.request(`/f/${file.id}/download`, { signal: controller.signal }).catch(() => undefined)
    await eventually(() => h.mock.ranges.length >= 2)
    controller.abort()
    await pending
    await eventually(() => h.mock.abortedRanges.includes('cancel'))
    await eventually(() => h.runtime.application.activeDownloads === 0)
  } finally { await h.close() }
})

test('shutdown stops admission and aborts an outstanding upstream at the drain deadline', async () => {
  const h = await harness({ shutdownMs: 50 })
  try {
    const file = await h.register('shutdown')
    h.mock.files.set('shutdown', { size: 10000, headerDelayMs: 3000 })
    const pending = h.request(`/f/${file.id}/download`).catch(() => undefined)
    await eventually(() => h.mock.ranges.length >= 2)
    const started = Date.now()
    const closing = h.runtime.close()
    assert.equal((await h.runtime.application.app.request('/ready')).status, 503)
    assert.equal((await h.runtime.application.app.request('/webhook/feishu', { method: 'POST', body: '{}' })).status, 503)
    await closing
    await pending
    await eventually(() => h.mock.abortedRanges.includes('shutdown'))
    assert.ok(Date.now() - started < 2000)
  } finally { await h.close() }
})

test('configuration rejects placeholder secrets, invalid policy and untrusted insecure origins', () => {
  assert.throws(() => readConfig({}), /Missing configuration/)
  const base = { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_VERIFICATION_TOKEN: 'token', FEISHU_ENCRYPT_KEY: 'key',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'token' }
  assert.throws(() => readConfig({ ...base, FEISHU_INTAKE_POLICY: 'unknown' }), /policy/)
  assert.throws(() => readConfig({ ...base, FEISHU_APP_SECRET: 'replace-me' }), /Missing configuration/)
  assert.throws(() => readConfig({ ...base, FEISHU_API_BASE: 'http://example.com' }), /origin/)
  assert.throws(() => readConfig({ ...base, FEISHU_TRANSPORT: 'mock' }), /test-injected/)
})
