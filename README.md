# 飞书文件中转服务

员工向飞书机器人单聊发送文件，机器人回复公开下载链接，客户无需登录。基于 pnpm、TypeScript、Hono、Cloudflare Workers 和 D1，实现单 Range/If-Range、流式下载、16 MiB 分片缓存、撤回/撤销、平台可用范围授权、持久化重试和下载统计。文件大小配置上限1 GiB，真实大文件尚待验收。不使用 R2、前端或任务队列。

## 本地开发

需要 Node.js 24+、pnpm 11.24.0。自动测试无需任何凭据，使用真实 workerd、独立 D1 SQLite/Cache API 与模拟飞书响应，不读取现有 .env/.dev.vars。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:large
pnpm db:migrate:local
# 仅首次复制；已有文件请手动合并，勿覆盖
Copy-Item .dev.vars.example .dev.vars
pnpm dev
```

访问 http://127.0.0.1:8787/health 返回 `{"status":"ok"}`。本地数据库在 .wrangler/，不会创建远程资源。真实密钥、日志和生成文件均被 Git 忽略。

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 生成平台类型并严格检查服务、测试、mock、脚本 |
| `pnpm test` | dry run 打包，再运行 Node 内置测试与 Miniflare/workerd 集成测试 |
| `pnpm test:large` | 100 MiB、500 MiB、1 GiB 完整与中断续传 SHA-256 校验 |
| `pnpm test:stress` | 本地10路并发1GiB，每路SHA-256与共享分片回源校验 |
| `pnpm build` | Wrangler dry run，只打包，不上传 |
| `pnpm db:migrate:local` | 只应用本地 D1 迁移 |
| `pnpm mock:feishu` | 在127.0.0.1:8790启动模拟飞书，file-demo为100 MiB数据 |
| `Invoke-RestMethod http://127.0.0.1:8787/health` | 开发服务健康检查 |
| `pnpm smoke` | 手动验证已授权测试链接的完整下载与中断续传哈希 |
| `pnpm deploy` | 真正部署，仅在完成配置且获得部署授权后手动执行 |
| `pnpm production:prepare` | 精确读取.env，核对生产账户/域名，生成本地生产配置 |
| `pnpm production:deploy` | 生产D1迁移、代码及Secrets部署、禁止覆盖冲突的域名绑定 |
| `pnpm production:verify` | 无文件登记/消息发送的生产配置与真实令牌检查 |

若镜像未同步锁定版本，可附加 `--registry=https://registry.npmjs.org/`。生产仅依赖 Hono，Miniflare 和 Node 类型仅用于开发验证。

## 配置与部署

阅读[部署说明](docs/deployment.md)、[验收说明](docs/acceptance.md)和[验证日志](docs/verification-log.md)。生产地址为 `https://dl.sinoballvalve.com`，飞书后台配置步骤见部署说明。独立免费版模拟环境继续保留，见[线上模拟测试](docs/online-testing.md)。

生产从忽略的.env读取四项飞书凭据和PUBLIC_BASE_URL，使用FEISHU_INTAKE_POLICY=platform，无需用户/会话名单或管理员ID，仅上传者本人可撤销。旧配置/模拟环境仍可使用allowlist。MAX_FILE_SIZE默认1,073,741,824字节。下载不验证客户身份，任何持有链接的人均可下载，务必仅上传允许外发的文件。

## 接口与实现

| 接口 | 行为 |
| --- | --- |
| `GET /health` | 健康检查，不泄露配置 |
| `POST /webhook/feishu` | 校验/解密、去重、登记、撤回、机器人命令 |
| `GET /f/:id` | 完整200、Range206、错误Range416、多Range忽略返回200、临时错误503 |
| `HEAD /f/:id` | 相同元数据，无body，无回源，不计数 |

公网 Hono Gateway 每次下载先从 D1 主库读取状态。ChunkEntry 是同一 Worker 的具名内部 RPC 入口，通过 ctx.exports 调用，无公开路由；公网 /chunks/* 返回404。分片顺序读取，长度、Content-Range与实际EOF均验证后缓存；损坏分片不缓存，中途错误中断响应，不伪装完整成功。Cache API 每数据中心独立，可被驱逐，不是持久存储。

Webhook 返回成功前持久化最小状态，所有飞书 I/O 放入 waitUntil；pending 和机器人回复有租约、持久化重试，Cron 每5分钟补偿。墓碑和条件更新保证已撤回文件不会复活。命令为 `撤销 <本服务链接或ID>` 和 `我的链接`。

下载强制附件、octet-stream、nosniff/noindex/no-referrer，支持中文文件名；200/206为 private,no-cache，错误/失效为no-store。起始偏移0且开始发送body的GET计数，HEAD和非零偏移续传不计数。

## 边界

- bytes=0-0精确回源1字节，避免拉取整片。PRD同时要求真实首字节、D1不存内容和只读D1，无法同时满足；此处优先数据正确和低回源量。HEAD完全不回源。
- 短退避2/10/60秒为最早重试时间，实际调度由后续回调或Cron触发，可能延后5分钟。
- 当前只将资源HTTP404/410确认永久失效；429/5xx、网络和鉴权/配置错误不永久作废。真实飞书业务码需联调。
- 源站不提供可信206/Content-Range时拒绝登记，不估算文件大小。忽略Range的小文件兼容需真实观测后确定。
- 真实飞书大文件可读性、边缘CDN、多地区TTFB、生产10路1GiB并发和附件1/7/30天保留需人工验收，本地模拟通过不能替代。
- 撤回/撤销之后新请求410，即使缓存仍在；进行中每8片复查。已交付字节与客户保存文件无法追回。

参考：[PRD v1.1](PRD.md)、[Workers ctx.exports](https://developers.cloudflare.com/workers/runtime-apis/context/)、[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)、[飞书Token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)。
