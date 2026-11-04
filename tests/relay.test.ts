import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesAt } from '../mocks/feishu-mock.ts'
import { setup, event, recall, register, eventually, verificationToken } from './helpers.ts'

test('Webhook 验证、加密、时间戳、白名单与幂等登记', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const health = await h.request('/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })
  assert.equal((await h.request('/not-found')).status, 404)
  for (const encrypted of [false, true]) {
    const response = await h.post({ type: 'url_verification', token: verificationToken, challenge: 'challenge-test' }, { encrypted })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { challenge: 'challenge-test' })
  }
  assert.equal((await h.post(event('bad-signature'), { badSignature: true })).status, 401)
  assert.equal((await h.post(event('stale'), { stale: true })).status, 401)
  const badToken = event('bad-token')
  badToken.header.token = 'wrong'
  assert.equal((await h.post(badToken)).status, 401)
  const oldEvent = event('stale-event')
  oldEvent.header.create_time = String(Date.now() - 1000000)
  assert.equal((await h.post(oldEvent)).status, 401)
  await h.post(event('outsider', { sender: 'ou_outsider' }))
  await h.post(event('group', { chatType: 'group' }))
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n, 0)
  h.mock.files.set('encrypted-file', { size: 12345 })
  assert.ok((await h.post(event('encrypted-file'), { encrypted: true })).ok)
  const file = await eventually<{ id: string; status: string; file_size: number } | null>(() => h.db.prepare('SELECT * FROM files WHERE message_id=?').bind('encrypted-file').first<{ id: string; status: string; file_size: number }>(), (value) => value?.status === 'active')
  assert.match(file!.id, /^[a-zA-Z0-9]{22}$/)
  assert.equal(file!.file_size, 12345)
  await h.post(event('encrypted-file'))
  await h.post(event('encrypted-file', { eventId: 'another-event-same-message' }))
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n, 1)
  await eventually(async () => h.mock.replies, (replies) => replies.some((reply) => JSON.stringify(reply).includes(file!.id)))
  const linkReplies = h.mock.replies.filter((reply) => JSON.stringify(reply).includes(file!.id))
  assert.equal(linkReplies.length, 1)
  assert.ok(!JSON.stringify(linkReplies).includes('mock-tenant-access-token'))
})

