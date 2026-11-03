# 验证日志

日期：2026-11-03。基线：PRD v1.1。以下先记录首次无需凭据的本地MVP验证，当时未部署或创建远程资源。后续用户已授权的免费版线上模拟测试见本文末尾及[线上模拟测试](online-testing.md)。全程未调用真实飞书或通过真实机器人登记文件，既有本地密钥文件和已暂存PRD修改均保留。

## 环境与命令

Windows、Node.js 24.20.0、pnpm 11.24.0；锁定Hono 4.13.16、TypeScript 7.0.2、Wrangler 4.156.2、Miniflare 5.20261102.0-beta及配套workerd。Node内置测试运行器，实际workerd/D1 SQLite/Cache API；所有飞书HTTP响应由本地mock接管。生产仅依赖Hono。

| 检查 | 结果与范围 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，锁文件可复现安装 |
| `pnpm typecheck` | 通过：生成平台类型，服务端、测试、mock、脚本严格TypeScript检查 |
| `pnpm test` | 18项通过，0失败、0跳过，覆盖F01–F04/F06–F13的本地行为 |
| `pnpm test:large` | 最终代码3项通过、0失败：100/500/1024 MiB完整及实际取消后续传SHA-256一致；见下表 |
| `pnpm test:stress` | 最终代码1项通过、0失败：10路1 GiB均完整且哈希一致，共65次源文件请求 |
| `pnpm build` | 本地dry run打包通过，无上传 |
| `pnpm db:migrate:local` | 8条迁移语句通过，仅本地全零占位ID绑定库 |
| `git diff --check`、`git diff --cached --check`、本地文档链接/新增文件空白检查 | 通过，既有已暂存PRD未改动 |
| 已安装Hono CLI 0.1.11 | 无法解析cloudflare:workers，未升级依赖；健康检查由真实workerd测试覆盖 |

普通测试覆盖加密/明文challenge、签名/Token/时间戳/应用ID、畸形事件、白名单与单聊、事件ID/消息ID幂等、JSON附件、可靠长度、超限失败、Token并发/强制刷新、pending和回复出站箱恢复、四次尝试与过期租约、撤回乱序/验证竞态/热缓存410、上传者/管理员/他人撤销、我的链接、统计、完整/后缀/开放Range、If-Range、多Range、416、HEAD、中文名与安全头、429/5xx/错误Range/截断/超长/404、损坏分片重读、缓存不可用降级、并发合并、首客户取消后跟随客户完整下载，以及响应头前取消信号处理。

## 大文件完整性（F05、F07、§13）

数据按绝对偏移生成，每64 KiB块前16字节编码绝对块号，避免周期数据掩盖整片错序/重复。独立从原始生成器流计算基准哈希，服务响应始终流式计算；测试不对大文件使用arrayBuffer。中断点使用客户端实际已接收长度，故意不按16 MiB对齐，再携带If-Range续传。

| 大小 | 字节数 | 原始/完整/续传共同SHA-256 | 冷回源次数 | 热续传新增回源 |
| --- | --- | --- | --- | --- |
| 100 MiB | 104857600 | `a14a09201182b6fb326acd2621160dc152597264d3980253e93e580a593e4fef` | 8 | 0 |
| 500 MiB | 524288000 | `d5628966fba65be6fac98dc2c51c663dc05efb4440f784739038cee33a9de23c` | 33 | 0 |
| 1 GiB | 1073741824 | `88d70583c2ecc851ea3debfbefca7da4b9295959a1412927cb8e60207e2c51c7` | 65 | 0 |

回源次数包含1次可信总长度探测，其余为16 MiB分片。10路并发1 GiB使用同一原始哈希，每路字节数1,073,741,824，累计交付10 GiB，源文件请求65次，证明同isolate共享分片回源。最终压力复核下载阶段约365秒；并行运行其他测试会影响时长，该数值不是生产吞吐/TTFB指标。最终dry-run包108.57 KiB，普通测试120秒、大文件三组274秒、压力测试含准备379秒。合计22项自动测试通过、0失败。

独立只读审查未发现剩余可操作的正确性/安全缺陷；确认D1主库门禁、撤回终态、私有RPC、流式背压、完成标记代次匹配和取消句柄释放。审查与自动测试都不能替代下文的真实环境验收。

## 边实现边验证的发现与决策

