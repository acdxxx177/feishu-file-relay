# 浏览器分片下载

本功能对应 PRD v1.2 F04/F05/F07/F10/F11。公开链接仍为 `/f/<22位ID>`，打开只显示页面；必须点击下载才获取文件字节。飞书仍是唯一源文件存储，D1 决定可用性，未增加数据库或持久文件仓库。

后续 CPU 定位、本地负面实验及保留线上预算的理由见[ChunkEntry CPU 调查](chunk-cpu-investigation.md)。当前仍使用 256 KiB BYOB，仅消除绕缓存路径中无用的缓存准备工作，不宣称已解决线上峰值。

## 浏览器保存方式

| 能力 | 保存方式 | 边界 |
| --- | --- | --- |
| HTTPS 且支持 `showSaveFilePicker` | 顺序请求分片，背压写入所选文件，完整后 close 提交 | 不缓冲整文件；已在 Windows Chrome 用原生选择器验证小文件落盘；其他设备需单独验收 |
| 不支持选择器且文件 ≤20 MiB | 验证分片后创建有上限的 Blob，再点击保存 | 浏览器负责最终保存，页面无法确认磁盘持久化 |
| 不支持选择器且文件 >20 MiB | 显示限制并提供复制链接 | 用支持流式保存的浏览器打开，例如支持该 API 的桌面 Chrome/Edge；不能按浏览器名称保证能力 |

能力由特性检测决定，不识别 User-Agent。没有 Service Worker，没有 1 GiB Blob，也不会自动转向旧长请求。移动浏览器是否可用取决于实际 API 支持。下载页提供英语、西班牙语、印地语和简体中文。在页面顶部的语言菜单中选择语言即可立即切换。选择“自动”会清除手动偏好，重新跟随浏览器语言顺序；均不匹配时使用英语。繁体中文偏好会继续匹配后续语言。

首次返回的 HTML 根据已保存的选择或请求头中的语言偏好显示文件信息与错误原因。打开页面后，自动模式读取浏览器的语言列表。手动选择保存在当前站点、仅作用于文件页的 Cookie 中，有效期一年；浏览器禁止写入时，当前页面仍可切换。切换语言不会重新请求文件、重新选择保存位置或丢失已准备好的保存链接。

文件名保持原样。下载期间可查看进度、已传输字节及总量。网络重试、确认保存和下载完成有独立提示；复制链接的反馈不会替换下载状态。界面支持键盘、状态播报、窄屏以及多行文件名。禁用 JavaScript 时仍会显示文件信息或错误原因，下载操作需要启用 JavaScript。

保存流在成功关闭后提交。网络中断时最多重试当前片三次，先 truncate 回最后完整片边界，再按绝对偏移写入。尊重 HTTP 429、Retry-After 和取消；404/410/412 等永久错误立即停止。重试耗尽或取消会 abort 暂存输出，手动重新下载从头开始。刷新、关闭页面或重启浏览器不支持续传。提交阶段停止提供取消操作。

## HTTP 合同

| 请求 | 结果 |
| --- | --- |
| `GET /f/:id` | HTML 下载页，不回源，不计数；无效 404、撤回/失效 410 |
| `HEAD /f/:id` | 保留旧文件元数据，无正文，无回源 |
| `GET /api/files/:id` | `id,name,size,status,etag,chunkSize,blobLimit`，不含飞书标识或凭据 |
| `GET/HEAD /api/files/:id/chunk` | 必须携带精确 `If-Match` 和单 Range，成功 206 |
| `GET/HEAD /f/:id/download` | 兼容原始文件下载，保留 Range/If-Range；大文件 Free CPU 仍有限制 |

分片最大 16 MiB。缺少 If-Match 为 428，ETag 不同为 412；缺少、多 Range、非法或超大 Range 为 416。Range 解析沿用原实现，末端超出文件大小按 HTTP 规则收敛到文件末尾。浏览器始终请求明确闭区间并验证精确响应。HEAD 分片同样验证前置条件，但只读 D1。

每片先读取 D1 主库；不存在 404，撤回/失效 410，D1 故障 503 且不访问热缓存或源站。正在传输的当前片可能继续；下一片必须重新授权。页面、元数据、分片和错误均 no-store，页面使用同源脚本与严格 CSP，文件名按文本输出。

