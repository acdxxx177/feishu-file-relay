import { Hono } from 'hono'
import { isIP } from 'node:net'
import type { HttpBindings } from '@hono/node-server'
import { browserScript, browserCss } from '../../.local/browser/assets'
import type { Config } from './config'
import type { RelayRepository } from '../db/repository'
import type { FeishuClient } from './feishu'
import { createDownloadHandlers } from './download'
import { presentPageError, securityHeaders } from '../lib/download-page-response'
import { handleWebhook } from './intake'
import { createScheduler } from './scheduler'
import { DownloadSessions } from './download-sessions'
import { createLocationReader } from './download-location'

export function createApplication(config: Config, repository: RelayRepository, feishu: FeishuClient) {
  const scheduler = createScheduler(config, repository, feishu)
  const sessions = new DownloadSessions({ enabled: config.firstDownloadNotification, origin: config.PUBLIC_BASE_URL,
    repository, wake: () => scheduler.context.wake() })
  const location = createLocationReader(config)
  const downloads = createDownloadHandlers({ repository: {
    getFile: (id) => repository.getDownloadFile(id),
    countDownload: (id) => repository.countDownload(id),
    markUnavailable: (id) => repository.markUnavailable(id),
  }, fetchResource: feishu.fetchResource,
    readTimeoutMs: Number(config.UPSTREAM_READ_TIMEOUT_MS), cacheEnabled: config.cacheEnabled,
    onUnavailable: () => scheduler.context.wake(),
    sessions,
  })
  const app = new Hono<{ Bindings: HttpBindings }>()
  let stopping = false
  let active = 0
  let readiness: Promise<boolean> | undefined
  let readinessUntil = 0
  const clients = new Map<string, { start: number; count: number }>()
  const error = (status: number, retry = '10') => new Response(null, { status, headers: { ...Object.fromEntries(securityHeaders()), 'Retry-After': retry } })
  app.use('*', async (c, next) => {
    if (stopping && c.req.path !== '/health') return presentPageError(c.req.raw, error(503))
    await next()
  })
  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.get('/ready', async (c) => {
    const remote = c.env?.incoming?.socket.remoteAddress
    if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return error(404)
    // 探针合并且失败也短暂缓存，不能让公开探测耗尽撤回所需数据库额度。
    if (!readiness || Date.now() >= readinessUntil) {
      readinessUntil = Date.now() + 15000
      readiness = repository.health().then(() => true, () => false)
    }
    return await readiness ? c.json({ status: 'ready' }, 200, { 'Cache-Control': 'no-store' }) : error(503)
  })
  app.post('/webhook/feishu', (c) => handleWebhook(c.req.raw, config, scheduler.context))
  app.get('/assets/download.js', () => new Response(browserScript, { headers: { ...Object.fromEntries(securityHeaders()), 'Content-Type': 'text/javascript; charset=utf-8' } }))
  app.get('/assets/download.css', () => new Response(browserCss, { headers: { ...Object.fromEntries(securityHeaders()), 'Content-Type': 'text/css; charset=utf-8' } }))
  app.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/f/') && !c.req.path.startsWith('/api/files/')) return next()
    const remote = c.env?.incoming?.socket.remoteAddress ?? 'local'
    // 容器地址可能随网络重建改变；显式开启后按请求头识别访客，不再校验代理 IP。
    const forwarded = config.trustProxy ? c.req.header('X-Real-IP') : undefined
    const ip = forwarded && isIP(forwarded) ? forwarded : remote
    const now = Date.now()
    for (const [key, value] of clients) if (now - value.start >= 60000) clients.delete(key)
    const client = clients.get(ip) ?? { start: now, count: 0 }
    if (!clients.has(ip) && clients.size >= 10000) return presentPageError(c.req.raw, error(429, '60'))
    clients.set(ip, client)
    if (++client.count > config.rateLimit) return presentPageError(c.req.raw, error(429, '60'))
    const streaming = c.req.method === 'GET' && (c.req.path.endsWith('/download') || c.req.path.endsWith('/chunk'))
    if (!streaming) return next()
    if (active >= config.maxDownloads) return error(503)
    active++
    let released = false
    const release = () => {
      if (!released) { released = true; active--; c.req.raw.signal.removeEventListener('abort', release) }
    }
    c.req.raw.signal.addEventListener('abort', release, { once: true })
    try {
      await next()
      const response = c.res
      if (!response.body) { release(); return }
      const reader = response.body.getReader()
      c.res = new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await reader.read()
            if (done) { controller.close(); reader.releaseLock(); release() } else controller.enqueue(value)
          } catch (reason) { controller.error(reason); release() }
        },
        async cancel(reason) { release(); await reader.cancel(reason).catch(() => {}) },
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers })
    } catch (reason) { release(); throw reason }
  })
  app.on(['GET', 'HEAD'], '/f/:id/download', (c) => downloads.raw(c.req.raw, c.req.param('id')))
  app.on(['GET', 'HEAD'], '/f/:id', (c) => c.req.method === 'HEAD' ? downloads.raw(c.req.raw, c.req.param('id')) : downloads.page(c.req.raw, c.req.param('id')))
  app.on(['GET', 'HEAD'], '/api/files/:id/chunk', (c) => downloads.chunk(c.req.raw, c.req.param('id')))
  app.get('/api/files/:id', (c) => downloads.page(c.req.raw, c.req.param('id'), true))
  app.post('/api/files/:id/download-session', (c) => sessions.start(c.req.raw, c.req.param('id')))
  app.post('/api/files/:id/download-complete', (c) => sessions.complete(c.req.raw, c.req.param('id'), location(c.req.raw)))
  app.notFound(() => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } }))
  app.onError((_failure, c) => { console.error(JSON.stringify({ event: 'request_failed' })); return presentPageError(c.req.raw, error(503)) })
  return { app, scheduler, stop() { stopping = true; scheduler.stop() }, get activeDownloads() { return active } }
}
