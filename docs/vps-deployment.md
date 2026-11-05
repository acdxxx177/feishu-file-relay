# VPS 部署、迁移与回滚

使用 Docker 时请按 [Docker 与 GHCR 部署](docker-deployment.md) 操作；仍须完成本文的生产切换与回滚清单。Docker 桥接模式通过明确的 `TRUSTED_PROXY_IPS` 信任宿主机代理，readiness 在容器内检查。

## 当前交付边界

应用采用 Node.js 24、Hono、Prisma 7.10.1，VPS 直接请求飞书内容及 Cloudflare D1 REST API。数据库仍是原生产 D1，原有 ID、记录和 `https://dl.sinoballvalve.com/f/<id>` 不变。本次代码交付没有部署生产、修改 DNS 或注册真实文件。

旧 Worker 入口、配置及脚本保留作恢复材料；默认 `build/dev/test` 已改为 VPS，旧验证使用 `*:worker`。`pnpm deploy` 故意拒绝自动发布，生产变更必须按下方清单授权执行。

## 飞书文件分享卡片

VPS 在运行时用 TypeScript 生成卡片 JSON 2.0，通过发送消息接口的 `msg_type: "interactive"` 和序列化的 `content` 投递到原单聊。无需创建、发布卡片模板或开通 CardKit 实体接口。完整的[生成示例](file-card-example.json)使用示例域名。[飞书卡片结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)

1. 在获准使用的测试应用启用机器人。确认已有应用权限 `im:message:send_as_bot`，它可用于发送并更新本应用自己的卡片。继续保留原有接收单聊消息、读取文件及撤回事件设置。无需申请读取员工 user_id 的权限，鉴权使用应用范围内的 open_id。[发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create) · [更新消息卡片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)
2. 在**事件与回调 → 回调配置**选择将回调发送至开发者服务器，将地址设为 `https://<测试域名>/webhook/feishu`，完成网址验证，添加**卡片回传交互**（`card.action.trigger`）。事件订阅和回调订阅是两个配置项。按平台要求使测试版本配置生效。加密策略中的 Encrypt Key 和 Verification Token 须与 VPS 配置一致。[接收回调](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)
3. 服务使用原始请求体和飞书请求头验证签名、解密加密数据，并校验 Token、App ID 与时间窗口。撤销事务逐项比对回调中的操作人、聊天、机器人卡片消息 ID 和 D1 中的文件。确认弹窗由飞书客户端提供，只有确认才会提交表单。卡片转发件关闭回传交互。[按钮与确认弹窗](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button) · [回调字段](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)

**运维与恢复。** 文件的 `files.message_id` 用于源附件。新 VPS 发布任务 `active:card:<文件ID>` 的 `bot_jobs.message_id` 保存飞书返回的卡片消息 ID。无需迁移或回填。撤销、撤回、源文件无法读取均先写入 D1，再由持久任务更新原卡片。过期或已被撤回的卡片可能仍显示旧内容，但 D1 会拦截后续下载。可根据文件 ID、任务状态和脱敏的 `card_delivery_failed`、`bot_reply_failed` 日志定位失败。

飞书明确拒绝卡片格式时，服务可用同一公开链接发送中文文本。遇到响应丢失、回执缺少消息 ID 等结果不明的情况，只在一小时去重窗口内用原 UUID 重试。超过安全窗口后停止自动投递；员工可发送「我的链接」找回有效地址。客户端低于 7.20 时显示升级提示。卡片发出 14 天后不能更新，30 天后不能再提交交互；此时可发送「撤销 <链接>」或撤回源消息。[交互与更新时限](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)

**回滚至旧运行时前**，先暂停新事件及卡片操作入口，等待 VPS 的发布、文字兜底和卡片更新任务完成，检查下列只读查询返回零行后再启用旧 Worker 的事件路由和 Cron。若仍有任务，保留 VPS 处理器继续恢复，避免旧 Worker 将这些任务作为普通文本消费。切换期间已有卡片可使用文字撤销命令。

```sql
SELECT id, state, attempts FROM bot_jobs
WHERE state = 'pending' AND
  (id LIKE 'active:card:%' OR id LIKE 'card:%' OR id LIKE 'fallback:%');
```

飞书仅保证相同 UUID 在一小时内最多成功发送一次。重试是否会返回原卡片的消息 ID 需要在获准的测试应用验证。若未获得可确认的回执，查看发布任务和脱敏日志；不要手动重新登记同一文件。

