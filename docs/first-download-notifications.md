# 首次确认下载通知

本功能仅适用于 VPS 运行时，默认关闭。启用后新登记的文件，在第一次符合条件的浏览器完成确认入库后，由飞书机器人向上传者的原单聊发送一张独立卡片。卡片包含文件名、确认时间（UTC+8）、大致国家/地区/城市和完成方式，不包含访客 IP。现有下载次数是近似统计，不能用它推断完整下载。

## 完成口径

| 路径 | 是否通知 |
| --- | --- |
| 浏览器原生文件保存 | 全部分片长度、范围和 EOF 校验通过，保存流 close 成功后提交确认 |
| 浏览器 Blob（不超过 20 MiB） | 全部接收完成后，用户真实点击“保存文件”才提交确认 |
| 同一浏览器会话分片失败后自动恢复 | 最终完整覆盖整个文件并完成上述保存动作，可以通知 |
| 原始 `/f/:id/download`，包括完整下载、Range 和续传 | 不通知；下载功能不变 |
| 页面、元数据、HEAD、预取、单个范围、孤立的最后一片、失败或取消 | 不通知 |

原生模式只能证明浏览器报告保存提交成功；Blob 只能证明收齐并发起保存，无法确认磁盘最终保存结果。HTTP 响应发送完毕不能证明代理下游已收到文件。卡片因此使用“首次确认下载”，不代表所有下载渠道中的绝对首次，也不代表客户打开了文件。持有公开链接的人可以模拟客户端协议，本功能不提供收件人身份或真人行为证明。

会话令牌只存在页面和 VPS 内存，最多保留 24 小时、最多 1,000 个，不进入 URL、日志或 D1。进程重启、过期、容量不足或跟踪请求失败时继续普通下载，可能漏掉通知。确认请求在页面存活期间最多重试十分钟；关闭页面会停止重试。已入库任务由现有持久调度器在重启后恢复，不依赖页面继续打开。

## 启用顺序

1. 核对当前 D1 迁移历史和备份。在隔离数据库验证 `0002_first_download_notification.sql`，再取得生产迁移授权。该迁移只增加资格列，默认 `0`，不回填历史文件。
2. **先应用迁移，再部署新版本**。新 Prisma Client 即使功能关闭也会读取新列；不支持先部署再迁移。容器和进程启动均不会自动迁移。
3. 初次部署保持 `FIRST_DOWNLOAD_NOTIFICATION_ENABLED=false` 和 `TRUST_CLOUDFLARE_GEO=false`。两个选项已列入环境模板与 Compose；重新生成模板不会覆盖现有配置，应手动将选项加入部署配置。
4. 完成下述代理检查；取得生产配置和部署授权后启用地理信任。缺少可信地理数据仍可发送“位置未知”的卡片。
5. 将 `FIRST_DOWNLOAD_NOTIFICATION_ENABLED=true` 后重启应用。只有此后新登记的文件会获得通知资格；Webhook 重送不会给历史文件补资格。配置开关关闭期间登记的文件也不会在重新启用时补入。
6. 使用明确获准的测试文件验证通知和撤回。不要通过登记真实文件、修改生产开关或重启服务来代替本地测试。

## Cloudflare 与 Nginx

在 Cloudflare 为实际下载域名启用 **Add visitor location headers**。它提供 `CF-IPCountry`、`CF-Region`、`CF-IPCity`；单独开启 IP geolocation 可能只有国家。字段可能缺失。[官方地理头说明](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/)