下载统计是近似请求计数：页面、元数据、HEAD 不计；浏览器偏移零分片成功转发后计一次。重复零偏移请求可能重复计数，不等同于用户人数或成功保存次数。

## 流式处理与完整性

ChunkEntry 精确读取请求范围，复用 Content-Range、Content-Length、encoding、实际长度、EOF 和超时校验。标准16 MiB范围沿用旧缓存；其他范围使用独立内部键，不会放大回源到整片。只有缓存数据和完整标记的代次、长度一致才可命中，取消后的残片不能复用。

Gateway 通过原生 pipeTo 与 FixedLengthStream 转发，移除了浏览器路径上的 JS 拼接循环。浏览器冷源使用 Workers 原生 BYOB readAtLeast，每次最多256 KiB，减少小网络帧进入JS循环的次数。冷缓存仍保留必要的源校验和有背压的双分支缓存写入，因此不能称为零 CPU。`BROWSER_CHUNK_CACHE_ENABLED=false` 可仅对新分片路径绕过缓存，校验仍保留。

新路径的 `UPSTREAM_READ_TIMEOUT_MS` 是每个BYOB聚合窗口的期限：默认30秒内需填满最多256 KiB或到达EOF，约对应8.5 KiB/s。持续供数但低于该速率也可能失败并重试；这与旧原始路径的逐次无进展超时不同。慢源失败仍会中断输出，不发布完整缓存标记。本地测试覆盖该失败及源恢复后的重新回源。

`BROWSER_CHUNK_SIZE` 为推荐字节数，支持 1048576、4194304、8388608、16777216；未设置或无效时使用16 MiB。硬上限始终16 MiB，不通过URL改写配置。仓库当前本地待部署变量选择1 MiB、BROWSER_CHUNK_CACHE_ENABLED=false，这是已测较优的实验配置，Free可靠性尚未通过；旧原始下载缓存不变。

浏览器校验范围、ETag 和实际字节数，在提交前检查总长度，不计算整文件浏览器哈希。自动化通过独立源生成器的 SHA-256 验证完整与中断恢复文件。relay ETag 固定 D1 id/version；没有源站稳定校验器时，不能发现同一消息附件标识下的同大小静默内容替换。

## 验证命令

```powershell
pnpm typecheck
pnpm test
pnpm test:large
pnpm build:mock
```

`test:large` 同时覆盖旧原始路径和新浏览器控制器；新控制器使用真实 workerd 与 Node 文件 sink，属于模拟文件保存 API。真实浏览器证据必须另列，不得由该测试推断。

已授权的隔离环境新轮次：

```powershell
pnpm online:deploy:browser
# 终端一，独立脱敏 Tail 文件；不修改旧失败记录
pnpm online:tail:browser
# 终端二，4 GiB 持久化新增预算、共享进程锁
pnpm online:test:browser
```

脚本只接受既有测试命名和 D1 清单，部署证据绑定构建哈希、配置哈希和 Gateway 版本。新账本 `.local/browser-online-results.json` 独立于旧512 MiB账本；不能删除账本、换构建或绕过锁恢复预算。完整尾日志和本次平台限制分别使用 `.local/browser-online-tail.jsonl` 与 `.local/browser-online-platform-limits.json`，旧记录保留。

先比较16/8/4/1 MiB冷/热各三组，并分别收集Gateway与私有ChunkEntry实际CPU；两类都必须有完整的六条样本覆盖。仅无超限、完整观察且CPU有余量的候选可扩大到100/500/1024 MiB。候选失败停止该尺寸；完整下载阶段失败停止扩大。全轮最多4 GiB、最多两请求并发，正常下载顺序执行。没有合格候选时不扩大。

若缓存开启候选全部不合格，允许在同一总预算内执行以下绕缓存比较，不改变生产配置：

```powershell
pnpm online:deploy:browser --no-chunk-cache
pnpm online:test:browser
```

线上结果见[验证日志](verification-log.md)。CPU不可观测、源模拟Worker超限、未测试浏览器及未测内存都应明确列为限制。

## 生产部署步骤（本次不执行）

