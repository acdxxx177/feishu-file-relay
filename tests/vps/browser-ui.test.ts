import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { build } from 'esbuild'
import { createMock } from '../../mocks/feishu-mock'
import { createApplication } from '../../src/vps/app'
import { readConfig } from '../../src/vps/config'
import { createFeishuClient } from '../../src/vps/feishu'
import { databaseFixture } from './database-fixture'

const browser = [
  process.env.CHROME_PATH,
  join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((path): path is string => !!path && existsSync(path))

test('served download UI preserves active transfers, localization and Blob limits in Chromium', {
  skip: browser ? false : 'Set CHROME_PATH to run the real-browser test', timeout: 150_000,
}, async (t) => {
  const sizes = { transfer: 8, blob: 20 * 1024 * 1024, oversized: 20 * 1024 * 1024 + 1 }
  const scenarios = Object.keys(sizes) as (keyof typeof sizes)[]
  const filename = '共享-साझा-instrucciones <final>.zip'
  const fixture = databaseFixture()
  t.after(() => fixture.db.close())
  const config = readConfig({ FEISHU_APP_ID: 'local', FEISHU_APP_SECRET: 'local', FEISHU_VERIFICATION_TOKEN: 'local',
    FEISHU_ENCRYPT_KEY: 'local', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'local' })
  const mock = createMock()
  const feishu = createFeishuClient(config, (input, init) => mock.handle(new Request(input, init)))
  t.after(() => feishu.close())
  const { app } = createApplication(config, fixture.repository, feishu)
  function pathFor(scenario: keyof typeof sizes) {
    return '/f/' + scenario[0].repeat(22) + '?scenario=' + scenario
  }
  for (const scenario of scenarios) {
    mock.files.set(scenario, { size: sizes[scenario] })
    fixture.db.prepare(`INSERT INTO files (id,message_id,file_key,file_name,file_size,uploader_open_id,chat_id,status)
      VALUES (?,?,?,?,?,'local','test','active')`).run(scenario[0].repeat(22), scenario, scenario, filename, sizes[scenario])
  }

  // 测试驱动和产品入口均由真实浏览器在生产 CSP 下作为同源脚本加载。
  const driver = await build({ entryPoints: ['tests/vps/browser-ui-driver.ts'], bundle: true, write: false, target: 'es2022' })
  let finish!: () => void
  let fail!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
  const completed: string[] = []
  const server = serve({ hostname: '127.0.0.1', port: 0, async fetch(request, bindings) {
    const { pathname } = new URL(request.url)
    if (pathname === '/test-driver.js') return new Response(driver.outputFiles[0].text, { headers: { 'Content-Type': 'text/javascript' } })
    if (pathname === '/test-result' && request.method === 'POST') {
      const result = await request.json() as { scenario: string; error?: string }
      if (result.error) fail(new Error(result.scenario + ': ' + result.error))
      completed.push(result.scenario)
      if (completed.length === scenarios.length) finish()
      const next = scenarios[completed.length]
      return new Response(next ? pathFor(next) : '')
    }
    const response = await app.fetch(request, bindings)
    if (!pathname.startsWith('/f/')) return response
    const html = (await response.text()).replace('<head>', '<head><script src="/test-driver.js"></script>')
    return new Response(html, { status: response.status, headers: response.headers })
  } }) as Server
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const profile = await mkdtemp(join(tmpdir(), 'relay-browser-'))
  const args = ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter', '--user-data-dir=' + profile]
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox')
  const child = spawn(browser!, [...args, 'http://127.0.0.1:' + address.port + pathFor('transfer')], { windowsHide: true, stdio: 'ignore' })
  const closed = once(child, 'close')
  t.after(async () => {
    child.kill()
    await closed
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
  })
  const timer = setTimeout(() => fail(new Error('Timed out waiting for browser at ' + scenarios[completed.length])), 120_000)
  try {
    await Promise.race([done, closed.then(([code]) => { throw new Error('Chromium exited before completing tests: ' + code) })])
  } finally { clearTimeout(timer) }
  assert.deepEqual(completed, scenarios)
  assert.equal(mock.ranges.filter(read => read.key === 'oversized').length, 0)
})
