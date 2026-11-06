# 验证日志

## v1.2.2：VPS 部署完成（2026-11-06）

经用户明确授权，已于北京时间 16:31 将 VPS 中转服务由 `1.2.0` 升级到 `1.2.2`。先拉取并核对镜像，再备份 `/root/web/docker-compose.yaml`，仅替换其中的中转镜像版本；执行 `docker compose up -d --no-deps --no-build --pull never feishurelay`。备份目录为 `/root/web/feishu-relay/backups/20261106T083100Z-v1.2.2`，包含旧 Compose 和不含凭据的部署前镜像、容器与配置校验记录。旧镜像保留，可按旧版本重建中转服务回滚。

- 拉取的 OCI index 为 `sha256:272d37745f8e8c6db4ebd266fd021ccf2461d7fdcfdb6857d15c5fb1b5a1d1c3`，运行镜像 ID 为 `sha256:7d2cab73484c8a42f02b6b82dae6a5a30456bc21505db194d397d3cb9822768f`，revision 为 `67e83568b913692b42b46d2d9c00a06ff3691b68`，均与发布记录一致。
- 新容器 `healthy`、重启次数为 0，两次 Docker 健康探测退出码均为 0；检查时无启动错误日志。
- 内部 `/health`、D1 就绪 `/ready` 均返回 200；公网 HTTPS `/health` 返回 200，携带伪造回环 `X-Real-IP` 的公网 `/ready` 仍返回 404。
- Compose 配置校验通过；Nginx 与 Xray 容器 ID 未变，`env.conf` 和 Nginx 配置的 SHA-256 与部署前一致。
- 代理信任、地理信任、首次下载通知开关保持开启。旧 `TRUSTED_PROXY_IPS` 无需删除，新镜像直接忽略；未执行数据库迁移或手动写入数据。

本次未发送真实飞书消息或注册测试文件。实际新文件完整下载后的通知及位置仍需客户端验收，已有通知的位置快照不会补写。

## v1.2.2：main 验证通过后发布标签及镜像（2026-11-06）

