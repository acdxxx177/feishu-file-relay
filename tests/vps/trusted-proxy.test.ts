import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApplication } from '../../src/vps/app'
import { readConfig } from '../../src/vps/config'
import { createFeishuClient } from '../../src/vps/feishu'
import { parseTrustedProxyIps, trustedProxyCheck } from '../../src/vps/trusted-proxy'
import { databaseFixture } from './database-fixture'

const base = {
  FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_VERIFICATION_TOKEN: 'fake', FEISHU_ENCRYPT_KEY: 'fake',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'fake',
}

test('trusted proxy configuration permits exact IPs only and normalizes mapped addresses', () => {
  assert.deepEqual(readConfig(base).trustedProxyIps, [])
  assert.deepEqual(parseTrustedProxyIps(' 172.30.0.1,::1,172.30.0.1 '), ['172.30.0.1', '::1'])
  for (const value of ['*', '172.30.0.0/24', 'proxy.local', '1.2.3.999', '172.30.0.1,', 'fe80::1%eth0']) {
    assert.throws(() => readConfig({ ...base, TRUSTED_PROXY_IPS: value }), /TRUSTED_PROXY_IPS/)
  }
  const trusted = trustedProxyCheck(['172.30.0.1', '2001:db8::1'])
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.30.0.1', '::ffff:ac1e:1', '2001:0db8:0:0:0:0:0:1']) assert.equal(trusted(address), true)
  for (const address of ['172.30.0.2', '203.0.113.1', 'invalid', '2001:db8::2']) assert.equal(trusted(address), false)
})

function harness(env: NodeJS.ProcessEnv = {}) {
  const fixture = databaseFixture()
  const config = readConfig({ ...base, DOWNLOAD_RATE_LIMIT: '1', TRUST_PROXY: 'true', TRUSTED_PROXY_IPS: '172.30.0.1', ...env })
  const application = createApplication(config, fixture.repository, createFeishuClient(config, async () => { throw new Error('Network disabled') }))
  const request = (remote: string, headers: Record<string, string>, path = '/f/invalid') => application.app.request(path, { headers }, {
    incoming: { socket: { remoteAddress: remote } },
  } as never)
  return { fixture, request, close: () => fixture.db.close() }
}

test('trusted bridge gateway and loopback keep separate client quotas; readiness stays loopback-only', async () => {
  const h = harness()
  try {
    assert.equal((await h.request('172.30.0.1', { 'X-Real-IP': '203.0.113.1' })).status, 404)
    assert.equal((await h.request('::ffff:172.30.0.1', { 'X-Real-IP': '203.0.113.2' })).status, 404)
    assert.equal((await h.request('127.0.0.1', { 'X-Real-IP': '203.0.113.3' })).status, 404)
    assert.equal((await h.request('172.30.0.1', { 'X-Real-IP': '203.0.113.1' })).status, 429)
    const before = h.fixture.calls()
    assert.equal((await h.request('172.30.0.1', { 'X-Real-IP': '127.0.0.1' }, '/ready')).status, 404)
    assert.equal(h.fixture.calls(), before)
    assert.equal((await h.request('127.0.0.1', {}, '/ready')).status, 200)
  } finally { h.close() }
})

test('untrusted peers and disabled trust cannot rotate quotas with spoofed headers', async () => {
  for (const env of [{}, { TRUST_PROXY: 'false' }]) {
    const h = harness(env)
    try {
      const remote = env.TRUST_PROXY === 'false' ? '172.30.0.1' : '172.30.0.2'
      assert.equal((await h.request(remote, { 'X-Real-IP': '203.0.113.1' })).status, 404)
      assert.equal((await h.request(remote, { 'X-Real-IP': '203.0.113.2' })).status, 429)
    } finally { h.close() }
  }
})

test('invalid and multi-value real IP headers fall back to socket; other forwarding headers are ignored', async () => {
  const h = harness()
  try {
    assert.equal((await h.request('172.30.0.1', { 'X-Real-IP': '203.0.113.1, 203.0.113.2' })).status, 404)
    assert.equal((await h.request('172.30.0.1', { 'X-Real-IP': 'not-an-ip' })).status, 429)
    assert.equal((await h.request('172.30.0.1', { 'X-Forwarded-For': '203.0.113.3', 'CF-Connecting-IP': '203.0.113.4' })).status, 429)
  } finally { h.close() }
})
