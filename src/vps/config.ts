import { parseTrustedProxyIps } from './trusted-proxy'

export interface Config {
  FEISHU_APP_ID: string
  FEISHU_APP_SECRET: string
  FEISHU_VERIFICATION_TOKEN: string
  FEISHU_ENCRYPT_KEY: string
  FEISHU_API_BASE: string
  FEISHU_ACCOUNTS_BASE: string
  FEISHU_INTAKE_POLICY: 'platform' | 'allowlist'
  ALLOWED_OPEN_IDS: string
  ADMIN_OPEN_IDS: string
  WEBHOOK_MAX_SKEW_SECONDS: string
  PUBLIC_BASE_URL: string
  MAX_FILE_SIZE: string
  UPSTREAM_READ_TIMEOUT_MS: string
  host: string
  port: number
  accountId: string
  databaseId: string
  token: string
  d1Budget: number
  cacheEnabled: boolean
  maxDownloads: number
  rateLimit: number
  trustProxy: boolean
  firstDownloadNotification: boolean
  trustCloudflareGeo: boolean
  trustedProxyIps: string[]
  shutdownMs: number
  pollMs: number
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const required = (key: string) => {
    const value = env[key]?.trim()
    if (!value || value.startsWith('replace-')) throw new Error(`Missing configuration: ${key}`)
    return value
  }
  const integer = (key: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(env[key] ?? fallback)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid configuration: ${key}`)
    return value
  }
  const boolean = (key: string, fallback = false) => {
    if (env[key] === undefined) return fallback
    if (env[key] !== 'true' && env[key] !== 'false') throw new Error(`Invalid configuration: ${key}`)
    return env[key] === 'true'
  }
  const origin = (key: string, fallback: string) => {
    const value = new URL(env[key] ?? fallback)
    if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash || value.pathname !== '/') throw new Error(`Invalid origin: ${key}`)
    return value.origin
  }
  const policy = env.FEISHU_INTAKE_POLICY ?? 'platform'
  if (policy !== 'platform' && policy !== 'allowlist') throw new Error('Invalid intake policy')
  if (env.FEISHU_TRANSPORT && env.FEISHU_TRANSPORT !== 'real') throw new Error('Mock transport is test-injected only')
  const accountId = required('CLOUDFLARE_ACCOUNT_ID')
  const databaseId = required('CLOUDFLARE_DATABASE_ID')
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-f0-9-]{36}$/i.test(databaseId)) throw new Error('Invalid D1 identifiers')
  return {
    FEISHU_APP_ID: required('FEISHU_APP_ID'), FEISHU_APP_SECRET: required('FEISHU_APP_SECRET'),
    FEISHU_VERIFICATION_TOKEN: required('FEISHU_VERIFICATION_TOKEN'), FEISHU_ENCRYPT_KEY: required('FEISHU_ENCRYPT_KEY'),
    FEISHU_API_BASE: origin('FEISHU_API_BASE', 'https://open.feishu.cn'),
    FEISHU_ACCOUNTS_BASE: origin('FEISHU_ACCOUNTS_BASE', 'https://accounts.feishu.cn'),
    FEISHU_INTAKE_POLICY: policy, ALLOWED_OPEN_IDS: env.ALLOWED_OPEN_IDS ?? '', ADMIN_OPEN_IDS: env.ADMIN_OPEN_IDS ?? '',
    PUBLIC_BASE_URL: origin('PUBLIC_BASE_URL', 'https://dl.sinoballvalve.com'),
    WEBHOOK_MAX_SKEW_SECONDS: String(integer('WEBHOOK_MAX_SKEW_SECONDS', 300)),
    MAX_FILE_SIZE: String(integer('MAX_FILE_SIZE', 1073741824, 1, 1073741824)),
    UPSTREAM_READ_TIMEOUT_MS: String(integer('UPSTREAM_READ_TIMEOUT_MS', 30000)),
    host: env.HOST ?? '127.0.0.1', port: integer('PORT', 3000, 0, 65535), accountId, databaseId,
    token: required('CLOUDFLARE_D1_TOKEN'), d1Budget: integer('D1_REQUEST_BUDGET', 900, 101, 1200),
    cacheEnabled: boolean('CHUNK_CACHE_ENABLED'), maxDownloads: integer('MAX_CONCURRENT_DOWNLOADS', 10),
    rateLimit: integer('DOWNLOAD_RATE_LIMIT', 60), trustProxy: boolean('TRUST_PROXY'),
    firstDownloadNotification: boolean('FIRST_DOWNLOAD_NOTIFICATION_ENABLED'),
    trustCloudflareGeo: boolean('TRUST_CLOUDFLARE_GEO'),
    trustedProxyIps: parseTrustedProxyIps(env.TRUSTED_PROXY_IPS),
    shutdownMs: integer('SHUTDOWN_TIMEOUT_MS', 60000), pollMs: integer('JOB_POLL_MS', 15000, 1000),
  }
}
