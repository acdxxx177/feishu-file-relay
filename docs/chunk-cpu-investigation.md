# ChunkEntry CPU 后续定位

本轮只在本地运行 workerd，不更新任何远程 Worker，不使用线上响应预算，不部署生产。对应 PRD F04/F05/F07/F10/F11 的流式交付、完整性及撤回要求。

## 能确认和不能确认的结论

旧线上 100 MiB 试验的私有入口峰值为 17 ms，但当时只保存了每次调用总 CPU，没有该次调用的函数栈 CPU profile。因此不能事后把 17 ms 精确归到某一行，也不能把网络耗时当 CPU。随后未完成的 500 MiB 阶段另有 19 ms 私有调用记录，不能忽略该波动。

本地 Inspector 采样覆盖真实 Gateway、D1、RPC 和 ChunkEntry。独立的源生成器及客户端 SHA-256 在 Node 中，不属于被采样的 relay isolate。`readAtLeast()` 是字节处理路径中最大的具名 self-sample 热点；例如 baseline-2 的 6,525 个样本中有 562 个落在该原生函数，另有未归因原生、程序及空闲样本。该结果支持继续调查缓冲分配、原生复制和流边界，但不能证明这些操作解释了线上整个峰值，也不代表 562 次读取。定时器、Promise、事件监听及流回调是另外可见的开销。

CPU profile 保存为 `.local/chunk-cpu/*.cpuprofile`，可导入 DevTools。采样间隔目标为 100 μs，实际调度有偏差；不按样本数乘间隔推算请求 CPU。Windows 上同时记录整个自有 workerd 进程的 OS CPU 增量，包含其内部 D1/桥接 isolate，不能冒充 ChunkEntry 单请求 CPU。

## 本地对照与取舍

全部为顺序独立 1 MiB 请求，逐次流式 SHA-256 校验；配置绕缓存。每轮先预热五次。表中耗时不包含启动、登记和预热，仍受本机、模拟源及调试器影响。

| 方案 / 报告名 | 请求数 | 阶段耗时 ms | 整个 workerd OS CPU ms |
| --- | ---: | ---: | ---: |
| 原 256 KiB / baseline-2 | 1000 | 17167.18 | 未采集 |
| 原 256 KiB / baseline-3 | 1000 | 17851.55 | 未采集 |
| 原 256 KiB / baseline-4 | 1000 | 15787.13 | 12171.875 |
| 手动定长写入并复用 BYOB 缓冲 / direct-2 | 1000 | 21389.76 | 未采集 |
| 聚合 512 KiB / buffer-512-1 | 1000 | 23587.10 | 未采集 |
| 聚合 128 KiB / buffer-128-1 | 1000 | 12622.82 | 9921.875 |
| 聚合 128 KiB 复测 / buffer-128-2 | 1000 | 18138.10 | 14750 |
| 聚合 64 KiB / buffer-64-1 | 1000 | 22482.43 | 19125 |
| 最终仅删除绕缓存准备 / cache-bookkeeping | 1000 | 15602.04 | 12250 |

手动写入减少了一部分 BYOB 分配，但引入额外写循环，没有整体收益；已撤销。128 KiB 首次较快，交替复测却反向，证据不足以改变尺寸。64/512 KiB 也不保留。最终仍是原生 pipeTo、256 KiB 有界 BYOB、原 30 秒聚合期限，未改生产配置。

唯一保留的服务端优化：`cache=false` 时不构造内部缓存 URL、不创建 miss 合并 Promise/清理闭包、不执行合并状态的清理查询。开启缓存的键、代次完成标记、并发合并及原始下载逻辑保持原有行为。这个改动确定减少无效对象和工作，但预期收益有限，不声称能消除 17 ms 峰值。

最终单轮整进程 CPU 为 12250 ms，对照 baseline-4 为12171.875 ms；阶段耗时15602.04 ms与15787.13 ms也很接近。均属于测量波动，**没有测出显著CPU下降**。保留该改动的理由是消除确定无消费者的准备工作，不能据此做Free兼容性或性能收益承诺。

公开分片仍先检查 D1 first-primary 与强 If-Match，再调用私有入口；源状态、Content-Range、可选 Content-Length、identity encoding、实际字节数、末尾 EOF、额外字节、超时及取消检查均未删改。

## 复现方法

```powershell
pnpm profile:chunk current
# 对已有不可变的本地产物复测，不重新构建：
node scripts/profile-chunk-cpu.ts baseline .local/chunk-cpu/baseline.js
pnpm typecheck
pnpm test
pnpm test:large
```

`profile:chunk` 是本地工具，使用既有测试 harness；不读取 `.env`、线上 manifest 或 Secrets，不会调用 Cloudflare API。启动前记录产物 SHA-256，结束时校验未变化；若测量期间文件变化则不发布报告。原始早期对照报告在加入这项防护前产生，当时未并发重建其产物；后续测量采用前后校验。

## 线上预算决策

最终本地校验：回归34/34；最后清理后分片功能9/9；大文件8/8（浏览器五种大小改用1 MiB/绕缓存，包括完整和中断恢复；旧raw三种大小完整/续传）；严格类型检查、两套dry run、文档链接及空白检查通过。详见[验证日志](verification-log.md)。新增测试没有提供真实原生保存API或新的浏览器兼容性证据。

本轮不使用剩余预算。没有稳定的本地净收益，也没有可以解释旧峰值的线上调用栈，继续完整大文件试验的证据收益不足。新账本仍预扣 765,788,160 / 4,294,967,296 字节，剩余 3,529,179,136 字节；旧账本、旧峰值、旧部署记录全部保留，不退款或重置。

后续若有新的有效信号，应先补齐两类入口的可观测性，再设计最多几十个 1 MiB 独立请求的有限试验，沿用活动构建核对、同一账本预扣、共享进程锁和平台失败即停。未取得 CPU 余量与完整观测前，不重复 100/500/1024 MiB 扩大测试。Workers Free 大文件可靠性仍未通过。

官方依据：[Workers CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/)、[BYOB reader](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreambyobreader/)。官方也指出 Worker 计时器随 I/O 推进，不能以普通时间差替代生产 CPU profile。
