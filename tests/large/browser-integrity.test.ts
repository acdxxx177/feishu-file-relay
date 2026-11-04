import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, unlink, rmdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup, register } from '../helpers.ts'
import { bytesAt } from '../../mocks/feishu-mock.ts'
import { downloadChunks, type DownloadMetadata, type DownloadSink } from '../../src/browser/download-controller.ts'

for (const mib of [1, 20, 100, 500, 1024]) {
  test(`${mib} MiB 浏览器控制器分片写盘及中断恢复 SHA-256（模拟文件保存 API）`, { timeout: 600000 }, async (t) => {
    // 本组隔离验证字节完整性；真实限流和 Retry-After 由功能测试单独覆盖。
    const h = await setup({ downloadRateLimit: 6000, bindings: { BROWSER_CHUNK_SIZE: '1048576', BROWSER_CHUNK_CACHE_ENABLED: 'false', UPSTREAM_READ_TIMEOUT_MS: '30000' } })
    t.after(() => h.mf.dispose())
    const size = mib * 1024 * 1024
    const file = await register(h, `browser-${mib}`, size)
    const metadata = await (await h.request(`/api/files/${file.id}`)).json() as DownloadMetadata
    const expected = createHash('sha256')
    for (let offset = 0; offset < size; offset += 65536) expected.update(bytesAt(offset, Math.min(65536, size - offset)))
    const sourceSha256 = expected.digest('hex')
    const directory = await mkdtemp(join(tmpdir(), 'relay-browser-'))
    const path = join(directory, 'download.bin')
    t.after(async () => { await unlink(path).catch(() => {}); await rmdir(directory) })
    for (const interrupted of [false, true]) {
      const output = await open(path, 'w')
      const sink: DownloadSink = {
        async write(position, bytes) {
          let written = 0
          while (written < bytes.byteLength) written += (await output.write(bytes, written, bytes.byteLength - written, position + written)).bytesWritten
        },
        truncate: (length) => output.truncate(length),
        close: () => output.close(),
        abort: () => output.close(),
      }
      let cut = false
      let requests = 0
      await downloadChunks(metadata, sink, {
        signal: new AbortController().signal, wait: async () => {},
        fetcher: async (_input, init) => {
          requests++
          const received = await h.request(`/api/files/${file.id}/chunk`, { headers: Object.fromEntries(new Headers(init?.headers)) })
          // 真实请求/缓存仍由 workerd 执行；仅在客户端桥接层模拟中途网络中断。
          const source = received.body!.getReader()
          let bytes = 0
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await source.read()
              if (done) { controller.close(); return }
              if (interrupted && !cut && bytes + value.byteLength > 137123) {
                cut = true
                await source.cancel()
                controller.error(new TypeError('simulated network interruption'))
              } else { bytes += value.byteLength; controller.enqueue(value) }
            },
            cancel: () => source.cancel(),
          })
          return new Response(body, { status: received.status, headers: Object.fromEntries(received.headers) })
        },
      })
      const actual = createHash('sha256')
      let received = 0
      for await (const bytes of createReadStream(path)) { actual.update(bytes); received += bytes.length }
      const actualSha256 = actual.digest('hex')
      assert.equal(received, size)
      assert.equal(actualSha256, sourceSha256)
      assert.equal(requests, Math.ceil(size / metadata.chunkSize) + (interrupted ? 1 : 0))
      console.log(JSON.stringify({ test: 'browser-integrity', mib, interrupted, received, requests, sourceSha256, actualSha256 }))
    }
  })
}
