import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConfig } from '../../src/vps/config'
import { createFeishuClient, UpstreamError } from '../../src/vps/feishu'

const config = readConfig({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_VERIFICATION_TOKEN: 'verify', FEISHU_ENCRYPT_KEY: 'encrypt',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'test' })
const source = { message_id: 'message', file_key: 'key' }

test('Feishu coalesces token requests and refreshes rejected credentials once; JSON attachments stay binary', async () => {
  let tokenCalls = 0
  let invalid = false
  const client = createFeishuClient(config, async (url, options) => {
    const request = new Request(url, options)
    if (new URL(request.url).pathname === '/oauth/v3/token') {
      tokenCalls++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return Response.json({ access_token: `token-${tokenCalls}`, expires_in: 7200 })
    }
    if (invalid && request.headers.get('Authorization') === 'Bearer token-1') return Response.json({ code: 99991663 }, { status: 401 })
    return new Response('{}', { status: 206, headers: { 'Content-Type': 'application/json', 'Content-Range': 'bytes 0-1/2', 'Content-Length': '2' } })
  })
  try {
    const initial = await Promise.all(Array.from({ length: 10 }, () => client.fetchResource(source, 0, 1)))
    for (const response of initial) assert.equal(await response.text(), '{}')
    assert.equal(tokenCalls, 1)
    invalid = true
    const refreshed = await Promise.all(Array.from({ length: 10 }, () => client.fetchResource(source, 0, 1)))
    for (const response of refreshed) assert.equal(await response.text(), '{}')
    assert.equal(tokenCalls, 2)
  } finally { client.close() }
})

test('Feishu rejects redirects, treats permission errors as temporary and retries only bounded source failures', async () => {
  let mode = 302
  let calls = 0
  const client = createFeishuClient(config, async (_url, options) => {
    if (options?.method === 'POST') return Response.json({ access_token: 'token', expires_in: 7200 })
    assert.equal(options?.redirect, 'manual')
    calls++
    return new Response(null, { status: mode, headers: { Location: 'https://untrusted.invalid' } })
  })
  try {
    await assert.rejects(client.fetchResource(source, 0, 0), (e: unknown) => e instanceof UpstreamError && !e.permanent)
    mode = 403
    await assert.rejects(client.fetchResource(source, 0, 0), (e: unknown) => e instanceof UpstreamError && !e.permanent)
    mode = 404
    await assert.rejects(client.fetchResource(source, 0, 0), (e: unknown) => e instanceof UpstreamError && e.permanent)
    mode = 503
    calls = 0
    await assert.rejects(client.fetchResource(source, 0, 0), UpstreamError)
    assert.equal(calls, 3)
  } finally { client.close() }
})
