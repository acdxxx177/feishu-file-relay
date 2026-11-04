import { randomUUID } from 'node:crypto'
import { D1HttpTransport, type Statement } from '../src/db/d1-http'

/**
 * 远程契约验收只允许操作者显式选择隔离 D1；不读取 .env、不创建云资源。
 * 设置 D1_TEST_ACCOUNT_ID、D1_TEST_DATABASE_ID、D1_TEST_API_TOKEN，
 * 并令 ALLOW_ISOLATED_D1_WRITES 精确等于 D1_TEST_DATABASE_ID，然后执行：
 *   pnpm test:d1:remote
 * 使用随机前缀临时表，不碰业务表；仅删除本次明确创建成功的临时表。
 * 网络结果不明时保留可能已创建的表，报告前缀供人工检查，不猜测所有权。
 * 本脚本证明远程 SQL/REST 契约，不证明真实飞书兼容性或生产配额容量。
 */

const productionDatabase = '796792c4-75d6-4934-8bbc-3ea04e4263d0'
const help = 'Set D1_TEST_ACCOUNT_ID, D1_TEST_DATABASE_ID, D1_TEST_API_TOKEN and ALLOW_ISOLATED_D1_WRITES=<same isolated database ID>; then run pnpm test:d1:remote. Never use production credentials.'

