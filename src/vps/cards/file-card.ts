import type { FileRecord } from '../../types'

type CardFile = Pick<FileRecord, 'id' | 'file_name' | 'file_size' | 'mime_type'>
type CardState = 'active' | 'revoked' | 'unavailable'
const headers = {
  active: ['green', '文件发布成功', '分享中'],
  revoked: ['grey', '文件分享已撤销', '已撤销'],
  unavailable: ['orange', '源文件已失效', '不可用'],
} as const

function plain(content: string) {
  return { tag: 'plain_text', content } as const
}

function paragraph(content: string) {
  return { tag: 'div', text: plain(content) } as const
}

export const revokeButtonName = 'revoke_share'

function activeActions(fileId: string, url: string) {
  return [
    paragraph(url),
    { tag: 'button', text: plain('打开下载链接'), type: 'primary',
      behaviors: [{ type: 'open_url', default_url: url }] },
    paragraph('⚠️ 此链接公开，任何持有链接的人均可下载。请仅分享允许对外发送的文件。'),
    paragraph('文件可用性取决于飞书源文件，不保证永久有效。'),
    paragraph('也可撤回原文件消息，或发送「撤销 <链接>」。'),
    { tag: 'hr' },
    // 提交按钮触发客户端的原生二次确认；下载按钮不能放入该表单。
    { tag: 'form', name: 'revoke_form', elements: [{
      tag: 'button', name: revokeButtonName, type: 'danger', form_action_type: 'submit',
      text: plain('撤销分享'),
      confirm: { title: plain('确认撤销文件分享？'), text: plain('撤销后，客户将无法继续通过此链接发起下载。该操作不可恢复。') },
      behaviors: [{ type: 'callback', value: { action: 'revoke_file', file_id: fileId } }],
    }] },
  ] as const
}

export function buildFileCard(file: CardFile, state: CardState, publicUrl: string) {
  if (file.file_size === null || !Number.isSafeInteger(file.file_size) || file.file_size <= 0) {
    throw new Error('Missing verified file size')
  }
  const [template, title, status] = headers[state]
  const info = [paragraph('📄 ' + file.file_name), paragraph(`文件大小：${(file.file_size / 1048576).toFixed(2)} MiB`)]
  const mime = file.mime_type?.split(';')[0].trim().toLowerCase()
  if (mime && !['application/octet-stream', 'binary/octet-stream'].includes(mime)) info.push(paragraph('文件类型：' + mime))
  const elements = state === 'active' ? [...info, ...activeActions(file.id, publicUrl)]
    : [...info, paragraph(state === 'revoked' ? '该文件的公开分享链接已失效，无法继续发起下载。' : '飞书源文件已无法读取，此下载链接不可用。')]
  return { schema: '2.0', config: { update_multi: true, enable_forward_interaction: false },
    header: { template, title: plain(title), subtitle: plain(status) }, body: { elements } } as const
}

export type FileCard = ReturnType<typeof buildFileCard>
