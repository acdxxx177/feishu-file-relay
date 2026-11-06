import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { build } from 'esbuild'
import { bytesAt, createMock } from '../../mocks/feishu-mock'
import { createApplication } from '../../src/vps/app'
import { readConfig } from '../../src/vps/config'
import { createFeishuClient } from '../../src/vps/feishu'
import { databaseFixture } from './database-fixture'
import { startBrowser } from './browser-process'

const browser = [
  process.env.CHROME_PATH,
  join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((path): path is string => !!path && existsSync(path))

async function connectBrowser(endpoint: string) {
  const socket = new WebSocket(endpoint)
  await once(socket, 'open')
  let nextId = 0
  const pending = new Map<number, { resolve: (result: Record<string, any>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const downloads = new Map<string, 'started' | 'completed' | 'canceled'>()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id) {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    } else if (message.method === 'Browser.downloadWillBegin') downloads.set(message.params.guid, 'started')
    else if (message.method === 'Browser.downloadProgress' && message.params.state !== 'inProgress') downloads.set(message.params.guid, message.params.state)
  })
  return {
    downloads,
    send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 10_000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    close() {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP closed')) }
      pending.clear()
      socket.close()
    },
  }
}

test('served download UI preserves active transfers, localization and Blob limits in Chromium', {
  skip: browser || process.env.REQUIRE_BROWSER === '1' ? false : 'Set CHROME_PATH to run the real-browser test', timeout: 150_000,
}, async (t) => {
  assert.ok(browser, 'Chromium is required; install it or set CHROME_PATH to an existing browser executable')
  const sizes = { transfer: 8, blob: 20 * 1024 * 1024, saveFailure: 8, oversized: 20 * 1024 * 1024 + 1 }
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
  let keyboard!: () => Promise<void>
  let keyboardReady!: () => void
  const ready = new Promise<void>(resolve => { keyboardReady = resolve })
  const completed: string[] = []
  const server = serve({ hostname: '127.0.0.1', port: 0, async fetch(request, bindings) {
    const { pathname } = new URL(request.url)
    if (pathname === '/test-driver.js') return new Response(driver.outputFiles[0].text, { headers: { 'Content-Type': 'text/javascript' } })
    if (pathname === '/test-keyboard-save' && request.method === 'POST') {
      await ready
      await keyboard()
      return new Response(null, { status: 204 })
    }
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
  const downloadDirectory = await mkdtemp(join(tmpdir(), 'relay-browser-download-'))
  const args = ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter', '--remote-debugging-port=0', '--user-data-dir=' + profile]
  // 隔离 CI 的内核可能禁止非特权用户命名空间；仅测试步骤显式关闭浏览器沙箱。
  if (process.platform === 'linux' && (process.getuid?.() === 0 || process.env.CHROME_NO_SANDBOX === '1')) args.push('--no-sandbox')
  const child = startBrowser(browser, [...args, 'http://127.0.0.1:' + address.port + pathFor('transfer')])
  t.after(async () => {
    await child.stop()
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
    await rm(downloadDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
  })
  const cdp = await connectBrowser(await child.endpoint(profile))
  t.after(() => cdp.close())
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDirectory, eventsEnabled: true })
  const { targetInfos } = await cdp.send('Target.getTargets')
  const target = targetInfos.find((item: { type: string; url: string }) => item.type === 'page' && item.url.startsWith('http://127.0.0.1:' + address.port))
  assert.ok(target, 'Missing relay browser page')
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId)
  keyboard = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }, sessionId)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
  }
  keyboardReady()
  const timer = setTimeout(() => fail(new Error('Timed out waiting for browser at ' + scenarios[completed.length])), 120_000)
  try {
    await Promise.race([done, child.closed.then(() => { throw child.failure('Chromium exited before completing tests') })])
  } finally { clearTimeout(timer) }
  assert.deepEqual(completed, scenarios)
  assert.equal(mock.ranges.filter(read => read.key === 'oversized').length, 0)
  for (let attempt = 0; attempt < 200 && [...cdp.downloads.values()].filter(state => state === 'completed').length < 2; attempt++) await delay(50)
  assert.equal(cdp.downloads.size, 2, 'Trusted repeated Save must still start two normal browser downloads')
  const expected = createHash('sha256').update(bytesAt(0, sizes.blob)).digest('hex')
  for (const [guid, state] of cdp.downloads) {
    assert.equal(state, 'completed')
    assert.match(guid, /^[a-f0-9-]{36}$/)
    const file = await readFile(join(downloadDirectory, guid))
    assert.equal(file.byteLength, sizes.blob)
    assert.equal(createHash('sha256').update(file).digest('hex'), expected)
  }
  console.log(JSON.stringify({ event: 'browser_trusted_blob_save', saves: 2, bytes: sizes.blob, sha256: expected, viewport: 390, reducedMotion: true }))
})
