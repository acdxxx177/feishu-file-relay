import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { setup, register, eventually } from './helpers.ts'
import { bytesAt } from '../mocks/feishu-mock.ts'

test('JSON MIME 附件作为二进制登记并下载', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  h.mock.files.set('json-mime', { size: 10000, mimeType: 'application/json' })
  const { event } = await import('./helpers.ts')
  await h.post(event('json-mime'))
  const file = await eventually<{ id: string; status: string } | null>(() => h.db.prepare('SELECT id,status FROM files WHERE message_id=?').bind('json-mime').first<{ id: string; status: string }>(), (value) => value?.status === 'active')
  const response = await h.request(`/f/${file!.id}/download`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesAt(0, 10000))
})

test('Cache API 不可用时下载仍正确且允许重新回源', { timeout: 60000 }, async (t) => {
  const h = await setup({ cacheApi: false })
  t.after(() => h.mf.dispose())
  const file = await register(h, 'cache-disabled')
  for (let i = 0; i < 2; i++) {
    const response = await h.request(`/f/${file.id}/download`)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesAt(0, 10000))
  }
  assert.equal(h.mock.ranges.length, 3)
})

test('冷分片并发合并回源、每个客户内容正确', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const file = await register(h, 'concurrent', 1024 * 1024)
  h.mock.files.get('concurrent')!.headerDelayMs = 100
  const calls = h.mock.ranges.length
  const bodies = await Promise.all(Array.from({ length: 5 }, async () => {
    const response = await h.request(`/f/${file.id}/download`)
    assert.equal(response.status, 200)
    return Buffer.from(await response.arrayBuffer())
  }))
  for (const body of bodies) assert.deepEqual(body, bytesAt(0, 1024 * 1024))
  assert.equal(h.mock.ranges.length - calls, 1)
})

test('冷分片首客户取消后，等待客户仍可重试并完整接收', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const size = 4 * 1024 * 1024
  const file = await register(h, 'leader-cancel', size)
  const response = await h.request(`/f/${file.id}/download`)
  const reader = response.body!.getReader()
  assert.equal((await reader.read()).done, false)
  const follower = h.request(`/f/${file.id}/download`)
  await reader.cancel()
  const other = await follower
  assert.equal(other.status, 200)
  assert.deepEqual(Buffer.from(await other.arrayBuffer()), bytesAt(0, size))
})

test('响应头前收到取消信号，及时结束回源且不计下载', { timeout: 60000 }, async (t) => {
  // 本地workerd在HTTP响应写出前不通知socket断开；从测试入口在运行时注入同一种Request.signal。
  const h = await setup({ injectAbort: true })
  t.after(() => h.mf.dispose())
  const file = await register(h, 'cancel-headers')
  h.mock.files.get('cancel-headers')!.headerDelayMs = 2000
  const calls = h.mock.ranges.length
  const started = Date.now()
  const response = await h.request(`/f/${file.id}/download`, { headers: { 'X-Test-Abort': '1' } })
  assert.equal(response.status, 503)
  assert.ok(Date.now() - started < 1500, '取消后不应等待2秒源站响应头')
  await setTimeout(2300)
  assert.equal(h.mock.ranges.length, calls + 1)
  assert.equal((await h.db.prepare('SELECT download_count AS n FROM files WHERE id=?').bind(file.id).first<{ n: number }>())?.n, 0)
})
