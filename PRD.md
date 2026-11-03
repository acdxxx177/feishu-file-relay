# 飞书文件公开下载服务 — 产品需求文档（PRD）

> 版本：v1.1　日期：2026-11-03　状态：MVP / Codex 开发基线 技术栈：pnpm + TypeScript + Hono.js + Cloudflare Workers（Paid）+ D1 + Cache API 核心原则：**上传足够简单、客户公开下载、不引入额外文件仓库、边实现边验证。**

## 0. v1.1 变更摘要

- 取消独立的 M1「源站能力验证」阶段，验证并入各里程碑，见第 11、12 章。
- 公开链接 ID 由 8 位加长为 22 位（≥128 bit），防止枚举。
- 新增：撤销命令、上传者白名单、邮件安全网关预取防护、Webhook 异步处理与 pending 重试、HTTP 缓存/安全头、下载统计、失效通知、量化验收指标、Workers 平台限制说明。
- 修正：「全球缓存」改为各数据中心独立缓存，命中率以实测为准。

## 1. 背景与目标

### 1.1 业务背景

与客户邮件往来时，经常需要交付 100 MB–1 GB 的文件。邮件附件有大小限制，以往使用的第三方文件平台要求注册且链接有有效期，给客户增加了操作负担。

方案：飞书机器人作为内部上传入口。员工给机器人发送文件，机器人回复下载 URL；员工把链接贴进客户邮件，客户通过 Cloudflare 域名直接下载。文件原始内容保存在飞书，D1 只存索引，Cloudflare 缓存尽量减少重复回源。

### 1.2 产品目标

1. 员工在飞书机器人单聊中发送文件即可，无需任何后台操作。
2. 机器人自动回复可直接发给客户的公开下载 URL。
3. 客户无需注册、登录、验证码、密码，直接下载。
4. 支持 100 MB–1 GB 文件，支持断点续传。
5. 员工撤回原文件消息，或向机器人发送撤销命令后，新的下载请求立即失效。
6. 使用 Cloudflare 缓存减少重复回源飞书，不使用 R2 做持久仓库。
7. 工程小而易维护。

### 1.3 非目标（MVP 不做）

- 客户账号、登录、授权页面、下载密码。
- 文件管理后台、网盘目录、在线预览、搜索界面、网页上传、邮件附件自动解析。
- 人为设置的链接有效期或下载次数上限。
- R2 持久副本；D1 存文件字节。
- 多 Range（multipart/byteranges）、主动全球预热、复杂下载统计、落地页。

## 2. 用户角色与场景

| 角色 | 操作 | 预期结果 |
| --- | --- | --- |
| 飞书应用可用范围内的员工 | 在机器人单聊发送文件 | 机器人回复下载 URL |
| 外部客户 | 点击邮件中的 URL | 无需鉴权，直接下载 |
| 内部员工 | 撤回文件消息，或发送「撤销 链接」 | 公开链接对新请求返回已失效 |

链接格式：`https://dl.example.com/f/<22 位 base62 随机 ID>`。ID 必须由 `crypto.getRandomValues` 生成，不得使用 `file_key`、`message_id` 或任何可推导值。

## 3. 产品主流程

### 3.1 文件登记与链接生成

1. 员工在机器人单聊中发送文件消息（msg\_type=file）。生产使用 `FEISHU_INTAKE_POLICY=platform`，由飞书应用可用范围控制使用者，不维护本地用户/会话名单。仅接受已认证回调中的用户单聊消息，群聊和机器人发送者不登记；已授权用户的非文件消息回复使用提示。模拟环境保留 `allowlist` 策略。
2. 飞书推送 `im.message.receive_v1` 到 `POST /webhook/feishu`。Worker 校验签名/Token 与时间戳后**立即返回 2xx**，后续处理放入 `ctx.waitUntil`。
3. 按 `event_id` 去重。
4. 原子写入：检查撤回墓碑，未撤回则插入 `pending` 记录（见 6.2）。
5. 校验源文件：用 `Range: bytes=0-0` 请求飞书资源接口，取得可靠总大小。失败按 2s / 10s / 60s 退避重试，最多 3 次。
6. 文件大小超过 `MAX_FILE_SIZE`（默认 1 GiB，可配置）→ `failed`，回复原因。
7. 校验成功 → `active`，回复下载 URL。重试耗尽 → `failed`，回复明确原因。
8. 兜底：Cron Trigger 每 5 分钟扫描创建超过 2 分钟、尝试次数未满的 `pending` 记录继续处理（防止 waitUntil 被中断）。

