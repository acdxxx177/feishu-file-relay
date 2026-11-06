import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocationReader } from '../../src/vps/download-location'

const config = { trustCloudflareGeo: true, trustProxy: true }
const utf8Header = (value: string) => Buffer.from(value, 'utf8').toString('latin1')
const headers = { 'X-Relay-Geo-Trusted': '1', 'X-Relay-Geo-Country': 'CN', 'X-Relay-Geo-Region': utf8Header('上海'), 'X-Relay-Geo-City': utf8Header('上海市') }
const request = (extra: Record<string, string> = {}) => new Request('https://relay.invalid', { headers: { ...headers, ...extra } })

test('geolocation requires both switches and the provenance marker, without socket metadata', () => {
  const read = createLocationReader(config)
  assert.deepEqual(read(request()), { country: 'CN', region: '上海', city: '上海市' })
  for (const disabled of [{ trustCloudflareGeo: false }, { trustProxy: false }]) {
    assert.deepEqual(createLocationReader({ ...config, ...disabled })(request()), {})
  }
  for (const marker of ['', '0', 'true', '1,1']) assert.deepEqual(read(request({ 'X-Relay-Geo-Trusted': marker })), {})
  const missingMarker = request()
  missingMarker.headers.delete('X-Relay-Geo-Trusted')
  assert.deepEqual(read(missingMarker), {})
  assert.deepEqual(read(new Request('https://relay.invalid', { headers: { 'X-Relay-Geo-Trusted': '1', 'CF-IPCountry': 'CN', 'CF-IPCity': 'city', 'X-Real-IP': '203.0.113.1' } })), {})
})

test('location normalization tolerates partial data and rejects unknown codes, malformed UTF-8 and unsafe strings', () => {
  const read = createLocationReader(config)
  for (const country of ['XX', 'ZZ', 'T1', 'AA', 'cn', 'CN,US', '']) {
    assert.equal(read(request({ 'X-Relay-Geo-Country': country })).country, undefined)
  }
  for (const city of ['\u00ff', 'x'.repeat(513), utf8Header('x\u202ey'), 'a,b', '\u0001']) {
    assert.equal(read(request({ 'X-Relay-Geo-City': city })).city, undefined)
  }
  assert.deepEqual(read(request({ 'X-Relay-Geo-Country': '', 'X-Relay-Geo-Region': '', 'X-Relay-Geo-City': utf8Header('München') })), { city: 'München' })
})
