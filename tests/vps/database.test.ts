import assert from 'node:assert/strict'
import { test } from 'node:test'
import { D1HttpTransport } from '../../src/db/d1-http'
import { RelayPrismaD1Adapter } from '../../src/db/prisma-d1-adapter'
import { databaseFixture } from './database-fixture'

const file = { id: 'A'.repeat(22), message_id: 'msg', file_key: 'key', file_name: '中文.zip', uploader_open_id: 'owner', chat_id: 'chat' }

test('Prisma reads legacy TEXT timestamps, nullable fields and 64-bit milliseconds; independent updates stay typed', async () => {
  const f = databaseFixture()
  try {
    await f.repository.registerFile('event', file)
    const claimed = await f.repository.claimPending(file.id)
    assert.ok(claimed)
    assert.ok(claimed.lease_until > 2 ** 31)
    assert.equal(await f.repository.finishValidation(claimed, 1073741824, null, 'published'), true)
    const actual = await f.repository.getFile(file.id)
    assert.equal(actual?.file_name, file.file_name)
    assert.equal(actual?.file_size, 1073741824)
    assert.equal(actual?.mime_type, null)
    assert.match(actual!.created_at, /^\d{4}-\d\d-\d\d /)
    await f.repository.countDownload(file.id)
    assert.equal((await f.repository.listFiles('owner'))[0].download_count, 1)
    assert.equal(await f.repository.revokeFile(file.id, 'other'), false)
    assert.equal(await f.repository.revokeFile(file.id, 'owner'), true)
    assert.equal((await f.repository.getFile(file.id))?.status, 'deleted')
  } finally { await f.repository.close(); f.db.close() }
})

test('duplicate registration, recall before registration and late validation never revive files', async () => {
  const f = databaseFixture()
  try {
    await Promise.all([f.repository.registerFile('event', file), f.repository.registerFile('event', file)])
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n, 1)
    const claimed = await f.repository.claimPending(file.id)
    assert.ok(claimed)
    await f.repository.recallFile('recall', 'msg')
    assert.equal(await f.repository.finishValidation(claimed, 100, null, 'published'), false)
    assert.equal((await f.repository.getFile(file.id))?.status, 'deleted')
    assert.equal((await f.repository.dueJobs()).length, 0)
    await f.repository.recallFile('early', 'msg2')
    await f.repository.registerFile('event2', { ...file, id: 'B'.repeat(22), message_id: 'msg2' })
    assert.equal(await f.repository.getFile('B'.repeat(22)), null)
  } finally { await f.repository.close(); f.db.close() }
})

test('atomic batch rolls back failed statements and preserves changes() outbox coupling', async () => {
  const f = databaseFixture()
  try {
    const transport = new D1HttpTransport(f.options)
    await assert.rejects(transport.batch([
      { sql: "INSERT INTO processed_events(event_id) VALUES('rollback')" },
      { sql: "INSERT INTO files(id) VALUES('invalid')" },
    ]))
    assert.equal(f.db.prepare("SELECT * FROM processed_events WHERE event_id='rollback'").get(), undefined)
    await f.repository.registerFile('event', file)
    const claimed = await f.repository.claimPending(file.id)
    assert.ok(claimed)
    await f.repository.finishValidation(claimed, 100, null, 'published')
    assert.equal(await f.repository.markUnavailable(file.id), true)
    assert.equal(await f.repository.markUnavailable(file.id), false)
    const jobs = await f.repository.dueJobs()
    assert.deepEqual(jobs.map(job => job.id), [`active:card:${file.id}`])
    // 发布仍待确认，必须先分清有没有卡片，才能决定更新卡片还是发送失效文字。
    await f.repository.finishJob((await f.repository.claimJob(jobs[0].id))!)
    assert.deepEqual((await f.repository.dueJobs()).map(job => job.id), [`unavailable:${file.id}`])
  } finally { await f.repository.close(); f.db.close() }
})

test('expired job owners cannot finish or retry a newer lease', async () => {
  const f = databaseFixture()
  try {
    await f.repository.createCommand('event', { id: 'cmd', message_id: 'msg', uploader_open_id: 'owner', chat_id: 'chat', argument: '我的链接' })
    const first = await f.repository.claimJob('cmd')
    assert.ok(first)
    assert.equal(await f.repository.claimJob('cmd'), null)
    f.db.prepare("UPDATE bot_jobs SET lease_until=0 WHERE id='cmd'").run()
    const second = await f.repository.claimJob('cmd')
    assert.ok(second)
    await f.repository.finishJob(first)
    await f.repository.retryJob(first)
    assert.equal((f.db.prepare("SELECT state FROM bot_jobs WHERE id='cmd'").get() as { state: string }).state, 'pending')
    await f.repository.finishJob(second)
    assert.equal((f.db.prepare("SELECT state FROM bot_jobs WHERE id='cmd'").get() as { state: string }).state, 'sent')
  } finally { await f.repository.close(); f.db.close() }
})

test('primary proof and request reserve fail closed, transactions are rejected', async () => {
  const f = databaseFixture()
  try {
    f.setPrimary(false)
    await assert.rejects(f.repository.getFile(file.id))
    f.setPrimary(true)
    const transport = new D1HttpTransport({ ...f.options, budget: 3, reserve: 1 })
    await transport.download(() => transport.query({ sql: 'SELECT 1' }))
    await transport.download(() => transport.query({ sql: 'SELECT 1' }))
    await assert.rejects(transport.download(() => transport.query({ sql: 'SELECT 1' })), /unavailable/)
    await transport.query({ sql: 'SELECT 1' })
    await assert.rejects(transport.query({ sql: 'SELECT 1' }))
    const adapter = await new RelayPrismaD1Adapter(transport).connect()
    await assert.rejects(adapter.startTransaction(), /atomic batch/)
  } finally { await f.repository.close(); f.db.close() }
})

test('unknown commit outcome is not automatically replayed', async () => {
  const f = databaseFixture()
  try {
    f.loseReply()
    await assert.rejects(f.repository.registerFile('event', file))
    assert.equal(f.calls(), 1)
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n, 1)
  } finally { await f.repository.close(); f.db.close() }
})

