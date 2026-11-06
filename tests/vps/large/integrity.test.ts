import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { setupStreaming, expectedDigest, digest } from '../streaming-harness'

for (const mib of [100, 500, 1024]) {
  test(`Node HTTP ${mib} MiB full and interrupted/resumed SHA-256 without cache`, { timeout: 600_000 }, async (t) => {
    const size = mib * 1024 * 1024
    const h = await setupStreaming(size)
    t.after(() => h.close())
    const expected = expectedDigest(size)
    const startRss = process.memoryUsage().rss
    let peakRss = startRss
    const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 25)
    t.after(() => clearInterval(monitor))
    const full = await fetch(`${h.url}/download`)
    assert.equal(full.headers.get('Content-Length'), String(size))
    assert.deepEqual(await digest(full), { bytes: size, sha256: expected })
    const partial = await fetch(`${h.url}/download`)
    const reader = partial.body!.getReader()
    const resumedHash = createHash('sha256')
    let received = 0
    while (received < 17 * 1024 * 1024 + 123) {
      const { value, done } = await reader.read()
      assert.equal(done, false)
      resumedHash.update(value!); received += value!.byteLength
    }
    await reader.cancel()
    const resumed = await fetch(`${h.url}/download`, { headers: { Range: `bytes=${received}-`, 'If-Range': full.headers.get('ETag')! } })
    assert.equal(resumed.status, 206)
    for await (const block of resumed.body!) { resumedHash.update(block); received += block.byteLength }
    assert.equal(received, size)
    assert.equal(resumedHash.digest('hex'), expected)
    assert.equal(h.notifications.length, 0)
    const session = await fetch(`${h.url}/download-session`, { method: 'POST',
      headers: { Origin: 'https://relay.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'native', etag: full.headers.get('ETag') }) })
    assert.equal(session.status, 200)
    const { token } = await session.json()
    const complete = () => fetch(`${h.url}/download-complete`, { method: 'POST',
      headers: { Origin: 'https://relay.invalid', 'Content-Type': 'application/json', 'X-Download-Session': token }, body: '{"method":"native"}' })
    assert.equal((await complete()).status, 409)
    // 浏览器接口用同一真实 HTTP 链路逐片验证，无整文件内存汇总。
    const browserHash = createHash('sha256')
    for (let start = 0; start < size; start += 16 * 1024 * 1024) {
      const end = Math.min(size - 1, start + 16 * 1024 * 1024 - 1)
      const headers = { Range: `bytes=${start}-${end}`, 'If-Match': full.headers.get('ETag')!, 'X-Download-Session': token }
      if (start === 16 * 1024 * 1024) {
        // 模拟浏览器丢弃失败片段后重试；不把已读的局部字节计入提交哈希或完成覆盖。
        const interrupted = await fetch(`${h.url}/chunk`, { headers })
        const reader = interrupted.body!.getReader()
        await reader.read(); await reader.cancel()
        assert.equal((await complete()).status, 409)
      }
      const response = await fetch(`${h.url}/chunk`, { headers })
      assert.equal(response.status, 206)
      for await (const block of response.body!) browserHash.update(block)
    }
    assert.equal(browserHash.digest('hex'), expected)
    assert.equal((await complete()).status, 204)
    assert.equal((await complete()).status, 204)
    assert.equal(h.notifications.length, 1)
    console.log(JSON.stringify({ mib, sha256: expected, originRequests: h.mock.ranges.length, dbReads: h.dbReads, startRss, peakRss }))
    assert.ok(peakRss - startRss < 512 * 1024 * 1024, 'single transfer working memory must not scale to a complete file')
  })
}
