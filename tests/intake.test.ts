import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { event, eventually, recall, register, setup } from './helpers.ts'
import type { Harness } from './helpers.ts'

interface FileState {
  id: string
  status: string
  file_size: number | null
  attempts: number
  lease_until: number
  next_attempt_at: number
  fail_reason: string | null
}

interface JobState {
  state: string
  attempts: number
  lease_until: number
  next_attempt_at: number
}

function fileState(h: Harness, messageId: string): Promise<FileState | null> {
  return h.db.prepare('SELECT * FROM files WHERE message_id=?').bind(messageId).first<FileState>()
}

function replyText(reply: Record<string, unknown>): string {
  if (typeof reply.content !== 'string') return ''
  const content: unknown = JSON.parse(reply.content)
  if (!content || typeof content !== 'object' || !('text' in content) || typeof content.text !== 'string') return ''
  return content.text
}

function trigger(h: Harness, messageId: string) {
  return h.post(event(messageId, { type: 'text', content: JSON.stringify({ text: '帮助' }) }))
}

test('已认证的畸形事件返回400，非文件消息给出提示', async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const malformed = event('malformed', { content: '{' })
  assert.equal((await h.post(malformed, { encrypted: true })).status, 400)
  assert.equal(h.mock.tokenCalls, 0, '非法事件不能请求飞书凭证')
  assert.equal((await h.post(event('unsupported', { type: 'image', content: 'non-json-image-content' }))).status, 200)
  await eventually(async () => h.mock.replies, (replies) => replies.some((reply) => replyText(reply).includes('请以文件形式发送')))
  assert.equal(await h.db.prepare('SELECT id FROM files LIMIT 1').first(), null)
})

test('相同event_id不能登记另一消息或执行另一条撤回', async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const file = await register(h, 'event-identity')
  h.mock.files.set('event-collision', { size: 123 })
  assert.equal((await h.post(event('event-collision', { eventId: 'evt-event-identity' }))).status, 200)
  assert.equal(await fileState(h, 'event-collision'), null)
  assert.equal(h.mock.ranges.filter((range) => range.key === 'event-collision').length, 0)
  const other = await register(h, 'event-recall-target')
  await h.post(recall('event-recall-target', 'evt-event-identity'))
  assert.equal((await h.request(`/f/${other.id}/download`, { method: 'HEAD' })).status, 200)
  assert.equal((await h.request(`/f/${file.id}/download`, { method: 'HEAD' })).status, 200)
  assert.equal(await h.db.prepare('SELECT message_id FROM recalled_messages WHERE message_id=?').bind('event-recall-target').first(), null)
})

test('登记拒绝错误Range、截断和超长探测，超限与404明确失败且不发布链接', async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  for (const mode of ['bad-range', 'truncate', 'oversize', 'ignore-range'] as const) {
    const messageId = `invalid-probe-${mode}`
    h.mock.files.set(messageId, { size: 100, mode })
    assert.equal((await h.post(event(messageId))).status, 200)
    // 上游探测的完整期限为8秒，放慢轮询使本用例也能覆盖只返回响应头的源站。
    const file = await eventually(async () => { await setTimeout(40); return fileState(h, messageId) }, (value) => value?.attempts === 1 && value.lease_until === 0)
    assert.equal(file!.status, 'pending', mode)
    assert.equal(file!.file_size, null, mode)
    assert.equal((await h.request(`/f/${file!.id}/download`, { method: 'HEAD' })).status, 404)
    assert.ok(!h.mock.replies.some((reply) => replyText(reply).includes(`/f/${file!.id}`)))
    // 冻结该独立失败样本，避免后续样本触发它的重试干扰断言。
    await h.db.prepare('UPDATE files SET next_attempt_at=? WHERE id=?').bind(Date.now() + 3_600_000, file!.id).run()
  }
  for (const [messageId, size, mode, expectedReason] of [
    ['file-too-large', 1073741825, 'ok', 'file_too_large'],
    ['file-missing', 100, 'missing', 'source_unavailable'],
  ] as const) {
    h.mock.files.set(messageId, { size, mode })
    assert.equal((await h.post(event(messageId))).status, 200)
    const file = await eventually(() => fileState(h, messageId), (value) => value?.status === 'failed')
    assert.equal(file!.file_size, null)
    assert.equal(file!.fail_reason, expectedReason)
    assert.equal((await h.request(`/f/${file!.id}/download`)).status, 404)
    await eventually(async () => h.mock.replies, (replies) => replies.some((reply) => replyText(reply).includes(expectedReason === 'file_too_large' ? '大小超过上限' : '检查源文件权限')))
    assert.ok(!h.mock.replies.some((reply) => replyText(reply).includes(`/f/${file!.id}`)))
  }
})

