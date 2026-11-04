import { buildBrowser } from './build-browser.ts'
import { execFile } from 'node:child_process'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { parseEnv, promisify } from 'node:util'

const execute = promisify(execFile)
const root = process.cwd()
const local = resolve(root, '.local')
const configPath = resolve(root, 'wrangler.jsonc')
const secretsPath = resolve(local, 'production-secrets.json')
const manifestPath = resolve(local, 'production.json')
const accountId = '99bb38b174e12e1527cfb17974a21c30'
const zoneId = '04731bc1e8f10f2ef107dfc17ab84d3b'
const workerName = 'feishu-file-relay'
const databaseName = 'feishu-file-relay'
const expectedBase = 'https://dl.sinoballvalve.com'
const secretNames = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_VERIFICATION_TOKEN', 'FEISHU_ENCRYPT_KEY'] as const
type Secrets = Record<typeof secretNames[number], string>
interface Manifest { accountId: string; workerName: string; databaseName: string; databaseId: string; publicBaseUrl: string }
type Config = Record<string, unknown> & { vars: Record<string, string>; d1_databases: Array<Record<string, unknown>> }

async function wrangler(args: string[], quiet = false): Promise<string> {
  try {
    const result = await execute(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
      cwd: root, env: { ...process.env, CI: 'true', CLOUDFLARE_ACCOUNT_ID: accountId }, maxBuffer: 8 * 1024 * 1024,
    })
    if (!quiet) process.stdout.write(result.stdout)
    return result.stdout
  } catch (error) {
    // 不打印子进程异常对象，它可能携带环境变量；部署输出只包含配置和 Secret 名称。
    if (!quiet && error && typeof error === 'object' && 'stdout' in error) process.stderr.write(String(error.stdout))
    if (!quiet && error && typeof error === 'object' && 'stderr' in error) process.stderr.write(String(error.stderr))
    throw new Error(`Wrangler ${args[0]} failed`)
  }
}

async function cloudflare(path: string, body?: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const auth = JSON.parse(await wrangler(['auth', 'token', '--json'], true)) as { token: string }
  if (!auth.token) throw new Error('Missing Wrangler authentication')
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: body ? 'PUT' : 'GET', body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, data: await response.json() as Record<string, unknown> }
}

async function credentials(): Promise<Secrets> {
  // Node 原生 parseEnv 不进行 $VAR 展开，且不会让 .dev.vars 或进程环境替换真实凭据。
  const env = parseEnv((await readFile(resolve(root, '.env'), 'utf8')).replace(/^\uFEFF/, ''))
  if (env.PUBLIC_BASE_URL?.replace(/\/$/, '') !== expectedBase) throw new Error('Unexpected production PUBLIC_BASE_URL')
  const secrets = {} as Secrets
  for (const name of secretNames) {
    if (!env[name]?.trim() || /replace-with|placeholder/i.test(env[name])) throw new Error(`Missing ${name}`)
    secrets[name] = env[name]
  }
  return secrets
}

