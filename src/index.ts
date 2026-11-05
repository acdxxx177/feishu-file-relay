import { Hono } from 'hono'
import { handleWebhook, runScheduled } from './handlers/feishu'
import { handleDownload } from './handlers/download'
import { handleFilePage, handleBrowserChunk } from './handlers/browser-download'
import { presentPageError, securityHeaders } from './lib/download-page-response'
import { browserScript, browserCss } from '../.local/browser/assets'
import type { AppEnv } from './worker-types'

export { ChunkEntry } from './cache/chunk-entry'

const app = new Hono<AppEnv>()

app.get('/health', (c) => c.json({ status: 'ok' }))
app.post('/webhook/feishu', (c) => handleWebhook(c.req.raw, c.env, c.executionCtx))
app.get('/assets/download.js', () => new Response(browserScript, { headers: { ...Object.fromEntries(securityHeaders()), 'Content-Type': 'text/javascript; charset=utf-8' } }))
app.get('/assets/download.css', () => new Response(browserCss, { headers: { ...Object.fromEntries(securityHeaders()), 'Content-Type': 'text/css; charset=utf-8' } }))
app.use('/f/*', async (c, next) => {
  // Workers 绑定按数据中心近似限流，无需客户身份，也不在日志中保留 IP。
  const ip = c.req.header('cf-connecting-ip')
  if (ip && !(await c.env.DOWNLOAD_LIMITER.limit({ key: ip })).success) {
    return presentPageError(c.req.raw, new Response(null, {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
    }))
  }
  await next()
})
app.use('/api/files/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip')
  if (ip && !(await c.env.DOWNLOAD_LIMITER.limit({ key: ip })).success) return new Response(null, { status: 429, headers: { ...Object.fromEntries(securityHeaders()), 'Retry-After': '60' } })
  await next()
})
app.on(['GET', 'HEAD'], '/f/:id/download', (c) => handleDownload(c.req.raw, c.env, c.executionCtx, c.req.param('id')))
app.on(['GET', 'HEAD'], '/f/:id', (c) => c.req.method === 'HEAD' ? handleDownload(c.req.raw, c.env, c.executionCtx, c.req.param('id')) : handleFilePage(c.req.raw, c.env, c.req.param('id')))
app.on(['GET', 'HEAD'], '/api/files/:id/chunk', (c) => handleBrowserChunk(c.req.raw, c.env, c.executionCtx, c.req.param('id')))
app.get('/api/files/:id', (c) => handleFilePage(c.req.raw, c.env, c.req.param('id'), true))
app.notFound(() => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } }))
app.onError((_error, c) => {
  // 不记录异常原文：上游 SDK 或 fetch 错误可能包含凭证、资源路径。
  console.error(JSON.stringify({ event: 'request_failed' }))
  return presentPageError(c.req.raw, new Response(null, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' },
  }))
})

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, ctx).catch(() => {
      console.error(JSON.stringify({ event: 'scheduled_failed' }))
    }))
  },
} satisfies ExportedHandler<Env>
