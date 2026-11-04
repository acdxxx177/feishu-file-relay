import type { SourceFile } from '../types'

export const CHUNK_SIZE = 16 * 1024 * 1024
export type ResourceFetcher = (file: SourceFile, start: number, end: number, signal: AbortSignal) => Promise<Response>

export class SourceError extends Error {
  constructor(public permanent = false) { super('Source transfer failed') }
}

interface CacheEntry { key: string; blocks: Uint8Array[]; length: number; expires: number; readers: number; retired: boolean }

/** 私有进程内服务：调用方必须先查数据库，缓存绝不授予下载权限。 */
export class ChunkService {
  private cache = new Map<string, CacheEntry>()
  private reservations = new Set<string>()
  private used = 0
  constructor(private fetchResource: ResourceFetcher, private options: { cacheEnabled?: boolean; readTimeoutMs?: number; maxCacheBytes?: number; cacheTtlMs?: number } = {}) {}

  private evict(id: string): void {
    const entry = this.cache.get(id)
    if (entry) {
      entry.retired = true
      // 已淘汰对象可能仍被慢速命中请求读取；最后一个读者释放后才能回收预算。
      if (entry.readers === 0) this.used -= entry.length
      this.cache.delete(id)
    }
  }

  async open(file: SourceFile, start: number, end: number, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; hit: boolean }> {
    if (signal.aborted) throw signal.reason
    const length = end - start + 1
    if (start < 0 || end >= file.file_size || length <= 0 || length > CHUNK_SIZE) throw new SourceError()
    const key = `${file.version}:${start}:${end}`
    for (const [id, entry] of this.cache) if (entry.expires <= Date.now()) this.evict(id)
    const cached = this.cache.get(file.id)
    if (this.options.cacheEnabled && cached?.key === key) {
      let index = 0
      let released = false
      let abortHit: () => void
      cached.readers++
      const release = () => {
        if (released) return
        released = true
        signal.removeEventListener('abort', abortHit)
        cached.readers--
        if (cached.retired && cached.readers === 0) this.used -= cached.length
      }
      return { hit: true, body: new ReadableStream<Uint8Array>({
        start(controller) {
          abortHit = () => { release(); controller.error(signal.reason) }
          signal.addEventListener('abort', abortHit, { once: true })
        },
        pull(controller) {
          const block = cached.blocks[index++]
          if (block) controller.enqueue(block.slice())
          else { release(); controller.close() }
        },
        cancel() { release() },
      }, { highWaterMark: 0 }) }
    }
    const abort = new AbortController()
    const onAbort = () => abort.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    let response: Response
    try {
      response = await this.fetchResource(file, start, end, abort.signal)
      if (abort.signal.aborted) throw abort.signal.reason
      if (response.status === 404 || response.status === 410) { void response.body?.cancel().catch(() => {}); throw new SourceError(true) }
      const encoding = response.headers.get('Content-Encoding')
      if (response.status !== 206 || !response.body || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${file.file_size}` ||
        (response.headers.has('Content-Length') && response.headers.get('Content-Length') !== String(length)) || (encoding && encoding !== 'identity')) {
        void response.body?.cancel().catch(() => {})
        throw new SourceError()
      }
    } catch (error) {
      abort.abort(); signal.removeEventListener('abort', onAbort)
      throw error
    }
    // 预留缓存预算包含写入中的分片，防止并发下载绕过内存上限。
    let reserved = false
    if (this.options.cacheEnabled && file.file_size > CHUNK_SIZE && !this.reservations.has(file.id)) {
      this.evict(file.id)
      const max = this.options.maxCacheBytes ?? 64 * 1024 * 1024
      if (length <= max) {
        for (const id of this.cache.keys()) { if (this.used + length <= max) break; this.evict(id) }
        if (this.used + length <= max) { this.used += length; reserved = true; this.reservations.add(file.id) }
      }
    }
    const blocks: Uint8Array[] = []
    const reader = response.body!.getReader()
    let count = 0
    let tail: Uint8Array | undefined
    let ended = false
    let cleaned = false
    const cleanup = (success = false) => {
      if (cleaned) return
      cleaned = true
      signal.removeEventListener('abort', onAbort)
      if (reserved) {
        this.reservations.delete(file.id)
        if (success) this.cache.set(file.id, { key, blocks, length, expires: Date.now() + (this.options.cacheTtlMs ?? 300_000), readers: 0, retired: false })
        else this.used -= length
        reserved = false
      }
      if (!success) { abort.abort(); void reader.cancel().catch(() => {}) }
    }
    const read = async () => {
      if (abort.signal.aborted) throw abort.signal.reason
      let timer: ReturnType<typeof setTimeout> | undefined
      let cancel: (() => void) | undefined
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            cancel = () => reject(abort.signal.reason ?? new SourceError())
            abort.signal.addEventListener('abort', cancel, { once: true })
            timer = setTimeout(() => { abort.abort(new SourceError()) }, this.options.readTimeoutMs ?? 30_000)
          }),
        ])
      } finally { clearTimeout(timer); if (cancel) abort.signal.removeEventListener('abort', cancel) }
    }
    return { hit: false, body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (ended) { controller.close(); cleanup(true); reader.releaseLock(); return }
          while (true) {
            const next = await read()
            if (next.done) {
              if (count !== length) throw new SourceError()
              ended = true
              if (tail) { controller.enqueue(tail); tail = undefined }
              else { controller.close(); cleanup(true); reader.releaseLock() }
              return
            }
            if (!next.value.byteLength) continue
            count += next.value.byteLength
            if (count > length) throw new SourceError()
            if (reserved) blocks.push(next.value.slice())
            // 保留最后一段直到 EOF，超长或截断都不能看起来像成功下载。
            const previous = tail
            tail = next.value
            if (previous) { controller.enqueue(previous); return }
          }
        } catch (error) { cleanup(); controller.error(error) }
      },
      cancel() { cleanup() },
    }, { highWaterMark: 0 }) }
  }
}
