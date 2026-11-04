import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// 仅访问操作者已获授权的公开测试链接；本脚本不发送飞书消息、不登记文件。
const inputUrl = process.env.DOWNLOAD_URL
const url = inputUrl ? inputUrl.replace(/(\/f\/[A-Za-z0-9]{22})\/?$/, '$1/download') : undefined
const expected = process.env.EXPECTED_SHA256?.toLowerCase()
if (!url || !expected || !/^[a-f0-9]{64}$/.test(expected)) {
  throw new Error('请设置 DOWNLOAD_URL 和原文件 EXPECTED_SHA256；脚本会完整下载并验证续传')
}
const head = await fetch(url, { method: 'HEAD' })
assert.equal(head.status, 200)
const total = Number(head.headers.get('content-length'))
assert.ok(Number.isSafeInteger(total) && total > 0)
const etag = head.headers.get('etag')!
const started = Date.now()
const full = await fetch(url)
assert.equal(full.status, 200)
const fullHash = createHash('sha256')
let fullBytes = 0
for await (const chunk of full.body!) { fullHash.update(chunk); fullBytes += chunk.length }
assert.equal(fullBytes, total)
assert.equal(fullHash.digest('hex'), expected)
const interrupted = await fetch(url)
const reader = interrupted.body!.getReader()
let received = 0
const resumedHash = createHash('sha256')
while (received < Math.min(total / 2, 17 * 1024 * 1024 + 123)) {
  const { value, done } = await reader.read()
  assert.equal(done, false)
  resumedHash.update(value!)
  received += value!.length
}
await reader.cancel()
if (received < total) {
  const resumed = await fetch(url, { headers: { Range: `bytes=${received}-`, 'If-Range': etag } })
  assert.equal(resumed.status, 206)
  assert.equal(resumed.headers.get('content-range'), `bytes ${received}-${total - 1}/${total}`)
  for await (const chunk of resumed.body!) { resumedHash.update(chunk); received += chunk.length }
}
assert.equal(received, total)
assert.equal(resumedHash.digest('hex'), expected)
console.log(JSON.stringify({ status: 'passed', bytes: total, sha256: expected, duration_ms: Date.now() - started }))
