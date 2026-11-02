# 飞书文件公开下载服务 — 产品需求文档（PRD）

> 版本：v1.0  
> 日期：2026-11-02  
> 状态：MVP / Codex 开发基线  
> 技术栈：pnpm + TypeScript + Hono.js + Cloudflare Workers + D1 + Cloudflare 缓存  
> 核心原则：**上传足够简单、客户公开下载、不引入额外文件仓库。**

## 1. 背景与目标

### 1.1 业务背景

与客户邮件往来时，经常需要交付 100 MB–1 GB 的文件。邮件附件大小有限，而以往使用的第三方文件平台通常要求注册，且分享链接可能设置有效期，给客户带来额外操作。

希望将飞书机器人作为内部上传入口：员工给机器人发送文件，机器人自动生成下载链接；员工将链接粘贴在客户邮件中，客户通过 Cloudflare 域名直接下载。文件原始内容仍由飞书保存，Cloudflare D1 只保存索引，Cloudflare CDN 尽可能缓存重复下载的数据。

### 1.2 产品目标

1. 员工在飞书机器人会话中发送文件，无需额外后台操作。
2. 机器人自动回复可以复制、发送给客户的公开下载 URL。
3. 客户无需注册、登录、验证码、密码或其他身份验证，直接下载文件。
4. 支持 100 MB–1 GB 的文件，支持断点续传和全球重复下载。
5. 员工撤回原始飞书文件消息后，D1 中标记删除，新下载请求立即失效。
6. 尽量使用 Cloudflare CDN 缓存减少重复回源飞书，不使用 R2 作为额外持久化仓库。
7. 使用 pnpm、Hono.js、Cloudflare Workers、D1 构建小型、易维护的服务。

### 1.3 非目标（MVP 不做）

- 不建设客户账号、登录系统、授权页面或下载密码。
- 不建设文件管理后台、网盘目录、在线预览或文件搜索界面。
- 不提供网页上传或邮件附件自动解析；唯一上传入口是飞书机器人。
- 不设置人为的下载链接有效期或下载次数上限。
- 不在 R2 持久保存完整文件，也不将 D1 作为文件存储。
- 不在第一版实现多 Range (`multipart/byteranges`) 请求、复杂下载统计及主动全球预热。

## 2. 用户角色与使用场景

| 角色 | 操作 | 预期结果 |
|---|---|---|
| 内部员工 | 在指定飞书机器人会话发送文件 | 机器人回复下载 URL |
| 外部客户 | 点击邮件中收到的 URL | 无需鉴权，直接下载原文件 |
| 内部员工 | 撤回之前发送的文件消息 | 公开链接对新的下载请求返回已失效 |

典型链接：`https://dl.example.com/f/aB7xQp9K`

链接 ID 必须随机生成且不可轻易猜测，不能直接使用 `file_key`、`message_id` 或访问凭证作为公开路径。

## 3. 产品主流程

### 3.1 文件登记与链接生成

1. 员工在允许的飞书机器人单聊中发送文件。
2. 飞书向 `POST /webhook/feishu` 推送 `im.message.receive_v1` 事件。
3. Worker 验证飞书回调来源，完成去重并解析消息中的 `message_id`、`file_key`、文件名等。
4. 系统核实文件确实可以通过飞书文件接口读取，并确认准确文件大小；暂时无法确认则保持 `pending`，不生成“可用”下载链接。
5. 文件满足约定范围且验证成功后，写入 D1，设为 `active`，生成随机公开文件 ID。
6. Worker 调用飞书发送消息接口，在原会话回复下载 URL。建议内容包含文件名和完整链接。
7. 员工复制链接到邮件，客户点击下载。

**注意：** 飞书文件接口需要成对保存 `message_id` 和 `file_key`。单独保存 `file_key` 不够。

### 3.2 客户公开下载

1. 用户请求 `GET /f/:id`。
2. Gateway Worker 查询 D1，确认文件存在且 `status = active`。
3. 对于正常文件，根据 HTTP `Range` 请求或完整下载模式，计算需要读取的固定大小分片。
4. Gateway 从内部 Chunk Worker 获取分片：命中 CDN 缓存则直接读取；未命中则由 Chunk Worker 使用飞书 API 按范围回源。
5. Gateway 使用流式响应向客户发送内容；完整下载返回 `200 OK`，单个合法 Range 返回 `206 Partial Content`。
6. 客户可使用浏览器或支持 HTTP Range 的下载工具继续中断的下载。

