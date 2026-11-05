import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConfig } from '../../src/vps/config'
import { CardDeliveryError, CardNotSentError, createFeishuClient, UpstreamError } from '../../src/vps/feishu'
import { buildFileCard } from '../../src/vps/cards/file-card'

const config = readConfig({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_VERIFICATION_TOKEN: 'verify', FEISHU_ENCRYPT_KEY: 'encrypt',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'test' })
const source = { message_id: 'message', file_key: 'key' }

test('direct interactive create and PATCH validate Feishu acknowledgements and failure codes', async () => {
  const card = buildFileCard({ id: 'A'.repeat(22), file_name: '文件', file_size: 10, mime_type: null }, 'active', 'https://example.invalid/f/' + 'A'.repeat(22))
  let result = { code: 0, data: { message_id: 'om_a' } }
  const calls: Request[] = []
  const client = createFeishuClient(config, async (url, options) => {
    const request = new Request(url, options)
    if (new URL(request.url).pathname === '/oauth/v3/token') return Response.json({ access_token: 'token', expires_in: 7200 })
    calls.push(request)
    return Response.json(result, { status: result.code ? 400 : 200 })
  })
  try {
    assert.equal(await client.sendCard('chat', card, 'stable'), 'om_a')
    const sent = calls[0]
    assert.equal(new URL(sent.url).searchParams.get('receive_id_type'), 'chat_id')
    assert.deepEqual(await sent.json(), { receive_id: 'chat', msg_type: 'interactive', uuid: 'stable', content: JSON.stringify(card) })
    await client.updateCard('om_a', card)
    assert.equal(calls[1].method, 'PATCH')
    assert.equal(new URL(calls[1].url).pathname, '/open-apis/im/v1/messages/om_a')
    assert.deepEqual(await calls[1].json(), { content: JSON.stringify(card) })
    result = { code: 0, data: { message_id: '' } }
    await assert.rejects(client.sendCard('chat', card, 'stable'), UpstreamError)
    for (const [code, reason] of [[230099, 'invalid_card'], [230028, 'denied'], [230031, 'expired'], [230011, 'recalled']] as const) {
      result.code = code
      await assert.rejects(client.updateCard('om_a', card), (e: unknown) => e instanceof CardDeliveryError && e.reason === reason)
    }
    result.code = 230049
    await assert.rejects(client.sendCard('chat', card, 'stable'), UpstreamError)
    result.code = 230020
    await assert.rejects(client.sendCard('chat', card, 'stable'), CardNotSentError)
    assert.equal(calls.length, 9)
  } finally { client.close() }
})

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
