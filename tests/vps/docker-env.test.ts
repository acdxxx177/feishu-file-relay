import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify, parseEnv } from 'node:util'
import { test } from 'node:test'
import { dockerEnvTemplate, generateDockerEnv } from '../../scripts/generate-docker-env.ts'

test('environment generator writes only defaults, leaves unknowns blank, and refuses overwrites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-env-'))
  try {
    await writeFile(join(directory, '.env'), 'FEISHU_APP_SECRET=must-not-read\nPUBLIC_BASE_URL=https://private.invalid\n')
    await promisify(execFile)(process.execPath, [resolve('scripts/generate-docker-env.ts')], {
      cwd: directory, env: { ...process.env, FEISHU_APP_SECRET: 'must-not-import' }, windowsHide: true,
    })
    const path = join(directory, '.env.docker')
    assert.equal(await readFile(path, 'utf8'), dockerEnvTemplate)
    const values = parseEnv(await readFile(path, 'utf8'))
    for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_VERIFICATION_TOKEN', 'FEISHU_ENCRYPT_KEY',
      'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN', 'PUBLIC_BASE_URL', 'DOCKER_IMAGE']) assert.equal(values[key], '')
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    await assert.rejects(generateDockerEnv(path), { code: 'EEXIST' })
    assert.equal(await readFile(path, 'utf8'), dockerEnvTemplate)
    const custom = join(directory, 'custom.env')
    await generateDockerEnv(custom)
    assert.equal(await readFile(custom, 'utf8'), dockerEnvTemplate)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('template covers runtime configuration and every Compose interpolation input', async () => {
  const values = parseEnv(dockerEnvTemplate)
  const config = await readFile('src/vps/config.ts', 'utf8')
  const compose = await readFile('docker-compose.yml', 'utf8')
  const keys = new Set([
    ...Array.from(config.matchAll(/env\.([A-Z][A-Z0-9_]+)/g), (match) => match[1]),
    ...Array.from(config.matchAll(/(?:required|integer|boolean|origin)\('([A-Z0-9_]+)'/g), (match) => match[1]),
    ...Array.from(compose.matchAll(/\$\{([A-Z0-9_]+)/g), (match) => match[1]),
  ])
  for (const key of keys) assert.ok(Object.hasOwn(values, key), `Missing template key: ${key}`)
})