| PRD关联 | 假设/实际观测 | 结论与修正 |
| --- | --- | --- |
| F01、§3.1 | 先ACK再异步落盘会在Worker中断时丢失已确认事件 | ACK前只提交短D1事务，飞书I/O全部放后台，持久pending/任务由Cron恢复 |
| §3.1、平台后台窗口 | 60秒退避不能可靠放在HTTP waitUntil内 | 持久化2/10/60秒最早重试时间，由后续回调或5分钟Cron触发，实际延迟可能更长 |
| F02/V1 | mock206必须有精确Content-Range/总长度及实际1字节 | 全部校验后激活，错误/短体/超长体不发布；真实飞书仍待验证 |
| §8.3 | 官方OAuth v3返回access_token/expires_in，不能使用旧固定长度假设 | 配置accounts/API两个base，缓存、提前刷新、并发合并，失效类错误只强刷重试一次 |
| F02/F04 | 成功206的application/json可能是附件内容 | 资源成功响应按二进制处理，不解析为API JSON信封 |
| 平台兼容 | 类型允许redirect:error，但workerd实际拒绝此取值 | 改manual，非成功状态拒绝，不向重定向站点转发凭据 |
| F05/F07、V7 | 未知长度JS流的手写Content-Length被Workers移除 | 原生FixedLengthStream保留精确长度；本地观测MISS后HIT |
| F07、V7 | 取消缓存写入后，实际出现Content-Length=4194304、体仅32585字节的200缓存对象 | 不假设Cache.put天然原子；写入成功且源站EOF验证结束后，才发布随机代次完成标记，命中必须同时匹配代次和长度；冷首客户取消/跟随读取测试通过 |
| F05/F09 | 半开连接取消确认可能迟迟不完成 | 默认每次读30秒无进展即失败，先传播流错误，再后台清理，登记探测最多8秒 |
| F05/F12 | 本地HTTP连接在响应写出前未及时通知socket断开，直接socket也可复现 | 启用官方enable_request_signal；测试专用入口注入同样Request.signal，验证2秒源站头等待期间1.5秒内结束、无重试、不计数。真实边缘断开通知时延仍为人工项 |
| F06/F09 | 状态修改与失效通知分离会丢通知 | active→unavailable和唯一通知任务同一D1事务，机器人UUID与任务租约支持恢复 |
| F10、§5.5 | 真首字节、D1不存源字节、0-0只读D1无法同时满足 | HEAD只查D1；0-0精确读源站1字节，不拉整片。明确需求偏差，不返回伪造字节 |
| F12 | 逻辑分片调用次数不等于带重试的HTTP请求数 | chunk记录origin_calls；每次实际资源HTTP调用另记feishu_resource_request/origin_requests，无路径或凭据 |

完成标记和数据各自缓存，仍为当前数据中心的Cache API，不引入额外存储或远程资源。数据或标记被驱逐、写失败、代次不一致时安全降级为MISS；D1始终决定是否允许读取，不能由缓存授权。

## 首次本地验证时跳过与人工配置项

以下列表记录首次本地验证时未执行的项目，不能用本地mock通过代替PRD M1–M3真实退出条件。后续已补充其中一部分Cloudflare模拟环境项目，见下方线上记录；真实飞书与生产验收仍未执行：

- 创建并授权真实飞书应用、机器人权限/事件订阅、真实文件登记/撤回窗口、消息UUID实际去重窗口。
- 远程D1创建/绑定/迁移、自定义域名、Secrets、生产部署、WAF规则和告警。
- V1–V6：真实消息资源接口的大文件Range能力/大小限制、可靠总长度、中文文件名、浏览器和下载工具续传。部分飞书文件接口可能有100MB限制，必须核对实际消息资源接口和租户能力；本地支持1 GiB不代表源站允许。
- V7–V10：自定义域名CDN、跨数据中心缓存/清理、具名入口公网隔离、Paid CPU/内存/子请求限额、10路1 GiB生产运行、真实客户端断开回源。
- V11/V12：附件1/7/30天保留和客户所在地区的冷/热TTFB及吞吐。
- 真实永久业务错误码映射：当前仅资源HTTP404/410置unavailable，鉴权/403/429/5xx/网络问题保留临时状态。真实源站忽略Range时先拒绝登记，不估算大小；小文件兼容策略需依据实际响应再决定。

操作步骤见[部署说明](deployment.md)与[验收说明](acceptance.md)。所有远程操作仍需操作者配置和授权。没有阻塞本地开发的凭据依赖；上述真实环境指标尚未验收。

