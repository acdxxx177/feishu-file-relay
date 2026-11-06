import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocationReader } from '../../src/vps/download-location'

const config = { trustCloudflareGeo: true, trustProxy: true, trustedProxyIps: ['172.30.0.1', '2001:db8::1'] }
const utf8Header = (value: string) => Buffer.from(value, 'utf8').toString('latin1')
const headers = { 'X-Relay-Geo-Trusted': '1', 'X-Relay-Geo-Country': 'CN', 'X-Relay-Geo-Region': utf8Header('上海'), 'X-Relay-Geo-City': utf8Header('上海市') }
const request = (extra: Record<string, string> = {}) => new Request('https://relay.invalid', { headers: { ...headers, ...extra } })

test('geolocation requires opt-in, trusted proxy and overwritten provenance marker; ignores raw CF/IP headers', () => {
  const read = createLocationReader(config)
  for (const peer of ['127.0.0.1', '::1', '172.30.0.1', '::ffff:172.30.0.1', '2001:db8::1']) {
    assert.deepEqual(read(request(), peer), { country: 'CN', region: '上海', city: '上海市' })
  }
  for (const peer of [undefined, '192.0.2.1', '172.30.0.2']) assert.deepEqual(read(request(), peer), {})
  for (const disabled of [{ trustCloudflareGeo: false }, { trustProxy: false }]) {
    assert.deepEqual(createLocationReader({ ...config, ...disabled })(request(), '127.0.0.1'), {})
  }
  assert.deepEqual(read(request({ 'X-Relay-Geo-Trusted': '0' }), '127.0.0.1'), {})
  assert.deepEqual(read(new Request('https://relay.invalid', { headers: { 'CF-IPCountry': 'CN', 'CF-IPCity': 'city', 'X-Real-IP': '203.0.113.1' } }), '127.0.0.1'), {})
})

test('location normalization tolerates partial data and rejects unknown codes, malformed UTF-8 and unsafe strings', () => {
  const read = createLocationReader(config)
  for (const country of ['XX', 'ZZ', 'T1', 'AA', 'cn', 'CN,US', '']) {
    assert.equal(read(request({ 'X-Relay-Geo-Country': country }), '127.0.0.1').country, undefined)
  }
  for (const city of ['\u00ff', 'x'.repeat(513), utf8Header('x\u202ey'), 'a,b', '\u0001']) {
    assert.equal(read(request({ 'X-Relay-Geo-City': city }), '127.0.0.1').city, undefined)
  }
  assert.deepEqual(read(request({ 'X-Relay-Geo-Country': '', 'X-Relay-Geo-Region': '', 'X-Relay-Geo-City': utf8Header('München') }), '127.0.0.1'), { city: 'München' })
})
