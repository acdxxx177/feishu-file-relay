# Docker 与 GHCR 部署

运行环境为 Linux AMD64、Docker Engine 与 Docker Compose v2。容器运行 Node.js 24，远程 D1 保存元数据，飞书保存原文件。无需数据库容器、数据卷或启动迁移。本文延续 [VPS 部署指南](vps-deployment.md) 的切换门槛，以及 PRD §9 的凭据隔离、限流和撤回授权要求。

## 生成并填写环境配置

在仓库根目录执行（Node.js 24；生成脚本本身无需安装依赖）：

```sh
node scripts/generate-docker-env.ts
# 已安装 pnpm 时等价：pnpm env:docker
# 自定义输出路径：pnpm env:docker /受保护目录/relay.env
```

默认生成 `.env.docker`。已有文件会拒绝覆盖；脚本不读取 `.env`、进程中的凭据或生产配置。Linux 新文件权限为 `0600`；Windows 请限制文件访问权限。默认文件已被 Git 忽略，任意自定义输出也应保存在仓库之外。

必须手动填写四项 `FEISHU_*` 凭据、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_DATABASE_ID`、`CLOUDFLARE_D1_TOKEN` 与 `PUBLIC_BASE_URL`。公开地址必须为 HTTPS origin，例如 `https://dl.example.com`。未知项为空时应用拒绝启动；不从旧 `.env` 补齐。新数据库需另行按已有文档准备 schema，容器不会初始化数据库。

模板含所有应用配置及 Docker 参数。`HOST=0.0.0.0` 为容器监听地址，`PORT=3000` 为容器端口，`PUBLISHED_PORT=3000` 为宿主机回环端口。`DOCKER_IMAGE` 留空时使用 `feishu-file-relay:local`。部署默认采用 platform 接入策略、关闭分片缓存、十个并发下载和单实例。

Compose 从显式 `--env-file` 读取变量，进程环境中的同名变量优先。凭据含 `$`、`#` 或空格时用单引号包围，例如：

```dotenv
FEISHU_APP_SECRET='fake$secret# value'
```

