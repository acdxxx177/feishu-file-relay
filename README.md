# 飞书文件中转服务

基于 pnpm、TypeScript、Hono 和 Cloudflare Workers 的最小开发环境。当前仅提供健康检查，对应 PRD §5.1、§7、§10；飞书、D1、缓存与文件下载尚未实现。

## 本地启动

需要 Node.js 24 或更高版本及 pnpm 11.24.0。

```powershell
pnpm install --frozen-lockfile
# 仅首次执行；已有 .dev.vars 时请保留原文件。
Copy-Item .dev.vars.example .dev.vars
pnpm dev
```

访问 `http://127.0.0.1:8787/health`，应返回 HTTP `200`、`application/json`，正文为：

```json
{"status":"ok"}
```

未知路径返回 `404`。按 `Ctrl+C` 停止服务。本地开发无需 Cloudflare 登录或远程资源。

若当前 npm 镜像尚未同步锁定版本，可使用 `pnpm install --frozen-lockfile --registry=https://registry.npmjs.org/`，无需修改全局配置。项目的 `pnpm-workspace.yaml` 仅允许 `esbuild`、`workerd` 执行必要的安装脚本，并记录本次安装所需的具体版本发布时间例外。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 在本机 Workers 运行时启动服务 |
| `pnpm cf-typegen` | 根据 Wrangler 配置生成平台类型 |
| `pnpm typecheck` | 生成类型并执行严格 TypeScript 检查 |
| `pnpm build` | 仅 dry run 打包到 `dist/`，不上传 |
| `pnpm exec hono request -P /health -J` | 使用 Hono CLI 检查健康响应 |
| `pnpm deploy` | 类型检查后部署；仅在另行授权并完成 Cloudflare 配置后手动执行 |

入口为 `src/index.ts`，Worker 配置为 `wrangler.jsonc`。平台类型由 `wrangler types` 生成，不手工维护，也不提交到 Git。

`.dev.vars.example` 只包含说明，健康检查无需配置。`.dev.vars` 与已有 `.env` 均被 Git 忽略；Wrangler 存在 `.dev.vars` 时不会加载 `.env`。现有 `.env.example` 用于后续 M1 验证，本阶段不使用。

参考：[Hono Workers 指南](https://hono.dev/docs/getting-started/cloudflare-workers)、[Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/)、[本地环境变量](https://developers.cloudflare.com/workers/local-development/environment-variables/)。