async function manifest(): Promise<Manifest | null> {
  try {
    const value = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
    if (value.accountId !== accountId || value.workerName !== workerName || value.databaseName !== databaseName || value.publicBaseUrl !== expectedBase) throw new Error('Production manifest mismatch')
    return value
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function configure(databaseId: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Config
  config.name = workerName
  config.account_id = accountId
  config.workers_dev = false
  config.preview_urls = false
  config.routes = [{ pattern: new URL(expectedBase).hostname, custom_domain: true, zone_id: zoneId }]
  delete config.services
  config.vars = { ...config.vars, PUBLIC_BASE_URL: expectedBase, FEISHU_TRANSPORT: 'real', FEISHU_INTAKE_POLICY: 'platform',
    FEISHU_API_BASE: 'https://open.feishu.cn', FEISHU_ACCOUNTS_BASE: 'https://accounts.feishu.cn' }
  for (const name of [...secretNames, 'ALLOWED_OPEN_IDS', 'ADMIN_OPEN_IDS', 'FEISHU_ALLOWED_CHAT_IDS']) delete config.vars[name]
  config.d1_databases = [{ binding: 'DB', database_name: databaseName, database_id: databaseId, migrations_dir: 'migrations', remote: false }]
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
}

async function prepare(): Promise<void> {
  const secrets = await credentials()
  const identity = JSON.parse(await wrangler(['whoami', '--json'], true)) as { loggedIn: boolean; accounts: Array<{ id: string }>; tokenPermissions: string[] }
  if (!identity.loggedIn || !identity.accounts.some((account) => account.id === accountId)) throw new Error('Production account is not available')
  for (const scope of ['workers_scripts:write', 'workers_routes:write', 'd1:write', 'zone:read', 'ssl_certs:write']) {
    if (!identity.tokenPermissions.includes(scope)) throw new Error(`Missing Cloudflare scope ${scope}`)
  }
  const zone = await cloudflare(`/zones/${zoneId}`)
  const zoneInfo = zone.data.result as { status?: string; account?: { id: string }; name?: string } | undefined
  if (zone.status !== 200 || zoneInfo?.status !== 'active' || zoneInfo.account?.id !== accountId || zoneInfo.name !== 'sinoballvalve.com') throw new Error('Production zone is not active in the expected account')
  const domains = await cloudflare(`/accounts/${accountId}/workers/domains`)
  if (domains.status !== 200 || !Array.isArray(domains.data.result)) throw new Error('Cannot inspect existing Worker custom domains')
  for (const domain of domains.data.result as Array<{ hostname: string; service: string }>) {
    if (domain.hostname === new URL(expectedBase).hostname && domain.service !== workerName) throw new Error('Custom domain belongs to another Worker; refusing to overwrite')
  }
  const existing = await manifest()
  if (!existing) {
    const worker = await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}/settings`)
    const codes = (worker.data.errors as Array<{ code: number }> | undefined)?.map((error) => error.code)
    if (worker.status !== 404 || !codes?.includes(10007)) throw new Error('Worker is not confirmed absent; refusing to adopt an existing production service')
  }
  await mkdir(local, { recursive: true })
  await writeFile(secretsPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 })
  await configure(existing?.databaseId ?? '00000000-0000-0000-0000-000000000000')
  console.log('生产配置已准备；仅保存指定四项 Secret，未创建远程资源。')
}

async function deploy(): Promise<void> {
  await buildBrowser()
  await prepare()
  let state = await manifest()
  if (!state) {
    const databases = JSON.parse(await wrangler(['d1', 'list', '--json'], true)) as Array<{ name: string; uuid: string }>
    if (databases.some((database) => database.name === databaseName)) throw new Error('Database name already exists without a production manifest; review before adoption')
    const output = await wrangler(['d1', 'create', databaseName, '--location', 'apac'])
    const databaseId = /"database_id"\s*:\s*"([a-f0-9-]{36})"/i.exec(output)?.[1]
    if (!databaseId) throw new Error('Cannot identify created production D1; inspect before retrying')
    state = { accountId, workerName, databaseName, databaseId, publicBaseUrl: expectedBase }
    await writeFile(manifestPath, JSON.stringify(state, null, 2) + '\n')
  }
  await configure(state.databaseId)
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath])
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Config
  const { routes: _routes, env: _environments, ...workerConfig } = config
  const deployConfigPath = resolve(local, 'production-worker.json')
  await writeFile(deployConfigPath, JSON.stringify({ ...workerConfig,
    $schema: resolve(root, 'node_modules/wrangler/config-schema.json'), main: resolve(root, 'src/index.ts'),
    d1_databases: [{ ...config.d1_databases[0], migrations_dir: resolve(root, 'migrations') }],
  }, null, 2) + '\n')
  // JSON 精确白名单上传，避免 .env 展开或额外本地变量进入生产。
  await wrangler(['deploy', '--config', deployConfigPath, '--secrets-file', secretsPath])
  // Wrangler 在非交互模式会自动覆盖冲突 DNS，故单独调用明确禁止覆盖的域名绑定接口。
  const domain = await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}/domains/records`, {
    override_scope: false, override_existing_origin: false, override_existing_dns_record: false,
    origins: [{ hostname: new URL(expectedBase).hostname, zone_id: zoneId }],
  })
  if (domain.status !== 200 || domain.data.success !== true) throw new Error('Custom domain attachment failed; no conflicting origin or DNS record was overwritten')
  console.log(`生产部署完成：${expectedBase}`)
}

async function verify(): Promise<void> {
  const secrets = await credentials()
  const state = await manifest()
  if (!state) throw new Error('No production manifest')
  const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), ...state }
  let health: Response | undefined
  for (let attempt = 0; attempt < 12; attempt++) {
    health = await fetch(`${expectedBase}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
    if (health?.ok) break
    await setTimeout(2500)
  }
  if (!health?.ok || (await health.json() as { status?: string }).status !== 'ok') throw new Error('Production HTTPS health check failed')
  report.health = 200
  const challenge = randomBytes(16).toString('hex')
  for (const encrypted of [false, true]) {
    let body = JSON.stringify({ type: 'url_verification', token: secrets.FEISHU_VERIFICATION_TOKEN, challenge })
    if (encrypted) {
      const iv = randomBytes(16)
      const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(secrets.FEISHU_ENCRYPT_KEY).digest(), iv)
      body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(body), cipher.final()]).toString('base64') })
    }
    const response = await fetch(`${expectedBase}/webhook/feishu`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) })
    if (response.status !== 200 || (await response.json() as { challenge?: string }).challenge !== challenge) throw new Error('Production callback challenge failed')
  }
  report.challenges = 'plaintext and encrypted passed'
  const invalid = await fetch(`${expectedBase}/webhook/feishu`, { method: 'POST', body: JSON.stringify({ type: 'url_verification', token: 'invalid', challenge }), signal: AbortSignal.timeout(15_000) })
  if (invalid.status !== 401) throw new Error('Invalid callback was not rejected')
  report.invalidCallback = invalid.status
  const unknown = await fetch(`${expectedBase}/f/${'0'.repeat(22)}`, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
  if (unknown.status !== 404) throw new Error('Unknown file HEAD did not return 404')
  report.unknownFileHead = unknown.status
  const secretList = JSON.parse(await wrangler(['secret', 'list', '--config', configPath], true)) as Array<{ name: string }>
  if (secretList.length !== 4 || secretNames.some((name) => !secretList.some((secret) => secret.name === name))) throw new Error('Unexpected production Secret names')
  report.secretNames = secretList.map((secret) => secret.name)
  const settings = await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}/settings`)
  const deployed = settings.data.result as { bindings?: Array<{ name: string; type: string; text?: string; id?: string }> } | undefined
  const bindings = deployed?.bindings ?? []
  if (settings.status !== 200 || bindings.some((binding) => binding.name === 'FEISHU_MOCK' || binding.name === 'ADMIN_OPEN_IDS' || binding.name === 'ALLOWED_OPEN_IDS')
    || !bindings.some((binding) => binding.name === 'DB' && binding.id === state.databaseId)
    || !bindings.some((binding) => binding.name === 'FEISHU_TRANSPORT' && binding.text === 'real')
    || !bindings.some((binding) => binding.name === 'FEISHU_INTAKE_POLICY' && binding.text === 'platform')) throw new Error('Unexpected production bindings')
  report.bindings = bindings.map((binding) => ({ name: binding.name, type: binding.type }))
  const subdomain = await cloudflare(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`)
  const exposure = subdomain.data.result as { enabled?: boolean; previews_enabled?: boolean } | undefined
  if (subdomain.status !== 200 || exposure?.enabled !== false || exposure.previews_enabled !== false) throw new Error('Unexpected workers.dev/preview exposure')
  report.workersDev = false
  report.previewUrls = false
  const tables = JSON.parse(await wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--config', configPath, '--command', "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"], true)) as unknown
  report.databaseTables = tables
  const counts = JSON.parse(await wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--config', configPath, '--command', 'SELECT (SELECT COUNT(*) FROM files) AS files,(SELECT COUNT(*) FROM bot_jobs) AS bot_jobs,(SELECT COUNT(*) FROM processed_events) AS events'], true)) as unknown
  report.productionCounts = counts
  const token = await fetch('https://accounts.feishu.cn/oauth/v3/token', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: secrets.FEISHU_APP_ID, client_secret: secrets.FEISHU_APP_SECRET }), signal: AbortSignal.timeout(15_000) })
  const tokenResult = await token.json() as { access_token?: string; expires_in?: number; code?: number; error?: string }
  report.realFeishuToken = { status: token.status, success: token.ok && typeof tokenResult.access_token === 'string' && !!tokenResult.access_token && typeof tokenResult.expires_in === 'number' && tokenResult.expires_in > 0 }
  // 凭证/Token 仅在内存参与请求，验证报告不保存响应原文或错误描述。
  await writeFile(resolve(local, 'production-verification.json'), JSON.stringify(report, null, 2) + '\n')
  if (!(report.realFeishuToken as { success: boolean }).success) throw new Error('Real Feishu token request failed; report contains HTTP status only')
  console.log('生产 HTTPS、回调挑战、错误拒绝、D1、绑定及真实飞书令牌获取验证通过；未登记文件或发送消息。')
}

try {
  const action = process.argv[2]
  if (action === 'prepare') await prepare()
  else if (action === 'deploy') await deploy()
  else if (action === 'verify') await verify()
  else throw new Error('Usage: node scripts/production-setup.ts prepare|deploy|verify')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Production setup failed')
  process.exitCode = 1
}
