import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage } from 'node:http'
import { databaseFixture } from '../database-fixture'
import { readConfig } from '../../../src/vps/config'
import { createFeishuClient } from '../../../src/vps/feishu'
import { startServer } from '../../../src/vps/server'
import { createMock } from '../../../mocks/feishu-mock'
import { expectedDigest } from '../streaming-harness'
import type { FirstDownloadSnapshot } from '../../../src/db/repository'

async function freePort(): Promise<number> {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return address.port
}

test('Linux HTTPS Nginx proxy preserves streaming, Range, revocation and disconnect without file spooling', { skip: process.platform !== 'linux' || !process.env.NGINX_TEST_BINARY }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-relay-proxy-'))
  const f = await databaseFixture()
  const mock = createMock()
  const size = 100 * 1024 * 1024
  mock.files.set('proxy-file', { size })
  mock.files.set('geo-file', { size: 64 })
  const config = { ...readConfig({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_VERIFICATION_TOKEN: 'token', FEISHU_ENCRYPT_KEY: 'key',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'fake',
    PUBLIC_BASE_URL: 'https://relay.invalid', FIRST_DOWNLOAD_NOTIFICATION_ENABLED: 'true', TRUST_CLOUDFLARE_GEO: 'true' }), port: 0, trustProxy: true }
  const id = 'N'.repeat(22)
  await f.repository.registerFile('proxy-event', { id, message_id: 'proxy-file', file_key: 'proxy-file', file_name: 'proxy.zip', uploader_open_id: 'owner', chat_id: 'chat' })
  await f.repository.finishValidation((await f.repository.claimPending(id))!, size, null, 'published')
  const geoId = 'G'.repeat(22)
  await f.repository.registerFile('geo-event', { id: geoId, message_id: 'geo-file', file_key: 'geo-file', file_name: 'geo.zip', uploader_open_id: 'owner', chat_id: 'chat', first_download_notification: 1 })
  await f.repository.finishValidation((await f.repository.claimPending(geoId))!, 64, null, 'published')
  const locations: FirstDownloadSnapshot['location'][] = []
  const recordFirstDownload = f.repository.recordFirstDownload.bind(f.repository)
  f.repository.recordFirstDownload = async (fileId, version, snapshot) => {
    locations.push(snapshot.location)
    return recordFirstDownload(fileId, version, snapshot)
  }
  const runtime = startServer(config, f.repository, createFeishuClient(config, (input, init) => mock.handle(new Request(input, init))))
  runtime.application.app.on(['GET', 'POST'], '/test-location-headers', c => c.json({
    region: Array.from(c.req.header('X-Relay-Geo-Region') ?? '', char => char.charCodeAt(0)),
    city: Array.from(c.req.header('X-Relay-Geo-City') ?? '', char => char.charCodeAt(0)),
  }))
  if (!runtime.server.listening) await once(runtime.server, 'listening')
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const port = await freePort()
  const httpPort = await freePort()
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  assert.equal(cert.status, 0)
  const site = (await readFile('deploy/nginx.conf', 'utf8'))
    // 仅测试配置模拟 Cloudflare TCP 对端，并重写 remote_addr，验证判断仍使用原始对端。
    .replace('default 0;', 'default 0; 127.0.0.2 1; ::1 1;')
    .replace('listen 80;', `listen 127.0.0.1:${httpPort};`).replace('listen 443 ssl;', `listen 127.0.0.1:${port} ssl; listen [::1]:${port} ssl;`)
    .replaceAll('http://127.0.0.1:3000', `http://127.0.0.1:${address.port}`)
    .replace('/etc/letsencrypt/live/dl.sinoballvalve.com/fullchain.pem', join(directory, 'cert.pem'))
    .replace('/etc/letsencrypt/live/dl.sinoballvalve.com/privkey.pem', join(directory, 'key.pem'))
    .replace('/var/log/nginx/feishu-relay-error.log', join(directory, 'error.log'))
  const nginxConfig = join(directory, 'nginx.conf')
  await writeFile(nginxConfig, `pid ${directory}/nginx.pid; error_log ${directory}/error.log; events {} http { access_log off; set_real_ip_from 127.0.0.2; set_real_ip_from ::1; real_ip_header CF-Connecting-IP; client_body_temp_path ${directory}/body; proxy_temp_path ${directory}/proxy; fastcgi_temp_path ${directory}/fastcgi; uwsgi_temp_path ${directory}/uwsgi; scgi_temp_path ${directory}/scgi; ${site} }`)
  const binary = resolve(process.env.NGINX_TEST_BINARY!)
  const syntax = spawnSync(binary, ['-p', directory, '-c', nginxConfig, '-t'], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  const nginx = spawn(binary, ['-p', directory, '-c', nginxConfig, '-g', 'daemon off;'], { stdio: 'ignore' })
  const request = (path: string, headers: Record<string, string> = {}) => new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port, path, headers, rejectUnauthorized: false }, resolve)
    req.once('error', reject); req.end()
  })
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      try { const response = await request('/health'); response.resume(); if (response.statusCode === 200) { ready = true; break } } catch {}
      await delay(25)
    }
    assert.ok(ready)
    const geoRequest = (path: string, peer: string, headers: Record<string, string>, body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpsRequest({ hostname: peer.includes(':') ? '::1' : '127.0.0.1', localAddress: peer, port, path, method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false,
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }) } }, async res => {
        try { const chunks: Buffer[] = []; for await (const chunk of res) chunks.push(chunk); resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }) } catch (error) { reject(error) }
      })
      // 用 Buffer 发送正文，避免 Node 的 string-body 快路径把 Latin-1 header 再次 UTF-8 编码。
      req.once('error', reject); req.end(body === undefined ? undefined : Buffer.from(body))
    })
    for (const peer of ['127.0.0.1', '127.0.0.2', '::1']) {
      const headers = { Origin: config.PUBLIC_BASE_URL, 'CF-Connecting-IP': '203.0.113.42', 'CF-IPCountry': 'CN',
        'CF-Region': Buffer.from('上海').toString('latin1'), 'CF-IPCity': Buffer.from('上海市').toString('latin1'),
        'X-Relay-Geo-Trusted': '1', 'X-Relay-Geo-Country': 'US', 'X-Relay-Geo-City': 'spoofed' }
      const probe = await geoRequest('/test-location-headers', peer, headers)
      assert.deepEqual(JSON.parse(probe.body), peer === '127.0.0.1' ? { region: [], city: [] } : {
        region: [...Buffer.from('上海')], city: [...Buffer.from('上海市')],
      })
      const postProbe = await geoRequest('/test-location-headers', peer, headers, '{}')
      assert.deepEqual(JSON.parse(postProbe.body), JSON.parse(probe.body))
      const started = await geoRequest(`/api/files/${geoId}/download-session`, peer, headers, JSON.stringify({ method: 'blob', etag: `"${geoId}-v1"` }))
      assert.equal(started.status, 200)
      const token = JSON.parse(started.body).token as string
      assert.equal((await geoRequest(`/api/files/${geoId}/chunk`, peer, { ...headers, Range: 'bytes=0-63', 'If-Match': `"${geoId}-v1"`, 'X-Download-Session': token })).status, 206)
      assert.equal((await geoRequest(`/api/files/${geoId}/download-complete`, peer, { ...headers, 'X-Download-Session': token }, '{"method":"blob"}')).status, 204)
    }
    assert.deepEqual(locations, [{}, { country: 'CN', region: '上海', city: '上海市' }, { country: 'CN', region: '上海', city: '上海市' }])
    const denied = await request('/ready'); assert.equal(denied.statusCode, 404); denied.resume()
    const full = await request(`/f/${id}/download`)
    assert.equal(full.statusCode, 200)
    assert.equal(full.headers['content-length'], String(size))
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of full) { hash.update(chunk); bytes += chunk.length }
    assert.equal(bytes, size)
    assert.equal(hash.digest('hex'), expectedDigest(size))
    const range = await request(`/f/${id}/download`, { Range: 'bytes=0-0' })
    assert.equal(range.statusCode, 206)
    let oneByte = 0
    for await (const chunk of range) oneByte += chunk.length
    assert.equal(oneByte, 1)
    mock.files.set('proxy-file', { size, headerDelayMs: 3000 })
    const start = mock.ranges.length
    const canceled = httpsRequest({ hostname: '127.0.0.1', port, path: `/f/${id}/download`, rejectUnauthorized: false })
    canceled.on('error', () => {}); canceled.end()
    for (let i = 0; i < 100 && mock.ranges.length === start; i++) await delay(20)
    canceled.destroy()
    for (let i = 0; i < 100 && !mock.abortedRanges.includes('proxy-file'); i++) await delay(20)
    assert.ok(mock.abortedRanges.includes('proxy-file'))
    await f.repository.recallFile('proxy-recall', 'proxy-file')
    const recalled = await request(`/f/${id}/download`); assert.equal(recalled.statusCode, 410); recalled.resume()
    for (const name of ['body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) assert.deepEqual(await readdir(join(directory, name)), [])
  } finally {
    const exit = once(nginx, 'exit')
    nginx.kill('SIGQUIT'); await exit
    await runtime.close(); f.db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
