import { feishuFetch } from './transport'

interface CachedToken {
  accessToken: string
  refreshAt: number
}

const memory = new Map<string, CachedToken>()
const refreshing = new Map<string, Promise<CachedToken>>()

export async function readSmallText(response: Response, maxBytes = 64 * 1024): Promise<string> {
  if (!response.body) throw new Error('Missing JSON body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new Error('JSON body too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const all = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all)
}

export async function readSmallJson(response: Response, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const data: unknown = JSON.parse(await readSmallText(response, maxBytes))
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid JSON object')
  return data as Record<string, unknown>
}

async function cacheKey(env: Env): Promise<string> {
  // 使用配置摘要隔离应用及密钥轮换；缓存键不包含凭证原文，也没有公网路由。
  const bytes = new TextEncoder().encode(`${env.FEISHU_ACCOUNTS_BASE}\0${env.FEISHU_APP_ID}\0${env.FEISHU_APP_SECRET}`)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const key = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('')
  return new URL(`/__internal/token/${key}`, env.PUBLIC_BASE_URL).href
}

export async function getToken(env: Env, force = false): Promise<string> {
  const key = await cacheKey(env)
  if (force) memory.delete(key)
  const cached = memory.get(key)
  if (!force && cached && cached.refreshAt > Date.now()) return cached.accessToken
  const inflight = refreshing.get(key)
  if (inflight) return (await inflight).accessToken
  const promise = loadToken(env, key, force)
  refreshing.set(key, promise)
  try {
    const token = await promise
    memory.set(key, token)
    return token.accessToken
  } finally {
    refreshing.delete(key)
  }
}

async function loadToken(env: Env, key: string, force: boolean): Promise<CachedToken> {
  const cache = await caches.open('relay-private-tokens-v1')
  if (!force) {
    const response = await cache.match(key).catch(() => undefined)
    if (response) {
      const stored = await readSmallJson(response).catch(() => null)
      if (stored && typeof stored.accessToken === 'string' && typeof stored.refreshAt === 'number' && stored.refreshAt > Date.now()) {
        return { accessToken: stored.accessToken, refreshAt: stored.refreshAt }
      }
    }
  } else {
    await cache.delete(key).catch(() => false)
  }
  const response = await feishuFetch(env, new URL('/oauth/v3/token', env.FEISHU_ACCOUNTS_BASE), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: env.FEISHU_APP_ID, client_secret: env.FEISHU_APP_SECRET }),
    signal: AbortSignal.timeout(8_000),
  })
  const data = await readSmallJson(response)
  if (!response.ok || typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
    throw new Error('Feishu token unavailable')
  }
  const lifetime = data.expires_in * 1000
  const token = { accessToken: data.access_token, refreshAt: Date.now() + Math.max(1000, lifetime - Math.min(300_000, lifetime / 2)) }
  // 仅专用内部命名空间存短期凭证；绝不混入文件分片缓存或 D1。
  await cache.put(key, new Response(JSON.stringify(token), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${Math.max(1, Math.floor((token.refreshAt - Date.now()) / 1000))}` },
  })).catch(() => undefined)
  return token
}
