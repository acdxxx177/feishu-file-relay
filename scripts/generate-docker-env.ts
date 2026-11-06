import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const dockerEnvTemplate = `# Docker 配置模板；不读取已有 .env，不含真实凭据。
# 未知值保持为空，必填项未补齐时应用将拒绝启动。
# 含 $、#、空格的值请用单引号包围，例如 FEISHU_APP_SECRET='fake$secret#value'
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_DATABASE_ID=
CLOUDFLARE_D1_TOKEN=
PUBLIC_BASE_URL=

HOST=0.0.0.0
PORT=3000
FEISHU_INTAKE_POLICY=platform
FEISHU_TRANSPORT=real
FEISHU_API_BASE=https://open.feishu.cn
FEISHU_ACCOUNTS_BASE=https://accounts.feishu.cn
ALLOWED_OPEN_IDS=
ADMIN_OPEN_IDS=
MAX_FILE_SIZE=1073741824
UPSTREAM_READ_TIMEOUT_MS=30000
WEBHOOK_MAX_SKEW_SECONDS=300
D1_REQUEST_BUDGET=900
MAX_CONCURRENT_DOWNLOADS=10
DOWNLOAD_RATE_LIMIT=60
CHUNK_CACHE_ENABLED=false
# 先应用迁移，再开启新文件的首次确认通知。
FIRST_DOWNLOAD_NOTIFICATION_ENABLED=false
# 先验证代理的 Cloudflare 来源检查和内部地理头覆盖。
TRUST_CLOUDFLARE_GEO=false
TRUST_PROXY=true
# 留空时 Compose 使用 DOCKER_GATEWAY；只允许明确 IP，不接受 CIDR 或通配符。
TRUSTED_PROXY_IPS=
SHUTDOWN_TIMEOUT_MS=60000
JOB_POLL_MS=15000

# 留空使用本地构建镜像；拉取 GHCR 时填写完整镜像名和版本或摘要。
DOCKER_IMAGE=
PUBLISHED_PORT=3000
DOCKER_SUBNET=172.30.0.0/24
DOCKER_GATEWAY=172.30.0.1
# 必须大于 SHUTDOWN_TIMEOUT_MS，给退出清理预留时间。
STOP_GRACE_PERIOD=70s
`

export async function generateDockerEnv(output = '.env.docker'): Promise<string> {
  const destination = resolve(output)
  // wx 原子拒绝覆盖，包括已有符号链接；只生成模板，不尝试获取生产配置。
  await writeFile(destination, dockerEnvTemplate, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return destination
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) {
    console.error('用法：node scripts/generate-docker-env.ts [输出路径]')
    process.exitCode = 1
  } else {
    try {
      console.log(`已生成环境模板：${await generateDockerEnv(args[0])}`)
    } catch (error) {
      console.error((error as NodeJS.ErrnoException).code === 'EEXIST' ? '目标文件已存在，未覆盖。' : '环境模板生成失败，请检查目标目录和权限。')
      process.exitCode = 1
    }
  }
}
