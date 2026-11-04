# VPS 迁移说明

默认运行时已迁移到 Node.js VPS。当前部署、环境配置和回滚以 [VPS 部署指南](vps-deployment.md) 为准；本页下方为旧 Worker 的恢复参考，不表示已切换生产。

---

# 真实飞书配置与部署

生产入口为 `https://dl.sinoballvalve.com`，Worker 和独立 D1 均名为 `feishu-file-relay`。使用账户现有套餐，不自动升级。隔离模拟环境继续保留，见[线上模拟测试](online-testing.md)；当前部署证据见[验证日志](verification-log.md)。

## 飞书后台现在需要配置什么

1. 打开[飞书开发者后台](https://open.feishu.cn/app)，进入与 `.env` 中 App ID 对应的**企业自建应用**。
2. 在「添加应用能力」中开启**机器人**。在应用发布/管理后台设置应用的**可用范围**，限定允许使用的用户或部门。本服务依赖该范围控制用户，不维护本地用户/会话名单；保持内部使用，不开启不需要的对外共享能力。
3. 在「权限管理」中开通以下**应用身份权限**，无需用户 OAuth 授权：

| 权限标识 | 名称 | 用途 |
| --- | --- | --- |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 | 接收文件及文本命令 |
| `im:message:readonly` | 获取单聊、群组消息 | 读取消息附件、订阅消息撤回事件 |
| `im:message:send_as_bot` | 以应用的身份发消息 | 机器人回复下载链接和命令结果 |

权限名称以当前后台为准。资源接口和撤回事件支持 `im:message:readonly`，不必为了此服务开通范围更大的 `im:message`。本服务不上传文件，不需要上传资源权限 `im:resource`。参考官方[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[获取消息中的资源文件](https://open.feishu.cn/document/server-docs/im-v1/message/get-2)、[消息撤回事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/recalled)和[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)。

4. 进入「事件与回调 → 事件配置」，订阅方式选择 **将事件发送至开发者服务器**，不要选择长连接。请求地址填写：

```text
https://dl.sinoballvalve.com/webhook/feishu
```

5. 在「加密策略/安全设置」确认 **Verification Token**、**Encrypt Key** 与本地 `.env` 完全一致，启用加密推送，再保存请求地址完成 URL challenge。不要在聊天或截图中展示这些值；若后台重新生成了密钥，先更新 `.env` 并重新部署，再保存地址。
6. 添加事件 **接收消息** `im.message.receive_v1` 和 **消息撤回** `im.message.recalled_v1`。这里只需要事件订阅，不需要另配卡片回调或网页 OAuth 重定向地址。
7. 在「版本管理与发布」创建版本、确认权限及可用范围、申请发布并完成所需管理员审批。权限或订阅变更后要重新发布，不能只停留在草稿状态。
8. 在飞书客户端搜索机器人，打开单聊，用明确允许公开分享的小文件验证：发送文件 → 收到链接 → 浏览器免登录下载 → 真正撤回原文件消息 → 链接 GET/HEAD 返回 410。「仅自己删除」不等于撤回；也可以发送 `撤销 <链接>`。发送 `我的链接` 仅返回本人最近十条有效链接。

生产只接收用户与机器人的单聊消息，忽略群聊和机器人发送者。只有上传者本人能撤销链接，不配置管理员 ID。已经获取链接的人都能下载并转发；从应用可用范围移除上传者，不会自动撤销其已有公开链接。

## 生产凭据与配置

`.env` 仅需以下五项；真实值已被 Git 忽略，示例见根目录 `.env.example`：

```dotenv
FEISHU_APP_ID=replace-with-app-id
FEISHU_APP_SECRET=replace-with-app-secret
FEISHU_VERIFICATION_TOKEN=replace-with-verification-token
FEISHU_ENCRYPT_KEY=replace-with-encrypt-key
PUBLIC_BASE_URL=https://dl.sinoballvalve.com
```

脚本使用 Node 原生 `parseEnv` 精确读取 `.env`，不执行变量展开，也不使用 `.dev.vars` 或进程环境替换四项凭据。四项值写入忽略文件 `.local/production-secrets.json`，通过 Wrangler 的 JSON `--secrets-file` 与代码同次上传，远程仅保存 Secret；`PUBLIC_BASE_URL` 为普通变量。不输出凭据或 access_token。`.env`/`.dev.vars` 本身不会自动成为部署 Secrets，见[官方 Secrets 说明](https://developers.cloudflare.com/workers/configuration/secrets/)。

生产 `FEISHU_INTAKE_POLICY=platform`、`FEISHU_TRANSPORT=real`，无模拟 Service Binding；`ALLOWED_OPEN_IDS`、`FEISHU_ALLOWED_CHAT_IDS`、`ADMIN_OPEN_IDS` 均无需配置。模拟/旧配置仍可选择 `allowlist`，未设置策略也默认该模式，空名单拒绝接入；管理员须同时处于上传者名单。未知策略拒绝接入。

实际 D1 ID、域名、普通变量、限流、Cron 与可观测性配置保存在 `wrangler.jsonc`。D1 只存索引、状态和持久化回复任务，不存文件字节、Secret 或令牌；只应用正常 `migrations/`，生产不导入 `testing-migrations/`。`remote:false` 只约束本地开发，已部署 Worker 仍访问真实数据库。

## 再次部署与校验

在仓库根目录执行；这些生产命令会更改远程资源，仅在操作者授权后运行：

```powershell
pnpm install --frozen-lockfile
pnpm production:prepare
pnpm typecheck
pnpm test
pnpm build
pnpm production:deploy
pnpm production:verify
```

`production:prepare` 只核对账户、域名和凭据，生成本地配置及 Secrets 文件，不创建远程资源。首次 `production:deploy` 创建 APAC 的生产 D1，将标识持久化到忽略的 `.local/production.json`，迁移后部署；后续复用该库。若发现已有同名 Worker/D1 但没有本机生产清单，停止并要求先核对资源，不能盲目接管。不要删除生产清单来重跑首次创建。

生产上传使用忽略的 `.local/production-worker.json`，其中不包含域名路由；随后单独绑定 Custom Domain，并明确设置禁止覆盖既有 DNS/其他 Worker 域名。冲突时停止，不删除任何旧记录。Wrangler 非交互模式可能覆盖冲突 DNS，因此不要绕过脚本直接对根配置运行 `wrangler deploy`。`pnpm deploy` 已转向该生产流程。Custom Domain 自动创建 DNS/证书，见[官方说明](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

`production:verify` 检查 HTTPS、明文/加密 challenge、错误回调 401、未知文件 HEAD 404、Secret 名称、生产绑定、workers.dev/预览关闭、D1 表和记录数，并在本地用真实凭据获取一次飞书令牌，只记录成功与 HTTP 状态。报告保存于 `.local/production-verification.json`。它不会登记虚构文件、发送机器人消息或执行大文件下载；也不能代替真实飞书事件推送测试。

生产 workers.dev、预览入口均关闭，ChunkEntry 只通过 `ctx.exports` 内部访问。不要给下载域名加客户登录/Cloudflare Access，也不要配置绕过 Worker 或缓存整个 `/f/*` 响应的规则。每次新 GET/HEAD 都必须经过 D1 状态检查。测试环境及其生成配置显式 `routes:[]`，不会继承生产域名。

## 运行与待验收边界

Cron 每五分钟恢复 pending/回复任务，清理七天前事件记录；2/10/60 秒是重试的最早时间，实际可能延后至下一次 Cron。关注 `bot_reply_retry`、`validation_retry`、`download_interrupted`、401/429/503 和 pending 积压。默认应用日志不含凭据、完整请求头或文件内容。

文件大小配置仍为 1 GiB，内部源站分片为 16 MiB。当前官方资源接口文档说明：`type=file` 的 100 MB 及以上文件需使用 Range，单次源站分片不超过 32 MB；本实现的 16 MiB 符合这个接口上限，但真实文件仍需联调验证。缺少可信 206/Content-Range 时停止登记，不估算长度。

历史免费版线上模拟的 100 MiB 下载已触发 `exceededCpu`，本次不升级套餐、不重复扩大压力，也不把配置的 1 GiB 当成生产验收通过。先完成小文件真实链路，再按[验收说明](acceptance.md)另行授权验证真实 Range、缓存、附件保留与大文件能力。

## 浏览器分片版本部署

本次实现未授权部署生产。生产部署仍使用原安全脚本，浏览器资源在脚本调用Wrangler前自动构建，无新增D1迁移。公开链接变为页面，原始客户端地址补 `/download`。完整生产检查、授权及部署命令见[浏览器下载说明](browser-downloads.md#生产部署步骤本次不执行)。
