import { AsyncLocalStorage } from 'node:async_hooks'

export type SqlValue = string | number | null
export interface Statement { sql: string; params?: SqlValue[] }
export interface QueryResult {
  results: Record<string, unknown>[]
  meta: { changes: number; served_by_primary: boolean }
  success: boolean
}
export interface D1HttpOptions {
  accountId: string
  databaseId: string
  token: string
  budget?: number
  reserve?: number
  timeoutMs?: number
  fetch?: typeof fetch
  /** 只供隔离测试；生产必须使用固定 Cloudflare API。 */
  endpoint?: string
  now?: () => number
}

export class DatabaseUnavailable extends Error {
  constructor(public readonly reason: string) { super('Metadata database unavailable'); this.name = 'DatabaseUnavailable' }
}

export class D1HttpTransport {
  private readonly priority = new AsyncLocalStorage<'download' | 'control'>()
  private readonly requests: number[] = []
  private readonly now: () => number
  private readonly endpoint: string
  constructor(private readonly options: D1HttpOptions) {
    if (!options.token || !options.accountId || !options.databaseId) throw new Error('Missing D1 configuration')
    this.now = options.now ?? Date.now
    this.endpoint = options.endpoint ?? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/query`
    const budget = options.budget ?? 900
    const reserve = options.reserve ?? Math.min(100, Math.floor(budget / 5))
    if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(reserve) || reserve < 0 || reserve >= budget) throw new Error('Invalid D1 request budget')
  }

  download<T>(operation: () => Promise<T>): Promise<T> { return this.priority.run('download', operation) }

  private admit(): void {
    const now = this.now()
    while (this.requests.length && this.requests[0] <= now - 300_000) this.requests.shift()
    const budget = this.options.budget ?? 900
    const reserve = this.options.reserve ?? Math.min(100, Math.floor(budget / 5))
    if (this.requests.length >= budget - (this.priority.getStore() === 'download' ? reserve : 0)) throw new DatabaseUnavailable('budget')
    this.requests.push(now)
  }

  async query(statement: Statement): Promise<QueryResult> { return (await this.execute([statement], false))[0] }
  async batch(statements: Statement[]): Promise<QueryResult[]> { return this.execute(statements, true) }

  private async execute(statements: Statement[], batch: boolean): Promise<QueryResult[]> {
    if (!statements.length) throw new Error('Empty database batch')
    for (const statement of statements) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement.sql)) throw new Error('Interactive transactions are unsupported')
      if ((statement.params?.length ?? 0) > 100) throw new Error('Too many query parameters')
      for (const value of statement.params ?? []) if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe database number')
    }
    this.admit()
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch ? { batch: statements } : statements[0]),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      })
      if (!response.ok) { await response.body?.cancel(); throw new DatabaseUnavailable(response.status === 429 ? 'rate_limit' : 'http') }
      // 元数据响应也设体积上限，异常 HTML/代理错误不得进入日志。
      const reader = response.body?.getReader()
      if (!reader) throw new DatabaseUnavailable('body')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 4 * 1024 * 1024) throw new DatabaseUnavailable('response_limit')
          chunks.push(next.value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { success?: boolean; result?: QueryResult[] }
      if (body.success !== true || !Array.isArray(body.result) || body.result.length !== statements.length) throw new DatabaseUnavailable('result')
      for (const result of body.result) {
        if (result.success !== true || !Array.isArray(result.results) || !Number.isSafeInteger(result.meta?.changes)) throw new DatabaseUnavailable('statement')
        // REST 没有 Sessions API；未证明读主库时绝不能批准文件下载。
        if (result.meta.served_by_primary !== true) throw new DatabaseUnavailable('not_primary')
        for (const row of result.results) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new DatabaseUnavailable('row')
          for (const value of Object.values(row)) {
            if (value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new DatabaseUnavailable('scalar')
          }
        }
      }
      return body.result
    } catch (error) {
      if (error instanceof DatabaseUnavailable) throw error
      // 写请求可能已提交，禁止在传输层自动重试；业务根据去重键及租约恢复。
      throw new DatabaseUnavailable('transport_or_unknown_commit')
    }
  }
}