### 3.3 撤回文件消息

1. 飞书发送 `im.message.recalled_v1` 撤回消息事件。
2. Worker 使用该事件携带的原始 `message_id` 查找文件记录，更新为 `status = deleted`，填写 `deleted_at`。
3. 之后针对该文件的 `GET`/`HEAD` 请求均先检查 D1，返回 `410 Gone`，不执行文件回源。
4. 系统可异步清理该文件对应的分片缓存。即使清理失败，Gateway 仍必须拒绝后续下载。
5. 维护撤回墓碑记录，防止回调重复或事件乱序导致已撤回文件再次被登记为 `active`。

**边界：** 飞书“仅对自己删除”不一定是“撤回”，仅依赖撤回事件实现自动失效。对已经开始传输的连接及客户已保存的文件，不保证能够追回或强制中断。

## 4. 功能需求与验收标准

| 编号 | 优先级 | 功能 | 验收标准 |
|---|---|---|---|
| F01 | P0 | 飞书 Webhook | 正确处理 URL 校验、接收消息、撤回消息；非法回调拒绝；重复事件幂等 |
| F02 | P0 | 文件登记 | 保存 message_id + file_key + 文件名 + 可信文件大小；生成随机 ID |
| F03 | P0 | 自动回复链接 | 机器人回复公开 URL；不泄露飞书 token、file_key 或 secret |
| F04 | P0 | 公开下载 | 未登录客户可以直接 GET 下载，文件名和内容正确 |
| F05 | P0 | 大文件与断点续传 | 100 MB、500 MB、1 GB 测试文件下载和续传后的 SHA-256 与原文件一致 |
| F06 | P0 | 撤回软删除 | 撤回后状态为 deleted；后续 GET/HEAD 返回 410；乱序事件不复活 |
| F07 | P0 | 分片缓存 | 16 MiB 分片独立缓存，重复下载可观察到缓存命中及飞书回源次数下降 |
| F08 | P1 | 错误处理 | 源文件失效、飞书限流、回源失败等有明确错误码，不把损坏内容当成功文件返回 |
| F09 | P1 | 运行日志 | 记录事件处理、公开下载结果、分片命中/回源；绝不记录凭证或文件内容 |

## 5. 技术架构

### 5.1 技术选型

| 组件 | 技术 | 职责 |
|---|---|---|
| 包管理 | pnpm | 依赖与脚本管理 |
| 开发语言 | TypeScript | 类型约束 |
| HTTP 框架 | Hono.js | Webhook、下载路由、健康检查 |
| 运行平台 | Cloudflare Workers | Serverless Gateway、飞书 API 代理 |
| 数据库 | Cloudflare D1 | 文件索引、状态、版本、去重数据 |
| CDN 缓存 | Cloudflare Workers Caching | 对标准化分片进行全球缓存复用 |
| 源文件 | 飞书消息附件 | 原始文件内容来源 |
| 持久对象仓库 | 无 R2 | MVP 不存第二份完整副本 |

建议设计为**一个部署项目、两个逻辑 Worker 入口**：

- **Gateway EntryPoint：** 面向公网，承载 Hono 路由；公开文件请求必须执行 D1 状态检查，不能被边缘缓存绕过。
- **Chunk EntryPoint：** 仅供 Gateway 内部调用；按标准 16 MiB 分片回源、验证响应并缓存。内部缓存入口不允许公网绕过 D1 访问。

实现前使用当前版本的 Wrangler 和 Cloudflare 官方文档核实 `exports`、入口缓存配置以及缓存清理 API；不应将示意配置未经验证直接投入生产。

### 5.2 数据流

