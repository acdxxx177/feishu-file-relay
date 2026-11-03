import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const execute = promisify(execFile)
const root = process.cwd()
const local = resolve(root, '.local')
const manifestPath = resolve(local, 'online-test.json')
const wranglerBin = resolve(root, 'node_modules/wrangler/bin/wrangler.js')
type Configuration = Record<string, unknown>
interface Manifest {
  accountId: string
  gatewayName: string
  mockName: string
  databaseId: string
  databaseName: string
  gatewayUrl: string
  configPath: string
  mockConfigPath: string
  secretsPath: string
  runId: string
}

async function wrangler(args: string[], accountId?: string, quiet = false): Promise<string> {
  const result = await execute(process.execPath, [wranglerBin, ...args], {
    cwd: root,
    env: { ...process.env, CI: 'true', ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}) },
    maxBuffer: 8 * 1024 * 1024,
  })
  if (!quiet) process.stdout.write(result.stdout)
  // 正常命令只会列出Secret名称，绝不回显本地JSON的值。
  if (!quiet && result.stderr) process.stderr.write(result.stderr)
  return result.stdout
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T
}

async function save(manifest: Manifest): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
}

async function configure(manifest: Manifest): Promise<void> {
  const source = await jsonFile<Configuration>('wrangler.jsonc')
  const environments = source.env as Record<string, Configuration>
  const test = environments['online-test']
  const { env: _environments, ...base } = source
  const gateway = {
    ...base, ...test,
    $schema: resolve(root, 'node_modules/wrangler/config-schema.json'),
    name: manifest.gatewayName,
    routes: [],
    account_id: manifest.accountId,
    main: resolve(root, 'src/index.ts'),
    services: [{ binding: 'FEISHU_MOCK', service: manifest.mockName }],
    vars: { ...(test.vars as Configuration), PUBLIC_BASE_URL: manifest.gatewayUrl || 'https://online-test.invalid' },
    d1_databases: [{ binding: 'DB', database_name: manifest.databaseName, database_id: manifest.databaseId,
      migrations_dir: resolve(root, 'migrations'), remote: false }],
    observability: { enabled: true, head_sampling_rate: 1, logs: { invocation_logs: false }, traces: { enabled: true, head_sampling_rate: 0.01 } },
  }
  const mock = {
    ...await jsonFile<Configuration>('wrangler.mock.jsonc'),
    $schema: resolve(root, 'node_modules/wrangler/config-schema.json'),
    name: manifest.mockName,
    account_id: manifest.accountId,
    main: resolve(root, 'src/testing/feishu-mock-worker.ts'),
    d1_databases: [{ binding: 'DB', database_name: manifest.databaseName, database_id: manifest.databaseId,
      migrations_dir: resolve(root, 'testing-migrations'), remote: false }],
  }
  await writeFile(manifest.configPath, JSON.stringify(gateway, null, 2) + '\n')
  await writeFile(manifest.mockConfigPath, JSON.stringify(mock, null, 2) + '\n')
}

async function prepare(): Promise<Manifest> {
  await mkdir(local, { recursive: true })
  try {
    const existing = await jsonFile<Manifest>(manifestPath)
    if (!/^feishu-file-relay-online-test-/.test(existing.gatewayName) || !/^feishu-file-relay-mock-test-/.test(existing.mockName) || !/^feishu-relay-test-/.test(existing.databaseName)) throw new Error('Manifest resource names are outside the isolated test scope')
    await configure(existing)
    return existing
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const identity = JSON.parse(await wrangler(['whoami', '--json'], undefined, true)) as { loggedIn: boolean; accounts: Array<{ id: string }>; tokenPermissions: string[] }
  if (!identity.loggedIn || identity.accounts.length !== 1) throw new Error('需要已登录且明确唯一的Cloudflare账户')
  for (const required of ['workers_scripts:write', 'd1:write', 'workers_tail:read']) {
    if (!identity.tokenPermissions.includes(required)) throw new Error(`缺少权限：${required}`)
  }
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '')
  const runId = `${date}-${randomBytes(3).toString('hex')}`
  const manifest: Manifest = {
    accountId: identity.accounts[0].id,
    gatewayName: `feishu-file-relay-online-test-${runId}`,
    mockName: `feishu-file-relay-mock-test-${runId}`,
    databaseName: `feishu-relay-test-${runId}`,
    databaseId: '00000000-0000-0000-0000-000000000000',
    gatewayUrl: '',
    configPath: resolve(local, 'online-gateway.json'),
    mockConfigPath: resolve(local, 'online-mock.json'),
    secretsPath: resolve(local, 'online-test-secrets.json'),
    runId,
  }
  const secrets = {
    FEISHU_APP_ID: `cli_mock_${randomBytes(8).toString('hex')}`,
    FEISHU_APP_SECRET: randomBytes(32).toString('base64url'),
    FEISHU_VERIFICATION_TOKEN: randomBytes(32).toString('base64url'),
    FEISHU_ENCRYPT_KEY: randomBytes(32).toString('base64url'),
    ALLOWED_OPEN_IDS: 'ou_online_owner,ou_online_other,ou_online_admin',
    ADMIN_OPEN_IDS: 'ou_online_admin',
  }
  await writeFile(manifest.secretsPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 })
  await save(manifest)
  await configure(manifest)
  return manifest
}

const command = process.argv[2] ?? 'prepare'
if (!['prepare', 'deploy'].includes(command)) throw new Error('仅支持prepare或deploy')
const manifest = await prepare()
console.log(JSON.stringify({ phase: command, gateway: manifest.gatewayName, mock: manifest.mockName, database: manifest.databaseName }))
if (command === 'deploy') {
  // 远程操作只针对本脚本生成并保存在清单中的隔离资源，不自动改写生产配置。
  if (manifest.databaseId === '00000000-0000-0000-0000-000000000000') {
    const output = await wrangler(['d1', 'create', manifest.databaseName, '--location', 'apac', '--update-config=false'], manifest.accountId)
    const databaseId = /"database_id"\s*:\s*"([a-f0-9-]{36})"/.exec(output)?.[1]
    if (!databaseId) throw new Error('无法读取新建数据库ID；请检查命令结果后更新隔离清单，勿重复创建')
    manifest.databaseId = databaseId
    await save(manifest)
    await configure(manifest)
  }
  for (const config of [manifest.configPath, manifest.mockConfigPath]) {
    await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', config], manifest.accountId)
  }
  for (const config of [manifest.mockConfigPath, manifest.configPath]) {
    const output = await wrangler(['deploy', '--config', config], manifest.accountId)
    await wrangler(['secret', 'bulk', manifest.secretsPath, '--config', config], manifest.accountId)
    if (config === manifest.configPath) {
      const gatewayUrl = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0]
      if (!gatewayUrl) throw new Error('未获得workers.dev地址，请检查账户子域名是否已初始化')
      manifest.gatewayUrl = gatewayUrl
      await save(manifest)
      await configure(manifest)
      await wrangler(['deploy', '--config', config], manifest.accountId)
    }
  }
  console.log(JSON.stringify({ phase: 'deployed', gatewayUrl: manifest.gatewayUrl, manifest: manifestPath }))
}
