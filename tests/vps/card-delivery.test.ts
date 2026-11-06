import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { FileCard } from '../../src/vps/cards/file-card'
import { CHUNK_SIZE } from '../../src/vps/chunks'
import { readConfig } from '../../src/vps/config'
import { createDownloadHandlers } from '../../src/vps/download'
import { CardDeliveryError, CardNotSentError, createFeishuClient, type FeishuClient, type NotificationCard } from '../../src/vps/feishu'
import { runScheduled, type IntakeContext } from '../../src/vps/intake'
import { databaseFixture } from './database-fixture'

const config = readConfig({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_VERIFICATION_TOKEN: 'verify', FEISHU_ENCRYPT_KEY: 'encrypt',
  PUBLIC_BASE_URL: 'https://relay.invalid', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'test' })
const file = { id: 'A'.repeat(22), message_id: 'employee-message', file_key: 'resource', file_name: '测试.pdf', uploader_open_id: 'owner', chat_id: 'private' }
const receipt = 'om_application_card'
const publication = 'active:card:' + file.id
const url = config.PUBLIC_BASE_URL + '/f/' + file.id

async function harness(t: TestContext) {
  const { db, repository } = databaseFixture()
  t.after(async () => { await repository.close(); db.close() })
  const creates: { chat: string; card: NotificationCard; uuid: string }[] = []
  const updates: { target: string; card: FileCard }[] = []
  const texts: string[] = []
  let reads = 0
  const feishu: FeishuClient = {
    async fetchResource(_source, start, end) {
      reads++
      return new Response(new Uint8Array(end - start + 1), { status: 206, headers: {
        'Content-Range': `bytes ${start}-${end}/${CHUNK_SIZE + 1}`, 'Content-Type': 'Application/PDF; version=1.5',
      } })
    },
    async sendCard(chat, card, uuid) { creates.push({ chat, card, uuid }); return receipt },
    async updateCard(target, card) { updates.push({ target, card }) },
    async sendText(_chat, text) { texts.push(text) },
    close() {},
  }
  const ctx: IntakeContext = { feishu, repository, signal: new AbortController().signal, shouldStop: () => false, wake() {}, waitUntil() {} }
  await repository.registerFile('fixture', file)
  const run = (base = config.PUBLIC_BASE_URL) => runScheduled({ ...config, PUBLIC_BASE_URL: base }, ctx)
  const job = (id: string) => db.prepare('SELECT state, message_id, attempts FROM bot_jobs WHERE id=?').get(id)
  const retryNow = (id: string) => db.prepare('UPDATE bot_jobs SET next_attempt_at=0 WHERE id=?').run(id)
  return { run, job, retryNow, feishu, db, repository, creates, updates, texts, reads: () => reads }
}

test('validated MIME and immutable public URL reach one active card; recall during create repairs the same bot message', async (t) => {
  const h = await harness(t)
  const send = h.feishu.sendCard
  h.feishu.sendCard = async (...args) => {
    await h.repository.recallFile('recall', file.message_id)
    return send(...args)
  }
  await h.run()
  await h.run()
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].chat, file.chat_id)
  assert.ok(JSON.stringify(h.creates[0].card).includes(url))
  assert.ok(JSON.stringify(h.creates[0].card).includes('文件类型：application/pdf'))
  assert.equal(h.job(publication)?.message_id, receipt)
  assert.equal((await h.repository.getFile(file.id))?.message_id, file.message_id)
  assert.deepEqual(h.updates.map((update) => [update.target, update.card.header.title.content]), [[receipt, '文件分享已撤销']])
  assert.equal(h.texts.length, 0)
})

test('a confirmed card rejection queues one Chinese text fallback using the original link', async (t) => {
  const h = await harness(t)
  h.feishu.sendCard = async () => { throw new CardDeliveryError('invalid_card') }
  await h.run()
  await h.run('https://changed.invalid')
  await h.run()
  assert.equal(h.job(publication)?.state, 'failed')
  assert.equal(h.job('fallback:' + file.id)?.state, 'sent')
  assert.equal(h.texts.length, 1)
  assert.ok(h.texts[0].includes(url))
  assert.match(h.texts[0], /文件已发布：测试.pdf（16.00 MiB）/)
  assert.ok(h.texts[0].includes('撤销'))
  assert.equal(h.job(publication)?.message_id, null)
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM files').get()?.n, 1)
  await h.repository.markUnavailable(file.id)
  await h.run()
  assert.match(h.texts[1], /源文件已无法读取/)
})

test('lost create acknowledgement recovers identical payload and UUID across configuration changes, then applies current state', async (t) => {
  const h = await harness(t)
  const send = h.feishu.sendCard
  h.feishu.sendCard = async (...args) => { await send(...args); throw new Error('lost response') }
  await h.run()
  assert.equal(h.job(publication)?.state, 'pending')
  await h.repository.markUnavailable(file.id)
  h.feishu.sendCard = send
  h.retryNow(publication)
  await h.run('https://changed.invalid')
  await h.run()
  assert.equal(h.creates.length, 2)
  assert.deepEqual(h.creates[1], h.creates[0])
  assert.equal(h.job(publication)?.message_id, receipt)
  assert.equal(h.texts.length, 0)
  assert.deepEqual(h.updates.map((update) => [update.target, update.card.header.title.content]), [[receipt, '源文件已失效']])
})