```text
内部员工
   │ 发送文件
   ▼
飞书机器人
   │ im.message.receive_v1
   ▼
Hono Gateway Worker ───────────────► D1 文件索引
   │                                     │
   └── 飞书消息回复：公开下载 URL ◄───────┘

外部客户 GET /f/:id
   │
   ▼
Hono Gateway Worker ───► D1 校验 active / deleted
   │ active
   ▼
内部 Chunk Worker ───► Cloudflare 分片缓存
   │ 缓存 MISS
   ▼
飞书资源接口（Range 分片）
   │
   ▼
Chunk Worker ───► Gateway 流式组合 ───► 客户下载

飞书撤回消息 ───► Gateway ───► D1 status=deleted
                                      │
后续 GET /f/:id ───────────────────► 410 Gone
```

### 5.3 分片与 CDN 缓存

- 分片大小：**16 MiB = 16,777,216 bytes**。
- 对于 1 GiB 文件，一共 64 个完整分片。文件不是 16 MiB 整数倍时，最后一片按实际长度取数。
- 飞书大于等于 100 MB 的文件应使用 `Range: bytes=start-end` 下载，**单次请求不得超过 32 MB**。
- 缓存 Key：`file_id + version + chunk_index`，例如内部逻辑键 `/chunks/aB7xQp9K/v1/0`。
- 内部 Chunk Worker 将源站 `206` 的单片内容转成独立的 `200` 缓存对象；公开 Gateway 根据客户请求组合为完整 `200` 或标准 `206`。
- 初始分片缓存 TTL：7 天。缓存存在驱逐风险、且是性能加速层，**不是永久存储**。
- 禁止缓存 `404`、`410`、`416`、`5xx` 以及任何含敏感凭证的错误响应。
- 缓存命中必须通过线上实际观测验证；首位用户缓存未命中时仍可能受到飞书源站速度影响。
- 建议初期顺序流式拼片，避免整份 1 GB 文件进入 Worker 内存；高负载时再引入有限并发预取/请求合并。

### 5.4 HTTP 下载语义

公开接口支持：

- `GET /f/:id`：完整下载，成功响应 `200 OK`。
- `HEAD /f/:id`：返回元数据响应头，不发送文件 body。
- `GET /f/:id` 携带单个 `Range`：成功响应 `206 Partial Content`。
- 非法或超出文件长度的 Range：返回 `416 Range Not Satisfiable`。
- 撤回后：返回 `410 Gone`，并设置 `Cache-Control: no-store`。

正确设置 `Content-Type`、`Content-Disposition`（兼容非 ASCII 文件名）、`Content-Length`、`Accept-Ranges: bytes` 和适用的 `Content-Range`。MVP 可不支持多 Range，但必须明确处理此类请求，不能输出错误的字节范围。

## 6. 数据模型（D1）

