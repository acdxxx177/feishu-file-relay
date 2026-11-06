import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createRemoteRepository } from '../../src/db/prisma-repository'

export function databaseFixture() {
  const db = new DatabaseSync(':memory:')
  const directory = new URL('../../migrations/', import.meta.url)
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'))
  }
  let calls = 0
  let primary = true
  let loseReply = false
  const mockFetch: typeof fetch = async (_input, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    const statements = body.batch ?? [body]
    const results: unknown[] = []
    db.exec('BEGIN')
    try {
      for (const query of statements) {
        const sql = db.prepare(query.sql)
        const params = query.params ?? []
        const rows = sql.columns().length ? sql.all(...params) : (sql.run(...params), [])
        const changes = (db.prepare('SELECT changes() AS count').get() as { count: number }).count
        results.push({ success: true, results: rows, meta: { changes, served_by_primary: primary } })
      }
      db.exec('COMMIT')
      if (loseReply) throw new Error('Connection dropped after commit')
      return Response.json({ success: true, result: results })
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      if (loseReply) throw error
      return Response.json({ success: false, errors: [{ code: 1 }], result: [] })
    }
  }
  const options = { accountId: 'test', databaseId: 'test', token: 'fake', fetch: mockFetch, budget: 10000 }
  return { db, options, repository: createRemoteRepository(options), calls: () => calls, setPrimary: (value: boolean) => { primary = value }, loseReply: (value = true) => { loseReply = value } }
}