按用户要求先提交修复 `67e83568b913692b42b46d2d9c00a06ff3691b68` 并推送 `main`，等待 [main CI 42186775001](https://github.com/acdxxx177/feishu-file-relay/actions/runs/42186775001) 全部成功后，才在同一提交创建附注标签 `v1.2.2` 并推送。原 `v1.2.1` 仍指向 `f10ce35d518a5e5b1bb31576e5601288ce2f676a`，没有移动或覆盖。[标签流程 42187107162](https://github.com/acdxxx177/feishu-file-relay/actions/runs/42187107162) 的验证和 GHCR 发布随后均成功。

| main CI 检查 | 结果 |
| --- | --- |
| 类型检查 | 通过 |
| 常规测试 | 106/106 通过，零跳过；包含真实 Linux Chromium 测试 |
| 浏览器保存 | 两次 20 MiB 保存成功，SHA-256 均为 `ae2eeb253c2b00e1f187bc1c665186f82d8780d25eb670f92629ec5a9dcd8275` |
| Hono 健康检查 | 通过 |
| 大文件测试 | 100/500/1024 MiB 完整及中断恢复 SHA-256 校验，3/3 通过、零跳过 |
| Linux AMD64 镜像构建 | 通过 |
| 必须执行的 Docker 测试 | 3/3 通过、零跳过 |

匿名读取 GHCR 清单并计算 SHA-256，确认 `ghcr.io/acdxxx177/feishu-file-relay` 的 `1.2.2`、`latest`、`sha-67e83568b913692b42b46d2d9c00a06ff3691b68` 三个标签对应同一 OCI index：`sha256:272d37745f8e8c6db4ebd266fd021ccf2461d7fdcfdb6857d15c5fb1b5a1d1c3`。Linux AMD64 配置摘要为 `sha256:7d2cab73484c8a42f02b6b82dae6a5a30456bc21505db194d397d3cb9822768f`，镜像 revision 标签与修复提交一致。

此次确认 CI 浏览器路径已恢复，但旧日志未保留 stderr，仍不能追溯证明原启动失败的具体沙箱原因。只提交、推送和发布镜像，未修改 VPS 配置、重启服务或写入线上数据；实际升级和新下载通知位置仍需操作者另行验证。

## Chromium CI 启动失败：本地兼容与诊断修正（2026-11-06）

后续发布授权：先提交修复并推送 `main`，等待该提交的 CI 成功后再创建和推送 `v1.2.2`。保留原 `v1.2.1` 标签，不移动或覆盖。本条记录仅说明发布顺序，远程验证和镜像发布结果待确认，不包含 VPS 部署。

`v1.2.1` 的[发布运行](https://github.com/acdxxx177/feishu-file-relay/actions/runs/42167624775)及同一提交的[main 运行](https://github.com/acdxxx177/feishu-file-relay/actions/runs/42167624794)均在 `pnpm test` 失败：102 项中 101 项通过，唯一失败为 `browser-ui.test.ts`，错误为 `Chromium did not expose its isolated debugging endpoint`。类型检查通过，代理白名单移除及地理位置测试通过；后续镜像发布跳过。Node.js 弃用信息不是此次失败点。

原测试只给 Linux root 进程添加 `--no-sandbox`，并将浏览器标准错误丢弃；现有日志无法确认具体退出原因。此次添加显式测试开关 `CHROME_NO_SANDBOX=1`，仅由 CI 的 `pnpm test` 步骤设置，兼容受限 Linux 沙箱环境，不改系统 AppArmor 或生产镜像。Linux 沙箱限制仍是待 CI 复验的可能原因，参考 [Chromium 官方说明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)。

测试启动器保留最多 8192 字符的错误尾部，报告可执行文件、启动错误、退出码和信号；进程提前退出时及时失败，最长等待 30 秒调试端口。测试结束先终止浏览器，必要时在五秒后强制结束，再清理专属临时目录。CI 同时设置 `REQUIRE_BROWSER=1`，浏览器缺失会失败而非跳过；没有取消原有真实保存、哈希或回调断言。

| 检查 | 结果 |
| --- | --- |
| `pnpm exec tsc -p tsconfig.vps.json` | 通过，包含测试与辅助模块 |
| `pnpm test` | 106/106 通过，零失败、零跳过 |
| Windows 真实 Chromium 保存 | 两次 20 MiB 保存及 SHA-256 校验通过 |
| WSL Linux 启动进程回归 | 4/4 通过，覆盖提前退出及有界 stderr、缺失程序、超时清理、端口文件就绪 |

WSL 使用已有 Node 24 将新启动测试打包后运行，系统未安装 Linux 浏览器，因此不将这些进程回归当作 Linux 浏览器验收。未重跑大文件专项、Docker 或生产验收。修正尚未提交/推送；GitHub CI 和镜像发布尚未恢复验证，不能通过重新运行旧 `v1.2.1` 标签来使用本地新代码。生产配置和服务未变更。

## 移除代理来源 IP 白名单（2026-11-06）

发布准备：用户随后授权提交代码、创建附注标签 `v1.2.1` 并推送。该标签会触发现有 CI 验证及通过后的 GHCR 发布；下列结果仍为本地验证证据，不代表远程构建或镜像发布已完成。本次不包含 VPS 部署。

按用户批准方案修改本地 VPS 代码，对应 PRD F10/F11 及首次确认下载通知扩展。地理位置与访客限流均不再匹配代理来源 IP；保留 `TRUST_PROXY`、`TRUST_CLOUDFLARE_GEO`、内部地理标记和字段校验。旧 `TRUSTED_PROXY_IPS` 任意值都会被忽略，Compose、环境示例和生成器不再输出该项。Docker 子网/网关及 Nginx 配置保持不变。readiness 继续检查实际 socket，只允许回环访问。

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过；补充测试后再次执行 `pnpm exec tsc -p tsconfig.vps.json` 通过 |
| `pnpm test` | 102/102 通过，零失败、零跳过 |
| `pnpm check:health` | Hono CLI 返回 HTTP 200、`status: ok` |
| `pnpm test:linux`（Windows） | 1 项因平台条件跳过；另在 WSL 运行同一测试通过 |
| WSL Linux Nginx 集成测试 | 1/1 通过，零跳过 |
| `pnpm test:docker` | 3 项均因 Docker CLI/引擎不可用跳过，不算验收通过 |

新增或调整测试覆盖：不配置白名单、遗留错误值不影响配置加载、Docker IPv4/映射 IPv6/IPv6 来源变化后仍按访客头限流、关闭或省略开关时使用 socket、缺失/无效/多值 IP 的回退、其他转发头被忽略，以及伪造回环头无法访问 `/ready`。隔离下载确认经不同 Docker 来源地址，将中文地点写入唯一通知快照；重复确认不改写首次地点。地理单测继续验证两个开关、缺失或错误标记、原始 `CF-*` 不被采用、国家代码、Unicode 和异常字符校验。

WSL 验证使用当前源码重新打包 `tests/vps/linux/proxy.test.ts` 为忽略目录 `.local/linux/proxy-trust.test.mjs`，采用 Node24 ESM bundle 和 `createRequire` banner。随后在 WSL Ubuntu 的仓库目录执行：

```sh
NGINX_TEST_BINARY="$PWD/.local/linux/nginx-root/usr/sbin/nginx" \
  .local/linux/node-v24.22.2-linux-x64/bin/node --test .local/linux/proxy-trust.test.mjs
```

测试覆盖代理地理头覆盖、IPv4/IPv6 来源及 real-IP 重写、中文地点、100 MiB 下载 SHA-256、Range、撤回、取消和无响应临时文件；使用本地 mock、临时证书及专属端口，结束后清理测试进程。未另行重跑 500 MiB/1 GiB、大文件专项或旧 Worker 套件。

新行为允许可直连 Node 的调用者提供访客 IP 和位置头，这是用户明确接受的取舍，详见[当前运行契约](../src/vps/context/runtime.md)与[Docker 部署说明](docker-deployment.md)。没有连接 VPS 执行变更，没有修改服务器文件、飞书权限或线上数据，没有发送真实消息。未发布镜像或部署，新代码需部署新版镜像才生效，已有通知位置不会补写。

## 首次确认下载通知（2026-11-06）

按用户批准口径实现：仅启用后新登记文件参与；原生保存提交成功、或完整 Blob 后真实保存点击才确认；原始下载不通知。原下载统计不变。会话内存最多 1,000 条/24 小时，确认入库后用永久唯一任务与现有持久调度器投递。记录[操作与限制说明](first-download-notifications.md)。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm typecheck:worker` | 最终均通过 |
| `pnpm test` | 100/100 通过，零跳过 |
| `pnpm test:large` | 3/3 通过，零跳过 |
| `pnpm test:worker` | 35/35 通过，零跳过 |
| 增强后的 Chromium UI 定向重跑 | 1/1 通过，包含两次真实可信 Blob 保存动作 |
| `pnpm check:health` | HTTP 200 |
| `pnpm db:check`、`pnpm exec prisma validate` | 本地按序迁移参考 schema 及 Prisma schema 均通过，不读取远程库 |
| `pnpm test:linux`（Windows） | 1 项明确跳过；随后在 WSL 执行同一测试通过，见下文 |
| `pnpm test:docker` | 3 项明确跳过：Docker CLI/引擎不可用 |
| 前端 premium 严格静态审查 | 零发现；忽略目录 `.local/premium-first-download-audit.json` 保留报告 |
| 独立只读审查 | 无阻塞发现；独立运行会话、地理、数据库和投递 21/21 测试通过 |

覆盖了缺片、乱序、重复片、跨会话、截断/超长/异常/取消、失败分片恢复、原始下载与 Range、HEAD/元数据/预取排除、Origin/令牌/方法/版本绑定、历史资格、会话过期/容量/重启边界、撤回与 warm cache、并发确认、未知 D1 提交、旧租约及飞书接受后回执丢失。一小时窗口内保持原 UUID/卡片，过窗停止；永久拒绝无替代消息，八次尝试上限有效。

大文件使用本地 HTTP 源和 relay，原始完整、原始中断恢复及带会话浏览器分片中断恢复均核对相同 SHA-256；未完成返回 409，收齐确认后返回 204，重复确认仍只有一条事件。

| 大小 | SHA-256 |
| --- | --- |
| 100 MiB | `a14a09201182b6fb326acd2621160dc152597264d3980253e93e580a593e4fef` |
| 500 MiB | `d5628966fba65be6fac98dc2c51c663dc05efb4440f784739038cee33a9de23c` |
| 1024 MiB | `88d70583c2ecc851ea3debfbefca7da4b9295959a1412927cb8e60207e2c51c7` |

真实 Chromium 在 390×844、减少动效、已切换语言的页面中，用浏览器进程外的 CDP 键盘 Enter 激活 Blob 保存两次：得到两个 `isTrusted=true` 事件、一个完成 POST、两个正常落盘的 20 MiB 文件。两份哈希均为 `ae2eeb253c2b00e1f187bc1c665186f82d8780d25eb670f92629ec5a9dcd8275`。未点击和合成点击均不报告，Blob URL、焦点和窄屏布局保持正确。原生 close 成功/失败采用受控 writable sink，不声称本次重新验证了系统原生选择器落盘。

Linux 验证复用忽略目录已有的 Node 24.22.2 与 Nginx 1.28.3。在 Windows 用 esbuild 将最新 `tests/vps/linux/proxy.test.ts` 打包为 `.local/linux/first-download-proxy.test.mjs`（Node 平台、ESM、Node24 target，banner 用 `createRequire` 支持 Prisma 的 Node 内置模块加载），再由 WSL Ubuntu 设置 `NGINX_TEST_BINARY` 后运行 `node --test`。最终 1/1 通过、零跳过。测试使用临时证书、高端口、本地假 D1/飞书与回环地址模拟可信 IPv4/IPv6 对端，未信任真实公网测试地址。验证原始对端在 real-IP 重写后仍正确、不可信直连地理头被清空、中文地理头字节正确、完整 100 MiB 哈希、Range、撤回、响应头前取消及无临时文件；结束时清理测试进程和目录。

中间检查发现并修复了测试类型推导及 Worker 编译边界问题：新增浏览器模块必须与现有控制器一起排除出 Worker 类型环境，由浏览器 tsconfig 检查。WSL 首次打包缺少 ESM `createRequire` banner，修正后进入测试。代理测试首次用 Node 字符串正文再次编码了模拟 UTF-8 头，改为 Buffer 正文并加入 GET/POST 原始字节断言后通过；没有因此放宽生产地理解析。

未执行生产或远程迁移、真实文件登记、真实飞书通知、镜像发布或部署。Docker 运行验收、隔离远程 D1 主库/事务合同、飞书真实 UUID 去重回执及目标 Cloudflare/Nginx 配置仍需分别验收。旧 Worker 大文件和十路压力测试未在此次重跑；上述数字仅指本次列出的检查。

## VPS 卡片回调 HTTP 401 修复（2026-11-06）

获准对目标 VPS 只读诊断后，Nginx 记录两次用户确认的测试点击分别于北京时间 09:31:42、09:34:02 返回 401，期间普通消息返回 200。内存诊断确认卡片回调解密、Token、App ID、签名均匹配，正文时间有效；请求头时间戳不是数字。旧代码因此在验签前误拒绝。原始回调及请求头原值未保存，两个临时诊断进程均已退出。

新增测试先在旧代码复现 `Expired request`，再验证修复：仅签名新版卡片将请求头时间戳作为原始字符串验签，保留正文时效与所有鉴权要求。测试使用合成的非数字头值，并非线上原始请求。实际 HTTP 测试覆盖加密回调、篡改拒绝、撤销成功、重复点击、原卡片更新及撤销后 HEAD 返回 410。

| 本地命令 | 实际结果 |
| --- | --- |
| `pnpm exec tsx --test --test-concurrency=1 tests/vps/webhook-auth.test.ts tests/vps/runtime.test.ts` | 19/19 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 72/72 通过，零跳过 |

独立只读审查无阻塞问题。本次未重跑大文件或 Worker 套件，未发布镜像或更新 VPS，也未修改生产配置及数据。修复上线后的飞书客户端确认与原卡片刷新仍待验收。

## VPS 飞书文件分享卡片（2026-11-06）

PRD F03、F06、F08、F09、§8.4。本地使用 Node、SQLite 模拟 D1 REST 事务和隔离飞书服务。Worker 使用原有本地 workerd 验证链路。完整[示例 JSON](file-card-example.json)由实际构建函数生成，并与测试输出逐字段比对。

| 本地命令 | 实际结果 |
| --- | --- |
| `pnpm typecheck`、`pnpm typecheck:worker` | 均通过 |
| `pnpm test`、`pnpm test:large` | VPS 65/65、3/3 通过 |
| `pnpm test:worker`、`pnpm test:worker:large` | Worker 35/35、8/8 通过 |
| `pnpm check:health` | HTTP 200，响应 `{"status":"ok"}` |

以上测试零跳过。两个运行时完整下载与中断续传的 SHA-256 均与隔离源一致。

| 大小 | SHA-256 |
| --- | --- |
| 100 MiB | `a14a09201182b6fb326acd2621160dc152597264d3980253e93e580a593e4fef` |
| 500 MiB | `d5628966fba65be6fac98dc2c51c663dc05efb4440f784739038cee33a9de23c` |
| 1024 MiB | `88d70583c2ecc851ea3debfbefca7da4b9295959a1412927cb8e60207e2c51c7` |

已覆盖更新过期时热缓存 GET/HEAD 返回 410、未知提交时提示稍后重试、收到旧回执时补更新，以及同一上传者用另一张卡片的回调无法撤销目标文件。只有明确未投递的卡片允许切换到文字兜底；结果不明时使用原 UUID 和原内容在安全窗口内追回回执。

变更文件按职责归档：

- VPS 展示与投递：`src/vps/cards/file-card.ts`、`src/vps/card-delivery.ts`、`src/vps/feishu.ts`。
- 回调、鉴权与命令：`src/vps/intake.ts`、`src/vps/webhook-auth.ts`、`src/vps/commands.ts`。
- 持久化：`src/db/repository.ts`、`src/db/prisma-repository.ts`。沿用原库表。
- 本地测试：`mocks/feishu-mock.ts`，以及 `tests/vps/` 下的 `card-delivery.test.ts`、`database-cards.test.ts`、`database-fixture.ts`、`database.test.ts`、`feishu.test.ts`、`file-card.test.ts`、`runtime.test.ts`。
- 说明及示例：`PRD.md`、`project-status.md`、`context/workflows.md`、`src/db/context/vps-contract.md`、`src/vps/context/runtime.md`、`docs/acceptance.md`、`docs/vps-deployment.md`、`docs/file-card-example.json` 和本日志。

待获准后按[客户端验收步骤](acceptance.md)验证取消无回调、实际请求耗时、完整 URL 选中、卡片就地刷新，以及重复 UUID 能否取回原消息 ID。未使用远程 D1 或真实文件执行这些操作。

## 首个 GHCR 镜像发布（2026-11-04）

用户授权创建 tag 并发布镜像后，将附注标签 `v1.0.0` 推送到已通过 CI 的提交 `2c3d2c98d7bf72820fdce5980f68c6c19c46a97f`。未使用随后带 `[skip ci]` 的纯文档提交作为发布目标。

- [发布工作流 41861522449](https://github.com/acdxxx177/feishu-file-relay/actions/runs/41861522449) 的 verify 已成功；publish job `126685098328` 所有列出的步骤（含上传、摘要记录和清理）均成功。最后检查时 GitHub 的 run/job 汇总仍为 `in_progress`，尚未记录汇总成功。
- GHCR 匿名请求已验证 `ghcr.io/acdxxx177/feishu-file-relay` 的 `1.0.0`、`latest` 和 `sha-2c3d2c98d7bf72820fdce5980f68c6c19c46a97f` 三个标签均指向同一摘要：`sha256:0569469bde620ab6df448e6321de5f67eb3059a55b2a8279520b4a074c99af61`。
- OCI 索引含 `linux/amd64` 镜像和证明清单。已验证无需登录即可读取清单；本机没有 Docker 引擎，没有把清单检查当作实际拉取/启动验收。没有修改 Package 可见性、部署 VPS 或操作生产 D1。

版本拉取命令：`docker pull ghcr.io/acdxxx177/feishu-file-relay:1.0.0`。固定内容可使用 `ghcr.io/acdxxx177/feishu-file-relay@sha256:0569469bde620ab6df448e6321de5f67eb3059a55b2a8279520b4a074c99af61`。

## Docker 修复推送与 CI 通过（2026-11-04）

用户授权后，将修复提交 `2c3d2c98d7bf72820fdce5980f68c6c19c46a97f`（`fix(ci): 修复容器环境与桥接网络验收测试`）推送到 main。

[GitHub Actions run 41858863201](https://github.com/acdxxx177/feishu-file-relay/actions/runs/41858863201) 已完成，结论为 **success**。verify job `126674824415` 的依赖安装、类型检查、应用测试、Hono 健康检查、大文件完整性、Linux AMD64 镜像构建和 `pnpm test:docker` 全部通过。此前两处 Docker 测试修复已获得真实 Linux CI 验证，下文“待新 CI 复验”为历史状态。

publish job 按 main 推送规则 **skipped**，没有发布 GHCR 镜像或部署生产。此结果不替代真实 D1、飞书和目标 VPS 验收。

## 首次 GitHub 容器验收失败修复（2026-11-04）

检查了 [run 41847085376 / verify](https://github.com/acdxxx177/feishu-file-relay/actions/runs/41847085376/job/126633311711) 的实际日志，对应提交 `311137b4b5680b445848e4dd93198f608a4ad362`。

- **CI 已通过**：依赖安装、类型检查、应用测试、健康检查、大文件完整性和 Linux AMD64 镜像构建；Docker 三项中，非 root/断网启动、静态资源和 SIGTERM 退出这一项通过。
- **CI 已失败**：环境测试把 `config --format json` 导出的 `fake$$secret# value` 与运行值 `fake$secret# value` 比较；桥接测试在 internal 网络上要求发布端口，`docker port` 报 `no public port '3000/tcp' published`。共 1 项通过、2 项失败。Node.js 20 弃用提示是警告，不是失败原因。
- **已修改**：保留 Compose 原始环境映射，通过测试专用 `network_mode: none` 覆盖文件运行 Node 断言，检查真实容器环境；桥接测试保持 internal 网络，改为 Linux 宿主机直接访问容器 IP，验证网关信任、客户限流隔离和 readiness 拒绝。生产 Compose、应用逻辑和发布规则未变。
- **本地通过**：`pnpm typecheck`、代理回归 4/4；下载到忽略目录并校验 SHA-256 的官方 Compose v5.7.0 独立程序，复现美元符号序列化行为，并验证进程端口覆盖、网关回退与断网覆盖文件合并。未安装 Docker 服务或修改系统网络。
- **待验证**：`pnpm test:docker` 仍因本机缺少引擎跳过三项；修复后的真实容器用例需在新提交 CI 中复验。本次没有推送提交、重跑工作流或发布镜像，直接重跑旧提交仍会执行旧测试。

## Docker 与 GHCR 配置验证（2026-11-04）

本次只交付本地文件；没有 Git remote，没有推送代码/版本标签、发布 GHCR 镜像、生产切换、真实飞书登记或远程 D1 操作。

- **通过**：`pnpm typecheck`（包含构建脚本、代理、配置和测试）、`pnpm test` 36/36、`pnpm check:health` 返回 200 / `{"status":"ok"}`。新增七个测试覆盖环境模板独立生成/拒绝覆盖/字段完整、GHCR 版本与手动标签策略、代理来源及 IPv4-mapped IPv6、不同客户限流、伪造/多值头拒绝，以及 readiness 不向可信网关开放。
- **通过**：`pnpm test:large` 3/3，100/500/1024 MiB 的 raw 完整下载、实际中断续传及浏览器分片组装 SHA-256 均与源一致；哈希分别为 `a14a09201182b6fb326acd2621160dc152597264d3980253e93e580a593e4fef`、`d5628966fba65be6fac98dc2c51c663dc05efb4440f784739038cee33a9de23c`、`88d70583c2ecc851ea3debfbefca7da4b9295959a1412927cb8e60207e2c51c7`。这是本地模拟源证据，不是 Docker 或生产容量证明。
- **通过**：`pnpm env:docker` 生成忽略入库的 `.env.docker`，未知凭据、域名和镜像地址为空；真实 `.env` 未被读取或改写。独立只读审查未发现阻断问题，Actions SHA 已通过官方仓库标签核验。
- **修正后通过**：第一轮 35/36，模板字段覆盖测试的正则漏掉数字，将 `CLOUDFLARE_D1_TOKEN` 截断；修正测试后完整回归 36/36。流中断测试中的 `Response stream interrupted` 为预期错误路径，测试本身通过。
- **跳过**：`pnpm test:docker` 三项全部因本机无 Docker CLI/daemon 跳过，0 项通过；不能把命令退出 0 当作容器验收。CI 使用 `REQUIRE_DOCKER=1`，缺少 Docker 会直接失败。
- **待 CI/目标环境验证**：Linux AMD64 镜像构建、Compose 特殊字符和进程覆盖、非 root/只读镜像启动与静态资源、SIGTERM 退出、宿主机桥接来源及 readiness 拒绝、GHCR 权限与发布。测试仅用假凭据和断外网容器；不会证明真实远程 D1 查询成功、目标 Nginx 重写头、真实飞书或生产切换。
- `node:24-bookworm-slim` 是可变基础镜像，重建同一提交可能产生新镜像；提交标签不等于内容不可变，部署固定版本应使用摘要。操作说明见 [Docker 部署](docker-deployment.md)。

## VPS / Prisma 迁移验证（2026-11-04）

本节为最新迁移证据，下方保留历史 Worker 验证。此次没有生产部署、DNS/套餐修改、真实飞书登记或远程 D1 写入。

- Prisma 7.10.1 Client/schema、受限 HTTP driver、repository 已集成。Prisma validate/generate、VPS 构建/严格类型检查通过；`db:check` 的本地参考检查和 `db:diff` 执行通过。diff 产生了重建表建议，未经应用；现有 CHECK 与 INTEGER 列继续保留。
- 旧 Worker 严格类型检查、两种 dry-run 构建、34/34 回归通过。
- VPS 小型回归最终 29/29 通过（数据库 6、飞书客户端 2、运行时 8、流式单元 10、实际 HTTP 3）；补充日志后的相关客户端/流式 15/15 复验通过。内容覆盖 Token 刷新合并、错误分类与有界重试，以及新增缓存引用预算回归。
- 仓库 Hono CLI 0.1.11 不支持技能新版示例的 `routes` 命令；依据安装版 `--help` 使用 `pnpm check:health`（`hono request tests/vps/cli-app.ts -P /health -J`），返回 200 / `{"status":"ok"}`。该入口拒绝任何数据库/飞书访问，不启动后台任务。文档相对链接检查和最终 `git diff --check` 通过。
- 本地 Node HTTP 大文件组 3/3 与十路并发组 1/1 通过；每个 100/500/1024 MiB 文件校验 raw 完整下载、实际取消后续传及浏览器分片组装。十个 1 GiB 下载在 69.386 秒内哈希一致，640 次源请求、80 次模拟 repository 读取，聚合 RSS 峰值 326,103,040 字节。测试源、服务与客户都在同一进程，CPU/内存不是生产服务单独占用；大型组没有真实 D1 API 限流链路。
- SHA-256：100 MiB `a14a09201182b6fb326acd2621160dc152597264d3980253e93e580a593e4fef`；500 MiB `d5628966fba65be6fac98dc2c51c663dc05efb4440f784739038cee33a9de23c`；1 GiB `88d70583c2ecc851ea3debfbefca7da4b9295959a1412927cb8e60207e2c51c7`。
- 实际 Node 适配器曾在截断后追加错误文本，使“一字节短缺”可能被填满。已增加 `safeNodeResponse`，先销毁 socket 再报告脱敏错误；头部前取消、截断及一字节短缺实际 HTTP 回归 3/3 连续通过。独立只读审查另发现 readiness 可消耗控制预算，已合并/缓存探针并在代理拒绝公网访问。
- 可选缓存测试包含预算淘汰、每文件单片、写入预留、取消释放、TTL、版本和活跃读取引用。修复了被淘汰但仍由客户读取的块提前释放预算问题；默认无缓存路径不变。
- WSL Ubuntu / Linux Node 24.22.2 下，数据库、运行时和实际流测试 17/17 通过。Node 官方压缩包 SHA-256 `48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75` 与官方清单匹配。
- 解包到忽略目录的 Nginx 1.28.3（未安装系统包）通过独立 HTTPS 代理测试 1/1：100 MiB SHA、长度、单字节 Range、撤回 410、响应头前断连传播、代理/请求临时目录为空。使用临时证书和回环高端口，测试后停止进程并清理专属目录。首次 apt 下载因旧索引版本 404，改用仓库可用基础版本；首次 Linux bundle 误触发 mock CLI，已修复入口识别并停止本次测试进程，最终结果不包含那次未结束测试。

**未执行/仍阻塞：**隔离远程 D1 契约与配额实测（提供 `pnpm test:d1:remote`，需独立测试配置）；真实飞书附件、召回及跨地区体验；目标 VPS systemd、证书/DNS 切换；原生浏览器保存器验收。所有已通过的飞书行为均使用 mock，SQLite fake-D1 主库标志与 batch 事务是夹具模拟，不能证明云端兼容性。生产服务保持原样。

部署、命令和回滚清单见 [VPS 部署](vps-deployment.md)。

---

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

## 2026-11-03 浏览器分片下载（PRD v1.2）

实现下载页、公开元数据、每片D1主库/强If-Match门禁、精确Range与原生Gateway管道，保留原始地址 `/f/:id/download`。File System Access背压写盘、失败片回滚、取消与提交检查；无选择器时Blob硬上限20 MiB。无新增D1迁移或持久文件仓库，未部署生产、升级套餐或登记生产文件。

### 本地实际结果

| 检查 | 实际结果 |
| --- | --- |
| `pnpm typecheck` | 通过：Workers、脚本/测试、独立DOM浏览器配置；TypeScript7 CLI生成资源 |
| `pnpm test` | 最终33/33通过、0失败/跳过，含原25项及8项新增浏览器/接口场景 |
| 新分片完整性组 | 最终5/5通过：1/20/100/500/1024 MiB完整与中断恢复SHA-256 |
| 旧原始路径大文件组 | BYOB修改后3/3通过，保留100/500/1024 MiB完整/续传与缓存回归 |
| `pnpm build`、`pnpm build:mock` | dry run通过，无生产上传；隔离部署另使用完整预构建及no-bundle同一产物 |
| 源码UI lint、严格静态UI审计 | 0失败/0警告、0审计发现 |
| 1440/768/390真实浏览器页面检查 | 0 FAIL；3项留存WARN属于小型居中工具的画布/固定反馈空间，截图已逐张查看 |
| 文档本地链接、`git diff --check` | 通过 |

新链路源/完整/恢复共同SHA-256：1 MiB `b2d1a8f7538af60e712ac2b5d5fde990431ac11fd35ae0e54271d40ca2a95b2c`；20 MiB `ae2eeb253c2b00e1f187bc1c665186f82d8780d25eb670f92629ec5a9dcd8275`；100/500/1024 MiB与本文前述独立生成器哈希表一致。全程增量校验，Node文件sink是模拟保存API，不能当作原生浏览器写盘证明。

保留早期失败及修正：外置Text模块未被旧测试包装入口收集，改为构建时内联资源；两项机器人链接期待错误迁移到raw地址，已修正；提速后完整性测试触发限流，其模拟等待跳过Retry-After导致500/1024 MiB失败。完整性夹具现独立提高本地限额，生产/default限额仍60/分钟，独立429/Retry-After测试继续通过。最初新增取消测试要求Node outbound桥接观察物理源断开，超出了本地能力；改为与旧测试同样验证及时返回、不重试、不计数，实际新路径物理源取消仍待专门边缘验证。

独立只读审查发现并修复最终truncate等待期间取消仍会close的竞态；后续审查确认范围、EOF、标记、回滚、预算及临时输出生命周期。BYOB每次最多256 KiB；其默认30秒是聚合读取期限，持续低于约8.5 KiB/s的源也可能失败，已测试失败后恢复且不复用残片；旧raw逐次空闲期限不变。

### 真实浏览器证据与未验证项

实际安装的Chrome 156.0.8078.80经CDP通过：1 MiB Blob实际保存及源哈希；100 MiB Blob拒绝；404禁用按钮；键盘主操作聚焦；离线元数据错误恢复；节流Fetch期间取消且不出现保存链接；原生选择器特性检测。均为真实浏览器执行，Blob模式通过特性覆盖强制选择。

未验证：真实showSaveFilePicker选择/写盘/close持久化、Firefox、WebKit/Safari、真实移动设备、原生模式磁盘满/权限撤销。390px仅为移动视口，不能代替移动设备兼容性。

### 隔离线上CPU与完整性

仅更新既有test Worker/D1，未触及生产绑定/路由/Secrets/数据。新账本独立保留，最大4 GiB，旧512 MiB账本和旧100 MiB exceededCpu记录不变。以下为三个完整候选运行及一次受控边界试验，公共响应观测LAX，边界运行另观测DFW；不宣称跨区缓存。

| 运行 | 实际结果 |
| --- | --- |
| `mw0qq98s` 初版 | 16 MiB exceededCpu；8/4 MiB功能样本通过，1 MiB出现502，100 MiB中断；2通过/3失败/3跳过 |
| `mw0rb2cn` BYOB＋缓存 | 1 MiB基础及四种尺寸功能均通过（5通过/1跳过）；CPU没有合格余量，不扩大 |
| `mw0rpakp` BYOB＋绕缓存 | 5通过/1跳过；1 MiB全部样本低于10 ms但仅1 ms最差余量，保守8 ms门槛未通过 |
| `mw0s436g` 显式边界复核 | 同一活动构建/配置/版本，放宽到最多9 ms样本，仅作边界试验；100 MiB完整性通过，随后因CPU/覆盖不足由primary受控终止扩大 |

初版筛选只统计Gateway，遗漏私有ChunkEntry；其原始platformLimited=false汇总也是脚本缺陷。原报告未被改写成通过，reviewNotes说明缺陷；同一活动版本及仅构建注释差异另经只读核对。新执行器分别要求两类完整样本、完整预构建并部署同一产物、核对活动100%版本并记录构建/配置哈希，整轮超限汇总保留历史失败。不能只用Gateway低CPU作为Free证据。

各尺寸三组冷/热样本的CPU范围（ms）：

| 分片 | 缓存开启 Gateway / 私有入口 | 绕缓存 Gateway / 私有入口 |
| --- | --- | --- |
| 16 MiB | 2–9 / 1–93 | 3–10 / 33–76 |
| 8 MiB | 2–8 / 1–26 | 3–8 / 18–38 |
| 4 MiB | 2–6 / 1–32 | 2–6 / 9–20 |
| 1 MiB | 3–11 / 1–20 | 3–6 / 4–9 |

100 MiB边界试验使用生产浏览器控制器与Node临时文件sink，独立1 MiB请求100次，104,857,600字节及源SHA-256 `a14a09201182b6fb326acd2621160dc152597264d3980253e93e580a593e4fef`一致。阶段总耗时138,410 ms，包含登记/元数据/限流保护间隔/本地验证，不是原生浏览器吞吐基准。物理mock表确认100次源请求、100 MiB源字节（不含登记探测）。

但完整试验CPU已观察到Gateway峰值8 ms（55条）、私有入口峰值17 ms/中位5 ms（65条），均未覆盖100次调用。**完整性成功，Free可靠性未通过。** 500 MiB阶段在人工性能复核时已部分启动：物理源43次请求/43 MiB，本地暂存输出约42.8 MiB；受控终止且未接受完整性结果，剩余1 GiB及大文件恢复未执行。未来执行器已增加整文件CPU和覆盖门禁，自动停止后续扩大。

最终新预算预扣765,788,160字节（730.3125 MiB），持久化已收744,642,304字节；受控终止时最后在途字节可能尚未持久化，因此已收数不是精确最终网络总量。预扣不退还，仍远低于4 GiB。验证PID后停止自有测试进程并清理其锁，仅删除自有局部输出文件；Tail已停止，远程资源与全部历史保留。原始报告、CPU/哈希/回源汇总在忽略的.local下保存，未保存凭据或文件内容日志。

仓库本地待部署变量选择实测较优的1 MiB/绕缓存，原始路径缓存不变；**未部署生产，也未认定该实验配置满足Free大文件验收**。峰值Worker内存不可获得；真实飞书、原生选择器及500 MiB–1 GiB线上完整交付仍待验证。操作与部署步骤见[浏览器下载说明](browser-downloads.md)。

## ChunkEntry CPU 后续定位与最小优化

本轮仅本地工作，没有部署或调用远程测试环境。新增 `pnpm profile:chunk`，使用现有 Miniflare/workerd、D1、RPC、模拟源，保存原生 CPU profile、产物 SHA-256 和 Windows 整个 workerd 进程的 OS CPU 增量；采样前后校验产物未变化。它不读取线上 manifest/Secrets/预算，不能替代平台每请求 CPU。独立只读审查确认最终改动未改变完整性、授权、取消和缓存开启时的生命周期。

原生 BYOB readAtLeast 是本地字节路径最大的具名 self-sample 热点，另有大量未归因原生/程序/空闲样本；没有旧 17 ms 请求的函数栈，不能精确归因。手动写入及缓冲复用、64/128/512 KiB 聚合对照均未取得稳定净收益，全部撤销；保留 256 KiB、原生 pipeTo 与原期限。只在明确绕缓存时跳过缓存 URL、合并完成 Promise/清理闭包和清理映射查询。未删改 D1 first-primary、If-Match、源响应头、精确字节、EOF、超长体、取消或完成标记检查。

| 本地检查 | 实际结果 |
| --- | --- |
| `pnpm test` | 34/34，0失败/跳过，136302.5 ms；包含新增边界、慢消费、错误体与取消后重读测试 |
| 最终构建 `node --test --test-concurrency=1 tests/browser-download.test.ts` | 9/9，0失败/跳过，26843.7 ms；在最后清理无用 clear 调用后复核 |
| `pnpm test:large` | 最终构建 8/8，0失败/跳过，241061.1 ms；浏览器组改为实际候选1 MiB/绕缓存，五种大小完整/中断恢复哈希一致；旧raw组100/500/1024 MiB完整及续传哈希一致、热恢复额外回源0 |
| `pnpm typecheck` | 最终代码通过 Workers、DOM、脚本及测试严格类型检查 |
| 两套 Worker dry run | 通过；分别由 test/test:large 的 build 和 test 的 build:mock 执行 |

新组1024 MiB完整1024次请求，中断恢复1025次；使用Node临时文件的绝对偏移写入，模拟文件保存API，不新增原生选择器或浏览器兼容性结论。原始日志为 `.local/chunk-cpu-regression.log`、`chunk-cpu-browser-final.log`、`chunk-cpu-large.log`、`chunk-cpu-delivery-typecheck.log`，CPU原始报告保留于 `.local/chunk-cpu/`。

本轮选择**不使用线上预算**：当前实验没有稳定净收益，有限的准备开销优化不能证明已消除17 ms峰值，不再用大传输试错。新账本预扣仍为765,788,160字节，剩余3,529,179,136字节；旧账本、旧部署记录和CPU失败均保留。详细对照及后续小规模试验前提见[CPU调查](chunk-cpu-investigation.md)。生产未部署，Free大文件可靠性仍未通过。

最终保留构建 `8f22bb3a0429271fd5d7f6c587823cd5b7d3c7cfeb62a41012a7af110b3f8dea` 在1000个独立1 MiB请求中全部哈希一致，阶段15602.04 ms、整进程OS CPU 12250 ms；baseline-4为15787.13 ms/12171.875 ms。**未测出显著CPU下降**，这些本地整进程值不能冒充线上私有入口请求CPU。原始报告 `cache-bookkeeping.json/.cpuprofile` 与所有被拒绝方案报告一同保留。
