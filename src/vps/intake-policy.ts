import type { Config } from './config'
type PolicyEnv = Pick<Config, 'FEISHU_INTAKE_POLICY' | 'ALLOWED_OPEN_IDS' | 'ADMIN_OPEN_IDS'>

function includesOpenId(list: string | undefined, id: string): boolean {
  return (list ?? '').split(',').map((value) => value.trim()).filter(Boolean).includes(id)
}

export function canUpload(env: PolicyEnv, openId: string): boolean {
  // 仅显式 platform 模式信任飞书应用可用范围；旧配置仍按名单拒绝未授权用户。
  const policy = env.FEISHU_INTAKE_POLICY ?? 'allowlist'
  return policy === 'platform' || (policy === 'allowlist' && includesOpenId(env.ALLOWED_OPEN_IDS, openId))
}

export function canRevoke(env: PolicyEnv, uploaderOpenId: string, senderOpenId: string): boolean {
  const policy = env.FEISHU_INTAKE_POLICY ?? 'allowlist'
  if (policy !== 'platform' && policy !== 'allowlist') return false
  return uploaderOpenId === senderOpenId || (policy === 'allowlist'
    && includesOpenId(env.ALLOWED_OPEN_IDS, senderOpenId)
    && includesOpenId(env.ADMIN_OPEN_IDS, senderOpenId))
}
