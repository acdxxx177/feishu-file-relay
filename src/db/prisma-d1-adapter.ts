import { ColumnTypeEnum, type SqlDriverAdapter, type SqlDriverAdapterFactory, type SqlQuery, type SqlResultSet } from '@prisma/driver-adapter-utils'
import { D1HttpTransport, type SqlValue } from './d1-http'

function parameters(query: SqlQuery): SqlValue[] {
  return query.args.map((value) => {
    if (value === null || typeof value === 'string') return value
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'number') { if (Number.isSafeInteger(value)) return value }
    if (typeof value === 'bigint') { const number = Number(value); if (Number.isSafeInteger(number)) return number }
    throw new Error('Unsupported or unsafe database parameter')
  })
}

/** 官方适配器不暴露 fetch/主库元数据且忽略事务；这里只实现项目所需标量类型。 */
export class RelayPrismaD1Adapter implements SqlDriverAdapterFactory {
  readonly provider = 'sqlite' as const
  readonly adapterName = 'relay-prisma-d1-http'
  constructor(private readonly transport: D1HttpTransport) {}
  async connect(): Promise<SqlDriverAdapter> {
    const queryRaw = async (query: SqlQuery): Promise<SqlResultSet> => {
      const result = await this.transport.query({ sql: query.sql, params: parameters(query) })
      const columnNames = Object.keys(result.results[0] ?? {})
      const rows = result.results.map((row) => columnNames.map((key) => row[key] ?? null))
      const columnTypes = columnNames.map((_name, index) => {
        const sample = rows.find((row) => row[index] !== null)?.[index]
        return typeof sample === 'number' ? ColumnTypeEnum.UnknownNumber : ColumnTypeEnum.Text
      })
      return { columnNames, columnTypes, rows }
    }
    return {
      provider: this.provider, adapterName: this.adapterName,
      queryRaw,
      executeRaw: async (query) => (await this.transport.query({ sql: query.sql, params: parameters(query) })).meta.changes,
      executeScript: async () => { throw new Error('Schema scripts require explicit reviewed D1 migrations') },
      startTransaction: async () => { throw new Error('D1 transactions must use repository atomic batch') },
      dispose: async () => {},
    }
  }
}