**注意：** 飞书文件接口需要成对使用 `message_id` 和 `file_key`。

### 3.2 客户公开下载

1. 请求 `GET|HEAD /f/:id`。ID 格式非法直接 404，不查库。
2. Gateway 查询 D1：不存在 → 404；`deleted` / `unavailable` → 410；`active` 继续。
3. 按完整下载或单个 Range 计算所需 16 MiB 分片，顺序获取并流式转发。
4. 完整下载返回 200，合法单 Range 返回 206；支持 If-Range。
5. 客户断开连接时取消上游请求。回源中途失败时中断响应流，不伪装成完整文件。
6. 可选（M3）：长下载中每传输 8 个分片（128 MiB）复查一次 D1 状态，已撤回则中断。

### 3.3 撤回与撤销

- **撤回：** 收到 `im.message.recalled_v1`，在一个原子操作内写入墓碑并将对应文件置为 `deleted`（`delete_reason=recalled`）。
- **撤销：** 用户向机器人发送文本「撤销 链接或 ID」。生产 `platform` 策略仅允许上传者本人撤销，不配置管理员 ID；兼容 `allowlist` 策略可允许名单内的 `ADMIN_OPEN_IDS` 管理员。置为 `deleted`（`delete_reason=revoked`），机器人回复确认。
- 之后 GET/HEAD 均先查 D1，返回 `410 Gone` + `Cache-Control: no-store`，不回源。
- 分片缓存可尽力清理；即使清理失败，Gateway 也必须拒绝。
- 墓碑与 `message_id` 唯一约束共同保证：回调重复、事件乱序都不会让已撤回文件复活。

**边界：** 飞书「仅对自己删除」不一定触发撤回事件；撤回通常有时间窗口。已开始的传输和客户已保存的文件无法追回。

### 3.4 源文件失效通知

下载回源时若确认飞书源文件不可读（权限变更、资源失效等，具体错误码以实测为准），将记录置为 `unavailable`，后续请求返回 410，并向上传者发送一次机器人通知：「文件 xxx 的飞书源文件已无法读取，链接已失效」。临时错误（429、5xx、网络）不改状态，返回 503 + `Retry-After`。

## 4. 功能需求与验收标准

| 编号 | 优先级 | 功能 | 验收标准 |
| --- | --- | --- | --- |
| F01 | P0 | 飞书 Webhook | URL 校验、签名/Token 校验、时间戳防重放；非法回调拒绝；重复事件幂等；先返回 2xx 再异步处理 |
| F02 | P0 | 文件登记 | 保存 message\_id + file\_key + 文件名 + 可信文件大小 + 上传者；生成 22 位随机 ID；生产依赖飞书可用范围，兼容名单策略 |
| F03 | P0 | 自动回复链接 | 回复含文件名、大小、公开 URL、公开提示；不泄露 token、file\_key、secret |
| F04 | P0 | 公开下载 | 未登录 GET 直接下载，文件名（含中文）和内容正确 |
| F05 | P0 | 大文件与续传 | 100 MB、500 MB、1 GB 下载及中断续传后 SHA-256 与原文件一致 |
| F06 | P0 | 撤回软删除 | 撤回后 GET/HEAD 返回 410；乱序事件不复活 |
| F07 | P0 | 分片缓存 | 16 MiB 分片独立缓存；重复下载可观测到命中且回源次数下降 |
| F08 | P1 | 撤销命令 | 生产仅上传者本人可撤销；兼容名单策略支持管理员；他人被拒绝；撤销后 410 |
| F09 | P1 | 错误处理 | 源文件失效、限流、回源失败有明确状态码；不把损坏内容当成功返回；失效通知上传者 |
| F10 | P1 | 预取防护 | HEAD 与 `Range: bytes=0-0` 不触发整片回源；基础限流规则生效 |
| F11 | P1 | 下载统计 | 记录 download\_count 与 last\_downloaded\_at（见 6.1 口径） |
| F12 | P1 | 运行日志 | 记录事件处理、下载结果、分片 HIT/MISS、回源次数；不记录凭证和文件内容 |
| F13 | P2 | 我的链接 | 机器人回复「我的链接」返回最近 10 个有效链接及下载次数 |

