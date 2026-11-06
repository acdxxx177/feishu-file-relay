import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createRemoteRepository } from '../../src/db/prisma-repository'
import type { FirstDownloadSnapshot } from '../../src/db/repository'
import { databaseFixture } from './database-fixture'

const file = { id: 'A'.repeat(22), message_id: 'first-source', file_key: 'key', file_name: '真实文件.zip', uploader_open_id: 'owner', chat_id: 'private', first_download_notification: 1 }
const snapshot: FirstDownloadSnapshot = { schema: 1, fileName: 'must-not-be-used', confirmedAt: '2026-11-06T03:04:05.000Z', method: 'native', location: { country: 'CN', region: '浙江', city: '杭州' } }
const id = `first-download:card:${file.id}`

async function active(f: ReturnType<typeof databaseFixture>, enabled = 1) {
  await f.repository.registerFile('register', { ...file, first_download_notification: enabled })
  const pending = await f.repository.claimPending(file.id)
  assert.ok(pending)
  await f.repository.finishValidation(pending, 100, null, 'https://relay.invalid/f/' + file.id)
}

test('additive migration disables historical files and preserves existing constraints and indexes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8'))
    db.prepare('INSERT INTO files(id,message_id,file_key,file_name,uploader_open_id,chat_id) VALUES(?,?,?,?,?,?)')
      .run(file.id, file.message_id, file.file_key, file.file_name, file.uploader_open_id, file.chat_id)
    db.exec(readFileSync(new URL('../../migrations/0002_first_download_notification.sql', import.meta.url), 'utf8'))
    assert.equal(db.prepare('SELECT first_download_notification FROM files').get()?.first_download_notification, 0)
    assert.throws(() => db.exec('UPDATE files SET first_download_notification=2'), /CHECK/)
    assert.throws(() => db.exec("UPDATE files SET status='invented'"), /CHECK/)
    assert.throws(() => db.exec('UPDATE files SET file_size=0'), /CHECK/)
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").get()?.n, 3)
  } finally { db.close() }
})

test('first confirmation is atomic, authoritative and permanent under concurrency and repeated delivery states', async () => {
  const f = databaseFixture()
  try {
    await active(f)
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => f.repository.recordFirstDownload(file.id, 1,
      { ...snapshot, confirmedAt: new Date(Date.parse(snapshot.confirmedAt) + index * 1000).toISOString() })))
    assert.ok(results.every(Boolean))
    const row = f.db.prepare('SELECT * FROM bot_jobs WHERE id=?').get(id)!
    const original = String(row.argument)
    assert.deepEqual(JSON.parse(original), { snapshot: { ...snapshot, fileName: file.file_name }, delivery: 'unsent' })
    assert.equal(row.chat_id, file.chat_id)
    assert.equal(row.uploader_open_id, file.uploader_open_id)
    assert.equal(f.db.prepare("SELECT count(*) n FROM bot_jobs WHERE id LIKE 'first-download:%'").get()?.n, 1)
    const claimed = await f.repository.claimJob(id)
    assert.ok(claimed)
    await f.repository.failFirstDownloadNotification(claimed, 'denied')
    assert.equal(await f.repository.recordFirstDownload(file.id, 1, { ...snapshot, method: 'blob' }), true)
    assert.deepEqual(JSON.parse(String(f.db.prepare('SELECT argument FROM bot_jobs WHERE id=?').get(id)?.argument)).snapshot,
      { ...snapshot, fileName: file.file_name })
    assert.equal(f.db.prepare('SELECT state FROM bot_jobs WHERE id=?').get(id)?.state, 'failed')
    assert.equal((await f.repository.getFile(file.id))?.download_count, 0)
    assert.equal((await f.repository.getFile(file.id))?.last_downloaded_at, null)
  } finally { await f.repository.close(); f.db.close() }
})

test('ineligible, pending, wrong-version and recalled files cannot create a first confirmation', async () => {
  for (const state of ['historical', 'pending', 'version', 'recalled', 'unavailable']) {
    const f = databaseFixture()
    try {
      if (state === 'pending') await f.repository.registerFile('register', file)
      else await active(f, state === 'historical' ? 0 : 1)
      if (state === 'recalled') await f.repository.recallFile('recall', file.message_id)
      if (state === 'unavailable') await f.repository.markUnavailable(file.id)
      assert.equal(await f.repository.recordFirstDownload(file.id, state === 'version' ? 2 : 1, snapshot), false, state)
      assert.equal(f.db.prepare('SELECT id FROM bot_jobs WHERE id=?').get(id), undefined)
    } finally { await f.repository.close(); f.db.close() }
  }
})

test('unknown first-confirmation commit recovers the original event even after recall', async () => {
  const f = databaseFixture()
  try {
    await active(f)
    f.loseReply()
    await assert.rejects(f.repository.recordFirstDownload(file.id, 1, snapshot))
    f.loseReply(false)
    await f.repository.recallFile('recall', file.message_id)
    assert.equal(await f.repository.recordFirstDownload(file.id, 1, { ...snapshot, confirmedAt: '2026-11-07T01:00:00.000Z' }), true)
    assert.equal(JSON.parse(String(f.db.prepare('SELECT argument FROM bot_jobs WHERE id=?').get(id)?.argument)).snapshot.confirmedAt, snapshot.confirmedAt)
  } finally { await f.repository.close(); f.db.close() }
})

test('first notification claim fencing rejects stale starts, retries and receipts', async () => {
  const f = databaseFixture()
  try {
    await active(f)
    await f.repository.recordFirstDownload(file.id, 1, snapshot)
    const first = (await f.repository.claimJob(id))!
    f.db.prepare('UPDATE bot_jobs SET lease_until=0 WHERE id=?').run(id)
    const second = (await f.repository.claimJob(id))!
    assert.equal(await f.repository.beginFirstDownloadNotification(first), false)
    await f.repository.finishFirstDownloadNotification(first, 'old')
    await f.repository.retryFirstDownloadNotification(first, true, 'old')
    await f.repository.failFirstDownloadNotification(first, 'old')
    assert.equal(await f.repository.beginFirstDownloadNotification(second), true)
    await f.repository.finishFirstDownloadNotification(second, 'current')
    assert.equal(f.db.prepare('SELECT message_id FROM bot_jobs WHERE id=?').get(id)?.message_id, 'current')
    assert.equal(f.db.prepare('SELECT state FROM bot_jobs WHERE id=?').get(id)?.state, 'sent')
  } finally { await f.repository.close(); f.db.close() }
})

test('public completion writes cannot spend reserved control quota', async () => {
  const f = databaseFixture()
  const limited = createRemoteRepository({ ...f.options, budget: 2, reserve: 1 })
  try {
    await active(f)
    await limited.health()
    await assert.rejects(limited.recordFirstDownload(file.id, 1, snapshot), /Metadata database unavailable/)
    await limited.health()
    assert.equal(f.db.prepare('SELECT id FROM bot_jobs WHERE id=?').get(id), undefined)
  } finally { await limited.close(); await f.repository.close(); f.db.close() }
})
