import type { FirstDownloadJobPayload, FirstDownloadSnapshot } from '../../db/repository'

export function readFirstDownloadPayload(argument: string): FirstDownloadJobPayload {
  const payload = JSON.parse(argument) as FirstDownloadJobPayload
  const snapshot = payload?.snapshot
  if (!snapshot || snapshot.schema !== 1 || (snapshot.method !== 'native' && snapshot.method !== 'blob') ||
    typeof snapshot.fileName !== 'string' || !snapshot.fileName || snapshot.fileName.length > 1024 ||
    typeof snapshot.confirmedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(snapshot.confirmedAt) ||
    !Number.isFinite(Date.parse(snapshot.confirmedAt)) || !snapshot.location ||
    (payload.delivery !== 'unsent' && payload.delivery !== 'uncertain')) throw new Error('Invalid first download snapshot')
  for (const value of [snapshot.location.country, snapshot.location.region, snapshot.location.city]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) throw new Error('Invalid location')
  }
  return payload
}

export function buildFirstDownloadCard(snapshot: FirstDownloadSnapshot) {
  const plain = (content: string) => ({ tag: 'plain_text', content } as const)
  const paragraph = (content: string) => ({ tag: 'div', text: plain(content) } as const)
  const time = new Date(Date.parse(snapshot.confirmedAt) + 8 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ')
  const location = [snapshot.location.country, snapshot.location.region, snapshot.location.city].filter(Boolean).join(' / ') || '位置未知'
  return {
    schema: '2.0', config: { update_multi: true, enable_forward_interaction: false },
    header: { template: 'green', title: plain('文件首次确认下载'), subtitle: plain('首次确认') },
    body: { elements: [
      paragraph('📄 ' + snapshot.fileName),
      paragraph(`首次确认时间：${time}（UTC+8）`),
      paragraph(`大致地点：${location}`),
      paragraph(snapshot.method === 'native' ? '完成方式：浏览器报告完整文件保存提交成功。' : '完成方式：已完整接收并点击保存，无法确认最终保存结果。'),
      paragraph('这是本服务首次接受的浏览器完整下载确认；不代表所有下载渠道中的绝对首次，也不代表文件已被打开。'),
      paragraph('地点为网络出口的大致位置，可能受 VPN、代理或移动网络影响。'),
    ] },
  } as const
}

export type FirstDownloadCard = ReturnType<typeof buildFirstDownloadCard>
