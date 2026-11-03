import { Hono } from 'hono'
import { handleWebhook, runScheduled } from './handlers/feishu'
import { handleDownload } from './handlers/download'
import type { AppEnv } from './types'

export { ChunkEntry } from './cache/chunk-entry'

const app = new Hono<AppEnv>()

app.get('/health', (c) => c.json({ status: 'ok' }))
app.post('/webhook/feishu', (c) => handleWebhook(c.req.raw, c.env, c.executionCtx))
app.on(['GET', 'HEAD'], '/f/:id', async (c) => {
  // Workers 绑定按数据中心近似限流，无需客户身份，也不在日志中保留 IP。
  const ip = c.req.header('cf-connecting-ip')
  if (ip && !(await c.env.DOWNLOAD_LIMITER.limit({ key: ip })).success) {
    return new Response(null, {
      status: 429,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
    })
  }
  return handleDownload(c.req.raw, c.env, c.executionCtx, c.req.param('id'))
})
app.notFound(() => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } }))
app.onError((_error, c) => {
  // 不记录异常原文：上游 SDK 或 fetch 错误可能包含凭证、资源路径。
  console.error(JSON.stringify({ event: 'request_failed' }))
  return new Response(null, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' },
  })
})

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, ctx).catch(() => {
      console.error(JSON.stringify({ event: 'scheduled_failed' }))
    }))
  },
} satisfies ExportedHandler<Env>
