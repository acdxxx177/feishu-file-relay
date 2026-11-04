import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { D1HttpTransport } from '../src/db/d1-http'

const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('files','recalled_messages','processed_events','bot_jobs','idx_files_status_created','idx_files_uploader','idx_jobs_due') ORDER BY type,name"
const local = new DatabaseSync(':memory:')
local.exec(await readFile('migrations/0001_init.sql', 'utf8'))
const expected = local.prepare(sql).all()
let actual: Record<string, unknown>[] = expected
if (process.argv.includes('--remote')) {
  const transport = new D1HttpTransport({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '', databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '', token: process.env.CLOUDFLARE_D1_TOKEN ?? '' })
  actual = (await transport.query({ sql })).results
}
const normalize = (rows: Record<string, unknown>[]) => JSON.stringify(rows.map((row) => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: String(row.sql).replace(/\s+/g, ' ').trim().replace(/;$/, '') })))
local.close()
if (normalize(actual) !== normalize(expected)) throw new Error('Schema differs from baseline; inspect manually before migrations')
console.log(JSON.stringify({ schema: 'baseline-matches', target: process.argv.includes('--remote') ? 'remote-read-only' : 'local-reference-only', recordsModified: false }))