## 后续授权的免费版线上模拟验收

用户随后明确授权使用已登录Wrangler创建独立测试Gateway、D1与私有飞书模拟Worker，选择workers.dev及现有免费版。资源详情、配置和清理命令见[线上模拟测试](online-testing.md)。没有升级套餐、部署生产环境或接入真实飞书。

部署前：类型检查、22项本地回归（含两Worker私有Service Binding完整链路）、Gateway及mock的dry run均通过。线上Gateway位于 `feishu-file-relay-online-test-20261103-281c20.wiliawu.workers.dev`；模拟Worker和内部热分片路径的公网探测均404。公开下载不要求客户登录。

| 场景 | 实际结果 |
| --- | --- |
| 1 MiB | 登记→模拟机器人回复取链接→完整下载/中断续传SHA-256通过，HEAD/Range/If-Range/416/多Range/安全头通过 |
| 20 MiB | 完整下载、跨16 MiB边界Range、中断续传、两路并发均通过 |
| 缓存 | 1 MiB源分片请求1→1，20 MiB为2→2，重复完整下载新增回源均0；实际观测HIT |
| 撤回/权限 | 热缓存后GET/HEAD410、先撤回后登记不复活、上传者/管理员可撤销、他人被拒绝，通过 |
| 故障 | 实际模拟资源404、429、错误206、截断206及恢复，通过；相应物理请求行已核对 |
| 冷源响应头前取消 | 两次1 MiB独立探测：源站延迟5秒，客户端1.5秒取消；mock记录cancelled-before-headers，发送0字节，通过 |
| 100 MiB | HTTP响应开始后流中断，Gateway Tail确认exceededCpu，失败；保留此平台限制证据，没有作为完整成功交付 |
| 后续大文件 | 检测CPU超限后停止扩大，500 MiB、1 GiB、十路并发在线测试跳过，没有升级套餐 |

1 MiB实际完整/续传哈希均为 `b2d1a8f7538af60e712ac2b5d5fde990431ac11fd35ae0e54271d40ca2a95b2c`。20 MiB的完整/续传/并发程序断言与独立生成基准一致，基准为 `ae2eeb253c2b00e1f187bc1c665186f82d8780d25eb670f92629ec5a9dcd8275`；早期该运行只保留等值断言结果，后续运行器已补充逐次预期/实际哈希明细。100 MiB未完成，不记录为哈希验收通过。

公网请求观察到LAX地区，D1管理查询由KIX/APAC响应；私有Service Binding请求未携带colo值。以上缓存结果只证明本次实际路径，不能推断跨地区或长期命中。

保留的运行记录（`.local/online-results.json`）：

| 运行后缀 | 通过 | 失败 | 跳过 | 解释 |
| --- | --- | --- | --- | --- |
| mw09790a | 1 | 2 | 14 | 首次驱动使用远程SQL导入输出，测试工具解析失败 |
| mw09bhdg | 11 | 5 | 1 | 1/20 MiB及核心行为通过；4项长文件名触发D1 LIKE工具查询限制，另1项为真实100 MiB CPU超限 |
| mw09oje2 | 13 | 0 | 4 | 修正查询后小文件功能/故障全通过，大文件依据既有CPU证据不再执行 |
| mw09y400 | 1 | 0 | 0 | 1 MiB冷源响应头前取消通过 |
| mw09ziz7 | 1 | 0 | 0 | 第二次相同规模冷源取消通过，预算继续累计 |

工具修正不掩盖原始历史：Wrangler4.156.2的 `d1 execute --file` 返回导入进度和汇总，改用无shell的 `--command` 获取查询行；过长LIKE模式产生SQLITE_ERROR7500，改用 `instr(content,fragment)>0`。日志采集移除CLI不接受的sampling-rate=1参数，使用默认完整采集；失败后及最终报告前等待短暂尾延迟读取平台证据。仅保存允许的结构化字段，不保存请求头、请求体、Token或原始异常。

跨进程锁的受控检查通过：持有独占锁时第二运行器被拒绝，未新增运行、未重置预算。最终保守预扣242,641,834字节（231.401 MiB），实际接收137,921,314字节（131.532 MiB），低于512 MiB上限。日志采集已停止，远程测试资源按要求保留。真实飞书、Paid/自定义域名、多地区及生产完整大文件验收仍未进行。