## 5. 技术架构

### 5.1 技术选型与平台要求

| 组件 | 技术 | 说明 |
| --- | --- | --- |
| 包管理 / 语言 | pnpm / TypeScript |  |
| HTTP 框架 | Hono.js | Webhook、下载、健康检查 |
| 运行平台 | Cloudflare Workers **Paid 计划** | 免费版子请求上限不足以支撑 1 GiB 文件 |
| 数据库 | D1 | 索引、状态、墓碑、去重 |
| 缓存 | Workers Cache API | 仅自定义域名生效；仅缓存在当前数据中心 |
| 源文件 | 飞书消息附件 | 唯一内容来源 |

一个部署项目、两个逻辑入口：

- **Gateway：** 面向公网，承载 Hono 路由；每次请求必须先查 D1。
- **Chunk：** 仅供 Gateway 通过 service binding / RPC 调用；不绑定公网路由，关闭 workers.dev 与预览域名；负责分片回源、校验和缓存。

### 5.2 数据流

```text
员工 ─发送文件─► 飞书机器人 ─im.message.receive_v1─► Gateway ─► D1（pending→active）
                                                         │
员工 ◄──────── 机器人回复公开 URL ◄───────────────────────┘

客户 GET /f/:id ─► Gateway ─► D1 校验 status
                              │ active
                              ▼
                         Chunk 入口 ─► Cache API 分片
                                         │ MISS
                                         ▼
                               飞书资源接口（Range 分片）
                              ▼
                 Gateway 顺序流式拼接 ─► 客户

撤回事件 / 撤销命令 ─► Gateway ─► D1 status=deleted ─► 后续请求 410
```

### 5.3 分片与缓存

- 分片大小 **16 MiB = 16,777,216 bytes**；1 GiB 文件共 64 片，末片按实际长度。飞书单次 Range 不得超过 32 MB。
- 缓存键：`/chunks/{id}/v{version}/{index}`（内部域名，不对外暴露）。
- Chunk 将飞书 206 响应转为独立 200 缓存对象；Gateway 按客户请求拼成 200 或 206。
- 仅当分片长度与预期完全一致时才写缓存；采用边转发边写缓存（tee），写缓存失败不影响本次下载。
- 初始 TTL 7 天。缓存是加速层，**不是存储**，也不保证跨数据中心命中。
- 禁止缓存 404、410、416、429、5xx 及含凭证的响应。
- 同一 isolate 内对同一分片的并发未命中合并为一次回源（进行中 Promise 共享）。
- 首片未命中的速度取决于飞书源站；初期顺序拉取，不并发预取。
- 缓存清理为尽力而为；能否按 URL/标签清理以 M2 实测为准，否则依赖 TTL + D1 状态。

### 5.4 HTTP 下载语义

| 场景 | 状态码 |
| --- | --- |
| 完整下载 | 200 |
| 单个合法 Range | 206 + Content-Range |
| 非法 / 越界 Range | 416 + `Content-Range: bytes */总大小` |
| 多 Range（逗号分隔） | 忽略 Range，返回完整 200（RFC 允许） |
| If-Range 的 ETag 与当前不匹配 | 忽略 Range，返回完整 200 |
| ID 非法或不存在 | 404（no-store） |
| deleted / unavailable | 410（no-store） |
| 飞书限流或回源失败（临时） | 503 + Retry-After |
| 触发限流规则 | 429 |