## 本地构建和检查

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm test
pnpm test:large
pnpm test:stress
pnpm build
pnpm db:check
pnpm db:diff
```

Linux 已安装 Nginx 时，可设置 `NGINX_TEST_BINARY` 为其绝对路径并运行 `pnpm test:linux`。该测试生成临时自签证书、在回环高端口启动独立 Nginx、使用本地假 D1/飞书，检查 HTTPS 100 MiB 哈希、Range、撤回、断连及无响应临时文件；退出时停止本次 Nginx 并清理本次测试目录。Windows 或未指定二进制时显式跳过，不能算 Linux 验收。

`db:generate` 只生成忽略入库的 Prisma Client；`db:check` 默认仅检查本地初始 schema；`db:diff` 从既有迁移创建本次专属影子库，输出 `.local/prisma-candidate.sql`，不执行任何远程操作。Prisma 对 BIGINT 等声明和 CHECK 支持的差异可能生成表重建 SQL，**不能直接应用初次 diff**。本次没有必要改变业务表，也不需要新迁移。

开发可复制 `.env.example` 为受保护的 `.env` 后执行 `pnpm dev`；运行构建用 `pnpm start`。真实配置启动后会立即恢复数据库待办，因此未获批准时不能连接生产库试运行。测试注入假凭据和本地 transport，不读取 `.env`。

## Prisma 与远程 D1

Prisma schema 使用 `@map/@@map` 保留表列名称；TEXT 时间保持字符串，毫秒时间和统计映射 BigInt，在 repository 转换为安全整数。数据库原有 CHECK、默认值和索引以 SQL 迁移为准。

已核对官方 `@prisma/adapter-d1` 的 HTTP 构造能力，但该版本不提供自定义 fetch 与主库元数据，事务可能退化为独立查询。本项目通过受限 Prisma driver adapter 运行类型化查询；repository 内的登记、撤回及 outbox 使用单次 D1 REST batch。不能调用 `$transaction`、嵌套事务或把批处理拆成多次 HTTP 请求。

所有结果须证明 `served_by_primary=true`。D1 不返回主库证明时服务拒绝读取文件，不能通过删除检查来“修好”上线。未知写入结果不在传输层重试；事件、通知和租约通过持久去重与后续扫描恢复。统计属于近似计数，失败可能漏计，零偏移重试可能重计。

Cloudflare API 配额由账户/用户共享，不是每台 VPS 独享。应用默认每五分钟最多 900 次，下载只能消耗其中 800 次，剩余留给控制操作；外部管理操作仍可能导致 Cloudflare 429。默认仅运行一个进程，不能未经验证横向复制进程绕过本地预算。浏览器默认 16 MiB，缩小分片会增加 D1 查询压力。

迁移流程：先运行只读 schema 核对，检查 `d1_migrations` 与初始 SQL；用 `prisma migrate diff` 生成候选，审查后新增到 `migrations/`；先在隔离 D1 使用 `pnpm exec wrangler d1 migrations apply DB --local` 或专属隔离配置的 `--remote` 验证。生产执行需要单独批准。禁止 `db push`、`migrate reset`、重新初始化生产表或自动启动迁移。

隔离远程合同验证使用 `pnpm test:d1:remote`：从受保护环境注入 `D1_TEST_ACCOUNT_ID`、`D1_TEST_DATABASE_ID`、`D1_TEST_API_TOKEN`，并将 `ALLOW_ISOLATED_D1_WRITES` 设为同一个测试库 ID。脚本拒绝已知生产库和当前应用库，只创建随机名称的本次专属表；覆盖主库证明、NULL/Unicode/64 位参数、RETURNING、整批回滚、changes()、去重及撤回竞争，最后仅清理明确创建成功的本次表。创建结果不明时保留前缀供检查，不自动删除不明资源。此命令未在本次实现中执行，不能将本地 SQLite 结果当作远程验收。

## Linux 安装

建议使用仍受支持的 Linux 发行版，安装 Node.js 24、项目锁定的 pnpm 和 Nginx。systemd 模板假设 Node 位于 `/usr/bin/node`；实际位置不同应在部署前调整。Prisma 使用 JS driver，不需要生产 SQLite 文件或数据库守护进程。

1. 创建无登录服务用户 `feishu-relay`，将构建和依赖放入 `/opt/feishu-file-relay/releases/<版本>`，通过 `current` 链接指向目标版本；保留上一版。
2. 以 `.env.example` 为清单创建 `/etc/feishu-file-relay.env`，仅 root 可读。systemd 用 `EnvironmentFile` 注入，不把秘密放在 CLI 参数、Git 或日志中。
3. 填入四项飞书凭据、现有 D1 的 account/database ID 和 D1 API Token。只授予所需账户范围的 D1 权限，不使用全局 API Key；记录该 Token 的实际权限边界。
4. 保持 `HOST=127.0.0.1`、`PORT=3000`，代理重写 IP 后才启用 `TRUST_PROXY=true`。生产接入使用 `FEISHU_INTAKE_POLICY=platform`，仅上传者可撤销自己的链接。
5. 安装 `deploy/feishu-file-relay.service`。先用隔离配置检查，再按授权执行 `systemctl daemon-reload` 和服务启动；`systemctl enable` 作为正式切换的一部分执行。
6. 安装 `deploy/nginx.conf`，配置有效 HTTPS 证书。先执行 `nginx -t`，再在批准的切换窗口重载。证书申请、DNS 和现有 Worker Custom Domain 路由切换不由应用自动处理。

Nginx 必须关闭代理缓存、响应缓冲、临时文件和压缩，并传递客户端断连。不要增加 `proxy_ignore_client_abort on`、下载缓存规则或正文日志。`/ready` 对公网返回 404，只在服务器本机检查；`/health` 为存活检查。readiness 查询合并并缓存 15 秒，避免探针耗尽撤回额度。

## 运行与监控

- `curl --fail http://127.0.0.1:3000/health` 和 `/ready`；readiness 失败时阻止流量切换。
- `journalctl -u feishu-file-relay` 查看脱敏 JSON 事件，关注 `background_processing_failed`、`request_failed`、持续 503/429、租约积压及文件失败状态；不要打印 SQL 参数、上游 URL、Token、完整文件名或文件内容。
- 默认十个活动下载，超额 503；每 IP 每分钟 60 次文件请求，超额 429。大型共同出口客户可能受到 IP 限制，调整前应验证 D1 和飞书配额。
- 默认无缓存，内存不随文件大小线性增长。可选缓存最多 64 MiB、五分钟、每文件最多一片；完整小文件不进入缓存。服务没有下载目录，Nginx 也不得落盘响应。
- 停止服务会停止领取任务，最多排空 60 秒，之后取消连接；systemd 的停止上限为 70 秒。未完成任务等待租约到期后重启恢复。不能同时让旧 Cron 与新消费者长期运行。

