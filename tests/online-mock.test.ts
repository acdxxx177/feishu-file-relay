import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import { Miniflare, Response as MfResponse, convertV4MiniflareOptions } from 'miniflare'
import { patternBytesAt } from '../mocks/file-pattern.ts'
import { bytesAt } from '../mocks/feishu-mock.ts'
import { event, eventually, verificationToken, encryptKey } from './helpers.ts'

async function createHarness() {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'private-feishu-mock',
    modules: true,
    scriptPath: 'dist/mock/feishu-mock-worker.js',
    compatibilityDate: '2026-11-02',
    compatibilityFlags: ['enable_request_signal'],
    d1Databases: ['DB'],
    bindings: { FEISHU_APP_ID: 'fake-online-app', FEISHU_APP_SECRET: 'fake-online-secret' },
    outboundService: () => { throw new Error('Mock Worker must never call the public internet') },
  }))
  const db = await mf.getD1Database('DB')
  const migration = await readFile('testing-migrations/0001_mock.sql', 'utf8')
  await db.batch(migration.split(';').filter((sql) => sql.trim()).map((sql) => db.prepare(sql)))
  const call = (path: string, init?: Parameters<typeof mf.dispatchFetch>[1]) => mf.dispatchFetch(`https://mock-feishu.invalid${path}`, init)
  const token = await mf.dispatchFetch('https://mock-accounts.invalid/oauth/v3/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'fake-online-app', client_secret: 'fake-online-secret' }),
  })
  assert.equal(token.status, 200)
  const tokenBody = await token.json() as { access_token: string }
  return { mf, db, call, headers: { Authorization: `Bearer ${tokenBody.access_token}` } }
}

test('纯Web生成器保留本地数据格式且跨块偏移正确', () => {
  const whole = patternBytesAt(0, 2 * 65536 + 100)
  assert.deepEqual(patternBytesAt(65530, 33), whole.subarray(65530, 65563))
  assert.deepEqual(Buffer.from(whole), bytesAt(0, whole.length))
  assert.notDeepEqual(patternBytesAt(0, 16), patternBytesAt(16 * 1024 * 1024, 16))
})

test('模拟传输配置缺失必须失败，真实默认路径不变', { timeout: 60000 }, async (t) => {
  const transport = stripTypeScriptTypes(await readFile('src/services/transport.ts', 'utf8'))
  let networkCalls = 0
  let privateCalls = 0
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: '.local/test-transport.js', contents: `
        import { feishuFetch } from './transport.js'
        export default { async fetch(request, env) {
          const name = new URL(request.url).pathname
          const config = { FEISHU_API_BASE: 'https://mock-feishu.invalid', FEISHU_ACCOUNTS_BASE: 'https://mock-accounts.invalid', FEISHU_TRANSPORT: 'mock' }
          if (name !== '/missing-binding') config.FEISHU_MOCK = env.PRIVATE
          if (name === '/wrong-config') config.FEISHU_API_BASE = 'https://open.feishu.cn'
          if (name === '/unsupported') config.FEISHU_TRANSPORT = 'unexpected'
          if (name === '/missing-mode') delete config.FEISHU_TRANSPORT
          if (name === '/real') {
            delete config.FEISHU_TRANSPORT
            delete config.FEISHU_MOCK
            config.FEISHU_API_BASE = 'https://open.feishu.cn'
            config.FEISHU_ACCOUNTS_BASE = 'https://accounts.feishu.cn'
          }
          const target = name === '/wrong-origin' ? 'https://open.feishu.cn/open-apis/test' : 'https://mock-feishu.invalid/open-apis/test'
          try { return await feishuFetch(config, new URL(target), {}) }
          catch { return new Response(null, {status:503}) }
        } }
      ` },
      { type: 'ESModule', path: '.local/transport.js', contents: transport },
    ],
    compatibilityDate: '2026-11-02',
    serviceBindings: { PRIVATE: () => { privateCalls++; return new MfResponse('private') } },
    outboundService: () => { networkCalls++; return new MfResponse('network') },
  }))
  t.after(() => mf.dispose())
  for (const path of ['/missing-binding', '/missing-mode', '/wrong-config', '/wrong-origin', '/unsupported']) assert.equal((await mf.dispatchFetch(`https://gateway.invalid${path}`)).status, 503)
  assert.equal(networkCalls, 0)
  assert.equal(privateCalls, 0)
  assert.equal(await (await mf.dispatchFetch('https://gateway.invalid/mock')).text(), 'private')
  assert.equal(privateCalls, 1)
  assert.equal(networkCalls, 0)
  assert.equal(await (await mf.dispatchFetch('https://gateway.invalid/real')).text(), 'network')
  assert.equal(networkCalls, 1)
})