function requireIsolatedConfiguration() {
  const accountId = process.env.D1_TEST_ACCOUNT_ID?.trim() ?? ''
  const databaseId = process.env.D1_TEST_DATABASE_ID?.trim().toLowerCase() ?? ''
  const token = process.env.D1_TEST_API_TOKEN?.trim() ?? ''
  const confirmation = process.env.ALLOW_ISOLATED_D1_WRITES?.trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId) || !token || token.startsWith('replace-')) throw new Error('missing_test_configuration')
  if (databaseId === productionDatabase || databaseId === process.env.CLOUDFLARE_DATABASE_ID?.trim().toLowerCase()) throw new Error('production_or_application_database_rejected')
  if (confirmation !== databaseId) throw new Error('explicit_isolated_write_confirmation_required')
  return { accountId, databaseId, token }
}

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) { console.log(help); return }
  let configuration: ReturnType<typeof requireIsolatedConfiguration>
  try { configuration = requireIsolatedConfiguration() }
  catch (error) {
    console.error(JSON.stringify({ event: 'd1_contract_blocked', reason: error instanceof Error ? error.message : 'configuration', help }))
    process.exitCode = 2
    return
  }
  const db = new D1HttpTransport({ ...configuration, budget: 200, reserve: 0, timeoutMs: 15_000 })
  const prefix = `relay_contract_${randomUUID().replaceAll('-', '')}`
  const names = { files: `${prefix}_files`, recalls: `${prefix}_recalls`, events: `${prefix}_events`, jobs: `${prefix}_jobs` }
  const quote = (name: string) => {
    check(/^relay_contract_[a-f0-9]{32}_(files|recalls|events|jobs)$/.test(name), 'unsafe_scratch_identifier')
    return `"${name}"`
  }
  const files = quote(names.files), recalls = quote(names.recalls), events = quote(names.events), jobs = quote(names.jobs)
  const owned = new Set<string>()
  let creationStarted = false
  let phase = 'primary_preflight'
  let failed = false
  let checks = 0
  const statement = (sql: string, ...params: (string | number | null)[]): Statement => ({ sql, params })
  const rows = async (sql: string, ...params: (string | number | null)[]) => (await db.query(statement(sql, ...params))).results
  const passed = (name: string) => { checks++; console.log(JSON.stringify({ event: 'd1_contract_pass', check: name })) }

  const register = (eventId: string, messageId: string, id: string) => db.batch([
    statement(`INSERT INTO ${files}(id,message_id,file_name) SELECT ?,?,'附件.zip'
      WHERE NOT EXISTS(SELECT 1 FROM ${recalls} WHERE message_id=?)
      AND NOT EXISTS(SELECT 1 FROM ${events} WHERE event_id=?) ON CONFLICT(message_id) DO NOTHING`, id, messageId, messageId, eventId),
    statement(`INSERT OR IGNORE INTO ${events}(event_id) VALUES(?)`, eventId),
  ])
  const recall = (eventId: string, messageId: string) => db.batch([
    statement(`INSERT OR IGNORE INTO ${recalls}(message_id) SELECT ? WHERE NOT EXISTS(SELECT 1 FROM ${events} WHERE event_id=?)`, messageId, eventId),
    statement(`UPDATE ${files} SET status='deleted' WHERE message_id=? AND status!='deleted'
      AND NOT EXISTS(SELECT 1 FROM ${events} WHERE event_id=?)`, messageId, eventId),
    statement(`INSERT OR IGNORE INTO ${events}(event_id) VALUES(?)`, eventId),
  ])
  const activate = (id: string) => db.batch([
    statement(`UPDATE ${files} SET status='active',file_size=100 WHERE id=? AND status='pending'`, id),
    statement(`INSERT OR IGNORE INTO ${jobs}(id,file_id) SELECT ?,? WHERE changes()>0`, `active:${id}`, id),
  ])

  try {
    let emptyRejected = false
    try { await db.batch([]) } catch { emptyRejected = true }
    check(emptyRejected, 'empty_batch_not_rejected')
    passed('empty_batch_rejected_before_io')
    const before = await rows("SELECT name FROM sqlite_master WHERE type='table'")
    const existing = new Set(before.map((row) => String(row.name)))
    check(Object.values(names).every((name) => !existing.has(name)), 'scratch_collision')
    passed('authoritative_primary_response')
    phase = 'create_owned_scratch_tables'
    creationStarted = true
    await db.batch([
      statement(`CREATE TABLE ${files}(id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,file_name TEXT NOT NULL,
        file_size INTEGER CHECK(file_size IS NULL OR file_size>0),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','active','deleted')),
        attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0)`),
      statement(`CREATE TABLE ${recalls}(message_id TEXT PRIMARY KEY)`),
      statement(`CREATE TABLE ${events}(event_id TEXT PRIMARY KEY)`),
      statement(`CREATE TABLE ${jobs}(id TEXT PRIMARY KEY,file_id TEXT NOT NULL)`),
    ])
    for (const name of Object.values(names)) owned.add(name)

    phase = 'parameters_returning_and_changes'
    const milliseconds = 1_800_000_000_123
    const insertion = await db.query(statement(`INSERT INTO ${files}(id,message_id,file_name,file_size,lease_until) VALUES(?,?,?,?,?) RETURNING *`, 'types', 'types-message', '中文 "quote" / 附件', null, milliseconds))
    check(insertion.results[0]?.file_name === '中文 "quote" / 附件' && insertion.results[0]?.file_size === null && insertion.results[0]?.lease_until === milliseconds, 'parameter_roundtrip')
    check(insertion.meta.changes === 1, 'insert_changes')
    passed(phase)

    phase = 'atomic_batch_rollback'
    let rejected = false
    try {
      await db.batch([
        statement(`INSERT INTO ${events}(event_id) VALUES('must-rollback')`),
        statement(`UPDATE ${files} SET file_size=-1 WHERE id='types'`),
      ])
    } catch { rejected = true }
    check(rejected, 'constraint_failure_not_reported')
    check((await rows(`SELECT event_id FROM ${events} WHERE event_id='must-rollback'`)).length === 0, 'partial_batch_commit')
    check((await rows(`SELECT file_size FROM ${files} WHERE id='types'`))[0]?.file_size === null, 'constraint_modified_original')
    passed(phase)

    phase = 'conditional_claim_concurrency'
    await register('claim-event', 'claim-message', 'claim')
    const claim = () => db.query(statement(`UPDATE ${files} SET attempts=attempts+1,lease_until=? WHERE id='claim' AND lease_until=0 RETURNING attempts,lease_until`, milliseconds))
    const claims = await Promise.allSettled([claim(), claim()])
    check(claims.every((result) => result.status === 'fulfilled'), 'claim_transport_failure')
    const claimedRows = claims.flatMap((result) => result.status === 'fulfilled' ? result.value.results : [])
    check(claimedRows.length === 1 && claimedRows[0].attempts === 1 && claimedRows[0].lease_until === milliseconds, 'duplicate_claim')
    passed(phase)

    phase = 'event_deduplication_and_outbox_atomicity'
    const duplicates = await Promise.allSettled([register('duplicate-event', 'duplicate-message', 'duplicate'), register('duplicate-event', 'duplicate-message', 'duplicate')])
    check(duplicates.every((result) => result.status === 'fulfilled'), 'duplicate_transport_failure')
    check((await rows(`SELECT id FROM ${files} WHERE message_id='duplicate-message'`)).length === 1, 'duplicate_file')
    const activations = await Promise.allSettled([activate('duplicate'), activate('duplicate')])
    check(activations.every((result) => result.status === 'fulfilled'), 'activation_transport_failure')
    const successful = activations.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    check(successful.filter((result) => result[0].meta.changes === 1 && result[1].meta.changes === 1).length === 1, 'changes_not_shared_across_batch')
    check(successful.filter((result) => result[0].meta.changes === 0 && result[1].meta.changes === 0).length === 1, 'concurrent_duplicate_outbox')
    const repeated = await activate('duplicate')
    check(repeated[0].meta.changes === 0 && repeated[1].meta.changes === 0, 'outbox_created_without_transition')
    check((await rows(`SELECT id FROM ${jobs} WHERE file_id='duplicate'`)).length === 1, 'duplicate_outbox')
    passed(phase)

    phase = 'recall_before_registration'
    await recall('early-recall', 'early-message')
    await register('early-register', 'early-message', 'early')
    check((await rows(`SELECT id FROM ${files} WHERE id='early'`)).length === 0, 'tombstone_bypassed')
    passed(phase)

    phase = 'registration_recall_race'
    for (let index = 0; index < 3; index++) {
      const id = `race-${index}`, message = `race-message-${index}`
      const raced = await Promise.allSettled([register(`race-register-${index}`, message, id), recall(`race-recall-${index}`, message)])
      check(raced.every((result) => result.status === 'fulfilled'), 'race_transport_failure')
      const result = await rows(`SELECT status FROM ${files} WHERE id=?`, id)
      check(result.length === 0 || result[0].status === 'deleted', 'recalled_file_revived')
      check((await rows(`SELECT message_id FROM ${recalls} WHERE message_id=?`, message)).length === 1, 'missing_recall_tombstone')
      const late = await activate(id)
      check(late[0].meta.changes === 0 && (await rows(`SELECT id FROM ${jobs} WHERE file_id=?`, id)).length === 0, 'late_activation_published')
    }
    passed(phase)

    phase = 'existing_table_preservation'
    const after = new Set((await rows("SELECT name FROM sqlite_master WHERE type='table'")).map((row) => String(row.name)))
    check([...existing].every((name) => after.has(name)), 'existing_table_missing')
    passed(phase)
  } catch {
    failed = true
    console.error(JSON.stringify({ event: 'd1_contract_failed', phase, scratchPrefix: creationStarted ? prefix : undefined }))
  } finally {
    // 仅已确认本次创建成功的随机表才有删除授权；不枚举前缀批量删除。
    for (const name of [...owned].reverse()) {
      try { await db.query(statement(`DROP TABLE ${quote(name)}`)); owned.delete(name) }
      catch { failed = true; console.error(JSON.stringify({ event: 'd1_contract_cleanup_failed', scratchTable: name })) }
    }
    console.log(JSON.stringify({ event: 'd1_contract_complete', passed: checks, failed, remainingOwnedTables: owned.size,
      scope: 'remote_metadata_contract_only', knownProductionDatabaseExcluded: true }))
    if (failed) process.exitCode = 1
  }
}

await main()
