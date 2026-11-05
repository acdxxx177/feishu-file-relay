import assert from 'node:assert/strict'
import { test } from 'node:test'
import { databaseFixture } from './database-fixture'

const file = { id: 'A'.repeat(22), message_id: 'source', file_key: 'private-key', file_name: '报价.pdf', uploader_open_id: 'owner', chat_id: 'chat' }
const url = `https://relay.invalid/f/${file.id}`
const publicationId = `active:card:${file.id}`
const deletedJobId = `card:deleted:${file.id}`
const unavailableJobId = `card:unavailable:${file.id}`

async function fixture() {
  const f = databaseFixture()
  const repo = f.repository
  await repo.registerFile('event', file)
  const pending = await repo.claimPending(file.id)
  assert.ok(pending)
  await repo.finishValidation(pending, 567, null, url, 'application/pdf')
  const publication = await repo.claimJob(publicationId)
  assert.ok(publication)
  assert.equal(publication.argument, `unsent:${url}`)
  assert.equal(await repo.beginUnsentCard(publication, url), true)
  return { ...f, repo, publication, close: async () => { await repo.close(); f.db.close() } }
}

test('card receipt retains source and metadata; revoke binds owner, chat, card and file even on replay', async () => {
  const f = await fixture()
  try {
    await f.repo.finishCardPublication(f.publication, 'original-card')
    const record = await f.repo.getFile(file.id)
    assert.equal(record?.message_id, 'source')
    assert.equal(record?.mime_type, 'application/pdf')
    const otherFile = { ...file, id: 'B'.repeat(22), message_id: 'source2' }
    await f.repo.registerFile('event2', otherFile)
    await f.repo.finishValidation((await f.repo.claimPending(otherFile.id))!, 1, null, 'different-url')
    const otherPublication = (await f.repo.claimJob(`active:card:${otherFile.id}`))!
    await f.repo.beginUnsentCard(otherPublication, 'different-url')
    await f.repo.finishCardPublication(otherPublication, 'second-card')
    for (const [id, actor, card, chat] of [
      [file.id, 'other', 'original-card', 'chat'], [file.id, 'owner', 'original-card', 'wrong-chat'],
      [file.id, 'owner', 'source', 'chat'], [file.id, 'owner', 'second-card', 'chat'],
      [otherFile.id, 'owner', 'original-card', 'chat'],
    ]) assert.equal(await f.repo.revokeCard(id, actor, card, chat), 'denied')
    assert.equal((await f.repo.getDownloadFile(file.id))?.status, 'active')
    const revoke = () => f.repo.revokeCard(file.id, 'owner', 'original-card', 'chat')
    assert.deepEqual((await Promise.all([revoke(), revoke()])).sort(), ['already_revoked', 'revoked'])
    assert.equal(await f.repo.revokeCard(file.id, 'other', 'original-card', 'chat'), 'denied')
    assert.equal((await f.repo.getDownloadFile(otherFile.id))?.status, 'active')
    const jobs = await f.repo.dueJobs()
    assert.deepEqual(jobs.map(job => [job.id, job.message_id]), [[deletedJobId, 'original-card']])
    await f.repo.failJob((await f.repo.claimJob(deletedJobId))!)
    assert.equal((await f.repo.getDownloadFile(file.id))?.status, 'deleted')
    assert.equal(f.db.prepare('SELECT state FROM bot_jobs WHERE id=?').get(deletedJobId)?.state, 'failed')
  } finally { await f.close() }
})

test('claim fence and late publication receipt reconcile recall and source unavailability', async () => {
  for (const status of ['deleted', 'unavailable']) {
    const f = await fixture()
    try {
      f.db.prepare('UPDATE bot_jobs SET lease_until=0 WHERE id=?').run(publicationId)
      const newClaim = await f.repo.claimJob(publicationId)
      assert.ok(newClaim)
      if (status === 'deleted') await f.repo.recallFile('recall', 'source')
      else await f.repo.markUnavailable(file.id)
      await f.repo.finishCardPublication(f.publication, 'discarded-receipt')
      assert.equal(f.db.prepare('SELECT message_id FROM bot_jobs WHERE id=?').get(publicationId)?.message_id, null)
      await f.repo.finishCardPublication(newClaim, 'card-id')
      const due = await f.repo.dueJobs()
      assert.deepEqual(due.map(job => [job.id, job.message_id]), [[`card:${status}:${file.id}`, 'card-id']])
      assert.equal((await f.repo.getDownloadFile(file.id))?.status, status)
    } finally { await f.close() }
  }
})