文件表（示例，供 Codex 转为迁移脚本）：

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE recalled_messages (
  message_id TEXT PRIMARY KEY,
  recalled_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_files_status ON files(status);
```

### 6.1 状态机

```text
pending ──校验成功──► active
   │                    │
   └──撤回──────────────┤
                        ▼
                      deleted（不可自动恢复）

active ──源文件不可读取──► unavailable
```

约定：

- `deleted` 为撤回的终态；重新发送相同文件产生新的 `message_id` 和公开下载 ID。
- 对原始消息已被撤回的 `message_id`，禁止后续接收事件将其新建为 `active`。
- 消息接收、墓碑检查、状态插入/更新要设计成数据库事务或等效原子操作，不能仅依赖非原子的“先查后写”。
- `file_size` 必须来自可靠的源文件响应或元信息，不能只根据文件名估算。
- D1 不存储原始文件字节或 `tenant_access_token`。

## 7. 对外 HTTP API

| 方法 | 路径 | 说明 | 预期状态码 |
|---|---|---|---|
| POST | `/webhook/feishu` | 飞书 URL 验证、接收与撤回事件 | 2xx / 4xx |
| GET | `/f/:id` | 公开文件下载 | 200 / 206 / 404 / 410 / 416 / 503 |
| HEAD | `/f/:id` | 文件信息、下载工具探测 | 与 GET 语义相同，无 body |
| GET | `/health` | 健康检查 | 200 |

内部缓存入口不作为公网 API 暴露。没有额外管理后台或客户登录接口。

## 8. 飞书平台集成

### 8.1 事件

- 接收消息：`im.message.receive_v1`。
- 撤回消息：`im.message.recalled_v1`。
- 使用飞书事件订阅将 HTTP POST 发送到 `/webhook/feishu`。
- 按飞书要求处理 URL 验证 `challenge`；配置加密时需要解密和验证回调。**URL 验证需要尽快（文档要求 1 秒内）响应**。
- 仅允许配置的员工或受控机器人会话登记文件，防止他人将服务当公共上传器。
- 对飞书事件按 `event_id` 去重；对撤回按 `message_id` 做幂等处理。

### 8.2 文件下载接口

```http
GET https://open.feishu.cn/open-apis/im/v1/messages/{message_id}/resources/{file_key}?type=file
Authorization: Bearer {tenant_access_token}
Range: bytes={start}-{end}
```

注意：机器人需要和该消息处于同一会话；`message_id` 与 `file_key` 必须匹配。文件撤回、权限变更、保密限制等会导致源站下载失败。

### 8.3 飞书 Token

采用用户提供的新版本自建应用 token 接口：

```http
POST https://accounts.feishu.cn/oauth/v3/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "<FEISHU_APP_ID>",
  "client_secret": "<FEISHU_APP_SECRET>"
}
```

成功后从 `access_token` 读取租户 Token，并根据 `expires_in` 在服务端缓存、提前刷新。Token 可能是较长的 JWT，不能硬编码长度，也不能传给客户。

### 8.4 机器人回复

在文件变为 `active` 后通过飞书发送消息 API 回复，例如：

```text
文件已发布：Product-Manual.zip
下载地址：https://dl.example.com/f/aB7xQp9K
客户可以直接打开链接下载，无需登录。
```

如果文件登记失败，机器人应回复明确失败原因，不应发布无法使用的链接。

## 9. 异常处理与最低安全要求

- **客户公开无需鉴权**，但这意味着任何持有链接的人都可以下载或转发，因此只能发送允许对外分享的文件。
- 公开链接不设置业务过期时间；但文件长期可用性仍受飞书消息资源保留策略、权限和缓存驱逐影响，不能承诺永不过期。
- Webhook 必须验证飞书来源及防重放，不能因为下载公开就省略上传入口安全。
- 飞书 App ID、App Secret、Verification Token、Encrypt Key 通过 Cloudflare Secrets 配置，不能写入仓库。
- 不要在日志中打印文件正文、访问 Token、Secret 或完整敏感请求头。
- 建议对公开接口配置 Cloudflare 基础限流和异常流量监控，但不能强制客户登录。
- 对飞书 429/5xx 做有限退避重试；若响应流中断，要让客户得到失败而不是伪装成功的完整文件。
- 缓存清理是撤回后的辅助动作：**决定是否可下载的是 Gateway 查询 D1 的状态**。
- 文件已被客户下载、下载已经开始后的数据不能保证被远程撤回。

## 10. 代码目录建议

```text
.
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── wrangler.jsonc
├── migrations/
│   └── 0001_init.sql
├── src/
│   ├── index.ts                 # Hono Gateway / 路由
│   ├── handlers/
│   │   ├── feishu.ts            # Webhook、接收、撤回
│   │   └── download.ts          # GET、HEAD、Range 下载
│   ├── cache/
│   │   └── chunk-entry.ts       # 内部 Chunk Worker 与缓存逻辑
│   ├── services/
│   │   └── feishu.ts            # Token、文件读取与回复
│   ├── db/
│   │   └── files.ts             # D1 操作
│   └── lib/
│       └── http-range.ts       # Range 解析、拼接和响应头
└── tests/
    ├── webhook.test.ts
    ├── recall.test.ts
    └── download-range.test.ts
