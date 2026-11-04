import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { setupStreaming } from './streaming-harness'
import { serve } from '@hono/node-server'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { safeNodeResponse } from '../../src/vps/node-response'

test('actual Node client disconnect aborts source while waiting for response headers', { timeout: 15_000 }, async (t) => {
  const h = await setupStreaming(1024 * 1024)
  t.after(() => h.close())
  h.mock.files.set('key', { size: 1024 * 1024, headerDelayMs: 5000 })
  const abort = new AbortController()
  const transfer = fetch(`${h.url}/download`, { signal: abort.signal }).catch(() => null)
  for (let attempt = 0; attempt < 100 && h.mock.ranges.length === 0; attempt++) await delay(10)
  assert.equal(h.mock.ranges.length, 1)
  abort.abort()
  await transfer
  for (let attempt = 0; attempt < 100 && h.mock.abortedRanges.length === 0; attempt++) await delay(10)
  assert.deepEqual(h.mock.abortedRanges, ['key'])
})

test('actual Node HTTP truncated body is surfaced as incomplete transfer', { timeout: 15_000 }, async (t) => {
  const h = await setupStreaming(1024 * 1024)
  t.after(() => h.close())
  h.mock.files.set('key', { size: 1024 * 1024, mode: 'truncate' })
  const response = await fetch(`${h.url}/download`)
  // 源站可能在 Node 适配器发送响应头前失败，此时应转为 503；已发 200 则必须中断。
  if (response.status === 503) { await response.body?.cancel(); return }
  assert.equal(response.status, 200)
  await assert.rejects(response.arrayBuffer())
})

test('Node adapter cannot append error text to fill a one-byte short response', { timeout: 15_000 }, async (t) => {
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch(_request, bindings) {
    let sent = false
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new Uint8Array([42])); return }
      await delay(20)
      controller.error(new Error('DO NOT APPEND THESE BYTES'))
    } }, { highWaterMark: 0 })
    return safeNodeResponse(new Response(body, { headers: { 'Content-Length': '2', 'Content-Type': 'application/octet-stream' } }), bindings.outgoing)
  } }) as Server
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await assert.rejects(async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}`)
    await response.arrayBuffer()
  })
})
