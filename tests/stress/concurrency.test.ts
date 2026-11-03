import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { setup, register, digest } from '../helpers.ts'
import { bytesAt } from '../../mocks/feishu-mock.ts'

test('10 个并发 1 GiB 下载内容完整且共享分片回源', { timeout: 1200000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const size = 1024 ** 3
  const hash = createHash('sha256')
  for (let offset = 0; offset < size; offset += 65536) hash.update(bytesAt(offset, 65536))
  const expected = hash.digest('hex')
  const file = await register(h, 'stress-1g', size)
  const started = Date.now()
  const downloads = await Promise.all(Array.from({ length: 10 }, async () => {
    const response = await h.request(`/f/${file.id}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(size))
    return digest(response)
  }))
  for (const result of downloads) assert.deepEqual(result, { sha256: expected, size })
  assert.equal(h.mock.ranges.length, 65, '一个大小探测 + 64个共享分片')
  console.log(JSON.stringify({ concurrentDownloads: 10, bytesEach: size, sha256: expected, originRequests: h.mock.ranges.length, duration_ms: Date.now() - started }))
})
