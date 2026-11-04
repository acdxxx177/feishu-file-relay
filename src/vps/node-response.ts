import type { ServerResponse } from 'node:http'
import type { Http2ServerResponse } from 'node:http2'

/** 适配器会尝试追加错误正文；二进制流失败必须先断开，不能补齐 Content-Length。 */
export function safeNodeResponse(response: Response, outgoing: ServerResponse | Http2ServerResponse): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) { controller.close(); reader.releaseLock() } else controller.enqueue(result.value)
      } catch {
        outgoing.destroy()
        controller.error(new Error('Response stream interrupted'))
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
  }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers })
}
