import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Config } from './config'
import type { SourceFile } from '../types'

export class UpstreamError extends Error {
  constructor(message: string, public status = 503, public permanent = false) { super(message) }
}

export async function readSmallText(response: Response, maxBytes = 65536): Promise<string> {
  if (!response.body) throw new Error('Missing body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > maxBytes) throw new Error('Body too large')
      chunks.push(value)
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks))
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
}

export interface FeishuClient {
  fetchResource(file: Pick<SourceFile, 'message_id' | 'file_key'>, start: number, end: number, signal?: AbortSignal): Promise<Response>
  sendText(chatId: string, text: string, uuid: string, signal?: AbortSignal): Promise<void>
  close(): void
}

export function messageUuid(id: string): string { return createHash('sha256').update(id).digest('hex').slice(0, 32) }

export function createFeishuClient(config: Config, transport: typeof fetch = fetch): FeishuClient {
  let token: { value: string; refreshAt: number } | undefined
  let refreshing: Promise<string> | undefined
  const shutdown = new AbortController()
  const invalidTokenCodes = new Set([99991661, 99991663, 99991664, 99991668])
  async function getToken(force = false): Promise<string> {
    if (force) token = undefined
    if (token && token.refreshAt > Date.now()) return token.value
    if (refreshing) return refreshing
    refreshing = (async () => {
      const response = await transport(new URL('/oauth/v3/token', config.FEISHU_ACCOUNTS_BASE), {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', client_id: config.FEISHU_APP_ID, client_secret: config.FEISHU_APP_SECRET }),
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(8000)]),
      })
      const data = JSON.parse(await readSmallText(response))
      if (!response.ok || typeof data?.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new UpstreamError('Token unavailable')
      const lifetime = data.expires_in * 1000
      token = { value: data.access_token, refreshAt: Date.now() + Math.max(1000, lifetime - Math.min(300000, lifetime / 2)) }
      return token.value
    })()
    try { return await refreshing } finally { refreshing = undefined }
  }
  async function authorized(path: string, init: RequestInit, inputSignal?: AbortSignal, resource = false): Promise<Response> {
    const signal = AbortSignal.any([shutdown.signal, ...(inputSignal ? [inputSignal] : [])])
    let refreshed = false
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      const accessToken = await getToken()
      signal.throwIfAborted()
      const headerDeadline = new AbortController()
      const timer = setTimeout(() => headerDeadline.abort(), 8000)
      let response: Response
      try {
        if (resource) console.log(JSON.stringify({ event: 'feishu_resource_request', origin_requests: 1, attempt: attempt + 1 }))
        response = await transport(new URL(path, config.FEISHU_API_BASE), {
          ...init, redirect: 'manual', signal: AbortSignal.any([signal, headerDeadline.signal]),
          headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
        })
      } catch {
        signal.throwIfAborted()
        if (attempt === 2) throw new UpstreamError('Network failure')
        await delay(100 * 2 ** attempt, undefined, { signal })
        continue
      } finally { clearTimeout(timer) }
      let data: Record<string, unknown> | undefined
      if (!(resource && response.status === 206) && response.headers.get('Content-Type')?.includes('json')) {
        // 错误响应同样需要期限，防止仅返回头部的源站长期占用任务租约。
        const bodyTimer = setTimeout(() => headerDeadline.abort(), 8000)
        try { data = JSON.parse(await readSmallText(response)) } finally { clearTimeout(bodyTimer) }
      }
      const code = typeof data?.code === 'number' ? data.code : undefined
      if (!refreshed && (response.status === 401 || (code !== undefined && invalidTokenCodes.has(code)))) {
        void response.body?.cancel().catch(() => {})
        // 只有仍为失败请求使用的旧 Token 时才强刷，避免并发失效反复刷新。
        await getToken(token?.value === accessToken)
        refreshed = true
        attempt--
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        void response.body?.cancel().catch(() => {})
        if (attempt === 2) throw new UpstreamError('Temporary source failure')
        const retry = Number(response.headers.get('Retry-After'))
        await delay(Math.min(5000, Math.max(100 * 2 ** attempt, Number.isFinite(retry) ? retry * 1000 : 0)), undefined, { signal })
        continue
      }
      if (!response.ok || (code !== undefined && code !== 0)) {
        void response.body?.cancel().catch(() => {})
        throw new UpstreamError('Resource unavailable', response.status, response.status === 404 || response.status === 410)
      }
      return data ? Response.json(data, { status: response.status }) : response
    }
    throw new UpstreamError('Temporary source failure')
  }
  return {
    fetchResource(file, start, end, signal) {
      return authorized(`/open-apis/im/v1/messages/${encodeURIComponent(file.message_id)}/resources/${encodeURIComponent(file.file_key)}?type=file`, {
        headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
      }, signal, true)
    },
    async sendText(chatId, text, uuid, signal) {
      const response = await authorized('/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid }),
      }, signal)
      await response.body?.cancel()
    },
    close() { shutdown.abort(); token = undefined },
  }
}