不要把 `.env.docker` 当作 shell 脚本执行，也不要把真实凭据放入 CLI 参数。单引号内的 `$` 不插值；值中的单引号使用 `\'` 转义。不要用双引号包围含 `$` 的凭据。规则见 [Compose 环境插值文档](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。只用 `config --quiet` 检查生产配置，完整 `config`/`inspect` 输出可能含凭据。

## 本地构建和启动

```sh
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker build --pull
# 只在已获准连接对应 D1 的环境启动；启动会恢复数据库待办。
docker compose --env-file .env.docker up -d --no-build --pull never
docker compose --env-file .env.docker ps
curl --fail http://127.0.0.1:3000/health
```

镜像以非 root 用户运行，只读根文件系统，不挂载凭据文件，应用仅接收环境变量。Dockerfile 使用锁定 pnpm 与冻结锁文件，构建 Prisma Client、浏览器资源和服务端；运行时直接执行构建产物，不使用会加载 `.env` 的 `pnpm start`。

存活检查每 30 秒访问 `/health`，不查询 D1。健康失败会标记 unhealthy，但 Docker 的 restart 策略只在进程退出时重启，不会仅因 unhealthy 自动重启。启动前应确认资源、网络和凭据，按现有 VPS 清单配置监控。

## 宿主机代理与网络

复用 [Nginx 模板](../deploy/nginx.conf)，将 `server_name` 和证书路径改为实际域名；如调整 `PUBLISHED_PORT`，同步修改 `proxy_pass`。必须覆盖 `X-Real-IP`，保持 `/ready` 公网 404，关闭缓存、响应缓冲、压缩和响应临时文件。HTTPS 证书与 DNS 不由容器配置管理。

Compose 使用独立 bridge 网络，默认子网 `172.30.0.0/24`、网关 `172.30.0.1`，仅向宿主机 `127.0.0.1` 发布端口。`TRUSTED_PROXY_IPS` 留空时由 Compose 取 `DOCKER_GATEWAY`，不要把整个网段或任意代理设为可信。与已有网络冲突时同时修改 `DOCKER_SUBNET` 和 `DOCKER_GATEWAY`；若明确填写了 `TRUSTED_PROXY_IPS`，也需同步修改。

应用只在 `TRUST_PROXY=true` 且 socket 来源为回环或列表内的 IP 时接受单个合法 `X-Real-IP`。列表支持逗号分隔 IPv4/IPv6，不支持 CIDR、域名或通配符；IPv4-mapped IPv6 可匹配对应 IPv4。其他转发头不参与限流。Docker rootless、Docker Desktop 或其他 NAT 拓扑的来源可能不同，应以目标 Linux VPS 实测为准，不要通过信任所有地址绕过问题。

`/ready` 始终只允许容器内部回环访问，检查方式：

```sh
docker compose --env-file .env.docker exec -T relay node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready',{signal:AbortSignal.timeout(10000)}).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
```

默认应用排空上限为 60 秒，Compose 停止宽限为 70 秒。修改 `SHUTDOWN_TIMEOUT_MS` 时必须同步增大 `STOP_GRACE_PERIOD`，至少多留 10 秒。运行单实例，不通过扩容绕过本地 D1 配额预算；生产切换时协调停用旧 Worker Cron。

## GitHub Actions 和 GHCR

将仓库推送到 GitHub 后工作流自动生效；当前配置不替你创建远程仓库。`main` 更新与 PR 运行类型检查、测试、大文件完整性和 Linux AMD64 镜像测试，不发布镜像。标签 `v*` 和手动触发先通过同样验证，再发布：

| 触发方式 | 发布标签 |
| --- | --- |
| `v1.2.3` | `1.2.3`、`sha-<完整提交号>`、`latest` |
| `v1.2.3-rc.1` | `1.2.3-rc.1`、`sha-<完整提交号>` |
| 手动 Run workflow | 仅 `sha-<完整提交号>` |

非 SemVer 的 `v*` 标签拒绝发布；构建元数据中的 `+` 转为 Docker 标签允许的 `_`。镜像地址自动取小写 `ghcr.io/<owner>/<repository>`。不要移动已有发布标签；版本/提交标签用于定位版本，要求完全固定内容时使用镜像摘要。

工作流使用 `GITHUB_TOKEN`，只有发布任务拥有 `packages: write`；无需配置飞书或 D1 Secrets，也不需要用于上传的个人 PAT。已有同名 GHCR package 若不属于此仓库，需由所有者配置仓库写入权限。Package 可见性不会自动改为 public；组织策略也可能限制发布。Actions 已固定到公开仓库核验的提交 SHA。

正式发布示例（需由维护者执行推送）：

```sh
git tag v1.0.0
git push origin v1.0.0
```

发布只上传镜像，不登录 VPS、不自动启动服务、不执行 D1 迁移。行为参考 [GitHub 镜像发布文档](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)。

## 拉取、升级与回滚

私有镜像需先执行 `docker login ghcr.io -u <GitHub用户名>`，在密码提示中输入具有 `read:packages` 权限的凭据；不要把 Token 写入命令参数。公开镜像通常无需登录。

在 `.env.docker` 填写 `DOCKER_IMAGE=ghcr.io/<owner>/<repository>:1.0.0`，或使用 `ghcr.io/<owner>/<repository>@sha256:<摘要>`，然后：

```sh
docker compose --env-file .env.docker pull relay
docker compose --env-file .env.docker up -d --no-build --pull never
docker compose --env-file .env.docker ps
```

更新环境变量也需要重新执行 `up -d`，仅 `restart` 不会重新注入配置。每次升级记录原镜像摘要。回滚时改回上一摘要并执行同样命令；沿用同一 D1，不恢复旧数据库快照覆盖新记录或撤回墓碑。DNS/Worker 切换和真实文件验收沿用 [VPS 切换清单](vps-deployment.md)。

## 验证命令与边界

```sh
pnpm typecheck
pnpm test
pnpm check:health
pnpm test:large
docker build --platform linux/amd64 -t feishu-file-relay:ci .
pnpm test:docker
```

`test:docker` 使用虚构凭据，检查 Compose 插值、镜像非 root 启动、静态资源、SIGTERM 退出和桥接网关的客户限流隔离。运行容器采用 `--network none` 或专属 internal 网络，避免启动扫描接触真实 D1/飞书。测试只删除本次随机命名的容器和网络。可用 `DOCKER_TEST_IMAGE` 指定已构建的测试镜像。

没有 Docker CLI/daemon 时本地 Docker 检查明确跳过；CI 设置 `REQUIRE_DOCKER=1`，此时缺少 Docker 会失败。容器测试不等于真实 D1、飞书、目标代理或生产容量验收；已执行结果记在 [验证日志](verification-log.md)。