test('源恢复后继续pending登记，失败的发布通知可靠重试一次', async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  h.mock.files.set('recover-source', { size: 321, mode: 'bad-range' })
  await h.post(event('recover-source'))
  const pending = await eventually(() => fileState(h, 'recover-source'), (value) => value?.attempts === 1 && value.lease_until === 0)
  assert.equal(pending!.status, 'pending')
  h.mock.files.get('recover-source')!.mode = 'ok'
  h.mock.failReplies(6)
  await h.db.prepare('UPDATE files SET next_attempt_at=0,lease_until=0 WHERE id=?').bind(pending!.id).run()
  await trigger(h, 'resume-pending')
  const active = await eventually(() => fileState(h, 'recover-source'), (value) => value?.status === 'active')
  assert.equal(active!.attempts, 2)
  assert.equal(active!.file_size, 321)
  const jobId = `active:${active!.id}`
  await eventually<JobState | null>(
    () => h.db.prepare('SELECT state,attempts,lease_until,next_attempt_at FROM bot_jobs WHERE id=?').bind(jobId)
      .first<JobState>(),
    (job) => job?.state === 'pending' && job.attempts === 1 && job.lease_until === 0 && job.next_attempt_at > 0,
  )
  assert.ok(!h.mock.replies.some((reply) => replyText(reply).includes(`/f/${active!.id}`)))
  h.mock.failReplies(0)
  await h.db.prepare('UPDATE bot_jobs SET next_attempt_at=0,lease_until=0 WHERE id=?').bind(jobId).run()
  await trigger(h, 'resume-outbox')
  await eventually(async () => h.mock.replies, (replies) => replies.some((reply) => replyText(reply).includes(`/f/${active!.id}`)))
  await eventually<{ state: string } | null>(
    () => h.db.prepare('SELECT state FROM bot_jobs WHERE id=?').bind(jobId).first<{ state: string }>(),
    (job) => job?.state === 'sent',
  )
  await trigger(h, 'outbox-idempotent')
  assert.equal(h.mock.replies.filter((reply) => replyText(reply).includes(`/f/${active!.id}`)).length, 1)
})

test('四次校验均失败后停止重试，第四次中断的租约也能结束', async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  h.mock.files.set('retry-exhausted', { size: 123, mode: 'bad-range' })
  await h.post(event('retry-exhausted'))
  let file = await eventually(() => fileState(h, 'retry-exhausted'), (value) => value?.attempts === 1 && value.lease_until === 0)
  for (let attempt = 2; attempt <= 4; attempt++) {
    await h.db.prepare('UPDATE files SET next_attempt_at=0,lease_until=0 WHERE id=?').bind(file!.id).run()
    await trigger(h, `retry-trigger-${attempt}`)
    file = await eventually(() => fileState(h, 'retry-exhausted'), (value) => value?.attempts === attempt && value.lease_until === 0)
  }
  assert.equal(file!.status, 'failed')
  assert.equal(h.mock.ranges.filter((range) => range.key === 'retry-exhausted').length, 4)
  await trigger(h, 'retry-exhausted-extra')
  assert.equal(h.mock.ranges.filter((range) => range.key === 'retry-exhausted').length, 4)
  h.mock.files.set('expired-fourth', { size: 123, mode: 'bad-range' })
  await h.post(event('expired-fourth'))
  const interrupted = await eventually(() => fileState(h, 'expired-fourth'), (value) => value?.attempts === 1 && value.lease_until === 0)
  await h.db.prepare('UPDATE files SET attempts=4,next_attempt_at=0,lease_until=0 WHERE id=?').bind(interrupted!.id).run()
  const readsBefore = h.mock.ranges.filter((range) => range.key === 'expired-fourth').length
  await trigger(h, 'recover-expired-fourth')
  const failed = await eventually(() => fileState(h, 'expired-fourth'), (value) => value?.status === 'failed')
  assert.equal(failed!.fail_reason, 'validation_interrupted')
  assert.equal(h.mock.ranges.filter((range) => range.key === 'expired-fourth').length, readsBefore)
})