## 2026-11-03 真实飞书生产配置与部署

用户明确授权从现有.env接入真实飞书、创建独立生产D1/Worker并绑定dl.sinoballvalve.com，生产依赖飞书应用可用范围，无本地用户/会话名单或管理员ID。保留原模拟环境，不调整账户套餐。

| 资源/配置 | 实际结果 |
| --- | --- |
| 生产Worker | feishu-file-relay，版本edba123c-b4e7-4cec-ade8-0cfb9136463a，部署100% |
| 生产D1 | feishu-file-relay，796792c4-75d6-4934-8bbc-3ea04e4263d0，APAC |
| 迁移 | 0001_init.sql的8条语句成功；未导入testing-migrations |
| Custom Domain | https://dl.sinoballvalve.com，已绑定生产Worker，HTTPS证书可用 |
| 公网入口 | workers.dev=false、preview_urls=false；公开/chunks路径404 |
| 生产接入 | FEISHU_INTAKE_POLICY=platform、FEISHU_TRANSPORT=real，无FEISHU_MOCK/名单/管理员绑定 |
| Secrets | 仅四项FEISHU_APP_ID/APP_SECRET/VERIFICATION_TOKEN/ENCRYPT_KEY，远程均为secret_text |
| 调度/限流 | Cron */5 * * * *，DOWNLOAD_LIMITER 60次/60秒，保留日志/trace配置 |

本地pnpm typecheck通过；pnpm test为25/25通过、无失败或跳过，包括新增的无名单平台接入、回调鉴权/用户单聊限制、仅本人查询/撤销、遗留管理员不生效、错误策略/空名单拒绝场景。原名单模式、回归链路和两个Worker的dry run通过；实际生产域名配置dry run通过。本轮未重跑不受本次修改影响的本地大型压力套件，也未扩大远程下载规模。

独立只读审查识别并修复两项路由风险：当前Wrangler非交互部署会默认覆盖冲突DNS，因此生产使用无路由生成配置上传，再以显式禁止覆盖的参数绑定域名；online-test及其生成配置显式routes:[]，防止继承生产域名。默认pnpm deploy也转向这一安全流程。复查未发现剩余阻塞缺陷。

production:verify报告于2026-11-03T08:06:26Z启动，实际通过：

- HTTPS /health返回200及status=ok。
- 使用.env对应Token完成明文及AES-CBC加密challenge往返；错误Token返回401。
- 未知合法ID的HEAD返回404，验证下载路径能够读取生产D1；内部公网/chunks返回404。
- Cloudflare API确认生产D1绑定、real/platform配置、四项Secret名称、关闭workers.dev和预览。
- 生产数据库仅包含正常业务/迁移/平台表；files=0、bot_jobs=0、processed_events=0。
- 本地使用真实App ID/Secret请求官方OAuth v3接口，HTTP200并取得有效令牌；报告仅保留状态和成功布尔值，未保存或输出令牌。
- Cloudflare API另行确认Custom Domain属于本Worker、证书标识存在、五分钟Cron和100%活动版本。

原始但已脱敏的配置检查结果保存在忽略的.local/production-verification.json，部署输出在.local/production-deploy.log。真实值仅保存在原.env、指定的忽略Secrets文件与远程Secrets；Git忽略检查、git diff --check及暂存区检查通过。没有登记虚构生产文件、向飞书发送机器人消息或删除既有资源。

### 尚待飞书端与真实文件验证

按[部署说明](deployment.md)启用机器人、限定应用可用范围、申请并发布im:message.p2p_msg:readonly、im:message:readonly、im:message:send_as_bot三项应用身份权限，订阅im.message.receive_v1和im.message.recalled_v1，将服务器回调地址保存为https://dl.sinoballvalve.com/webhook/feishu，并启用与.env一致的加密配置。

权限及接口说明已通过飞书官方文档门户公开get_detail接口核对。资源接口当前文档允许type=file在100 MB及以上时使用Range，单次分片不超过32 MB；本实现16 MiB分片符合文档，但尚无真实附件响应证据。接收回调、附件206/Content-Range、机器人回复与热缓存后撤回410，仍需操作者发布应用后使用允许公开的小文件联调。

本次仅完成生产Cloudflare配置及真实凭据连通性，不能标为真实飞书文件链路或大文件验收通过。此前免费版线上模拟100 MiB的exceededCpu失败继续保留；未重试100 MiB及以上传输，未升级账户套餐。