200/206 响应头：

- `Content-Type: application/octet-stream`（一律强制，避免上传的 HTML 在本域名被渲染）
- `Content-Disposition: attachment`，同时提供 ASCII 回退 `filename` 与 `filename*=UTF-8''` 百分号编码，兼容中文
- `Content-Length`、`Accept-Ranges: bytes`、适用时的 `Content-Range`
- `ETag`：强 ETag，取值由 id 与 version 组成；`Last-Modified`：登记时间
- `Cache-Control: private, no-cache`（防止边缘缓存整份响应；与浏览器续传的兼容性在 M1 实测）
- `X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`

`HEAD` 与 GET 语义一致但无 body，只查 D1，不回源、不计下载次数。

### 5.5 邮件安全网关预取

客户邮件中的链接可能被 Outlook Safe Links、Mimecast 等网关自动 GET，造成整文件被拉取。应对：

- HEAD 和 `Range: bytes=0-0` 只读 D1，不回源。
- 分片已缓存时，重复拉取不增加飞书回源；仅首次未命中会回源。
- 配置 Cloudflare 速率限制规则（按 IP 限制下载请求频率）。
- 日志中记录来源 ASN / User-Agent 摘要，便于识别网关流量；`download_count` 不剔除机器流量，仅作参考。

### 5.6 Workers 平台约束

- 1 GiB 完整下载至少产生 64 次 Chunk 调用及相应回源子请求，需 Paid 计划，并在 M2/M3 实测是否触限（子请求、CPU 时间）。
- 全程流式，禁止对大文件使用 `arrayBuffer()`。
- 下载并发过高时优先降级为返回 503，而不是拖垮飞书配额。

## 6. 数据模型（D1）

