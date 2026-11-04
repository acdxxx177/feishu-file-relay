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
  const config = { ...readConfig({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_VERIFICATION_TOKEN: 'token', FEISHU_ENCRYPT_KEY: 'key',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'fake' }), port: 0, trustProxy: true }
  const id = 'N'.repeat(22)
  await f.repository.registerFile('proxy-event', { id, message_id: 'proxy-file', file_key: 'proxy-file', file_name: 'proxy.zip', uploader_open_id: 'owner', chat_id: 'chat' })
  await f.repository.finishValidation((await f.repository.claimPending(id))!, size, null, 'published')
  const runtime = startServer(config, f.repository, createFeishuClient(config, (input, init) => mock.handle(new Request(input, init))))
  if (!runtime.server.listening) await once(runtime.server, 'listening')
  const address = runtime.server.address()
  assert.ok(address && typeof address !== 'string')
  const port = await freePort()
  const httpPort = await freePort()
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  assert.equal(cert.status, 0)
  const site = (await readFile('deploy/nginx.conf', 'utf8'))
    .replace('listen 80;', `listen 127.0.0.1:${httpPort};`).replace('listen 443 ssl;', `listen 127.0.0.1:${port} ssl;`)
    .replaceAll('http://127.0.0.1:3000', `http://127.0.0.1:${address.port}`)
    .replace('/etc/letsencrypt/live/dl.sinoballvalve.com/fullchain.pem', join(directory, 'cert.pem'))
    .replace('/etc/letsencrypt/live/dl.sinoballvalve.com/privkey.pem', join(directory, 'key.pem'))
    .replace('/var/log/nginx/feishu-relay-error.log', join(directory, 'error.log'))
  const nginxConfig = join(directory, 'nginx.conf')
  await writeFile(nginxConfig, `pid ${directory}/nginx.pid; error_log ${directory}/error.log; events {} http { access_log off; client_body_temp_path ${directory}/body; proxy_temp_path ${directory}/proxy; fastcgi_temp_path ${directory}/fastcgi; uwsgi_temp_path ${directory}/uwsgi; scgi_temp_path ${directory}/scgi; ${site} }`)
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
