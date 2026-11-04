import { createApplication } from '../../src/vps/app'
import { readConfig } from '../../src/vps/config'
import { createFeishuClient } from '../../src/vps/feishu'
import type { RelayRepository } from '../../src/db/repository'

// CLI 只枚举路由和检查 /health；任何数据访问均拒绝，绝不读取本机生产环境。
const config = readConfig({ FEISHU_APP_ID: 'cli', FEISHU_APP_SECRET: 'cli', FEISHU_VERIFICATION_TOKEN: 'cli', FEISHU_ENCRYPT_KEY: 'cli',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_DATABASE_ID: '00000000-0000-0000-0000-000000000000', CLOUDFLARE_D1_TOKEN: 'cli' })
const repository = new Proxy({} as RelayRepository, { get: () => async () => { throw new Error('CLI database disabled') } })
export default createApplication(config, repository, createFeishuClient(config, async () => { throw new Error('CLI transport disabled') })).app
