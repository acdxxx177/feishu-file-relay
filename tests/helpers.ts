import { readFile } from 'node:fs/promises'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { Miniflare, Response as MfResponse, convertV4MiniflareOptions } from 'miniflare'
import type { Request as MfRequest } from 'miniflare'
import { createMock } from '../mocks/feishu-mock.ts'

export const base = 'https://dl.example.test'
export const verificationToken = 'mock-verification-token'
export const encryptKey = 'mock-encrypt-key'

export async function setup(options: { cacheApi?: boolean; injectAbort?: boolean; bindings?: Record<string, string> } = {}) {
  const mock = createMock()
  const source = options.injectAbort ? {
    modules: [
      { type: 'ESModule' as const, path: '.local/test-entry.js', contents: `
        import relay from './relay.js'
        export { ChunkEntry } from './relay.js'
        export default { fetch(request, env, ctx) {
          if (request.headers.get('X-Test-Abort') === '1') {
            const controller = new AbortController()
            setTimeout(() => controller.abort(), 100)
            request = new Request(request, { signal: controller.signal })
          }
          return relay.fetch(request, env, ctx)
        } }
      ` },
      { type: 'ESModule' as const, path: '.local/relay.js', contents: await readFile('dist/index.js', 'utf8') },
    ],
  } : { modules: true as const, scriptPath: 'dist/index.js' }
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'relay',
    ...source,
    compatibilityDate: '2026-11-02',
    compatibilityFlags: ['enable_ctx_exports', 'enable_request_signal'],
    d1Databases: ['DB'],
    cacheAPI: options.cacheApi ?? true,
    unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
    ratelimits: { DOWNLOAD_LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } } },
    bindings: {
      PUBLIC_BASE_URL: base,
      FEISHU_API_BASE: 'https://mock-feishu.test',
      FEISHU_ACCOUNTS_BASE: 'https://mock-accounts.test',
      FEISHU_APP_ID: 'mock-app',
      FEISHU_APP_SECRET: 'mock-secret',
      FEISHU_VERIFICATION_TOKEN: verificationToken,
      FEISHU_ENCRYPT_KEY: encryptKey,
      ALLOWED_OPEN_IDS: 'ou_employee,ou_other,ou_admin',
      ADMIN_OPEN_IDS: 'ou_admin',
      MAX_FILE_SIZE: '1073741824',
      WEBHOOK_MAX_SKEW_SECONDS: '300',
      CHUNK_CACHE_TTL_SECONDS: '604800',
      UPSTREAM_READ_TIMEOUT_MS: '1000',
      ...options.bindings,
    },
    outboundService: async (request: MfRequest) => {
      // 每个请求都走本地 mock，测试绝不接触真实飞书或读取本地 .env。
      const response = await mock.handle(new Request(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
      }))
      return new MfResponse(response.body, { status: response.status, headers: Object.fromEntries(response.headers) })
    },
  }))
  const db = await mf.getD1Database('DB')
  const migration = await readFile('migrations/0001_init.sql', 'utf8')
  // D1 exec 单行语句解析有限；迁移每条语句单独 prepare，保持真实 SQLite 行为。
  const statements = migration.replace(/--[^\n]*/g, '').split(';').filter((sql) => sql.trim())
  await db.batch(statements.map((sql) => db.prepare(sql)))
  const request = (path: string, init?: Parameters<typeof mf.dispatchFetch>[1]) => mf.dispatchFetch(`${base}${path}`, init)
  const post = (payload: unknown, options: { encrypted?: boolean; stale?: boolean; badSignature?: boolean } = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000) - (options.stale ? 1000 : 0))
    let body = JSON.stringify(payload)
    if (options.encrypted) {
      const iv = randomBytes(16)
      const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv)
      body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(body), cipher.final()]).toString('base64') })
    }
    const nonce = 'mock-nonce'
    const signature = createHash('sha256').update(timestamp + nonce + encryptKey + body).digest('hex')
    return request('/webhook/feishu', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lark-Request-Timestamp': timestamp,
        'X-Lark-Request-Nonce': nonce,
        'X-Lark-Signature': options.badSignature ? '0'.repeat(64) : signature,
      },
      body,
    })
  }
  return { mf, db, mock, request, post }
}

export function event(messageId: string, options: { eventId?: string; sender?: string; type?: string; content?: string; chatType?: string; fileKey?: string } = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: options.eventId ?? `evt-${messageId}`,
      event_type: 'im.message.receive_v1',
      create_time: String(Date.now()),
      token: verificationToken,
      app_id: 'mock-app',
    },
    event: {
      sender: { sender_id: { open_id: options.sender ?? 'ou_employee' }, sender_type: 'user' },
      message: {
        message_id: messageId,
        chat_id: 'oc_test',
        chat_type: options.chatType ?? 'p2p',
        message_type: options.type ?? 'file',
        content: options.content ?? JSON.stringify({ file_key: options.fileKey ?? messageId, file_name: '../中文 <手册>.zip' }),
      },
    },
  }
}

export function recall(messageId: string, eventId = `recall-${messageId}`) {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.recalled_v1', create_time: String(Date.now()), token: verificationToken, app_id: 'mock-app' },
    event: { message_id: messageId, chat_id: 'oc_test', chat_type: 'p2p' },
  }
}

export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, label = '状态未达预期'): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (accept(value)) return value
    await setTimeout(25)
  }
  throw new Error(label)
}

export type Harness = Awaited<ReturnType<typeof setup>>
export async function register(h: Harness, messageId: string, size = 10000) {
  h.mock.files.set(messageId, { size })
  const response = await h.post(event(messageId))
  if (!response.ok) throw new Error(`Webhook HTTP ${response.status}: ${await response.text()}`)
  return eventually<{ id: string; status: string; file_name: string } | null>(
    () => h.db.prepare('SELECT * FROM files WHERE message_id=?').bind(messageId).first<{ id: string; status: string; file_name: string }>(),
    (value) => value?.status === 'active',
    `文件 ${messageId} 未激活`,
  ).then((value) => value!)
}

export async function digest(response: { body: AsyncIterable<Uint8Array> | null }) {
  const hash = createHash('sha256')
  let size = 0
  if (!response.body) throw new Error('缺少 body')
  for await (const chunk of response.body) { hash.update(chunk); size += chunk.length }
  return { sha256: hash.digest('hex'), size }
}
