import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { parseEnv, promisify } from 'node:util'
import { dockerEnvTemplate } from '../../scripts/generate-docker-env.ts'

const exec = promisify(execFile)
const image = process.env.DOCKER_TEST_IMAGE ?? 'feishu-file-relay:ci'
const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
let available = false
try { await docker('info', '--format', '{{.OSType}}'); available = true } catch { /* 缺少 Docker 时明确跳过；CI 必须失败。 */ }
if (!available && process.env.REQUIRE_DOCKER === '1') throw new Error('Docker is required for CI container acceptance')
const skip = available ? false : 'Docker CLI/daemon unavailable; container checks not verified'
const fakeEnv: Record<string, string> = {
  FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_VERIFICATION_TOKEN: 'fake', FEISHU_ENCRYPT_KEY: 'fake',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'fake',
  PUBLIC_BASE_URL: 'https://relay.invalid', HOST: '0.0.0.0', PORT: '3000', SHUTDOWN_TIMEOUT_MS: '1000', JOB_POLL_MS: '60000',
}

async function runContainer(name: string, network: string, env: Record<string, string>, extra: string[] = []) {
  return docker('run', '--detach', '--name', name, '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    ...extra, ...Object.entries({ ...fakeEnv, ...env }).flatMap(([key, value]) => ['--env', `${key}=${value}`]), image)
}

async function healthy(name: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await docker('exec', name, 'node', '-e', "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")
      return
    } catch { await delay(250) }
  }
  throw new Error('Container did not become healthy')
}

test('Compose preserves quoted secrets and process overrides without reading local configuration', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-compose-'))
  try {
    const path = join(directory, '.env.docker')
    await writeFile(path, dockerEnvTemplate.replace('FEISHU_APP_SECRET=\n', "FEISHU_APP_SECRET='fake$secret# value'\n").replace('DOCKER_GATEWAY=172.30.0.1', 'DOCKER_GATEWAY=172.31.0.1'))
    const env = { ...process.env }
    for (const key of Object.keys(parseEnv(dockerEnvTemplate))) delete env[key]
    delete env.COMPOSE_FILE
    delete env.COMPOSE_ENV_FILES
    env.PORT = '3456'
    const result = await exec('docker', ['compose', '-f', resolve('docker-compose.yml'), '--env-file', path, 'config', '--format', 'json'], { cwd: directory, env, windowsHide: true })
    const config = JSON.parse(result.stdout)
    assert.equal(config.services.relay.environment.FEISHU_APP_SECRET, 'fake$secret# value')
    assert.equal(config.services.relay.environment.PORT, '3456')
    assert.equal(config.services.relay.environment.TRUSTED_PROXY_IPS, '172.31.0.1')
    assert.equal(config.services.relay.ports[0].host_ip, '127.0.0.1')
    assert.equal(Number(config.services.relay.ports[0].target), 3456)
    assert.equal(await readFile(path, 'utf8').then((value) => value.includes('fake$secret')), true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('image runs non-root without network, serves bundled assets, and exits cleanly on SIGTERM', { skip }, async () => {
  const name = `relay-offline-${randomUUID()}`
  let created = false
  try {
    await runContainer(name, 'none', {})
    created = true
    await healthy(name)
    assert.notEqual(await docker('exec', name, 'node', '-p', 'process.getuid()'), '0')
    await docker('exec', name, 'node', '-e', "Promise.all(['/assets/download.js','/assets/download.css'].map(async p=>{const r=await fetch('http://127.0.0.1:3000'+p);if(!r.ok||!(await r.text()).length)throw Error('asset')})).catch(()=>process.exit(1))")
    await docker('exec', name, 'node', '-e', "const fs=require('node:fs');for(const p of ['.env','.env.docker','.git','scripts','src'])if(fs.existsSync(p))process.exit(1)")
    await docker('stop', '--time', '10', name)
    assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', name), '0')
  } finally { if (created) await docker('rm', '--force', name) }
})

test('host bridge gateway keeps distinct client limits and cannot access readiness', { skip }, async () => {
  const name = `relay-bridge-${randomUUID()}`
  const network = `${name}-net`
  let created = false
  let networkCreated = false
  try {
    // internal 网络允许宿主机验证桥接，但隔绝后台任务到真实 D1/飞书的外网访问。
    await docker('network', 'create', '--internal', network)
    networkCreated = true
    const gateway = await docker('network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', network)
    await runContainer(name, network, { TRUST_PROXY: 'true', TRUSTED_PROXY_IPS: gateway, DOWNLOAD_RATE_LIMIT: '1' }, ['--publish', '127.0.0.1::3000'])
    created = true
    await healthy(name)
    const published = await docker('port', name, '3000/tcp')
    assert.match(published, /^127\.0\.0\.1:\d+$/)
    const request = (path: string, ip: string) => fetch(`http://${published}${path}`, { headers: { 'X-Real-IP': ip }, signal: AbortSignal.timeout(5000) })
    for (const ip of ['203.0.113.1', '203.0.113.2']) {
      const response = await request('/f/invalid', ip)
      assert.equal(response.status, 404)
      await response.arrayBuffer()
    }
    const limited = await request('/f/invalid', '203.0.113.1')
    assert.equal(limited.status, 429)
    await limited.arrayBuffer()
    const readiness = await request('/ready', '127.0.0.1')
    assert.equal(readiness.status, 404)
    await readiness.arrayBuffer()
  } finally {
    if (created) await docker('rm', '--force', name)
    if (networkCreated) await docker('network', 'rm', network)
  }
})
