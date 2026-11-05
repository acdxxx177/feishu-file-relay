import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildFileCard } from '../../src/vps/cards/file-card'

const file = { id: 'ibQS5eskUbtPAIqXTRVite', file_name: 'API 6D QSL-3G的试压标准.pdf', file_size: 492831, mime_type: 'application/pdf' }
const url = 'https://dl.example.com/f/' + file.id

test('generated Card 2.0 matches the documented publication, confirmation and callback contract', () => {
  const card = buildFileCard(file, 'active', url)
  const sample = JSON.parse(readFileSync(new URL('../../docs/file-card-example.json', import.meta.url), 'utf8'))
  assert.deepEqual(card, sample)
  assert.equal(card.schema, '2.0')
  assert.equal(card.config.update_multi, true)
  assert.deepEqual(card.header, { template: 'green', title: { tag: 'plain_text', content: '文件发布成功' }, subtitle: { tag: 'plain_text', content: '分享中' } })
  const lines = card.body.elements.filter((e) => e.tag === 'div').map((e) => e.text.content)
  for (const line of ['📄 ' + file.file_name, '文件大小：0.47 MiB', '文件类型：application/pdf', url,
    '⚠️ 此链接公开，任何持有链接的人均可下载。请仅分享允许对外发送的文件。', '文件可用性取决于飞书源文件，不保证永久有效。']) assert.ok(lines.includes(line))
  const open = card.body.elements.find((e) => e.tag === 'button')!
  assert.equal(open.text.content, '打开下载链接')
  assert.equal(open.type, 'primary')
  assert.deepEqual(open.behaviors, [{ type: 'open_url', default_url: url }])
  const form = card.body.elements.find((e) => e.tag === 'form')!
  const [submit] = form.elements
  assert.equal(submit.form_action_type, 'submit')
  assert.equal(submit.type, 'danger')
  assert.equal(submit.text.content, '撤销分享')
  assert.deepEqual(submit.behaviors, [{ type: 'callback', value: { action: 'revoke_file', file_id: file.id } }])
  assert.deepEqual(submit.confirm, { title: { tag: 'plain_text', content: '确认撤销文件分享？' },
    text: { tag: 'plain_text', content: '撤销后，客户将无法继续通过此链接发起下载。该操作不可恢复。' } })
})

test('filenames stay literal and terminal cards contain no URL or actions', () => {
  const name = '报价 "[客户](url)" <at id=all> &.pdf'
  for (const state of ['revoked', 'unavailable'] as const) {
    const card = buildFileCard({ ...file, file_name: name, mime_type: 'application/octet-stream' }, state, url)
    const elements = JSON.parse(JSON.stringify(card)).body.elements
    assert.deepEqual(elements[0], { tag: 'div', text: { tag: 'plain_text', content: '📄 ' + name } })
    assert.ok(elements.every((e: { tag: string }) => e.tag === 'div'))
    assert.equal(elements[2].text.content, state === 'revoked' ? '该文件的公开分享链接已失效，无法继续发起下载。' : '飞书源文件已无法读取，此下载链接不可用。')
    assert.equal(elements.length, 3)
    assert.equal(card.header.title.content, state === 'revoked' ? '文件分享已撤销' : '源文件已失效')
    assert.equal(card.header.subtitle.content, state === 'revoked' ? '已撤销' : '不可用')
    assert.ok(!JSON.stringify(card).includes(url))
  }
})