```

Codex 可根据 Cloudflare 当前支持的入口导出方式调整代码组织，但需保留 Gateway 与缓存入口的权限/缓存隔离。

## 11. 实施阶段

### M1：源站能力验证（先做）

- [ ] 创建飞书自建应用，开启机器人能力并申请所需权限。
- [ ] 完成 Webhook URL 验证。
- [ ] 用真实消息拿到 `message_id` 和 `file_key`。
- [ ] 实测 100 MB、500 MB、1 GB 文件的飞书 Range 读取。
- [ ] 确认如何获取可靠 `file_size`。
- [ ] 分片合并后校验 SHA-256。

### M2：最小可用产品

- [ ] 使用 pnpm 初始化 TypeScript + Hono + Workers 工程。
- [ ] 创建 D1 迁移及数据访问层。
- [ ] 实现飞书文件接收、验证、去重和写入。
- [ ] 实现随机文件 ID 和机器人自动回复。
- [ ] 实现公开下载 GET、HEAD、单 Range，流式发送。

### M3：缓存和撤回

- [ ] 实现 16 MiB 内部分片和稳定缓存键。
- [ ] 验证 Cloudflare 缓存命中及回源次数下降。
- [ ] 实现 `im.message.recalled_v1` 软删除。
- [ ] 实现撤回墓碑与事件乱序保护。
- [ ] 校验撤回后 GET/HEAD 返回 410。
- [ ] 实现可选的缓存标签清理和失败重试。

### M4：上线验收

- [ ] 验证不同地区重复下载与首轮回源性能。
- [ ] 验证断点续传、错误 Range、源文件不可读和飞书限流。
- [ ] 验证跨地区缓存不绕过 Gateway 删除状态。
- [ ] 配置生产域名、Secrets、日志与基础限流。
- [ ] 执行 1 天、7 天、30 天的飞书附件持续可读性测试。

## 12. 发布风险与待验证事项

1. **飞书附件长期可读性：** 现有接口文档说明了下载方式，但并未保证聊天附件永久保存或资源 Key 永久有效。
2. **真实大文件响应：** 必须验证飞书对 Range 请求返回的 HTTP 状态、Content-Range、Content-Length 以及总文件长度的取得方式。
3. **Cloudflare 当前缓存 API：** 需通过实际部署验证 Worker 分层缓存、内部入口调用、缓存命中与清理行为。
4. **首次下载速度：** CDN 不能消除首次缓存未命中的飞书回源延迟。
5. **公开链接安全：** 链接一旦转发即可能被第三方访问；本服务不是私密文件共享平台。
6. **消息撤回窗口：** 若飞书客户端不允许撤回很久之前的消息，MVP 没有管理后台替代删除功能；后续可加入仅内部可用的“撤销链接”命令。

## 13. Codex 执行约束

请 Codex 按本 PRD 开发，优先满足端到端可用，而不是提前加入复杂架构。

**必须遵循：**

1. 优先实现 M1；如果飞书 API 的实际返回与假设不一致，先反馈和修正设计，不要伪造文件长度或绕过数据完整性校验。
2. 不引入 R2、登录系统、UI 管理后台、复杂任务队列，除非后续明确要求。
3. 对外下载无需鉴权；飞书 Webhook 和内部 Chunk 调用必须保证安全。
4. 使用流式传输，不能对 1 GB 文件调用 `arrayBuffer()` 并全部放入内存。
5. 状态为 `deleted` 的文件不得因为缓存命中或事件乱序重新对外可下载。
6. 所有秘密参数使用 Cloudflare Secrets，提供 `.dev.vars.example`，不要提交真实凭证。
7. 为事件去重、撤回乱序、Range 边界、状态码和文件内容完整性编写测试。
8. 提供完整 README：飞书应用配置、Cloudflare/D1 初始化、`pnpm` 安装、迁移、开发、测试和部署步骤。
9. 对尚未验证的 API 字段或 Cloudflare 新功能，使用官方文档核实，并清楚标注假设；不要直接套用未经验证的示例配置。

## 14. 参考资料

- 用户提供：《获取消息中的资源文件》：飞书消息资源接口、Range 分片大小及相关权限限制。
- 用户提供：《将回调发送至开发者服务器》：飞书回调、加密验证、URL challenge。
- 用户提供：《获取访问凭证》《自建应用获取 tenant_access_token》：服务端授权及新版令牌接口。
- 飞书开放平台：https://open.feishu.cn/document/
- Cloudflare Workers 文档：https://developers.cloudflare.com/workers/
- Cloudflare Workers Caching 文档：https://developers.cloudflare.com/workers/cache/

> 本文档是开发需求基线。涉及飞书消息撤回事件的可用性、文件大小取得方式以及 Cloudflare 最新 Workers Caching 特性，仍须在 M1/M3 实测验证。