test('完整/单 Range/If-Range/HEAD、中文文件名与预取', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const file = await register(h, 'ranges', 40000)
  const path = `/f/${file.id}/download`
  const originBefore = h.mock.ranges.length
  const head = await h.request(path, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal(head.headers.get('content-length'), '40000')
  assert.equal(h.mock.ranges.length, originBefore)
  assert.equal(head.headers.get('content-type'), 'application/octet-stream')
  assert.match(head.headers.get('content-disposition')!, /filename\*=UTF-8''/)
  assert.equal(head.headers.get('cache-control'), 'private, no-cache')
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff')
  const probe = await h.request(path, { headers: { Range: 'bytes=0-0' } })
  assert.equal(probe.status, 206)
  assert.equal(probe.headers.get('content-length'), '1')
  assert.deepEqual(new Uint8Array(await probe.arrayBuffer()), new Uint8Array(bytesAt(0, 1)))
  assert.equal(h.mock.ranges.at(-1)?.range, 'bytes=0-0')
  for (const [range, start, end] of [
    ['bytes=17-123', 17, 123], ['bytes=39999-', 39999, 39999], ['bytes=-20', 39980, 39999], ['bytes=39990-99999', 39990, 39999],
  ] as const) {
    const response = await h.request(path, { headers: { Range: range } })
    assert.equal(response.status, 206, range)
    assert.equal(response.headers.get('content-length'), String(end - start + 1))
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/40000`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesAt(start, end - start + 1))
  }
  for (const range of ['bytes=40000-', 'bytes=4-3', 'bytes=-0', 'bytes=abc', 'items=0-1', 'bytes=999999999999999999999-']) {
    const response = await h.request(path, { headers: { Range: range } })
    assert.equal(response.status, 416, range)
    assert.equal(response.headers.get('content-range'), 'bytes */40000')
  }
  for (const headers of [
    { Range: 'bytes=0-1,4-5' },
    { Range: 'bytes=0-2', 'If-Range': '"wrong"' },
    { Range: 'bytes=0-2', 'If-Range': `W/${head.headers.get('etag')}` },
  ]) {
    const response = await h.request(path, { headers })
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytesAt(0, 40000))
  }
  const matched = await h.request(path, { headers: { Range: 'bytes=10-20', 'If-Range': head.headers.get('etag')! } })
  assert.equal(matched.status, 206)
  assert.deepEqual(Buffer.from(await matched.arrayBuffer()), bytesAt(10, 11))
  assert.equal((await h.request('/f/invalid')).status, 404)
  assert.equal((await h.request(`/f/${'A'.repeat(22)}/download`)).status, 404)
  assert.equal((await h.request(`/chunks/${file.id}/v1/0`)).status, 404)
})

test('撤回墓碑、并发登记、热缓存撤回后 GET/HEAD 410', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  await h.post(recall('recall-first'))
  h.mock.files.set('recall-first', { size: 100 })
  await h.post(event('recall-first'))
  assert.equal(await h.db.prepare('SELECT id FROM files WHERE message_id=?').bind('recall-first').first(), null)
  const file = await register(h, 'warm')
  const warm = await h.request(`/f/${file.id}/download`)
  assert.equal(warm.status, 200)
  await warm.arrayBuffer()
  const originCalls = h.mock.ranges.length
  const warmAgain = await h.request(`/f/${file.id}/download`)
  await warmAgain.arrayBuffer()
  assert.equal(h.mock.ranges.length, originCalls, '重复下载应命中分片缓存')
  await h.post(recall('warm'))
  await h.post(event('warm', { eventId: 'late-file-event' }))
  for (const method of ['GET', 'HEAD']) {
    const response = await h.request(`/f/${file.id}/download`, { method })
    assert.equal(response.status, 410)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(h.mock.ranges.length, originCalls)
  h.mock.files.set('racing', { size: 100 })
  await Promise.all([h.post(event('racing')), h.post(recall('racing'))])
  const race = await h.db.prepare('SELECT status FROM files WHERE message_id=?').bind('racing').first<{ status: string }>()
  assert.ok(race === null || race.status === 'deleted')
})

test('撤销权限、管理员、我的链接与统计', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  const file = await register(h, 'commands')
  const path = `/f/${file.id}/download`
  await h.request(path, { method: 'HEAD' })
  const resumed = await h.request(path, { headers: { Range: 'bytes=10-20' } })
  await resumed.arrayBuffer()
  assert.equal((await h.db.prepare('SELECT download_count AS n FROM files WHERE id=?').bind(file.id).first<{ n: number }>())?.n, 0)
  const full = await h.request(path)
  await full.arrayBuffer()
  await eventually<{ n: number } | null>(() => h.db.prepare('SELECT download_count AS n FROM files WHERE id=?').bind(file.id).first<{ n: number }>(), (value) => value?.n === 1)
  await h.post(event('other-revoke', { sender: 'ou_other', type: 'text', content: JSON.stringify({ text: `撤销 ${file.id}` }) }))
  await eventually(async () => h.mock.replies.length, (n) => n >= 2)
  assert.equal((await h.request(path, { method: 'HEAD' })).status, 200)
  await h.post(event('my-links', { type: 'text', content: JSON.stringify({ text: '我的链接' }) }))
  await eventually(async () => h.mock.replies, (replies) => replies.filter((reply) => JSON.stringify(reply).includes(file.id)).length >= 2)
  await h.post(event('owner-revoke', { type: 'text', content: JSON.stringify({ text: `撤销 https://dl.example.test/f/${file.id}` }) }))
  await eventually(() => h.request(path, { method: 'HEAD' }).then((response) => response.status), (status) => status === 410)
  const adminFile = await register(h, 'admin-target')
  await h.post(event('admin-revoke', { sender: 'ou_admin', type: 'text', content: JSON.stringify({ text: `撤销 ${adminFile.id}` }) }))
  await eventually(() => h.request(`/f/${adminFile.id}/download`, { method: 'HEAD' }).then((response) => response.status), (status) => status === 410)
})

test('源错误、损坏响应与失效通知', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  for (const mode of ['throttle', 'bad-range', 'ignore-range'] as const) {
    const file = await register(h, `error-${mode}`)
    h.mock.files.get(`error-${mode}`)!.mode = mode
    const response = await h.request(`/f/${file.id}/download`)
    assert.equal(response.status, 503, mode)
    assert.ok(response.headers.get('retry-after'))
    assert.equal((await h.db.prepare('SELECT status FROM files WHERE id=?').bind(file.id).first<{ status: string }>())?.status, 'active')
  }
  for (const mode of ['truncate', 'oversize'] as const) {
    const file = await register(h, `error-${mode}`)
    h.mock.files.get(`error-${mode}`)!.mode = mode
    const response = await h.request(`/f/${file.id}/download`)
    if (response.status === 200) await assert.rejects(() => response.arrayBuffer(), mode)
    else assert.equal(response.status, 503)
    h.mock.files.get(`error-${mode}`)!.mode = 'ok'
    const repaired = await h.request(`/f/${file.id}/download`)
    assert.equal(repaired.status, 200)
    assert.deepEqual(Buffer.from(await repaired.arrayBuffer()), bytesAt(0, 10000), '损坏分片不得缓存')
  }
  const file = await register(h, 'gone')
  h.mock.files.get('gone')!.mode = 'missing'
  const before = h.mock.replies.length
  assert.equal((await h.request(`/f/${file.id}/download`)).status, 410)
  assert.equal((await h.request(`/f/${file.id}/download`)).status, 410)
  await eventually(async () => h.mock.replies.length, (n) => n > before)
  assert.equal(h.mock.replies.filter((reply) => JSON.stringify(reply).includes('无法读取')).length, 1)
})

test('基础匿名 IP 限流返回 429', { timeout: 60000 }, async (t) => {
  const h = await setup()
  t.after(() => h.mf.dispose())
  let denied = 0
  for (let i = 0; i < 65; i++) {
    const response = await h.request('/f/invalid', { headers: { 'CF-Connecting-IP': '192.0.2.4' } })
    if (response.status === 429) { denied++; assert.equal(response.headers.get('retry-after'), '60') }
  }
  assert.ok(denied > 0)
})
