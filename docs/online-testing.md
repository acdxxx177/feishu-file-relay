# 免费版线上模拟验收

本环境由操作者明确授权创建，使用 Workers 免费版和 workers.dev；不升级账户计划，不配置真实飞书。生产配置的默认入口仍关闭 workers.dev，线上测试使用单独配置、独立D1和两个带test后缀的Worker。

## 当前资源

| 资源 | 名称/地址 |
| --- | --- |
| 测试Gateway | `feishu-file-relay-online-test-20261103-281c20` |
| 健康检查 | [访问测试服务](https://feishu-file-relay-online-test-20261103-281c20.wiliawu.workers.dev/health) |
| 私有飞书模拟Worker | `feishu-file-relay-mock-test-20261103-281c20`，无公开路由、workers.dev或预览URL |
| 测试D1 | `feishu-relay-test-20261103-281c20` |
| 数据库ID | `df3e3ea8-d562-47d6-8435-5bcc372d3bb7` |

真实配置和资源清单位于忽略文件 `.local/online-test.json`、`.local/online-gateway.json`、`.local/online-mock.json`。随机模拟凭据位于 `.local/online-test-secrets.json`，已写入两个测试Worker的Secrets。不要提交、打印或粘贴此文件，也不要用真实飞书凭据替换。

## 测试隔离

- 两个飞书base固定为 `https://mock-feishu.invalid`、`https://mock-accounts.invalid`，FEISHU_TRANSPORT=mock，所有请求通过私有FEISHU_MOCK绑定。缺少模式/绑定、错误域名均直接失败，不回退真实飞书。
- 模拟源按绝对字节偏移生成文件，D1不存文件内容。测试表mock_files保存模式和长度，mock_replies保存机器人回复，mock_requests记录回源状态、字节与地区，不保存Token。
- 用测试签名/加密回调登记文件，再从模拟机器人回复取得公开链接，客户下载路径与应用正常路径相同。公网不增加测试管理接口。
- 本轮最大100 MiB单文件、最多2路并发、客户端响应预算512 MiB。预算按每次响应上限预扣并原子持久化，取消和重启不返还；跨进程锁防止两个运行器重复消费预算。不要删除账本或强行绕过锁来重试。
- 免费版限制以实际Worker结果为准：发生CPU/子请求/内存超限时停止扩大规模；500 MiB、1 GiB、十路并发不在线执行。

## 可复现命令

在已授权的当前测试环境运行：

```powershell
pnpm typecheck
pnpm test
pnpm build:mock
# 读取当前登录账户并生成/复用本地隔离清单，不创建远程资源
pnpm online:prepare
```

`pnpm online:deploy` 会创建/复用清单中的测试D1、应用两组迁移、部署私有模拟Worker和Gateway，并上传模拟Secrets；这是远程变更命令。它不会部署根配置的生产Worker，也不改变账户付费计划。已有测试清单不自动重命名、换库或覆盖生产资源。

先启动脱敏日志采集，再运行测试：

```powershell
# 终端一：最长采集30分钟，仅保存白名单事件字段与平台结果
pnpm online:tail
# 终端二：会写入隔离测试数据及预算账本
pnpm online:test
```

报告保存在 `.local/online-results.json`；每次运行保留独立runId和通过/失败/跳过记录。`.local/online-tail.jsonl`只包含允许的事件字段、CPU/耗时/平台结果，不记录请求头、请求体或原始异常。超限时生成 `.local/online-platform-limits.json`，运行器在扩大文件大小前读取该证据。

停止日志采集可按Ctrl+C，或在项目目录创建 `.local/online-tail.stop`。结束采集不删除远程资源。若进程异常退出留下 `.local/online-test.lock`，先确认没有测试进程，再人工处理该锁；不要重置已有预算。

Wrangler当前版本对远程 `d1 execute --file` 使用导入模式，返回导入统计而非SELECT结果；运行器保留SQL审计文件，但通过无shell的execFile参数 `--command` 取得实际行。查询不携带Secret。

## 结果与边界

实际结果见[验证日志](verification-log.md)的线上模拟验收记录。缓存必须根据重复下载后的实际回源次数验收；观察动作完成不代表命中，未观测到HIT应标记为未验收。所有线上测试仍使用模拟飞书，不能证明真实飞书Range、权限、撤回窗口或附件保留。

## 保留与人工清理

本次保留测试资源和数据供复查。下列命令仅供确认不再需要后人工执行，会删除指定测试Worker或整个测试数据库，不属于自动测试步骤：

```powershell
node node_modules/wrangler/bin/wrangler.js delete --config .local/online-gateway.json
node node_modules/wrangler/bin/wrangler.js delete --config .local/online-mock.json
node node_modules/wrangler/bin/wrangler.js d1 delete feishu-relay-test-20261103-281c20 --config .local/online-gateway.json
```

执行前核对 `.local/online-test.json` 中的账户、资源名称和数据库ID。生产Worker及生产数据库不在此清理范围内。
