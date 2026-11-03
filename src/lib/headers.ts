import type { FileRecord } from '../types'

export function publicError(status: number, head = false, extra?: HeadersInit): Response {
  const headers = new Headers(extra)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  headers.set('Referrer-Policy', 'no-referrer')
  if (status === 503) headers.set('Retry-After', '10')
  return new Response(head ? null : ({ 404: 'Not found', 410: 'Gone', 416: 'Range not satisfiable', 503: 'Service unavailable' }[status] ?? 'Request failed'), { status, headers })
}

export function fileHeaders(file: FileRecord): Headers {
  // JSON 可携带孤立代理项；先经 UTF-8 修复，避免 encodeURIComponent 拒绝整个下载。
  const name = new TextDecoder().decode(new TextEncoder().encode(file.file_name)).replace(/[\u0000-\u001f\u007f/\\]/g, '_') || 'download'
  const ascii = name.replace(/[^\x20-\x7e]|["\\;]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  const createdAt = file.created_at.replace(' ', 'T')
  return new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'Accept-Ranges': 'bytes',
    'ETag': `"${file.id}-v${file.version}"`,
    'Last-Modified': new Date(/[Zz]|[+-]\d\d:\d\d$/.test(createdAt) ? createdAt : `${createdAt}Z`).toUTCString(),
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  })
}