test('探测尚未完成时撤回，迟到的成功结果不能激活或发布', async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  h.mock.files.set('recall-during-probe', { size: 123 })
  const original = h.mock.handle
  let entered = false
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.after(() => release())
  h.mock.handle = async (request) => {
    if (new URL(request.url).pathname.endsWith('/resources/recall-during-probe')) {
      entered = true
      await gate
    }
    return original(request)
  }
  assert.equal((await h.post(event('recall-during-probe'))).status, 200)
  await eventually(async () => entered, (value) => value)
  const pending = await fileState(h, 'recall-during-probe')
  assert.equal(pending!.status, 'pending')
  assert.equal((await h.post(recall('recall-during-probe'))).status, 200)
  // 在同一后台处理周期的出站箱放入标记，观察标记即可确定迟到校验已经结束。
  await h.db.prepare("INSERT INTO bot_jobs(id,kind,uploader_open_id,chat_id,argument) VALUES('probe-barrier','notification','ou_employee','oc_test','probe-completed-marker')").run()
  release()
  await eventually(async () => h.mock.replies, (replies) => replies.some((reply) => replyText(reply) === 'probe-completed-marker'))
  assert.equal((await fileState(h, 'recall-during-probe'))!.status, 'deleted')
  assert.equal(await h.db.prepare("SELECT id FROM bot_jobs WHERE file_id=? AND id LIKE 'active:%'").bind(pending!.id).first(), null)
  assert.ok(!h.mock.replies.some((reply) => replyText(reply).includes(`/f/${pending!.id}`)))
  for (const method of ['GET', 'HEAD']) assert.equal((await h.request(`/f/${pending!.id}/download`, { method })).status, 410)
})

test('并发登记合并Token请求，失效Token仅刷新并重试一次', async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const messages = ['concurrent-token-a', 'concurrent-token-b', 'concurrent-token-c']
  for (const messageId of messages) h.mock.files.set(messageId, { size: 123 })
  const callbacks = await Promise.all(messages.map((messageId) => h.post(event(messageId))))
  for (const callback of callbacks) assert.equal(callback.status, 200)
  await eventually<{ n: number } | null>(
    () => h.db.prepare("SELECT COUNT(*) AS n FROM files WHERE status='active'").first<{ n: number }>(),
    (value) => value?.n === 3,
  )
  assert.equal(h.mock.tokenCalls, 1, '同一应用的并发登记应复用一次Token刷新')
  const original = h.mock.handle
  let rejected = 0
  h.mock.handle = async (request) => {
    if (new URL(request.url).pathname.endsWith('/resources/refresh-invalid-token') && rejected === 0) {
      rejected++
      return Response.json({ code: 99991663 }, { status: 401 })
    }
    return original(request)
  }
  const file = await register(h, 'refresh-invalid-token')
  assert.equal(rejected, 1)
  assert.equal(h.mock.tokenCalls, 2, '已失效Token只允许一次强制刷新')
  assert.equal((await h.request(`/f/${file.id}/download`, { method: 'HEAD' })).status, 200)
  assert.equal(h.mock.ranges.filter((range) => range.key === 'refresh-invalid-token').length, 1)
})