仓库 [Nginx 模板](../deploy/nginx.conf) 的 `geo`/`map` 必须位于 `http` 上下文，依赖 `ngx_http_realip_module`。模板使用 `$realip_remote_addr` 检查原始 TCP 对端，即使其他配置改写 `$remote_addr` 仍不能用访客地址伪装 Cloudflare 来源。内置网段来自 2026-11-06 的官方 [IPv4](https://www.cloudflare.com/ips-v4) / [IPv6](https://www.cloudflare.com/ips-v6) 列表，部署维护时应复核更新；不要改为信任所有来源。

可信来源的三项地理值通过 `X-Relay-Geo-Country`、`X-Relay-Geo-Region`、`X-Relay-Geo-City` 转发，并写入 `X-Relay-Geo-Trusted: 1`。不可信来源的地理值清空、标记为 `0`。所有内部头都必须覆盖，不能透传用户同名头。应用还要求 `TRUST_PROXY=true`、socket 对端在现有可信代理列表及 `TRUST_CLOUDFLARE_GEO=true`，不直接相信请求上的 `CF-*` 值。

检查实际拓扑而非仅复制配置：如果 Nginx 前面还有代理/NAT，需证明其保留真实来源；无法证明时保持地理开关关闭。Node 端口应继续只通过受控代理访问。先执行 `nginx -t`，再在授权窗口重载。保留无缓存、无缓冲、无临时响应文件、无压缩及断连传播配置，不开启敏感请求头或正文日志。

对一个隔离请求分别验证：Cloudflare 路径产生真实地点；直连并伪造 `CF-*`、`X-Relay-Geo-*` 只能得到未知地点；IPv6 路径和 real-IP 重写不改变来源判断。核对非 ASCII 城市名没有乱码。位置仅表示网络出口，VPN、代理、移动网络可能影响准确性；应用不采集 IP、经纬度或邮编。

## 去重、失败与回滚

`first-download:card:<fileId>` 是永久唯一任务键，也是首次确认记录。`argument` 包含不可变 `snapshot`，以及发送状态和最后失败原因；`message_id` 保存确认的机器人回执。不要删除、重建或换任务键来重试，`sent` 与 `failed` 行也必须保留。

发送前持久化“可能已发送”标记。明确未发送可按现有退避重试；超时、连接断开、响应丢失等结果不明时，只能在保守的一小时窗口内使用同 UUID 和同卡片重试。超窗、永久拒绝或八次尝试耗尽后停止，保留失败原因；不改为文本、不换 UUID。飞书的一小时去重约定仍需要真实隔离应用验收，不能承诺无限期恰好一次。[官方 UUID 说明](https://larksuite.github.io/oapi-sdk-java/com/lark/oapi/service/im/v1/model/CreateMessageReqBody.Builder.html)

关注脱敏事件 `first_download_delivery_retry`、`first_download_delivery_failed` 和既有 `bot_reply_retry`/`bot_reply_failed`，结合 D1 任务状态排查。只在受控环境查看快照，不把文件名、地理信息或完整任务参数复制到公共日志。结果不明且超窗的任务只能人工核实，不能自动重发。

确认入库前文件已撤回或失效，不新建通知；已入库的历史下载事件仍可通知，不恢复公开链接。首次时间取首个成功入库事件所携带的服务端有效确认时间，而非不可信的客户端时钟。

回滚前先关闭新增跟踪、重启以丢弃未完成内存会话，仍用新版本排空所有 `first-download:card:` 待办，确认没有此类 `pending` 行后才换旧消费者。旧 VPS/Worker 不理解新 JSON 任务格式，不能直接接管尚有待办的数据库，也不能并行启用旧 Cron。保留加法迁移及所有首次事件行。

## 验收命令与边界

本地执行 `pnpm typecheck`、`pnpm test`、`pnpm test:large`、`pnpm check:health`、`pnpm db:check`。共享浏览器代码用 `pnpm typecheck:worker` 和 `pnpm test:worker` 验证兼容性。代理用指定 `NGINX_TEST_BINARY` 的 Linux 环境运行 `pnpm test:linux`；容器用 `pnpm test:docker`。环境缺失产生的 skip 不能算通过。

数据库夹具按顺序加载全部迁移，覆盖历史库升级及全新库。大文件测试验证 100/500/1024 MiB 原始完整/恢复和带会话的浏览器分片恢复 SHA-256，并断言只有完整确认才通知。浏览器测试必须覆盖原生提交失败、Blob 未点击、真实保存点击、重复点击及通知失败不破坏保存结果。

实际结果见[验证日志](verification-log.md)。隔离远程 D1 主库证明、批处理原子性、真实飞书 UUID 回执及目标代理配置是独立上线门槛，本地 SQLite 和 mock 不替代这些证据。