test('ambiguous creates stop at UUID expiry without a second delivery or text fallback', async (t) => {
  const h = await harness(t)
  h.feishu.sendCard = async () => { throw new Error('lost response') }
  await h.run()
  h.db.prepare("UPDATE bot_jobs SET created_at=datetime('now','-1 hour'), next_attempt_at=0 WHERE id=?").run(publication)
  h.feishu.sendCard = async () => assert.fail('must never create again after UUID expiry')
  await h.run()
  assert.equal(h.job(publication)?.state, 'failed')
  assert.equal(h.job('fallback:' + file.id), undefined)
  assert.equal(h.texts.length, 0)
})

test('a later schema rejection after an uncertain send cannot produce a second notification', async (t) => {
  const h = await harness(t)
  h.feishu.sendCard = async () => { throw new Error('lost response') }
  await h.run()
  h.retryNow(publication)
  h.feishu.sendCard = async () => { throw new CardDeliveryError('invalid_card') }
  await h.run()
  assert.equal(h.job(publication)?.state, 'failed')
  assert.equal(h.job('fallback:' + file.id), undefined)
  assert.equal(h.texts.length, 0)
})

for (const failure of ['token', 'rate_limit'] as const) {
  test(`a confirmed ${failure} failure before recall never publishes an active card on recovery`, async (t) => {
    const h = await harness(t)
    let tokenCalls = 0
    let messageCalls = 0
    const client = createFeishuClient(config, async (input) => {
      if (String(input).includes('/oauth/v3/token')) {
        tokenCalls++
        if (failure === 'token') return Response.json({ code: 42 }, { status: 503 })
        return Response.json({ access_token: 'fake-token', expires_in: 7200 })
      }
      messageCalls++
      return Response.json({ code: 230020 }, { status: 429 })
    })
    t.after(() => client.close())
    h.feishu.sendCard = client.sendCard
    await h.run()
    assert.equal(h.job(publication)?.state, 'pending')
    assert.equal(tokenCalls, 1)
    assert.equal(messageCalls, failure === 'token' ? 0 : 1)
    await h.repository.recallFile('recall', file.message_id)
    h.retryNow(publication)
    await h.run()
    assert.equal(h.job(publication)?.state, 'sent')
    assert.equal(h.job(publication)?.message_id, null)
    assert.equal(tokenCalls, 1)
    assert.equal(messageCalls, failure === 'token' ? 0 : 1)
    assert.equal(h.texts.length, 0)
  })
}

test('a proven refusal during receipt recovery does not erase an earlier ambiguous create', async (t) => {
  const h = await harness(t)
  const send = h.feishu.sendCard
  h.feishu.sendCard = async (...args) => { await send(...args); throw new Error('lost receipt') }
  await h.run()
  h.feishu.sendCard = async () => { throw new CardNotSentError() }
  h.retryNow(publication)
  await h.run()
  await h.repository.recallFile('recall', file.message_id)
  h.feishu.sendCard = send
  h.retryNow(publication)
  await h.run()
  await h.run()
  assert.deepEqual(h.creates[1], h.creates[0])
  assert.equal(h.job(publication)?.message_id, receipt)
  assert.equal(h.updates[0].card.header.title.content, '文件分享已撤销')
})

test('a pending legacy success job retains its original text when the application upgrades', async (t) => {
  const h = await harness(t)
  const claimed = await h.repository.claimPending(file.id)
  assert.ok(claimed)
  await h.repository.finishValidation(claimed, 10, null, url)
  const oldJob = 'active:' + file.id
  const oldText = '文件已发布：测试.pdf\n下载地址：' + url
  h.db.prepare('UPDATE bot_jobs SET id=?,argument=? WHERE id=?').run(oldJob, oldText, publication)
  await h.run()
  assert.deepEqual(h.texts, [oldText])
  assert.equal(h.job(oldJob)?.state, 'sent')
  assert.equal(h.creates.length, 0)
})

test('failed revoked-card PATCH keeps warm chunks inaccessible, transient retries end on permanent expiry', async (t) => {
  const h = await harness(t)
  await h.run()
  const downloads = createDownloadHandlers({ repository: h.repository, cacheEnabled: true, fetchResource: h.feishu.fetchResource })
  const raw = (method = 'GET') => downloads.raw(new Request(url, { method, headers: { Range: 'bytes=0-0' } }), file.id)
  assert.equal((await (await raw()).arrayBuffer()).byteLength, 1)
  const warmed = h.reads()
  assert.equal((await (await raw()).arrayBuffer()).byteLength, 1)
  assert.equal(h.reads(), warmed)
  assert.ok(await h.repository.revokeFile(file.id, file.uploader_open_id))
  const update = 'card:deleted:' + file.id
  h.feishu.updateCard = async () => { throw new Error('temporary failure') }
  await h.run()
  assert.equal(h.job(update)?.state, 'pending')
  for (const method of ['GET', 'HEAD']) {
    const response = await raw(method)
    assert.equal(response.status, 410)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  assert.equal(h.reads(), warmed)
  h.retryNow(update)
  h.feishu.updateCard = async () => { throw new CardDeliveryError('expired') }
  await h.run()
  assert.equal(h.job(update)?.state, 'failed')
  assert.equal((await h.repository.getFile(file.id))?.status, 'deleted')
  assert.equal(h.texts.length, 0)
})
