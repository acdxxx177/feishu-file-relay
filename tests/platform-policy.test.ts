import assert from 'node:assert/strict'
import { test } from 'node:test'
import { event, eventually, recall, setup } from './helpers.ts'

test('平台授权模式无需名单，仍校验回调和单聊用户身份', { timeout: 60000 }, async (t) => {
  const h = await setup({ bindings: { FEISHU_INTAKE_POLICY: 'platform', ALLOWED_OPEN_IDS: '', ADMIN_OPEN_IDS: '' } })
  t.after(() => h.mf.dispose())
  assert.equal((await h.post(event('platform-bad-signature'), { badSignature: true })).status, 401)
  const wrongApp = event('platform-wrong-app')
  wrongApp.header.app_id = 'another-app'
  assert.equal((await h.post(wrongApp)).status, 401)
  await h.post(event('platform-group', { sender: 'ou_new', chatType: 'group' }))
  const bot = event('platform-bot', { sender: 'ou_new' })
  bot.event.sender.sender_type = 'app'
  await h.post(bot)
  const missingIdentity = event('platform-empty-id', { sender: '' })
  assert.equal((await h.post(missingIdentity)).status, 400)
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n, 0)
  assert.equal(h.mock.tokenCalls, 0)
  h.mock.files.set('platform-user', { size: 1234 })
  assert.equal((await h.post(event('platform-user', { sender: 'ou_not_in_any_list' }), { encrypted: true })).status, 200)
  const file = await eventually<{ id: string; status: string } | null>(() => h.db.prepare('SELECT id,status FROM files WHERE message_id=?').bind('platform-user')
    .first<{ id: string; status: string }>(), (row) => row?.status === 'active')
  await eventually(async () => h.mock.replies, (rows) => rows.some((row) => JSON.stringify(row).includes(file!.id)))
  assert.equal((await h.request(`/f/${file!.id}/download`, { method: 'HEAD' })).status, 200)
  await h.post(recall('platform-user'))
  assert.equal((await h.request(`/f/${file!.id}/download`, { method: 'HEAD' })).status, 410)
})

test('平台授权模式只列本人文件，只允许本人撤销，忽略遗留管理员配置', { timeout: 60000 }, async (t) => {
  const h = await setup({ bindings: { FEISHU_INTAKE_POLICY: 'platform', ALLOWED_OPEN_IDS: '', ADMIN_OPEN_IDS: 'ou_admin' } })
  t.after(() => h.mf.dispose())
  for (const [messageId, sender] of [['platform-owner', 'ou_owner'], ['platform-other', 'ou_admin']] as const) {
    h.mock.files.set(messageId, { size: 20 })
    await h.post(event(messageId, { sender }))
  }
  const files = await eventually<Array<{ id: string; uploader_open_id: string }>>(async () => (await h.db.prepare("SELECT id,uploader_open_id FROM files WHERE status='active'")
    .all<{ id: string; uploader_open_id: string }>()).results, (rows) => rows.length === 2)
  const owner = files.find((row) => row.uploader_open_id === 'ou_owner')!
  const other = files.find((row) => row.uploader_open_id === 'ou_admin')!
  await eventually(async () => h.mock.replies.length, (n) => n === 2)
  await h.post(event('platform-list', { sender: 'ou_owner', type: 'text', content: JSON.stringify({ text: '我的链接' }) }))
  const listed = await eventually(async () => h.mock.replies, (rows) => rows.some((row) => JSON.stringify(row).includes('最近的有效链接')))
  const listReply = JSON.stringify(listed.find((row) => JSON.stringify(row).includes('最近的有效链接')))
  assert.ok(listReply.includes(owner.id))
  assert.ok(!listReply.includes(other.id))
  await h.post(event('platform-deny-revoke', { sender: 'ou_admin', type: 'text', content: JSON.stringify({ text: `撤销 ${owner.id}` }) }))
  await eventually(async () => h.mock.replies, (rows) => rows.some((row) => JSON.stringify(row).includes('仅上传者本人可以撤销')))
  assert.equal((await h.request(`/f/${owner.id}/download`, { method: 'HEAD' })).status, 200)
  await h.post(event('platform-owner-revoke', { sender: 'ou_owner', type: 'text', content: JSON.stringify({ text: `撤销 ${owner.id}` }) }))
  await eventually(() => h.request(`/f/${owner.id}/download`, { method: 'HEAD' }).then((response) => response.status), (status) => status === 410)
  assert.equal((await h.request(`/f/${other.id}/download`, { method: 'HEAD' })).status, 200)
})

test('错误接入策略和空白名单不接受登记', { timeout: 60000 }, async (t) => {
  for (const policy of ['unknown', 'allowlist']) {
    const h = await setup({ bindings: { FEISHU_INTAKE_POLICY: policy, ALLOWED_OPEN_IDS: '' } })
    t.after(() => h.mf.dispose())
    await h.post(event(`policy-${policy}`))
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n, 0)
    assert.equal(h.mock.tokenCalls, 0)
  }
})
