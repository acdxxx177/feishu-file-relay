import type { FileRecord } from '../types'
import { claimJob, finishJob, queueNotification, retryJob } from '../db/files'
import { getToken, readSmallJson } from './token'
import { feishuFetch } from './transport'

export class UpstreamError extends Error {
  constructor(message: string, public status = 503, public permanent = false) {
    super(message)
    this.name = 'UpstreamError'
  }
}

const invalidTokenCodes = new Set([99991661, 99991663, 99991664, 99991668])

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function authorizedFetch(env: Env, path: string, options: RequestInit, signal?: AbortSignal, resource = false): Promise<Response> {
  let refreshed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw signal.reason
    let response: Response
    try {
      const token = await getToken(env, refreshed)
      if (signal?.aborted) throw signal.reason
      if (signal?.aborted) throw signal.reason
      // 只限制等待响应头的时间，不能用固定短超时截断慢速的大分片。
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(), 8_000)
      try {
        if (resource) console.log(JSON.stringify({ event: 'feishu_resource_request', origin_requests: 1, attempt: attempt + 1 }))
        response = await feishuFetch(env, new URL(path, env.FEISHU_API_BASE), {
          ...options,
          redirect: 'manual',
          signal: controller.signal,
          headers: { ...options.headers, Authorization: `Bearer ${token}` },
        })
      } finally {
        clearTimeout(timer)
        // 客户取消须继续传递到响应流，不能在收到响应头后解除监听。
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (attempt === 2) throw new UpstreamError('Feishu network or token failure')
      await delay(100 * 2 ** attempt + crypto.getRandomValues(new Uint8Array(1))[0], signal)
      continue
    }
    let code: number | undefined
    let jsonResponse: Record<string, unknown> | null = null
    // 附件可以本身就是 JSON；成功的 Range 响应必须逐字节转发，不可当成 API 信封解析。
    if (!(resource && response.status === 206) && (response.headers.get('Content-Type') ?? '').includes('json')) {
      jsonResponse = await readSmallJson(response)
      code = typeof jsonResponse.code === 'number' ? jsonResponse.code : undefined
    }
    if (!refreshed && (response.status === 401 || (code !== undefined && invalidTokenCodes.has(code)))) {
      await response.body?.cancel().catch(() => undefined)
      refreshed = true
      attempt--
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined)
      if (attempt === 2) throw new UpstreamError('Feishu temporary failure')
      await delay(100 * 2 ** attempt + crypto.getRandomValues(new Uint8Array(1))[0], signal)
      continue
    }
    if (!response.ok || (code !== undefined && code !== 0)) {
      await response.body?.cancel().catch(() => undefined)
      // 403 可能是全局权限配置错误，不能据此永久作废全部文件。
      throw new UpstreamError('Feishu resource unavailable', response.status, response.status === 404 || response.status === 410)
    }
    if (jsonResponse) return Response.json(jsonResponse, { status: response.status })
    return response
  }
  throw new UpstreamError('Feishu temporary failure')
}

export function fetchResource(env: Env, file: { message_id: string; file_key: string }, start: number, end: number, signal?: AbortSignal): Promise<Response> {
  const path = `/open-apis/im/v1/messages/${encodeURIComponent(file.message_id)}/resources/${encodeURIComponent(file.file_key)}?type=file`
  return authorizedFetch(env, path, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' } }, signal, true)
}

export async function sendText(env: Env, chatId: string, text: string, uuid: string): Promise<void> {
  const response = await authorizedFetch(env, '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid }),
  })
  await response.body?.cancel()
}

export async function notifyUnavailable(env: Env, file: FileRecord): Promise<void> {
  const id = `unavailable:${file.id}`
  await queueNotification(env.DB, id, file, `文件 ${file.file_name} 的飞书源文件已无法读取，链接已失效。`)
  const job = await claimJob(env.DB, id)
  if (!job) return
  try {
    await sendText(env, job.chat_id, job.argument, await messageUuid(id))
    await finishJob(env.DB, id)
  } catch {
    await retryJob(env.DB, job)
  }
}

export async function messageUuid(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  return Array.from(new Uint8Array(digest).slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join('')
}
