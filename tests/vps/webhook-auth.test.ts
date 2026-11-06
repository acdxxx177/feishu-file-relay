import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { readConfig } from '../../src/vps/config'
import { decodeAndVerify } from '../../src/vps/webhook-auth'

const config = readConfig({
  FEISHU_APP_ID: 'mock-app', FEISHU_APP_SECRET: 'mock-secret',
  FEISHU_VERIFICATION_TOKEN: 'mock-token', FEISHU_ENCRYPT_KEY: 'mock-key',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'mock-d1',
})
const opaqueTimestamp = 'opaque timestamp +0800 m=+123.456'

function callback(overrides: Record<string, unknown> = {}) {
  return { schema: '2.0', header: {
    event_type: 'card.action.trigger', create_time: String(Date.now() * 1000),
    token: config.FEISHU_VERIFICATION_TOKEN, app_id: config.FEISHU_APP_ID, ...overrides,
  }, event: {} }
}

function signed(body = callback(), timestamp = opaqueTimestamp) {
  const raw = JSON.stringify(body)
  const nonce = 'mock-nonce'
  const signature = createHash('sha256').update(timestamp + nonce + config.FEISHU_ENCRYPT_KEY + raw).digest('hex')
  const request = new Request('https://relay.example/webhook/feishu', { method: 'POST', body: raw, headers: {
    'X-Lark-Request-Timestamp': timestamp, 'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': signature,
  } })
  return { raw, request }
}

test('signed modern cards accept opaque timestamp headers and fresh body time in seconds, milliseconds or microseconds', async () => {
  const now = Date.now()
  for (const time of [Math.floor(now / 1000), now, now * 1000]) {
    const body = callback({ create_time: String(time) })
    const { raw, request } = signed(body)
    assert.deepEqual(await decodeAndVerify(raw, request, config), body)
  }
})

test('opaque signed headers do not bypass stale, future, missing or malformed body time checks', async () => {
  for (const createTime of [String((Date.now() - 600000) * 1000), String((Date.now() + 600000) * 1000), undefined, 'invalid']) {
    const { raw, request } = signed(callback({ create_time: createTime }))
    await assert.rejects(decodeAndVerify(raw, request, config), /Expired event/)
  }
})

test('opaque signed headers still require the correct app and token', async () => {
  for (const header of [{ app_id: 'other' }, { token: 'other' }]) {
    const { raw, request } = signed(callback(header))
    await assert.rejects(decodeAndVerify(raw, request, config), /Wrong application|Invalid token/)
  }
})

test('signature covers the exact opaque timestamp, nonce and body', async () => {
  for (const name of ['X-Lark-Request-Timestamp', 'X-Lark-Request-Nonce', 'X-Lark-Signature', 'body']) {
    const { raw, request } = signed()
    if (name !== 'body') request.headers.set(name, name === 'X-Lark-Signature' ? '0'.repeat(64) : 'changed')
    await assert.rejects(decodeAndVerify(name === 'body' ? raw + ' ' : raw, request, config), /Invalid signature/)
  }
})

test('signed cards require all three nonempty signature headers', async () => {
  for (const name of ['X-Lark-Request-Timestamp', 'X-Lark-Request-Nonce', 'X-Lark-Signature']) {
    for (const empty of [false, true]) {
      const { raw, request } = signed()
      if (empty) request.headers.set(name, '')
      else request.headers.delete(name)
      await assert.rejects(decodeAndVerify(raw, request, config), /Missing signature/)
    }
  }
})

test('ordinary events and unsigned or legacy envelopes retain numeric request timestamp checks', async () => {
  for (const eventType of ['im.message.receive_v1', 'im.message.recalled_v1']) {
    for (const timestamp of [opaqueTimestamp, String(Math.floor(Date.now() / 1000) - 600)]) {
      const { raw, request } = signed(callback({ event_type: eventType }), timestamp)
      await assert.rejects(decodeAndVerify(raw, request, config), /Expired request/)
    }
  }
  const unsigned = signed()
  await assert.rejects(decodeAndVerify(unsigned.raw, unsigned.request, { ...config, FEISHU_ENCRYPT_KEY: '' }), /Expired request/)
  const legacy = signed({ ...callback(), schema: '1.0' })
  await assert.rejects(decodeAndVerify(legacy.raw, legacy.request, config), /Expired request/)
})
