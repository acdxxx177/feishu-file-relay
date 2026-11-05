import { renderDownloadPage } from '../browser/page'

export function securityHeaders(): Headers {
  return new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' })
}

export function downloadPageResponse(request: Request, file: { name: string; size: number } | null, status = 200, retryAfter: string | null = null): Response {
  const headers = securityHeaders()
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  headers.set('X-Frame-Options', 'DENY')
  if (retryAfter !== null) headers.set('Retry-After', retryAfter)
  return new Response(request.method === 'HEAD' ? null : renderDownloadPage(file, status, request), { status, headers })
}

// 限流和停机可在路由前返回。仅为下载页 GET 替换正文，原始文件、HEAD 和 API 保留各自的 HTTP 合同。
export function presentPageError(request: Request, response: Response): Response {
  if (request.method !== 'GET' || !/^\/f\/[^/]+$/.test(new URL(request.url).pathname)) return response
  return downloadPageResponse(request, null, response.status, response.headers.get('Retry-After'))
}