## 切换清单（需明确生产授权）

- [ ] 所有本地、隔离远程 D1、Linux/Nginx 和真实飞书验收门槛通过；核对版本、schema、已有 ID 和公开链接。
- [ ] 记录当前生产 Worker 版本、Custom Domain/DNS 配置、Cron、证书和回滚步骤；保留现有数据备份用于事故调查，不把回滚等同于恢复数据库。
- [ ] VPS 用隔离 D1 验证，不提前启动生产数据库消费者。采用 hosts/指定 Host/SNI 测试反向代理，不修改公开域名。
- [ ] 在窗口内停止旧 Cron，排空旧任务；协调 Worker Custom Domain 的解除与 VPS DNS/路由切换。不得只添加 A 记录而忽略仍接管域名的 Worker。
- [ ] 启动 VPS 生产消费者并验证存活、readiness、原链接、HEAD、Range、回调和批准的真实文件撤回。
- [ ] 确认当前流量已迁移；保留旧 Worker 和云资源，不自动删除或升级套餐。

## 回滚清单

- [ ] 停止 VPS 消费者和入口，排空或取消连接。
- [ ] 恢复记录的 Worker Custom Domain/DNS 路由和 Cron，验证原链接与 webhook。
- [ ] 继续使用同一 D1；新产生的记录和墓碑必须保留，不恢复旧快照覆盖它们。
- [ ] 检查待办、租约和消息去重；记录故障证据后修复 VPS。

当前旧生产 Worker 与最新本地浏览器版本并不完全相同，回滚前应以实际部署版本验证路由行为；恢复旧版本也会恢复此前已知的大文件 CPU 限制。
