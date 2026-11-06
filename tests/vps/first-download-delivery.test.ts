import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { BotJob, FirstDownloadJobPayload, FirstDownloadSnapshot } from '../../src/db/repository'
import { createRemoteRepository } from '../../src/db/prisma-repository'
import { deliverBotJob } from '../../src/vps/card-delivery'
import { buildFirstDownloadCard } from '../../src/vps/cards/first-download-card'
import { readConfig } from '../../src/vps/config'
import { CardDeliveryError, CardNotSentError, type FeishuClient } from '../../src/vps/feishu'
import type { IntakeContext } from '../../src/vps/intake'
import { databaseFixture } from './database-fixture'

const config = readConfig({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_VERIFICATION_TOKEN: 'verify', FEISHU_ENCRYPT_KEY: 'encrypt',
  PUBLIC_BASE_URL: 'https://relay.invalid', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'test' })
const file = { id: 'D'.repeat(22), message_id: 'source', file_key: 'key', file_name: '<b>文件.zip</b>', uploader_open_id: 'owner', chat_id: 'private', first_download_notification: 1 }
const snapshot: FirstDownloadSnapshot = { schema: 1, fileName: file.file_name, confirmedAt: '2026-11-06T03:04:05.000Z', method: 'native', location: { country: 'CN', region: '浙江', city: '杭州' } }
const id = `first-download:card:${file.id}`

async function harness(t: TestContext) {
  const f = databaseFixture()
  t.after(async () => { await f.repository.close(); f.db.close() })
  await f.repository.registerFile('register', file)
  await f.repository.finishValidation((await f.repository.claimPending(file.id))!, 100, null, 'url')
  await f.repository.recordFirstDownload(file.id, 1, snapshot)
  const requests: string[] = []
  const messages = new Map<string, string>()
  const feishu: FeishuClient = {
    async fetchResource() { throw new Error('Unused') },
    async sendCard(chat, card, uuid) {
      assert.equal(chat, file.chat_id)
      const body = JSON.stringify(card)
      requests.push(JSON.stringify({ chat, card, uuid }))
      const previous = messages.get(uuid)
      if (previous) assert.equal(body, previous)
      messages.set(uuid, body)
      return 'notification-receipt'
    },
    async updateCard() { throw new Error('No update expected') },
    async sendText() { throw new Error('No fallback expected') },
    close() {},
  }
  const ctx: IntakeContext = { repository: f.repository, feishu, signal: new AbortController().signal, wake() {}, waitUntil() {}, shouldStop: () => false }
  const row = () => f.db.prepare('SELECT * FROM bot_jobs WHERE id=?').get(id) as unknown as BotJob
  const payload = () => JSON.parse(row().argument) as FirstDownloadJobPayload
  const run = async () => {
    f.db.prepare('UPDATE bot_jobs SET next_attempt_at=0 WHERE id=?').run(id)
    const job = await ctx.repository.claimJob(id)
    if (job) await deliverBotJob(config, ctx, job)
  }
  return { ...f, feishu, ctx, run, row, payload, requests, messages }
}

test('first download card uses plain text, UTC+8, partial/unknown location and explicit Blob limitation', () => {
  const native = JSON.stringify(buildFirstDownloadCard(snapshot))
  assert.ok(native.includes('2026-11-06 11:04:05（UTC+8）'))
  assert.ok(native.includes('CN / 浙江 / 杭州'))
  assert.ok(native.includes('<b>文件.zip</b>'))
  assert.ok(!native.includes('markdown') && !native.includes('button'))
  const blob = JSON.stringify(buildFirstDownloadCard({ ...snapshot, method: 'blob', location: { city: '杭州' } }))
  assert.ok(blob.includes('大致地点：杭州'))
  assert.ok(blob.includes('无法确认最终保存结果'))
  assert.ok(JSON.stringify(buildFirstDownloadCard({ ...snapshot, location: {} })).includes('位置未知'))
})

test('lost provider acknowledgement recovers one visible card using identical content after process restart and recall', async t => {
  const h = await harness(t)
  const send = h.feishu.sendCard
  h.feishu.sendCard = async (...args) => { await send(...args); throw new Error('Acknowledgement lost') }
  await h.run()
  assert.equal(h.payload().delivery, 'uncertain')
  await h.repository.recallFile('recall', file.message_id)
  const restarted = createRemoteRepository(h.options)
  t.after(() => restarted.close())
  h.ctx.repository = restarted
  h.feishu.sendCard = send
  await h.run()
  assert.equal(h.messages.size, 1)
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[0], h.requests[1])
  assert.equal(h.row().state, 'sent')
  assert.equal(h.row().message_id, 'notification-receipt')
  assert.equal(h.payload().snapshot.confirmedAt, snapshot.confirmedAt)
})

test('unknown database commit before POST is treated as uncertain and never sends outside dedup window', async t => {
  const h = await harness(t)
  const job = (await h.repository.claimJob(id))!
  h.loseReply()
  await assert.rejects(deliverBotJob(config, h.ctx, job))
  h.loseReply(false)
  assert.equal(h.requests.length, 0)
  assert.equal(h.payload().delivery, 'uncertain')
  h.db.prepare("UPDATE bot_jobs SET lease_until=0, created_at='2000-01-01 00:00:00' WHERE id=?").run(id)
  await h.run()
  assert.equal(h.requests.length, 0)
  assert.equal(h.row().state, 'failed')
  assert.equal(h.payload().failureReason, 'create_deduplication_expired')
})

test('definitely unsent attempts can retry old jobs; later no-send cannot clear prior uncertainty', async t => {
  const h = await harness(t)
  h.db.prepare("UPDATE bot_jobs SET created_at='2000-01-01 00:00:00' WHERE id=?").run(id)
  h.feishu.sendCard = async () => { throw new CardNotSentError() }
  await h.run()
  assert.equal(h.payload().delivery, 'unsent')
  assert.equal(h.payload().failureReason, 'not_sent')
  h.feishu.sendCard = async () => { throw new Error('Unknown send') }
  await h.run()
  assert.equal(h.payload().delivery, 'uncertain')
  await h.run()
  assert.equal(h.row().state, 'failed')
  assert.equal(h.payload().failureReason, 'create_deduplication_expired')

  const other = await harness(t)
  other.feishu.sendCard = async () => { throw new Error('Unknown send') }
  await other.run()
  other.feishu.sendCard = async () => { throw new CardNotSentError() }
  await other.run()
  assert.equal(other.payload().delivery, 'uncertain')
})

test('permanent rejection has no fallback and eight retry attempts remain bounded', async t => {
  for (const reason of ['invalid_card', 'denied'] as const) {
    const h = await harness(t)
    h.feishu.sendCard = async () => { throw new CardDeliveryError(reason) }
    await h.run()
    assert.equal(h.row().state, 'failed')
    assert.equal(h.payload().failureReason, reason)
    await h.run()
    assert.equal(h.row().attempts, 1)
  }
  const h = await harness(t)
  h.feishu.sendCard = async () => { throw new CardNotSentError() }
  for (let i = 0; i < 10; i++) await h.run()
  assert.equal(h.row().attempts, 8)
  assert.equal(h.row().state, 'failed')
})

test('lost receipt commit cannot create a second message', async t => {
  const h = await harness(t)
  const send = h.feishu.sendCard
  h.feishu.sendCard = async (...args) => {
    const receipt = await send(...args)
    h.loseReply()
    return receipt
  }
  await assert.rejects(h.run())
  h.loseReply(false)
  assert.equal(h.row().state, 'sent')
  await h.run()
  assert.equal(h.messages.size, 1)
  assert.equal(h.requests.length, 1)
})
