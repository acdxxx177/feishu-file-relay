import { getFile } from '../db/files'
import type { BotJob } from '../db/files'
import { canRevoke } from '../lib/intake-policy'

function parseTarget(argument: string, env: Env): string | null {
  const input = argument.trim()
  if (/^[A-Za-z0-9]{22}$/.test(input)) return input
  try {
    const url = new URL(input)
    const base = new URL(env.PUBLIC_BASE_URL)
    if (url.origin !== base.origin || url.search || url.hash) return null
    return /^\/f\/([A-Za-z0-9]{22})$/.exec(url.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

export const usageText = '请以文件形式发送需要公开分享的文件。支持「撤销 <链接或ID>」和「我的链接」。仅发送允许对外分享的文件。'

export async function executeCommand(env: Env, job: BotJob): Promise<string> {
  if (job.argument === '我的链接') {
    const files = await env.DB.withSession('first-primary').prepare(`SELECT id,file_name,download_count FROM files
      WHERE uploader_open_id=? AND status='active' ORDER BY created_at DESC,id DESC LIMIT 10`)
      .bind(job.uploader_open_id).all<{ id: string; file_name: string; download_count: number }>()
    if (!files.results.length) return '暂无有效的公开链接。'
    return '最近的有效链接：\n' + files.results.map((file) => `${file.file_name}（下载 ${file.download_count} 次）\n${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/f/${file.id}`).join('\n\n')
  }
  const revoke = /^撤销\s+(.+)$/.exec(job.argument)
  if (!revoke) return usageText
  const id = parseTarget(revoke[1], env)
  if (!id) return '链接或 ID 格式不正确，请发送「撤销 <本服务链接或22位ID>」。'
  const file = await getFile(env.DB, id)
  if (!file) return '未找到该链接。'
  if (!canRevoke(env, file.uploader_open_id, job.uploader_open_id)) return env.FEISHU_INTAKE_POLICY === 'platform'
    ? '无权撤销：仅上传者本人可以撤销。'
    : '无权撤销：仅上传者本人或管理员可以撤销。'
  if (file.status === 'deleted') return '该链接已失效。'
  await env.DB.prepare("UPDATE files SET status='deleted',delete_reason='revoked',deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='deleted'").bind(id).run()
  return `已撤销：${file.file_name}。新的下载请求将返回 410。`
}
