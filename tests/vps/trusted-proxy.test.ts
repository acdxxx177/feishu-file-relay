import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApplication } from '../../src/vps/app'
import { readConfig } from '../../src/vps/config'
import { createFeishuClient } from '../../src/vps/feishu'
import { databaseFixture } from './database-fixture'

const base = {
  FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_VERIFICATION_TOKEN: 'fake', FEISHU_ENCRYPT_KEY: 'fake',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'fake',
}

test('legacy proxy IP configuration is ignored, including values rejected by old versions', () => {
  for (const value of ['', '172.29.0.4', '*', '172.30.0.0/24', 'proxy.local', '1.2.3.999', '172.30.0.1,', 'fe80::1%eth0']) {
    assert.deepEqual(readConfig({ ...base, TRUSTED_PROXY_IPS: value }), readConfig(base))
  }
  assert.equal(readConfig(base).trustProxy, false)
})

function harness(env: NodeJS.ProcessEnv = {}) {
  const fixture = databaseFixture()
  const config = readConfig({ ...base, DOWNLOAD_RATE_LIMIT: '1', TRUST_PROXY: 'true', ...env })
  const application = createApplication(config, fixture.repository, createFeishuClient(config, async () => { throw new Error('Network disabled') }))
  const request = (remote: string, headers: Record<string, string>, path = '/f/invalid') => application.app.request(path, { headers }, {
    incoming: { socket: { remoteAddress: remote } },
  } as never)
  return { fixture, request, close: () => fixture.db.close() }
}

test('enabled proxy headers keep per-client quotas across changing Docker addresses and ignore old IP lists', async () => {
  for (const env of [{}, { TRUSTED_PROXY_IPS: '172.29.0.4' }, { TRUSTED_PROXY_IPS: 'nginx' }]) {
    const h = harness(env)
    try {
      const peers = ['172.31.0.4', '::ffff:172.31.0.4', '2001:db8::4', '203.0.113.10', '127.0.0.1']
      for (const [index, remote] of peers.entries()) {
        const client = `203.0.113.${index + 1}`
        assert.equal((await h.request(remote, { 'X-Real-IP': client })).status, 404)
        assert.equal((await h.request('172.32.0.4', { 'X-Real-IP': client })).status, 429)
      }
      assert.equal((await h.request('172.31.0.4', { 'X-Real-IP': '2001:db8::100' })).status, 404)
      assert.equal((await h.request('172.32.0.4', { 'X-Real-IP': '2001:db8::100' })).status, 429)
    } finally { h.close() }
  }
})

test('readiness requires a real loopback socket even with forwarded loopback addresses', async () => {
  const h = harness()
  try {
    const before = h.fixture.calls()
    for (const remote of ['172.31.0.4', '::ffff:172.31.0.4', '2001:db8::4', '203.0.113.10']) {
      assert.equal((await h.request(remote, { 'X-Real-IP': '127.0.0.1', 'X-Forwarded-For': '::1', 'CF-Connecting-IP': '127.0.0.1' }, '/ready')).status, 404)
    }
    assert.equal(h.fixture.calls(), before)
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal((await h.request(remote, {}, '/ready')).status, 200)
    }
  } finally { h.close() }
})

test('disabled or omitted proxy trust uses the socket despite forwarded IP changes', async () => {
  for (const env of [{ TRUST_PROXY: 'false' }, { TRUST_PROXY: undefined }]) {
    const h = harness(env)
    try {
      assert.equal((await h.request('172.31.0.4', { 'X-Real-IP': '203.0.113.1' })).status, 404)
      assert.equal((await h.request('172.31.0.4', { 'X-Real-IP': '203.0.113.2' })).status, 429)
      assert.equal((await h.request('172.32.0.4', { 'X-Real-IP': '203.0.113.1' })).status, 404)
    } finally { h.close() }
  }
})

test('invalid and multi-value real IP headers fall back to socket; other forwarding headers are ignored', async () => {
  const h = harness()
  try {
    assert.equal((await h.request('172.31.0.4', {})).status, 404)
    assert.equal((await h.request('172.31.0.4', { 'X-Real-IP': '' })).status, 429)
    assert.equal((await h.request('172.30.0.1', { 'X-Real-IP': '203.0.113.1, 203.0.113.2' })).status, 404)
    assert.equal((await h.request('172.30.0.1', { 'X-Real-IP': 'not-an-ip' })).status, 429)
    assert.equal((await h.request('172.30.0.1', { 'X-Forwarded-For': '203.0.113.3', 'CF-Connecting-IP': '203.0.113.4' })).status, 429)
  } finally { h.close() }
})
