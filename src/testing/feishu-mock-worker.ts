import { patternStream } from '../../mocks/file-pattern'

interface MockFile {
  message_id: string
  file_key: string
  file_size: number
  mode: 'ok' | 'missing' | 'throttle' | 'forbidden' | 'bad-range' | 'truncate' | 'slow-headers'
  header_delay_ms: number
}

const accessToken = 'online-mock-tenant-access-token'

async function secretEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

async function smallJson(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length')) > 32768) throw new Error('Body too large')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 32768) throw new Error('Body too large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const all = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength }
  const result: unknown = JSON.parse(new TextDecoder().decode(all))
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid object')
  return result as Record<string, unknown>
}

async function recordRequest(env: Env, request: Request, messageId: string, status: number): Promise<number> {
  const result = await env.DB.prepare('INSERT INTO mock_requests(message_id,range_header,status,colo) VALUES(?,?,?,?)')
    .bind(messageId, request.headers.get('Range'), status, request.cf?.colo ?? null).run()
  return result.meta.last_row_id
}

function updateRequest(env: Env, ctx: ExecutionContext, id: number, bytes: number, outcome: string): void {
  ctx.waitUntil(env.DB.prepare('UPDATE mock_requests SET bytes=?,outcome=? WHERE id=?').bind(bytes, outcome, id).run().then(() => undefined))
}

async function delayHeaders(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function resource(request: Request, env: Env, ctx: ExecutionContext, messageId: string, fileKey: string): Promise<Response> {
  const file = await env.DB.prepare('SELECT * FROM mock_files WHERE message_id=? AND file_key=?').bind(messageId, fileKey).first<MockFile>()
  let status = !file || file.mode === 'missing' ? 404 : file.mode === 'throttle' ? 429 : file.mode === 'forbidden' ? 403 : 206
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range') ?? '')
  const start = range ? Number(range[1]) : NaN
  const end = file && range ? Math.min(Number(range[2]), file.file_size - 1) : NaN
  if (status === 206 && (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end)) status = 416
  const id = await recordRequest(env, request, messageId, status)
  if (status !== 206 || !file) {
    updateRequest(env, ctx, id, 0, 'rejected')
    return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '1' } : {}) } })
  }
  try {
    if (file.mode === 'slow-headers') await delayHeaders(file.header_delay_ms || 2000, request.signal)
  } catch {
    updateRequest(env, ctx, id, 0, 'cancelled-before-headers')
    return new Response(null, { status: 503 })
  }
  const length = end - start + 1
  let produced = 0
  const source = patternStream(start, file.mode === 'truncate' ? Math.max(0, length - 1) : length, (bytes) => { produced += bytes })
  const fixed = new FixedLengthStream(length)
  // 不缓冲整个分片，且不把待发送正文或凭证写入测试数据库。
  ctx.waitUntil(source.pipeTo(fixed.writable).then(
    () => updateRequest(env, ctx, id, produced, 'completed'),
    () => updateRequest(env, ctx, id, produced, request.signal.aborted ? 'cancelled' : 'interrupted'),
  ))
  return new Response(fixed.readable, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(length),
      'Content-Range': `bytes ${file.mode === 'bad-range' ? start + 1 : start}-${end}/${file.file_size}`,
      'Cache-Control': 'no-store',
    },
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'POST' && url.origin === 'https://mock-accounts.invalid' && url.pathname === '/oauth/v3/token') {
        const body = await smallJson(request)
        if (body.grant_type !== 'client_credentials' || typeof body.client_id !== 'string' || typeof body.client_secret !== 'string' || !await secretEqual(body.client_id, env.FEISHU_APP_ID) || !await secretEqual(body.client_secret, env.FEISHU_APP_SECRET)) {
          return Response.json({ error: 'invalid_client' }, { status: 401 })
        }
        return Response.json({ access_token: accessToken, expires_in: 7200, token_type: 'Bearer' })
      }
      if (url.origin !== 'https://mock-feishu.invalid') return new Response(null, { status: 404 })
      if (request.headers.get('Authorization') !== `Bearer ${accessToken}`) return Response.json({ code: 99991663 }, { status: 401 })
      const match = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/.exec(url.pathname)
      if (request.method === 'GET' && match && url.searchParams.get('type') === 'file') return resource(request, env, ctx, decodeURIComponent(match[1]), decodeURIComponent(match[2]))
      if (request.method === 'POST' && url.pathname === '/open-apis/im/v1/messages' && url.searchParams.get('receive_id_type') === 'chat_id') {
        const body = await smallJson(request)
        if (body.msg_type !== 'text' || typeof body.uuid !== 'string' || !/^[a-f0-9]{32}$/.test(body.uuid) || typeof body.content !== 'string' || typeof body.receive_id !== 'string') return Response.json({ code: 1 }, { status: 400 })
        const content: unknown = JSON.parse(body.content)
        if (!content || typeof content !== 'object' || !('text' in content) || typeof content.text !== 'string') return Response.json({ code: 1 }, { status: 400 })
        await env.DB.prepare('INSERT OR IGNORE INTO mock_replies(uuid,receive_id,content) VALUES(?,?,?)').bind(body.uuid, body.receive_id, body.content).run()
        return Response.json({ code: 0, data: { message_id: `mock-reply-${body.uuid}` } })
      }
      return new Response(null, { status: 404 })
    } catch {
      // 线上模拟服务也不输出请求原文，避免调试日志意外包含测试签名材料。
      return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
  },
} satisfies ExportedHandler<Env>