### 6.1 表结构（示例，供转为迁移脚本）

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,                -- 22 位 base62 随机 ID
  message_id TEXT NOT NULL UNIQUE,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,            -- 已清洗：去路径分隔符与控制字符，≤255 字节
  file_size INTEGER,
  mime_type TEXT,
  uploader_open_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','failed','unavailable','deleted')),
  fail_reason TEXT,
  delete_reason TEXT,                 -- recalled | revoked
  attempts INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE recalled_messages (
  message_id TEXT PRIMARY KEY,
  recalled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_files_status_created ON files(status, created_at);
CREATE INDEX idx_files_uploader ON files(uploader_open_id, created_at);
```

`download_count` 口径：GET 请求成功开始发送 body 且起始偏移为 0 时 +1（HEAD 与断点续传不计），通过 `waitUntil` 异步更新。`processed_events` 由 Cron 清理 7 天前记录。

### 6.2 原子性要求

用 D1 `batch()`（事务）实现：

- 登记：`INSERT INTO files ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM recalled_messages WHERE message_id = ?) ON CONFLICT(message_id) DO NOTHING`。
- 撤回：同一 batch 内 `INSERT OR IGNORE INTO recalled_messages` + `UPDATE files SET status='deleted', delete_reason='recalled', deleted_at=CURRENT_TIMESTAMP WHERE message_id=? AND status!='deleted'`。
- 状态迁移的 UPDATE 都带前置状态条件，避免覆盖 `deleted`。

### 6.3 状态机

```text
pending ──校验成功──► active
pending ──重试耗尽/超限──► failed（终态，重发文件产生新记录）
active  ──确认源文件不可读──► unavailable（MVP 不自动恢复）
pending / active / unavailable ──撤回或撤销──► deleted（终态）
```

- 重新发送相同文件会产生新的 `message_id` 与新链接。
- `file_size` 必须来自飞书响应（如 Content-Range 总长度），不得估算。
- D1 不存文件字节与 `tenant_access_token`。

## 7. 对外 HTTP API

| 方法 | 路径 | 说明 | 状态码 |
| --- | --- | --- | --- |
| POST | `/webhook/feishu` | URL 验证、接收与撤回事件、机器人命令 | 2xx / 4xx |
| GET | `/f/:id` | 公开下载 | 200 / 206 / 404 / 410 / 416 / 429 / 503 |
| HEAD | `/f/:id` | 元数据 | 同 GET，无 body |
| GET | `/health` | 健康检查（不暴露内部细节） | 200 |

Chunk 入口不暴露公网；无管理后台，无客户登录接口。

## 8. 飞书平台集成

### 8.1 事件与机器人命令

- 事件：`im.message.receive_v1`、`im.message.recalled_v1`。
- URL 验证（challenge）需尽快响应；配置加密时解密并校验签名；校验 Verification Token；事件头 `create_time` 与当前时间偏差超过 5 分钟（可配置）拒绝。
- 接入策略：生产显式 `FEISHU_INTAKE_POLICY=platform`，信任飞书应用可用范围，无需用户/会话名单或管理员 ID，不赋予跨用户撤销权限。模拟/兼容配置可选 `allowlist`（未配置策略时默认），`ALLOWED_OPEN_IDS` 为空则拒绝接入，`ADMIN_OPEN_IDS` 管理员同时须在名单内；未知策略拒绝接入。两种策略都只处理用户单聊，仍校验 Token、App ID、签名与时间戳。
- 文本命令：`撤销 <链接或ID>`（F08）、`我的链接`（F13）；其他文本回复使用提示。
- 支持的消息类型：file。图片、视频、文件夹等回复「暂不支持，请以文件形式发送」。
- 域名可配置：`FEISHU_API_BASE`（默认 open.feishu.cn）、`FEISHU_ACCOUNTS_BASE`（默认 accounts.feishu.cn），以兼容 Lark 国际版。

### 8.2 文件下载接口

```http
GET {FEISHU_API_BASE}/open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=file
Authorization: Bearer {tenant_access_token}
Range: bytes={start}-{end}
```

机器人必须与该消息处于同一会话；`message_id` 与 `file_key` 必须匹配。撤回、权限变更、保密限制会导致源站失败。

### 8.3 飞书 Token

```http
POST {FEISHU_ACCOUNTS_BASE}/oauth/v3/token
Content-Type: application/json

