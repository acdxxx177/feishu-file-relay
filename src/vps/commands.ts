import type { Config } from './config'
import type { RelayRepository, BotJob } from '../db/repository'
import { canRevoke } from './intake-policy'

export const usageText = '请以文件形式发送需要公开分享的文件。支持「撤销 <链接或ID>」和「我的链接」。仅发送允许对外分享的文件。'

function target(input: string, base: string): string | null {
  if (/^[A-Za-z0-9]{22}$/.test(input)) return input
  try {
    const url = new URL(input)
    if (url.origin !== new URL(base).origin || url.search || url.hash) return null
    return /^\/f\/([A-Za-z0-9]{22})$/.exec(url.pathname)?.[1] ?? null
  } catch { return null }
}

export async function executeCommand(config: Config, repository: RelayRepository, job: BotJob): Promise<string> {
  if (job.argument === '我的链接') {
    const files = await repository.listFiles(job.uploader_open_id)
    return files.length ? '最近的有效链接：\n' + files.map((file) => `${file.file_name}（下载 ${file.download_count} 次）\n${config.PUBLIC_BASE_URL}/f/${file.id}`).join('\n\n') : '暂无有效的公开链接。'
  }
  const match = /^撤销\s+(.+)$/.exec(job.argument)
  if (!match) return usageText
  const id = target(match[1].trim(), config.PUBLIC_BASE_URL)
  if (!id) return '链接或 ID 格式不正确，请发送「撤销 <本服务链接或22位ID>」。'
  const file = await repository.getFile(id)
  if (!file) return '未找到该链接。'
  if (!canRevoke(config, file.uploader_open_id, job.uploader_open_id)) return config.FEISHU_INTAKE_POLICY === 'platform' ? '无权撤销：仅上传者本人可以撤销。' : '无权撤销：仅上传者本人或管理员可以撤销。'
  if (file.status === 'deleted') return '该链接已失效。'
  const revoked = await repository.revokeFile(id, job.uploader_open_id, config.FEISHU_INTAKE_POLICY === 'allowlist' && canRevoke(config, '__other__', job.uploader_open_id))
  if (!revoked) return '该链接已失效。'
  return `已撤销：${file.file_name}。新的下载请求将返回 410。`
}