1. 核对当前账户、生产Worker/D1、域名和 `.env`；保留原Secrets、路由保护、Cron和限流。不要导入 testing-migrations。此功能无数据库迁移。
2. 完成上述本地检查和 dry run；阅读本次线上CPU证据，决定是否达到部署条件。
3. 取得明确生产部署授权后，运行 `pnpm deploy`。该命令仍调用原有安全部署脚本，先生成浏览器资源；域名绑定禁止覆盖冲突DNS。
4. 运行 `pnpm production:verify`，确认HTTPS、回调验证、生产绑定及内部路径隔离。
5. 使用另行授权的可外发小文件，验证机器人仍返回页面链接、原生文件选择器、下载内容和撤回；大文件与实际客户浏览器逐步人工验收。

生产原始客户端下载地址需补上 `/download`。`pnpm smoke` 兼容传入页面链接并转换为原始地址，但该脚本会进行整文件与续传测试，不可用来未经批准重复大文件线上传输。

### 最小分片边界复核

默认自动筛选要求两类调用峰值≤8 ms。若1 MiB候选完整样本均≤9 ms、当前活动构建/配置/版本完全一致，可由操作者显式运行 `pnpm online:test:browser --large-only` 做仅余1 ms的边界复核。它复用生产浏览器控制器的字节检查、回滚和最多三次重试，文件写入本地临时测试输出再增量校验SHA-256；不改变总预算。100 MiB失败、CPU达到标称预算或Tail覆盖不完整即停止扩大，不能仅凭小样本把边界候选称为可靠Free支持。

## 官方依据

[Workers CPU限制](https://developers.cloudflare.com/workers/platform/limits/)、[BYOB读取语义](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreambyobreader/)、[文件保存流提交语义](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)。

## 本次变更文件

- [DESIGN.md](../DESIGN.md)
- [PRD.md](../PRD.md)
- [README.md](../README.md)
- [context/domain.md](../context/domain.md)
- [context/product.md](../context/product.md)
- [context/workflows.md](../context/workflows.md)
- [docs/acceptance.md](../docs/acceptance.md)
- [docs/browser-downloads.md](../docs/browser-downloads.md)
- [docs/deployment.md](../docs/deployment.md)
- [docs/online-testing.md](../docs/online-testing.md)
- [docs/verification-log.md](../docs/verification-log.md)
- [mocks/feishu-mock.ts](../mocks/feishu-mock.ts)
- [package.json](../package.json)
- [project-status.md](../project-status.md)
- [scripts/build-browser.ts](../scripts/build-browser.ts)
- [scripts/context/online-tests.md](../scripts/context/online-tests.md)
- [scripts/online-setup.ts](../scripts/online-setup.ts)
- [scripts/online-tail.ts](../scripts/online-tail.ts)
- [scripts/online-test.ts](../scripts/online-test.ts)
- [scripts/production-setup.ts](../scripts/production-setup.ts)
- [scripts/smoke.ts](../scripts/smoke.ts)
- [src/browser/download-controller.ts](../src/browser/download-controller.ts)
- [src/browser/download.css](../src/browser/download.css)
- [src/browser/page.ts](../src/browser/page.ts)
- [src/cache/chunk-entry.ts](../src/cache/chunk-entry.ts)
- [src/cache/context/contracts.md](../src/cache/context/contracts.md)
- [src/handlers/browser-download.ts](../src/handlers/browser-download.ts)
- [src/handlers/download.ts](../src/handlers/download.ts)
- [src/index.ts](../src/index.ts)
- [src/lib/file-access.ts](../src/lib/file-access.ts)
- [tests/browser-download.test.ts](../tests/browser-download.test.ts)
- [tests/helpers.ts](../tests/helpers.ts)
- [tests/intake.test.ts](../tests/intake.test.ts)
- [tests/large/browser-integrity.test.ts](../tests/large/browser-integrity.test.ts)
- [tests/large/integrity.test.ts](../tests/large/integrity.test.ts)
- [tests/online-mock.test.ts](../tests/online-mock.test.ts)
- [tests/platform-policy.test.ts](../tests/platform-policy.test.ts)
- [tests/relay.test.ts](../tests/relay.test.ts)
- [tests/streaming.test.ts](../tests/streaming.test.ts)
- [tests/stress/concurrency.test.ts](../tests/stress/concurrency.test.ts)
- [tsconfig.browser.json](../tsconfig.browser.json)
- [tsconfig.json](../tsconfig.json)
- [wrangler.jsonc](../wrangler.jsonc)