{ "grant_type": "client_credentials", "client_id": "<APP_ID>", "client_secret": "<APP_SECRET>" }
```

读取 `access_token` 与 `expires_in`，提前 5 分钟刷新。缓存在 isolate 内存与 Cache API（内部键）中，并发刷新合并为一次请求；遇到 token 失效类错误强制刷新并重试一次。不硬编码 token 长度，不得传给客户或写入日志。

### 8.4 机器人回复

```text
文件已发布：Product-Manual.zip（512 MB）
下载地址：https://dl.example.com/f/<22 位 ID>
⚠️ 该链接公开，任何拿到链接的人都可下载，请仅发送允许对外分享的文件。
撤回本条文件消息，或发送「撤销 <链接>」，可使链接失效。
```

登记失败时回复明确原因（文件过大、飞书暂时无法读取请稍后重发等），不发布不可用链接。

## 9. 异常处理与最低安全要求

- 链接公开：任何持有链接者均可下载转发，只能发送允许外发的文件。
- 不设业务有效期，但文件可用性受飞书资源保留策略、权限和缓存驱逐影响，不承诺永久可用。
- Webhook 必须校验来源与时间戳；生产 Secrets（App ID/Secret、Verification Token、Encrypt Key）通过 Cloudflare Secrets 配置，不入仓库；平台可用范围由飞书管理员维护。
- 飞书 429/5xx 做有限退避（最多 3 次，指数退避加抖动）。
- 日志为结构化 JSON，字段含 file\_id、状态码、字节数、分片 HIT/MISS、回源次数、耗时；绝不记录文件内容、Token、Secret、完整请求头。
- 公开接口配置 Cloudflare 基础限流与异常流量告警，但不强制客户登录。
- 缓存清理是辅助动作，**能否下载由 D1 状态决定**。

## 10. 代码目录建议

```text
.
├── package.json / pnpm-lock.yaml / tsconfig.json / wrangler.jsonc
├── .dev.vars.example / README.md
├── migrations/0001_init.sql
├── src/
│   ├── index.ts                  # Hono Gateway 与路由、Cron 入口
│   ├── handlers/{feishu.ts, commands.ts, download.ts}
│   ├── cache/chunk-entry.ts      # Chunk 入口：回源、校验、缓存
│   ├── services/{feishu.ts, token.ts}
│   ├── db/files.ts
│   └── lib/{http-range.ts, headers.ts, id.ts}
├── tests/{webhook, recall, revoke, download-range, chunk}.test.ts
├── mocks/feishu-mock.ts          # 本地模拟飞书：Range、429、中断
├── scripts/smoke.ts              # 真实应用冒烟脚本（不入 CI）
└── docs/verification-log.md      # 验证日志
```

可按 Cloudflare 当前入口导出方式调整，但必须保留 Gateway 与 Chunk 的权限/缓存隔离。

## 11. 实施阶段（边实现边验证）

不设独立的前置验证阶段。每个里程碑内同步验证对应假设（见第 12 章），结果写入 `docs/verification-log.md`，与假设不一致时先调整设计再继续。

### M1：最小可用链路（无缓存）

- [ ] pnpm + TypeScript + Hono + Wrangler 工程、D1 迁移、Secrets、`.dev.vars.example`、自定义域名、关闭 workers.dev。
- [ ] 创建飞书自建应用，开启机器人并申请权限、限定可用范围；完成 Webhook 校验、去重、接入策略、异步处理。
- [ ] 登记流程：`pending → active`、22 位随机 ID、机器人回复链接、失败回复。
- [ ] 下载：GET / HEAD / 单 Range / If-Range，按 16 MiB 分片从飞书直接回源并流式转发（分片模块预留缓存接口）。
- [ ] 撤回软删除、墓碑、410。
- [ ] 同步验证 V1–V6。

* **退出条件：** 真实飞书应用端到端通过：100 MB / 500 MB / 1 GB 文件发送 → 得到链接 → 浏览器下载 SHA-256 一致；中断续传一致；撤回后 410；验证日志完整。

### M2：分片缓存

- [ ] Chunk 入口（service binding / RPC）、缓存键、tee 写缓存、TTL、不缓存错误、同 isolate 请求合并。
- [ ] 同步验证 V7–V10。

* **退出条件：** 重复下载可观测到 HIT 且飞书回源次数下降；缓存命中时撤回仍返回 410；Chunk 入口无法从公网访问。

### M3：加固与上线

- [ ] 撤销命令、失效通知、pending Cron 重试、`processed_events` 清理、下载统计、「我的链接」。
- [ ] 预取防护与速率限制规则、可选的长下载状态复查、结构化日志。
- [ ] 多地区测试（含客户所在地区）、飞书限流 / 源失败 / 错误 Range / 并发下载测试。
- [ ] 生产域名、Secrets、监控告警。
- [ ] 上线后启动持续探测：用一份测试文件每日 `Range: bytes=0-0` 读取，记录 1 / 7 / 30 天的附件可读性（V11）。

* **退出条件：** 满足第 13 章验收指标。

## 12. 假设与验证清单

| # | 待验证假设 | 阶段 | 不一致时的处理 |
| --- | --- | --- | --- |
| V1 | 飞书 Range 响应的状态码、Content-Range、Content-Length 符合预期，可取得可靠总大小 | M1 | 无法可靠取得则**停止并反馈**，不估算 |
| V2 | 小于 100 MB 的文件同样支持 Range | M1 | 不支持则流式读取并按字节计数切片，不缓冲整文件 |
| V3 | 16 MiB 分片稳定；了解飞书限流阈值与 429 行为 | M1 | 调小分片或降低并发 |
| V4 | 单聊中 `im.message.recalled_v1` 实际推送并携带 message\_id；了解撤回时间窗口 | M1 | 未推送则撤销命令升为 P0 |
| V5 | 中文及特殊字符文件名在主流浏览器/下载工具下正确 | M1 | 调整文件名编码与回退策略 |
| V6 | `Cache-Control: private, no-cache` 与 ETag / If-Range 下浏览器和下载工具续传正常 | M1 | 调整缓存头 |
| V7 | Cache API 在自定义域名下的 HIT/MISS、tee 写入、对象大小限制；跨数据中心命中情况 | M2 | 命中不足则仅作加速层，写入已知限制 |
| V8 | 能否按 URL/标签清理缓存对象 | M2 | 不能则依赖 TTL + D1 状态 |
| V9 | Chunk 入口无法被公网绕过 | M2 | 修正路由与绑定配置 |
| V10 | 1 GiB 下载在 Paid 计划下不触发子请求/CPU 限制；并发行为 | M2 / M3 | 限制并发或调整分片 |
| V11 | 飞书附件 1 / 7 / 30 天持续可读 | 上线后 | 无保证则在回复和文档中说明，评估备份方案 |
| V12 | 客户所在地区的首次回源速度可接受 | M3 | 评估调整方案（如分片大小、预取） |

## 13. 验收指标（初始目标，以实测校准）

- 数据完整性：100 MB / 500 MB / 1 GB 文件下载及续传后 SHA-256 100% 一致。
- 首字节时间：缓存命中 ≤ 1 s；未命中 ≤ 5 s。
- 并发：10 个并发 1 GB 下载全部成功，无内存或 CPU 超限错误。
- 吞吐：记录命中与未命中的基线，不设硬指标。
- 撤回/撤销后新请求 100% 返回 410。
- 日志中无任何凭证或文件内容。

## 14. 风险

1. **飞书附件长期可读性** 无官方保证（V11）。
2. **首次下载速度** 受飞书源站影响，CDN 无法消除首次未命中；飞书在国内，海外客户需实测（V12）。
3. **缓存不跨数据中心保证命中**，成本主要来自 Worker 请求与飞书回源。
4. **公开链接可被转发**，本服务不是私密共享平台。
5. **邮件网关预取** 可能产生额外回源与计数噪声（5.5）。
6. **撤回时间窗口** 受飞书限制，已用撤销命令兜底。

## 15. Codex 执行约束

优先端到端可用，不提前引入复杂架构。

1. 从 M1 开始，**边实现边验证**；每项验证（假设 / 实测 / 结论 / 决策）写入 `docs/verification-log.md`。
2. 实测与假设不一致时，先记录并给出调整方案，必要时暂停反馈；不伪造文件长度，不绕过完整性校验。
3. 不引入 R2、登录系统、管理后台、任务队列、Durable Objects，除非后续明确要求。
4. 下载无需鉴权；Webhook 与 Chunk 入口必须保证安全。
5. 全程流式，禁止对大文件使用 `arrayBuffer()`。
6. `deleted` 文件不得因缓存命中或事件乱序重新可下载。
7. 秘密参数使用 Cloudflare Secrets，提供 `.dev.vars.example`。
8. 测试覆盖：事件去重、撤回乱序、撤销权限、Range 边界（含多 Range、If-Range、416）、状态码、内容完整性；用本地 mock 飞书服务模拟 Range、429、中途中断。
9. 提供完整 README：飞书应用配置、Cloudflare / D1 初始化、迁移、开发、测试、部署。
10. 对未验证的飞书字段或 Cloudflare 新特性，以官方文档核实并标注假设。

## 16. 参考资料

- 飞书开放平台：https://open.feishu.cn/document/（消息资源文件、事件回调、访问凭证）
- Cloudflare Workers：https://developers.cloudflare.com/workers/
- Cloudflare Workers Cache：https://developers.cloudflare.com/workers/cache/