test('私有飞书模拟器验证凭据/配对、精确Range、动态失败和持久化回复', { timeout: 60000 }, async (t) => {
  const h = await createHarness()
  t.after(() => h.mf.dispose())
  const badToken = await h.mf.dispatchFetch('https://mock-accounts.invalid/oauth/v3/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'fake-online-app', client_secret: 'wrong' }),
  })
  assert.equal(badToken.status, 401)
  await h.db.prepare('INSERT INTO mock_files(message_id,file_key,file_size) VALUES(?,?,?)').bind('om_test', 'file_test', 131072).run()
  const path = '/open-apis/im/v1/messages/om_test/resources/file_test?type=file'
  assert.equal((await h.call(path)).status, 401)
  assert.equal((await h.call(path.replace('om_test', 'om_wrong'), { headers: { ...h.headers, Range: 'bytes=0-0' } })).status, 404)
  const response = await h.call(path, { headers: { ...h.headers, Range: 'bytes=65530-65600' } })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 65530-65600/131072')
  assert.equal(response.headers.get('content-length'), '71')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesAt(65530, 71))
  await h.db.prepare("UPDATE mock_files SET mode='throttle' WHERE message_id='om_test'").run()
  assert.equal((await h.call(path, { headers: { ...h.headers, Range: 'bytes=0-0' } })).status, 429)
  await h.db.prepare("UPDATE mock_files SET mode='missing' WHERE message_id='om_test'").run()
  assert.equal((await h.call(path, { headers: { ...h.headers, Range: 'bytes=0-0' } })).status, 404)
  const content = JSON.stringify({ text: '公开测试链接 https://download.invalid/f/abcdefghijklmnopqrstuv' })
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await h.call('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST', headers: { ...h.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: 'a'.repeat(32), msg_type: 'text', receive_id: 'oc_fake', content }),
    })
    assert.equal(reply.status, 200)
  }
  const replies = await h.db.prepare('SELECT content FROM mock_replies').all<{ content: string }>()
  assert.deepEqual(replies.results, [{ content }])
  const requests = await h.db.prepare('SELECT status,range_header FROM mock_requests ORDER BY id').all<{ status: number; range_header: string }>()
  assert.deepEqual(requests.results.map((row: { status: number }) => row.status), [404, 206, 429, 404])
  assert.equal(requests.results[1].range_header, 'bytes=65530-65600')
})

test('真实服务绑定串联签名Webhook、D1、模拟机器人回复与公开下载', { timeout: 60000 }, async (t) => {
  const noNetwork = () => { throw new Error('Online test transport must not access the public internet') }
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    {
      name: 'online-gateway', modules: true, scriptPath: 'dist/index.js',
      compatibilityDate: '2026-11-02', compatibilityFlags: ['enable_ctx_exports', 'enable_request_signal'],
      d1Databases: { DB: 'online-binding-test' },
      serviceBindings: { FEISHU_MOCK: 'private-mock' },
      ratelimits: { DOWNLOAD_LIMITER: { namespace_id: '1011', simple: { limit: 60, period: 60 } } },
      bindings: {
        FEISHU_TRANSPORT: 'mock', FEISHU_API_BASE: 'https://mock-feishu.invalid', FEISHU_ACCOUNTS_BASE: 'https://mock-accounts.invalid',
        PUBLIC_BASE_URL: 'https://binding-test.invalid', FEISHU_APP_ID: 'mock-app', FEISHU_APP_SECRET: 'fake-secret',
        FEISHU_VERIFICATION_TOKEN: verificationToken, FEISHU_ENCRYPT_KEY: encryptKey,
        ALLOWED_OPEN_IDS: 'ou_employee', ADMIN_OPEN_IDS: '', MAX_FILE_SIZE: '104857600',
        WEBHOOK_MAX_SKEW_SECONDS: '300', CHUNK_CACHE_TTL_SECONDS: '604800', UPSTREAM_READ_TIMEOUT_MS: '1000',
      },
      outboundService: noNetwork,
    },
    {
      name: 'private-mock', modules: true, scriptPath: 'dist/mock/feishu-mock-worker.js',
      compatibilityDate: '2026-11-02', compatibilityFlags: ['enable_request_signal'],
      d1Databases: { DB: 'online-binding-test' },
      bindings: { FEISHU_APP_ID: 'mock-app', FEISHU_APP_SECRET: 'fake-secret' },
      outboundService: noNetwork,
    },
  ] }))
  t.after(() => mf.dispose())
  const db = await mf.getD1Database('DB', 'online-gateway')
  for (const path of ['migrations/0001_init.sql', 'testing-migrations/0001_mock.sql']) {
    const sql = await readFile(path, 'utf8')
    await db.batch(sql.replace(/--[^\n]*/g, '').split(';').filter((statement) => statement.trim()).map((statement) => db.prepare(statement)))
  }
  await db.prepare('INSERT INTO mock_files(message_id,file_key,file_size) VALUES(?,?,?)').bind('om_binding', 'file_binding', 10000).run()
  const body = JSON.stringify(event('om_binding', { fileKey: 'file_binding' }))
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = 'mock-binding-nonce'
  const signature = createHash('sha256').update(timestamp + nonce + encryptKey + body).digest('hex')
  const callback = await mf.dispatchFetch('https://binding-test.invalid/webhook/feishu', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Lark-Request-Timestamp': timestamp, 'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': signature },
  })
  assert.equal(callback.status, 200)
  const reply = await eventually<{ content: string } | null>(() => db.prepare('SELECT content FROM mock_replies LIMIT 1').first<{ content: string }>(), (value) => typeof value?.content === 'string')
  const link = /https:\/\/binding-test\.invalid\/f\/[A-Za-z0-9]{22}/.exec(reply!.content)?.[0]
  assert.ok(link, '必须从模拟机器人回复而非文件索引取得链接')
  const response = await mf.dispatchFetch(link)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesAt(0, 10000))
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM mock_requests').first<{ n: number }>())?.n, 2)
})