test('D1 excludes simultaneous terminal PATCH leases across processes; crashed leases can be reclaimed', async () => {
  const f = await fixture()
  try {
    await f.repo.finishCardPublication(f.publication, 'card')
    await f.repo.markUnavailable(file.id)
    const unavailable = (await f.repo.claimJob(unavailableJobId))!
    assert.equal(await f.repo.revokeFile(file.id, 'owner'), true)
    assert.equal(await f.repo.claimJob(deletedJobId), null)
    // 模拟进程崩溃、租约到期。迟到的旧 PATCH 回执可能在新 PATCH 之后返回。
    f.db.prepare('UPDATE bot_jobs SET lease_until=1 WHERE id=?').run(unavailableJobId)
    const deleted = (await f.repo.claimJob(deletedJobId))!
    assert.equal(await f.repo.claimJob(unavailableJobId), null)
    await f.repo.finishCardUpdate(deleted, 'deleted')
    await f.repo.finishCardUpdate({ ...unavailable, lease_until: 1 }, 'unavailable')
    const repair = (await f.repo.claimJob(deletedJobId))!
    assert.equal(repair.message_id, 'card')
    assert.ok(repair.attempts > deleted.attempts)
    await f.repo.finishCardUpdate(repair, 'deleted')
    assert.deepEqual(await f.repo.dueJobs(), [])
  } finally { await f.close() }
})

test('event and text transitions atomically record terminal sync and roll back on outbox failure', async () => {
  const f = await fixture()
  try {
    await f.repo.finishCardPublication(f.publication, 'card')
    f.db.exec(`CREATE TRIGGER fail_terminal BEFORE INSERT ON bot_jobs WHEN NEW.id LIKE 'card:%'
      BEGIN SELECT RAISE(ABORT,'injected failure'); END`)
    await assert.rejects(f.repo.revokeCard(file.id, 'owner', 'card', 'chat'))
    await assert.rejects(f.repo.revokeFile(file.id, 'owner'))
    await assert.rejects(f.repo.recallFile('recall', 'source'))
    await assert.rejects(f.repo.markUnavailable(file.id))
    assert.equal((await f.repo.getFile(file.id))?.status, 'active')
    assert.equal(f.db.prepare('SELECT * FROM recalled_messages').get(), undefined)
    assert.equal(f.db.prepare('SELECT * FROM processed_events WHERE event_id=?').get('recall'), undefined)
    assert.deepEqual(await f.repo.dueJobs(), [])
  } finally { await f.close() }
})

test('definitive rejection creates one text fallback for same URL; no card ID is invented', async () => {
  const f = await fixture()
  try {
    await f.repo.fallbackCardPublication(f.publication)
    await f.repo.fallbackCardPublication(f.publication)
    const [pending] = await f.repo.dueJobs()
    assert.equal(pending.id, `fallback:${file.id}`)
    assert.equal(pending.argument, url)
    assert.equal(pending.message_id, null)
    assert.equal(await f.repo.revokeCard(file.id, 'owner', 'unbound-message', 'chat'), 'denied')
    await f.repo.finishJob((await f.repo.claimJob(pending.id))!)
    assert.equal(await f.repo.markUnavailable(file.id), true)
    assert.deepEqual((await f.repo.dueJobs()).map(job => job.id), [`unavailable:${file.id}`])
  } finally { await f.close() }
})

test('known-unsent retries recheck active status and clear marker before each POST across restarts', async () => {
  const f = await fixture()
  try {
    await f.repo.retryUnsentCard(f.publication, url)
    f.db.prepare('UPDATE bot_jobs SET next_attempt_at=0 WHERE id=?').run(publicationId)
    const retry = (await f.repo.claimJob(publicationId))!
    assert.equal(retry.argument, `unsent:${url}`)
    assert.equal(await f.repo.beginUnsentCard(f.publication, url), false)
    assert.equal(await f.repo.beginUnsentCard(retry, 'different-url'), false)
    assert.equal(await f.repo.beginUnsentCard(retry, url), true)
    assert.equal(f.db.prepare('SELECT argument FROM bot_jobs WHERE id=?').get(publicationId)?.argument, url)
    await f.repo.retryUnsentCard(retry, url)
    f.db.prepare('UPDATE bot_jobs SET next_attempt_at=0 WHERE id=?').run(publicationId)
    const next = (await f.repo.claimJob(publicationId))!
    await f.repo.markUnavailable(file.id)
    assert.equal(await f.repo.beginUnsentCard(next, url), false)
    await f.repo.finishJob(next)
    assert.deepEqual((await f.repo.dueJobs()).map(job => job.id), [`unavailable:${file.id}`])
  } finally { await f.close() }
})

test('unknown commit of card revocation recovers through the same authorized binding', async () => {
  const f = await fixture()
  try {
    await f.repo.finishCardPublication(f.publication, 'card')
    f.loseReply()
    await assert.rejects(f.repo.revokeCard(file.id, 'owner', 'card', 'chat'))
    assert.equal(f.db.prepare('SELECT status FROM files WHERE id=?').get(file.id)?.status, 'deleted')
    assert.ok(f.db.prepare('SELECT id FROM bot_jobs WHERE id=?').get(deletedJobId))
    f.loseReply(false)
    assert.equal(await f.repo.revokeCard(file.id, 'owner', 'card', 'chat'), 'already_revoked')
    assert.deepEqual((await f.repo.dueJobs()).map(job => job.id), [deletedJobId])
  } finally { await f.close() }
})
