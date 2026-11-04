import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupStreaming, expectedDigest, digest } from '../streaming-harness'

test('ten concurrent Node HTTP 1 GiB downloads without cache', { timeout: 1_200_000 }, async (t) => {
  const size = 1024 ** 3
  const h = await setupStreaming(size)
  t.after(() => h.close())
  const expected = expectedDigest(size)
  const startRss = process.memoryUsage().rss
  let peakRss = startRss
  const started = Date.now()
  const cpu = process.cpuUsage()
  const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 25)
  t.after(() => clearInterval(monitor))
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const response = await fetch(`${h.url}/download`)
    assert.equal(response.status, 200)
    return digest(response)
  }))
  for (const result of results) assert.deepEqual(result, { bytes: size, sha256: expected })
  assert.equal(h.mock.ranges.length, 640)
  assert.equal(h.dbReads, 80)
  assert.ok(peakRss - startRss < 768 * 1024 * 1024, 'bounded aggregate source/relay/client process memory')
  console.log(JSON.stringify({ concurrency: 10, bytesEach: size, sha256: expected, originRequests: h.mock.ranges.length, dbReads: h.dbReads,
    durationMs: Date.now() - started, startRss, peakRss, cpuMicros: process.cpuUsage(cpu) }))
})
