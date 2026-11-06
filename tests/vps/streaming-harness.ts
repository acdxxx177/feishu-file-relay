import { serve } from '@hono/node-server'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { createMock } from '../../mocks/feishu-mock'
import { patternBytesAt } from '../../mocks/file-pattern'
import { createDownloadHandlers } from '../../src/vps/download'
import { safeNodeResponse } from '../../src/vps/node-response'
import type { FileRecord } from '../../src/types'
import { DownloadSessions } from '../../src/vps/download-sessions'
import type { FirstDownloadSnapshot } from '../../src/db/repository'

async function listen(fetchHandler: (request: Request) => Promise<Response>) {
  const server = serve({ fetch: async (request, bindings) => safeNodeResponse(await fetchHandler(request), bindings.outgoing), hostname: '127.0.0.1', port: 0 }) as Server
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

export async function setupStreaming(size: number) {
  const mock = createMock()
  mock.files.set('key', { size })
  const source = await listen(mock.handle)
  const file: FileRecord = { id: 'L'.repeat(22), message_id: 'message', file_key: 'key', file_name: '完整性.zip', file_size: size,
    mime_type: null, uploader_open_id: 'user', chat_id: 'chat', version: 1, status: 'active', fail_reason: null, delete_reason: null,
    attempts: 1, download_count: 0, last_downloaded_at: null, created_at: '2026-11-04 00:00:00', updated_at: '2026-11-04 00:00:00', deleted_at: null,
    first_download_notification: 1 }
  let dbReads = 0
  const notifications: FirstDownloadSnapshot[] = []
  const sessions = new DownloadSessions({ enabled: true, origin: 'https://relay.invalid', wake() {}, repository: {
    async getDownloadFile() { dbReads++; return file },
    async recordFirstDownload(_id, _version, snapshot) { if (!notifications.length) notifications.push(snapshot); return true },
  } })
  const handlers = createDownloadHandlers({ repository: {
    async getFile() { dbReads++; return file }, async countDownload() { file.download_count++ }, async markUnavailable() { file.status = 'unavailable'; return true },
  }, sessions, fetchResource: (_file, start, end, signal) => fetch(`${source.url}/open-apis/im/v1/messages/message/resources/key?type=file`, {
    signal, headers: { Authorization: 'Bearer mock-tenant-access-token', Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
  }) })
  const relay = await listen((request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/download-session')) return sessions.start(request, file.id)
    if (path.endsWith('/download-complete')) return sessions.complete(request, file.id, {})
    return path.endsWith('/chunk') ? handlers.chunk(request, file.id) : handlers.raw(request, file.id)
  })
  return {
    file, mock, notifications, url: relay.url, get dbReads() { return dbReads },
    async close() { for (const server of [relay.server, source.server]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) } },
  }
}

export function expectedDigest(size: number): string {
  const hash = createHash('sha256')
  for (let offset = 0; offset < size; offset += 65536) hash.update(patternBytesAt(offset, Math.min(65536, size - offset)))
  return hash.digest('hex')
}

export async function digest(response: Response) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of response.body!) { hash.update(chunk); bytes += chunk.byteLength }
  return { bytes, sha256: hash.digest('hex') }
}
