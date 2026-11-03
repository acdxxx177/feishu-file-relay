import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { bytesAt } from '../../mocks/feishu-mock.ts'
import { setup, register, digest } from '../helpers.ts'

for (const mib of [100, 500, 1024]) {
  test(`${mib} MiB 完整下载、中断续传 SHA-256、缓存回源次数`, { timeout: 600000 }, async (t) => {
    const h = await setup()
    t.after(() => h.mf.dispose())
    const size = mib * 1024 * 1024
    const expectedHash = createHash('sha256')
    for (let offset = 0; offset < size; offset += 65536) expectedHash.update(bytesAt(offset, Math.min(65536, size - offset)))
    const expected = expectedHash.digest('hex')
    const file = await register(h, `large-${mib}`, size)
    const path = `/f/${file.id}`
    const full = await h.request(path)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-length'), String(size))
    assert.deepEqual(await digest(full), { sha256: expected, size })
    const coldCalls = h.mock.ranges.length
    assert.equal(coldCalls, Math.ceil(size / (16 * 1024 * 1024)) + 1)
    // 真实取消读取后，从实际已收字节续传；断点故意不按分片边界对齐。
    const interrupted = await h.request(path)
    const reader = interrupted.body!.getReader()
    const resumedHash = createHash('sha256')
    let received = 0
    while (received < 17 * 1024 * 1024 + 123) {
      const { done, value } = await reader.read()
      assert.equal(done, false)
      resumedHash.update(value!)
      received += value!.length
    }
    await reader.cancel()
    const resumed = await h.request(path, { headers: { Range: `bytes=${received}-`, 'If-Range': full.headers.get('etag')! } })
    assert.equal(resumed.status, 206)
    for await (const chunk of resumed.body!) { resumedHash.update(chunk); received += chunk.length }
    assert.equal(received, size)
    assert.equal(resumedHash.digest('hex'), expected)
    assert.equal(h.mock.ranges.length, coldCalls, '热缓存完整/续传不应再次回源')
    console.log(JSON.stringify({ mib, bytes: size, sha256: expected, coldOriginCalls: coldCalls, resumedAdditionalOriginCalls: 0 }))
  })
}
