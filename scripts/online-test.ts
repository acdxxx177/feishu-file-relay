import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, createReadStream, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { patternBytesAt } from '../mocks/file-pattern.ts'
import { downloadChunks, type DownloadMetadata } from '../src/browser/download-controller.ts'

interface Manifest {
  accountId: string
  gatewayName: string
  mockName: string
  databaseId: string
  databaseName: string
  gatewayUrl: string
  configPath: string
  mockConfigPath: string
  secretsPath: string
  runId: string
}
interface TestSecrets {
  FEISHU_APP_ID: string
  FEISHU_APP_SECRET: string
  FEISHU_VERIFICATION_TOKEN: string
  FEISHU_ENCRYPT_KEY: string
  ALLOWED_OPEN_IDS: string
  ADMIN_OPEN_IDS: string
}
interface CaseResult {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  detail: string
}
interface HttpResult { path: string; method: string; status: number; colo: string; declaredBytes: number | null }
interface IntegrityResult {
  kind: 'full' | 'range' | 'resumed'
  path: string
  bytes: number
  start: number
  end: number
  expectedSha256: string
  actualSha256: string
}
interface CancellationResult {
  path: string
  clientAborted: boolean
  abortAfterMs: number
  sourceRequests: Array<{ status: number; bytes: number; outcome: string; colo: string | null }>
}
interface Report {
  buildHash?: string
  buildHashes?: string[]
  browserTrials?: Array<Record<string, unknown>>
  accountId: string
  gatewayName: string
  gatewayUrl: string
  budgetBytes: number
  chargedBytes: number
  receivedBytes: number
  runs: Array<{ runId: string; startedAt: string; finishedAt?: string; buildHash?: string; configHash?: string; gatewayVersion?: string; cases: CaseResult[]; http: HttpResult[]; cache: unknown[]; integrity: IntegrityResult[]; cancellation: CancellationResult[]; platformLimited: boolean; platformLimits: Array<{ time?: string; worker?: string; outcome?: string }> }>
}
interface Published { messageId: string; fileKey: string; fileName: string; url: string; size: number }
class SkipCase extends Error {}

const MiB = 1024 * 1024
const browserMode = process.argv.includes('--browser')
const budget = (browserMode ? 4096 : 512) * MiB
const cancelOnly = process.argv.includes('--cancel-only')
const manifestIndex = process.argv.indexOf('--manifest')
const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : '.local/online-test.json'
if (!manifestPath) throw new Error('缺少 --manifest 路径')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
for (const field of ['accountId', 'gatewayName', 'mockName', 'databaseId', 'databaseName', 'gatewayUrl', 'configPath', 'secretsPath', 'runId'] as const) {
  if (typeof manifest[field] !== 'string' || !manifest[field]) throw new Error(`测试清单缺少字段 ${field}`)
}
const gateway = new URL(manifest.gatewayUrl)
if (!/^[a-z0-9-]{1,64}$/i.test(manifest.runId)) throw new Error('测试runId格式无效')
if (gateway.protocol !== 'https:' || !gateway.hostname.endsWith('.workers.dev') || !gateway.hostname.startsWith(`${manifest.gatewayName}.`) || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash) throw new Error('本脚本只测试清单中已授权的 workers.dev 隔离环境')
if (!/^feishu-file-relay-online-test-[a-z0-9-]+$/.test(manifest.gatewayName) || !/^feishu-relay-test-[a-z0-9-]+$/.test(manifest.databaseName) || !/^feishu-file-relay-mock-test-[a-z0-9-]+$/.test(manifest.mockName)) throw new Error('资源名称必须使用独立测试前缀，拒绝运行到生产资源')
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(manifest.databaseId) || /^0{8}(?:-0{4}){3}-0{12}$/.test(manifest.databaseId)) throw new Error('测试数据库尚未创建或ID无效')
const actualConfigText = await readFile(manifest.configPath, 'utf8')
const actualConfig = JSON.parse(actualConfigText) as {
  name?: string; account_id?: string; vars?: { FEISHU_TRANSPORT?: string; FEISHU_API_BASE?: string; FEISHU_ACCOUNTS_BASE?: string }
  d1_databases?: Array<{ binding?: string; database_id?: string; database_name?: string }>
  services?: Array<{ binding?: string; service?: string }>
}
const boundDatabase = actualConfig.d1_databases?.find((binding) => binding.binding === 'DB')
const boundMock = actualConfig.services?.find((binding) => binding.binding === 'FEISHU_MOCK')
if (actualConfig.name !== manifest.gatewayName || actualConfig.account_id !== manifest.accountId ||
  boundDatabase?.database_id !== manifest.databaseId || boundDatabase.database_name !== manifest.databaseName ||
  actualConfig.vars?.FEISHU_TRANSPORT !== 'mock' || actualConfig.vars.FEISHU_API_BASE !== 'https://mock-feishu.invalid' ||
  actualConfig.vars.FEISHU_ACCOUNTS_BASE !== 'https://mock-accounts.invalid' || boundMock?.service !== manifest.mockName) {
  throw new Error('生成配置与隔离测试清单不匹配，拒绝访问远程 D1 或公开接口')
}
const secrets = JSON.parse(await readFile(manifest.secretsPath, 'utf8')) as TestSecrets
const allowed = secrets.ALLOWED_OPEN_IDS.split(',').map((value) => value.trim()).filter(Boolean)
const admin = secrets.ADMIN_OPEN_IDS.split(',').map((value) => value.trim()).find((value) => allowed.includes(value))
const employee = allowed.find((value) => value !== admin)
const other = allowed.find((value) => value !== admin && value !== employee)
if (!employee || !admin || !other || !secrets.FEISHU_ENCRYPT_KEY) throw new Error('模拟配置需要不同的上传者、管理员、其他白名单用户及 Encrypt Key')

const reportPath = browserMode ? '.local/browser-online-results.json' : '.local/online-results.json'
await mkdir('.local', { recursive: true })
const lockPath = '.local/online-test.lock'
const lockToken = randomBytes(16).toString('hex')
try {
  const descriptor = openSync(lockPath, 'wx', 0o600)
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: lockToken, accountId: manifest.accountId, gatewayName: manifest.gatewayName })) }
  finally { closeSync(descriptor) }
} catch {
  throw new Error('线上测试进程锁已存在；确认没有其他测试进程后再人工检查 .local/online-test.lock，不自动接管')
}
// 所有在线下载共用一个账本和进程锁；异常强杀留下锁时必须人工核查，不能重置预算。
process.once('exit', () => {
  try {
    const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: string }
    if (existing.token === lockToken) unlinkSync(lockPath)
  } catch { /* 退出时不覆盖其他进程的锁，也不输出环境细节。 */ }
})
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))
let report: Report
try {
  report = JSON.parse(await readFile(reportPath, 'utf8')) as Report
  if (report.accountId !== manifest.accountId || report.gatewayName !== manifest.gatewayName || report.budgetBytes !== budget) {
    throw new Error('已有流量账本属于其他环境，必须由操作者检查后处理，不能自动重置')
  }
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  report = { accountId: manifest.accountId, gatewayName: manifest.gatewayName, gatewayUrl: gateway.origin, budgetBytes: budget, chargedBytes: 0, receivedBytes: 0, runs: [] }
}
if (!Number.isSafeInteger(report.chargedBytes) || report.chargedBytes < 0 || report.chargedBytes > budget) throw new Error('流量账本无效，拒绝重置预算')
const runId = `${manifest.runId}-${Date.now().toString(36)}`
const run: Report['runs'][number] = { runId, startedAt: new Date().toISOString(), cases: [], http: [], cache: [], integrity: [], cancellation: [], platformLimited: false, platformLimits: [] }
report.runs.push(run)
let saving = Promise.resolve()
function save(): Promise<void> {
  const snapshot = JSON.stringify(report, null, 2)
  saving = saving.then(async () => {
    const temporary = `${reportPath}.${process.pid}.${lockToken}.tmp`
    await writeFile(temporary, snapshot, 'utf8')
    await rename(temporary, reportPath)
  })
  return saving
}
await save()

if (browserMode) {
  const deployed = JSON.parse(await readFile('.local/browser-online-deployment.json', 'utf8')) as { gatewayName: string; gatewayVersion: string; artifactPath?: string; buildHash: string; configHash: string }
  const buildHash = createHash('sha256').update(await readFile(deployed.artifactPath ?? 'dist/index.js')).digest('hex')
  if (deployed.gatewayName !== manifest.gatewayName || !deployed.gatewayVersion || deployed.buildHash !== buildHash || deployed.configHash !== createHash('sha256').update(actualConfigText).digest('hex')) throw new Error('未找到与本地构建/配置匹配的隔离部署证据')
  // 构建变化记录到新 run，但共享总预算不能重置；保留首个构建的历史字段。
  report.buildHash ??= buildHash
  report.buildHashes = [...new Set([...(report.buildHashes ?? []), report.buildHash, buildHash])]
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('node_modules/wrangler/bin/wrangler.js'), 'deployments', 'list', '--config', manifest.configPath, '--json'], { windowsHide: true, timeout: 60000, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: manifest.accountId } })
  const active = (JSON.parse(stdout) as Array<{ created_on: string; versions: Array<{ version_id: string; percentage: number }> }>).sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0]
  if (active?.versions.length !== 1 || active.versions[0].version_id !== deployed.gatewayVersion || active.versions[0].percentage !== 100) throw new Error('隔离 Worker 活动版本与测试构建不匹配')
  run.buildHash = buildHash
  run.configHash = deployed.configHash
  run.gatewayVersion = deployed.gatewayVersion
  report.browserTrials ??= []
  await save()
}

const exec = promisify(execFile)
let sqlSequence = 0
const sqlValue = (value: string) => `'${value.replace(/'/g, "''")}'`
async function sql<T extends object = Record<string, unknown>>(query: string): Promise<T[]> {
  if (await readFile(manifest.configPath, 'utf8') !== actualConfigText) throw new Error('测试运行期间配置已变化，停止访问远程 D1')
  const sqlPath = path.resolve('.local', `online-${runId}-${sqlSequence++}.sql`)
  await writeFile(sqlPath, query, 'utf8')
  try {
    const { stdout } = await exec(process.execPath, [
      path.resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--remote',
      // 当前 Wrangler 的 --file 走批量导入，只返回导入摘要；--command 才返回 SELECT 行。
      // execFile 将 SQL 作为独立参数传递，不经过 shell；查询只包含隔离测试元数据，绝不包含密钥。
      '--config', path.resolve(manifest.configPath), '--command', query, '--json',
    ], {
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: manifest.accountId, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 8 * MiB,
      timeout: 120000,
    })
    const parsed: unknown = JSON.parse(stdout)
    if (!Array.isArray(parsed)) throw new Error('SQL response shape')
    return parsed.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object' || !('success' in item) || item.success !== true || !('results' in item) || !Array.isArray(item.results)) throw new Error('SQL response failure')
      return item.results as T[]
    })
  } catch {
    // Wrangler 异常可能包含查询或环境信息；报告中只保留操作阶段，不输出原文。
    throw new Error('远程测试 D1 操作失败，请查看本地 Wrangler 日志')
  }
}

let platformLimited = false
let platformSince = Date.now()
async function refreshPlatformLimit(): Promise<void> {
  try {
    const marker = JSON.parse(await readFile(browserMode ? '.local/browser-online-platform-limits.json' : '.local/online-platform-limits.json', 'utf8')) as { limited?: boolean; time?: string; worker?: string; outcome?: string }
    if ((!browserMode || !!marker.time && Date.parse(marker.time) >= platformSince) && marker.limited && (marker.worker === manifest.gatewayName || marker.worker === manifest.mockName)) {
      platformLimited = true
      if (!run.platformLimits.some((item) => item.time === marker.time && item.worker === marker.worker && item.outcome === marker.outcome)) {
        run.platformLimits.push({ time: marker.time, worker: marker.worker, outcome: marker.outcome })
        await save()
      }
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    // 平台证据文件损坏时宁可停止扩大测试，也不能把无法读取等同于没有超限。
    platformLimited = true
    run.platformLimits.push({ outcome: 'unreadable-limit-evidence' })
    await save()
  }
}
let activeRequests = 0
const waiting: Array<() => void> = []
let nextDownloadAt = 0
async function acquire() {
  if (activeRequests < 2) { activeRequests++; return }
  await new Promise<void>((resolve) => waiting.push(resolve))
}
function release() {
  const next = waiting.shift()
  if (next) next()
  else activeRequests--
}
async function withResponse<T>(requestPath: string, init: RequestInit, maximumBytes: number, consume: (response: Response) => Promise<T>): Promise<T> {
  await acquire()
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || report.chargedBytes + maximumBytes > budget) throw new Error('本轮持久化流量预算不足，停止该下载')
    // 先保守扣除完整响应上限并落盘，进程中断也不会在重启时重新获得预算。
    report.chargedBytes += maximumBytes
    await save()
    if (requestPath.startsWith('/f/') || requestPath.startsWith('/api/files/')) {
      const at = Math.max(Date.now(), nextDownloadAt)
      nextDownloadAt = at + 1200
      await setTimeout(Math.max(0, at - Date.now()))
    }
    const deadline = AbortSignal.timeout(120000)
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    const response = await fetch(new URL(requestPath, gateway), { ...init, redirect: 'manual', signal })
    run.http.push({ path: requestPath.split('?')[0], method: init.method ?? 'GET', status: response.status, colo: response.headers.get('cf-ray')?.split('-').at(-1) ?? '', declaredBytes: response.headers.has('content-length') ? Number(response.headers.get('content-length')) : null })
    if (response.status >= 500 && response.status !== 503) platformLimited = true
    let readBytes = 0
    const reader = response.body?.getReader()
    const countedBody = reader ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read()
          if (done) { controller.close(); return }
          report.receivedBytes += value.byteLength
          readBytes += value.byteLength
          if (readBytes > maximumBytes) {
            await reader.cancel().catch(() => {})
            throw new Error('响应超过预留字节数，已取消')
          }
          controller.enqueue(value)
        } catch (error) { controller.error(error) }
      },
      cancel(reason) { return reader.cancel(reason) },
    }) : null
    const counted = new Response(countedBody, { status: response.status, headers: response.headers })
    try { return await consume(counted) }
    finally { await counted.body?.cancel().catch(() => {}); await save() }
  } finally { release() }
}
function get(pathname: string, size: number, consume: (response: Response) => Promise<void>, headers?: HeadersInit) {
  return withResponse(pathname, { headers }, Math.max(65536, size), consume)
}
async function status(pathname: string, expected: number, method = 'HEAD', headers?: HeadersInit): Promise<Headers> {
  return withResponse(pathname, { method, headers }, 65536, async (response) => {
    if (response.status !== expected) {
      const text = await response.text()
      if (/1102|exceeded|resource limit|CPU/i.test(text)) platformLimited = true
      throw new Error(`预期 HTTP ${expected}，实际 ${response.status}${platformLimited ? '（平台限制）' : ''}`)
    }
    return response.headers
  })
}

async function post(payload: unknown, badSignature = false): Promise<number> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(12).toString('hex')
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(secrets.FEISHU_ENCRYPT_KEY).digest(), iv)
  const body = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') })
  const signature = createHash('sha256').update(timestamp + nonce + secrets.FEISHU_ENCRYPT_KEY + body).digest('hex')
  return withResponse('/webhook/feishu', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Lark-Request-Timestamp': timestamp, 'X-Lark-Request-Nonce': nonce,
    'X-Lark-Signature': badSignature ? '0'.repeat(64) : signature,
  }, body }, 65536, async (response) => {
    await response.text()
    return response.status
  })
}
function envelope(eventId: string, type: string, event: unknown) {
  return { schema: '2.0', header: { event_id: eventId, event_type: type, create_time: String(Date.now()), token: secrets.FEISHU_VERIFICATION_TOKEN, app_id: secrets.FEISHU_APP_ID }, event }
}
function message(messageId: string, type: 'file' | 'text', content: object, sender = employee!, chatType: 'p2p' | 'group' = 'p2p') {
  return envelope(`evt-${messageId}`, 'im.message.receive_v1', {
    sender: { sender_id: { open_id: sender }, sender_type: 'user' },
    message: { message_id: messageId, chat_id: `chat-${runId}`, chat_type: chatType, message_type: type, content: JSON.stringify(content) },
  })
}
function recall(messageId: string) { return envelope(`recall-${messageId}`, 'im.message.recalled_v1', { message_id: messageId, chat_id: `chat-${runId}`, chat_type: 'p2p' }) }
async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await read()
    if (accept(result)) return result
    await setTimeout(1500)
  }
  throw new Error(`${label}未在限定轮询内完成`)
}
async function register(label: string, size: number): Promise<Published> {
  const messageId = `${runId}-${label}`
  const fileKey = `key-${messageId}`
  const fileName = `${messageId}-中文.bin`
  await sql(`INSERT INTO mock_files(message_id,file_key,file_size,file_name) VALUES(${sqlValue(messageId)},${sqlValue(fileKey)},${size},${sqlValue(fileName)});`)
  assert.equal(await post(message(messageId, 'file', { file_key: fileKey, file_name: fileName })), 200)
  const replies = await poll(
    () => sql<{ content: string }>(`SELECT content FROM mock_replies WHERE receive_id=${sqlValue(`chat-${runId}`)} AND instr(content,${sqlValue(fileName)})>0 ORDER BY created_at DESC;`),
    (rows) => rows.some((row) => row.content.includes('/f/')), '机器人公开链接',
  )
  const texts = replies.map((row) => (JSON.parse(row.content) as { text: string }).text)
  const link = texts.flatMap((text) => text.match(/https:\/\/[^\s]+\/f\/[A-Za-z0-9]{22}/g) ?? [])[0]
  if (!link || new URL(link).origin !== gateway.origin) throw new Error('机器人回复没有当前测试域名的公开链接')
  return { messageId, fileKey, fileName, size, url: link }
}
function filePath(file: Published) { return `${new URL(file.url).pathname}/download` }
function expectedHash(start: number, length: number): string {
  const hash = createHash('sha256')
  for (let offset = start; offset < start + length; offset += 65536) hash.update(patternBytesAt(offset, Math.min(65536, start + length - offset)))
  return hash.digest('hex')
}
async function recordIntegrity(kind: IntegrityResult['kind'], file: Published, start: number, end: number, bytes: number, actualSha256: string): Promise<string> {
  const expectedSha256 = expectedHash(start, end - start + 1)
  run.integrity.push({ kind, path: filePath(file), bytes, start, end, expectedSha256, actualSha256 })
  await save()
  return expectedSha256
}
async function full(file: Published): Promise<void> {
  await get(filePath(file), file.size, async (response) => {
    if (response.status !== 200) {
      const error = await response.text()
      if (/1102|CPU|resource|exceeded/i.test(error)) platformLimited = true
      throw new Error(`完整下载 HTTP ${response.status}${platformLimited ? '（平台限制）' : ''}`)
    }
    assert.equal(Number(response.headers.get('content-length')), file.size)
    const hash = createHash('sha256')
    let count = 0
    for await (const chunk of response.body!) { hash.update(chunk); count += chunk.byteLength }
    const actual = hash.digest('hex')
    const expected = await recordIntegrity('full', file, 0, file.size - 1, count, actual)
    assert.equal(count, file.size)
    assert.equal(actual, expected)
  })
}
async function range(file: Published, start: number, end: number): Promise<void> {
  await get(filePath(file), end - start + 1, async (response) => {
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${file.size}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    const expected = await recordIntegrity('range', file, start, end, bytes.byteLength, actual)
    assert.equal(bytes.byteLength, end - start + 1)
    assert.equal(actual, expected)
  }, { Range: `bytes=${start}-${end}` })
}
async function resume(file: Published): Promise<void> {
  const hash = createHash('sha256')
  let received = 0
  const headers = await status(filePath(file), 200)
  await get(filePath(file), file.size, async (response) => {
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const stop = Math.min(Math.floor(file.size / 3), 17 * MiB + 123)
    while (received < stop) {
      const { value, done } = await reader.read()
      assert.equal(done, false)
      hash.update(value!)
      received += value!.byteLength
    }
    await reader.cancel()
  })
  const offset = received
  await get(filePath(file), file.size - offset, async (response) => {
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes ${offset}-${file.size - 1}/${file.size}`)
    for await (const chunk of response.body!) { hash.update(chunk); received += chunk.byteLength }
  }, { Range: `bytes=${offset}-`, 'If-Range': headers.get('etag')! })
  const actual = hash.digest('hex')
  const expected = await recordIntegrity('resumed', file, 0, file.size - 1, received, actual)
  assert.equal(received, file.size)
  assert.equal(actual, expected)
}
async function originCounts(file: Published) {
  return sql<{ colo: string; calls: number; bytes: number; outcome: string }>(`SELECT colo,outcome,COUNT(*) AS calls,SUM(bytes) AS bytes FROM mock_requests WHERE message_id=${sqlValue(file.messageId)} AND range_header!='bytes=0-0' GROUP BY colo,outcome;`)
}
async function cacheCheck(file: Published) {
  const before = await originCounts(file)
  await full(file)
  await setTimeout(1000)
  const after = await originCounts(file)
  const callsBefore = before.reduce((sum, row) => sum + row.calls, 0)
  const callsAfter = after.reduce((sum, row) => sum + row.calls, 0)
  const observed = { size: file.size, before, after, additionalOriginCalls: callsAfter - callsBefore, result: callsAfter === callsBefore ? 'hit-observed' : 'cache-not-accepted' }
  run.cache.push(observed)
  await save()
  return callsAfter === callsBefore
}
async function caseRun(name: string, body: () => Promise<void>, skip?: string): Promise<boolean> {
  const started = Date.now()
  let status: CaseResult['status'] = 'passed'
  let detail = ''
  if (skip) { status = 'skipped'; detail = skip }
  else {
    try { await body() }
    catch (error) {
      status = error instanceof SkipCase ? 'skipped' : 'failed'
      // 只报告自定义阶段/断言简述，不序列化可能包含请求头的底层错误对象。
      detail = error instanceof assert.AssertionError ? `断言失败：${String(error.actual).slice(0, 80)} / ${String(error.expected).slice(0, 80)}` : error instanceof Error ? error.message.slice(0, 200) : '未知错误'
      if (status === 'failed') {
        // Tail 事件可能比 HTTP 失败晚到；给监控写入有限宽限，再把平台证据关联到本用例。
        await setTimeout(2000)
        await refreshPlatformLimit()
        if (run.platformLimits.some((item) => item.time && Date.parse(item.time) >= started)) detail += '（同期观察到 Workers 资源限制）'
      }
    }
  }
  run.cases.push({ name, status, durationMs: Date.now() - started, detail })
  await save()
  console.log(JSON.stringify({ case: name, status, detail }))
  return status === 'passed'
}

try {
  if (browserMode) {
    await runBrowserTrials()
  } else if (cancelOnly) {
    await caseRun('冷源响应头前取消（1 MiB 隔离探测）', async () => {
      const file = await register('cancel-headers', MiB)
      await sql(`UPDATE mock_files SET mode='slow-headers',header_delay_ms=5000 WHERE message_id=${sqlValue(file.messageId)};`)
      const controller = new AbortController()
      const reason = new Error('online-test-client-cancel')
      const abortAfterMs = 1500
      const timer = globalThis.setTimeout(() => controller.abort(reason), abortAfterMs)
      let clientAborted = false
      let receivedHeaders = false
      try {
        await withResponse(filePath(file), { signal: controller.signal }, MiB, async (response) => {
          receivedHeaders = true
          await response.body?.cancel()
        })
      } catch (error) {
        if (!controller.signal.aborted) throw error
        clientAborted = error === reason || error instanceof Error && (error.name === 'AbortError' || error.message === reason.message)
      } finally { globalThis.clearTimeout(timer) }
      assert.equal(clientAborted, true, '客户端必须由本次主动取消结束')
      assert.equal(receivedHeaders, false, '5秒慢响应头不应在1.5秒主动取消前到达')
      type SourceRequest = CancellationResult['sourceRequests'][number]
      let sourceRequests: SourceRequest[] = []
      for (let attempt = 0; attempt < 4; attempt++) {
        sourceRequests = await sql<SourceRequest>(`SELECT status,bytes,outcome,colo FROM mock_requests WHERE message_id=${sqlValue(file.messageId)} AND range_header!='bytes=0-0' ORDER BY id DESC;`)
        if (sourceRequests.length && sourceRequests.every((row) => row.outcome !== 'started')) break
        await setTimeout(1500)
      }
      run.cancellation.push({ path: filePath(file), clientAborted, abortAfterMs, sourceRequests })
      await save()
      if (!sourceRequests.length || !sourceRequests.every((row) => row.outcome === 'cancelled-before-headers' && row.bytes === 0)) {
        throw new SkipCase('客户端已取消，但本轮未观测所有源站请求在响应头前取消且零字节；保留为边缘通知待验证项')
      }
    })
  } else {
    const healthy = await caseRun('健康检查与回调来源校验', async () => {
      await status('/health', 200, 'GET')
      assert.equal(await post({ type: 'url_verification', token: secrets.FEISHU_VERIFICATION_TOKEN, challenge: 'online-test' }), 200)
      assert.equal(await post(message(`${runId}-invalid-signature`, 'text', { text: '帮助' }), true), 401)
    })
    let basic: Published | undefined
    const basicReady = await caseRun('1 MiB 登记、机器人回复、重复事件与白名单', async () => {
      basic = await register('basic', MiB)
      assert.equal(await post(message(basic.messageId, 'file', { file_key: basic.fileKey, file_name: basic.fileName })), 200)
      const rows = await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM files WHERE message_id=${sqlValue(basic.messageId)};`)
      assert.equal(rows[0].n, 1)
      const outsiderId = `${runId}-outsider`
      assert.equal(await post(message(outsiderId, 'file', { file_key: 'not-a-real-file', file_name: 'outsider.bin' }, `outsider-${runId}`)), 200)
      assert.equal((await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM files WHERE message_id=${sqlValue(outsiderId)};`))[0].n, 0)
      const groupId = `${runId}-group`
      assert.equal(await post(message(groupId, 'file', { file_key: 'not-a-real-file', file_name: 'group.bin' }, employee!, 'group')), 200)
      assert.equal((await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM files WHERE message_id=${sqlValue(groupId)};`))[0].n, 0)
    }, !healthy ? '基础健康检查失败' : undefined)
    const basicDownload = await caseRun('1 MiB 完整下载、HEAD、安全头与 SHA-256', async () => {
      const head = await status(filePath(basic!), 200)
      assert.equal(head.get('content-length'), String(MiB))
      assert.equal(head.get('content-type'), 'application/octet-stream')
      assert.equal(head.get('x-content-type-options'), 'nosniff')
      assert.match(head.get('content-disposition')!, /filename\*=UTF-8''/)
      await full(basic!)
      const statistics = await sql<{ download_count: number; last_downloaded_at: string | null }>(`SELECT download_count,last_downloaded_at FROM files WHERE message_id=${sqlValue(basic!.messageId)};`)
      assert.ok(statistics[0].download_count >= 1)
      assert.ok(statistics[0].last_downloaded_at)
    }, !basicReady ? '登记失败' : undefined)
    await caseRun('Range、If-Range、多 Range、416 与续传', async () => {
      await range(basic!, 10, 123)
      await range(basic!, 0, 0)
      await status(filePath(basic!), 416, 'GET', { Range: `bytes=${MiB}-` })
      await get(filePath(basic!), basic!.size, async (response) => {
        assert.equal(response.status, 200)
        await response.body!.pipeTo(new WritableStream())
      }, { Range: 'bytes=0-1,4-5' })
      await get(filePath(basic!), basic!.size, async (response) => {
        assert.equal(response.status, 200)
        await response.body!.pipeTo(new WritableStream())
      }, { Range: 'bytes=0-1', 'If-Range': '"wrong"' })
      await resume(basic!)
    }, !basicDownload ? '1 MiB 下载失败' : undefined)
    await caseRun('workers.dev 重复下载缓存验收', async () => {
      if (!await cacheCheck(basic!)) throw new SkipCase('本轮未观测到重复下载无新增回源，缓存保持未验收')
    }, !basicDownload ? '1 MiB 下载失败' : undefined)
    await caseRun('我的链接包含已发布链接和下载统计', async () => {
      assert.equal(await post(message(`${runId}-my-links`, 'text', { text: '我的链接' })), 200)
      const replies = await poll(() => sql<{ content: string }>(`SELECT content FROM mock_replies WHERE receive_id=${sqlValue(`chat-${runId}`)} AND instr(content,${sqlValue('最近的有效链接')})>0;`), (rows) => rows.length > 0, '我的链接回复')
      assert.ok(replies.some((reply) => reply.content.includes(basic!.url) && reply.content.includes('下载')))
    }, !basicDownload ? '1 MiB 下载失败' : undefined)
    await caseRun('已下载文件撤回后 GET/HEAD 410', async () => {
      assert.equal(await post(recall(basic!.messageId)), 200)
      const before = await originCounts(basic!)
      await status(filePath(basic!), 410)
      await status(filePath(basic!), 410, 'GET')
      assert.deepEqual(await originCounts(basic!), before)
    }, !basicDownload ? '1 MiB 下载失败' : undefined)
    await caseRun('先撤回后登记不会复活', async () => {
      const id = `${runId}-recall-first`
      assert.equal(await post(recall(id)), 200)
      await sql(`INSERT INTO mock_files(message_id,file_key,file_size) VALUES(${sqlValue(id)},${sqlValue(`key-${id}`)},1024);`)
      assert.equal(await post(message(id, 'file', { file_key: `key-${id}`, file_name: 'recall-first.bin' })), 200)
      assert.equal((await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM files WHERE message_id=${sqlValue(id)};`))[0].n, 0)
    }, !healthy ? '基础健康检查失败' : undefined)
    await caseRun('撤销命令的其他用户、上传者和管理员权限', async () => {
      const file = await register('revoke-owner', 65536)
      const command = async (label: string, sender: string) => assert.equal(await post(message(`${runId}-${label}`, 'text', { text: `撤销 ${file.url}` }, sender)), 200)
      await command('other-revoke', other!)
      await poll(() => sql<{ content: string }>(`SELECT content FROM mock_replies WHERE receive_id=${sqlValue(`chat-${runId}`)} AND instr(content,${sqlValue('无权撤销')})>0;`), (rows) => rows.length > 0, '拒绝他人撤销')
      await status(filePath(file), 200)
      await command('owner-revoke', employee!)
      await poll(() => sql<{ status: string }>(`SELECT status FROM files WHERE message_id=${sqlValue(file.messageId)};`), (rows) => rows[0]?.status === 'deleted', '上传者撤销')
      await status(filePath(file), 410)
      const adminFile = await register('revoke-admin', 65536)
      assert.equal(await post(message(`${runId}-admin-revoke`, 'text', { text: `撤销 ${adminFile.url}` }, admin!)), 200)
      await poll(() => sql<{ status: string }>(`SELECT status FROM files WHERE message_id=${sqlValue(adminFile.messageId)};`), (rows) => rows[0]?.status === 'deleted', '管理员撤销')
      await status(filePath(adminFile), 410)
    }, !basicReady ? '基础登记失败' : undefined)
    for (const mode of ['missing', 'throttle', 'bad-range', 'truncate'] as const) {
      await caseRun(`回源错误 ${mode}`, async () => {
        const file = await register(`error-${mode}`, 65536)
        await sql(`UPDATE mock_files SET mode=${sqlValue(mode)} WHERE message_id=${sqlValue(file.messageId)};`)
        const physicalRequests = () => sql<{ status: number }>(`SELECT status FROM mock_requests WHERE message_id=${sqlValue(file.messageId)} AND range_header!='bytes=0-0';`)
        let physical: Array<{ status: number }>
        if (mode === 'truncate') {
          let interrupted = false
          try { await full(file) } catch { interrupted = true }
          assert.equal(interrupted, true)
          physical = await physicalRequests()
          await sql(`UPDATE mock_files SET mode='ok' WHERE message_id=${sqlValue(file.messageId)};`)
          await full(file)
        } else {
          await status(filePath(file), mode === 'missing' ? 410 : 503, 'GET')
          if (mode === 'missing') await status(filePath(file), 410)
          physical = await physicalRequests()
        }
        assert.ok(physical.some((row) => row.status === (mode === 'missing' ? 404 : mode === 'throttle' ? 429 : 206)), '模拟源站必须实际返回所注入的错误')
      }, !basicDownload ? '1 MiB 下载失败，保留小文件错误用例待复核' : undefined)
    }
    let medium: Published | undefined
    await refreshPlatformLimit()
    const mediumReady = await caseRun('20 MiB 完整下载与跨 16 MiB 分片 Range', async () => {
      medium = await register('medium', 20 * MiB)
      await full(medium)
      await range(medium, 16 * MiB - 17, 16 * MiB + 35)
    }, !basicDownload || platformLimited ? '小文件失败或触发平台限制，停止扩大规模' : undefined)
    await refreshPlatformLimit()
    const mediumStable = await caseRun('20 MiB 中断续传与两路并发（另记录缓存观测）', async () => {
      await resume(medium!)
      await cacheCheck(medium!)
      await Promise.all([full(medium!), full(medium!)])
    }, !mediumReady || platformLimited ? '20 MiB 未稳定通过，停止扩大规模' : undefined)
    await refreshPlatformLimit()
    await caseRun('100 MiB 单路完整下载 SHA-256', async () => { await full(await register('large', 100 * MiB)) }, !mediumStable || platformLimited ? '20 MiB 未稳定通过或触发平台限制' : undefined)
    await caseRun('500 MiB / 1 GiB / 十路并发', async () => {}, '免费版本轮不执行，保持付费计划不变')
  }
} finally {
  await setTimeout(2000)
  await refreshPlatformLimit()
  run.platformLimited = platformLimited || run.platformLimits.length > 0
  run.finishedAt = new Date().toISOString()
  await save()
  const summary = run.cases.reduce((counts, result) => { counts[result.status]++; return counts }, { passed: 0, failed: 0, skipped: 0 })
  console.log(JSON.stringify({ runId, gatewayUrl: gateway.origin, summary, chargedBytes: report.chargedBytes, receivedBytes: report.receivedBytes, budgetBytes: budget, platformLimited: run.platformLimited, reportPath }))
}
if (run.cases.some((result) => result.status === 'failed')) process.exitCode = 1

async function browserMetadata(file: Published): Promise<{ id: string; etag: string }> {
  return withResponse(`/api/files/${new URL(file.url).pathname.split('/')[2]}`, {}, 65536, async (response) => {
    assert.equal(response.status, 200)
    return await response.json() as { id: string; etag: string }
  })
}

async function browserFull(file: Published, chunkSize: number, interrupt = false): Promise<void> {
  const metadata = await browserMetadata(file) as DownloadMetadata
  metadata.size = file.size
  metadata.chunkSize = chunkSize
  const outputPath = path.resolve('.local', `browser-output-${runId}-${metadata.id}.bin`)
  const output = await open(outputPath, 'wx')
  const stop = new AbortController()
  const checkPlatformLimit = (reason: string) => {
    if (platformLimited) stop.abort(new Error(reason))
    stop.signal.throwIfAborted()
  }
  let interrupted = false
  try {
    await downloadChunks(metadata, {
      async write(position, bytes) {
        let written = 0
        while (written < bytes.byteLength) written += (await output.write(bytes, written, bytes.byteLength - written, position + written)).bytesWritten
      },
      truncate: (size) => output.truncate(size), close: () => output.close(), abort: () => output.close(),
    }, {
      signal: stop.signal,
      async wait(milliseconds) {
        await setTimeout(Math.max(2000, milliseconds))
        await refreshPlatformLimit()
        checkPlatformLimit('本阶段出现平台超限，停止重试')
      },
      async fetcher(_input, init) {
        await refreshPlatformLimit()
        checkPlatformLimit('本阶段出现平台超限，停止后续分片')
        const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range')!)!
        const maximum = Number(range[2]) - Number(range[1]) + 1
        // 将预算包装器的生命周期绑定到浏览器控制器消费/取消正文，而非收到响应头。
        return new Promise<Response>((resolve, reject) => {
          void withResponse(`/api/files/${metadata.id}/chunk`, init ?? {}, maximum, async (response) => {
            if (!response.body) { resolve(new Response(null, { status: response.status, headers: response.headers })); return }
            const reader = response.body.getReader()
            await new Promise<void>((finish) => {
              let bytes = 0
              resolve(new Response(new ReadableStream<Uint8Array>({
                async pull(controller) {
                  try {
                    const { value, done } = await reader.read()
                    if (done) { controller.close(); finish(); return }
                    bytes += value.byteLength
                    if (interrupt && !interrupted && bytes > 137123) {
                      interrupted = true
                      void reader.cancel().catch(() => {})
                      throw new TypeError('controlled interruption')
                    }
                    controller.enqueue(value)
                  } catch (error) { controller.error(error); finish() }
                },
                cancel(reason) { finish(); void reader.cancel(reason).catch(() => {}) },
              }), { status: response.status, headers: response.headers }))
            })
          }).catch(reject)
        })
      },
    })
    const hash = createHash('sha256')
    let total = 0
    for await (const value of createReadStream(outputPath)) { hash.update(value); total += value.length }
    const actual = hash.digest('hex')
    assert.equal(total, file.size)
    assert.equal(actual, await recordIntegrity(interrupt ? 'resumed' : 'full', file, 0, file.size - 1, total, actual))
  } finally {
    await output.close().catch(() => {})
    await unlink(outputPath).catch(() => {})
  }
}

async function trialCpu(ids: string[]): Promise<{ gateway: number[]; chunkEntry: number[] }> {
  await setTimeout(2000)
  try {
    const lines = (await readFile('.local/browser-online-tail.jsonl', 'utf8')).trim().split('\n')
    const result = { gateway: [] as number[], chunkEntry: [] as number[] }
    for (const line of lines) {
      const row = JSON.parse(line) as { time: string; worker: string; cpuTime?: number; logs?: Array<{ event?: string; file_id?: string }> }
      if (Date.parse(row.time) < platformSince || row.worker !== manifest.gatewayName || typeof row.cpuTime !== 'number') continue
      if (row.logs?.some((log) => log.event === 'browser_chunk' && ids.includes(log.file_id ?? ''))) result.gateway.push(row.cpuTime)
      if (row.logs?.some((log) => log.event === 'chunk' && ids.includes(log.file_id ?? ''))) result.chunkEntry.push(row.cpuTime)
    }
    return result
  } catch { return { gateway: [], chunkEntry: [] } }
}

async function runBrowserTrials(): Promise<void> {
  const candidates: Array<{ mib: number; cpu: number[]; durationMs: number }> = []
  const cacheEnabled = (actualConfig.vars as Record<string, string>).BROWSER_CHUNK_CACHE_ENABLED !== 'false'
  if (process.argv.includes('--large-only')) {
    const prior = [...(report.browserTrials ?? [])].reverse().find((trial) => trial.mib === 1 && trial.cacheEnabled === cacheEnabled && trial.passed === true)
    const sourceRun = prior ? report.runs.find((item) => item.runId === prior.runId) : undefined
    const coverage = prior?.cpuCoverage as { gateway?: number[]; chunkEntry?: number[] } | undefined
    const cpu = [...coverage?.gateway ?? [], ...coverage?.chunkEntry ?? []]
    // 明确的边界复核：至少保留 1ms 余量，且必须复用同一活动构建/配置的完整样本。
    if (!sourceRun || sourceRun.buildHash !== run.buildHash || sourceRun.configHash !== run.configHash || sourceRun.gatewayVersion !== run.gatewayVersion || !coverage || (coverage.gateway?.length ?? 0) < 6 || (coverage.chunkEntry?.length ?? 0) < 6 || Math.max(...cpu) > 9) throw new Error('缺少同一构建下两类CPU均低于10ms的完整1MiB候选证据')
    candidates.push({ mib: 1, cpu, durationMs: Number(prior!.durationMs) })
    report.browserTrials!.push({ runId, reviewOnly: true, sourceRun: sourceRun.runId, maximumCpuMs: 9, marginMs: 1, cacheEnabled })
  } else {
  const smallPassed = await caseRun('1 MiB 新分片基础完整性', async () => { await browserFull(await register('browser-basic', MiB), MiB) })
  if (!smallPassed) return
  for (const mib of [16, 8, 4, 1]) {
    platformLimited = false
    platformSince = Date.now()
    const ids: string[] = []
    const started = Date.now()
    const passed = await caseRun(`${mib} MiB 分片冷/热三组 SHA-256（缓存${cacheEnabled ? '开启' : '关闭'}）`, async () => {
      for (let sample = 0; sample < 3; sample++) {
        const file = await register(`chunk-${mib}-${sample}`, mib * MiB)
        ids.push((await browserMetadata(file)).id)
        await browserFull(file, mib * MiB)
        const before = await originCounts(file)
        await browserFull(file, mib * MiB)
        const after = await originCounts(file)
        run.cache.push({ mib, cacheEnabled, before, after })
        await refreshPlatformLimit()
        if (platformLimited) throw new Error('候选分片触发平台限制')
      }
    })
    const coverage = await trialCpu(ids)
    const cpu = [...coverage.gateway, ...coverage.chunkEntry]
    const durationMs = Date.now() - started
    report.browserTrials!.push({ runId, mib, cacheEnabled, passed, cpuMs: cpu, cpuCoverage: coverage, durationMs, platformLimited, ids })
    await save()
    if (passed && coverage.gateway.length >= 6 && coverage.chunkEntry.length >= 6 && Math.max(...cpu) <= 8) candidates.push({ mib, cpu, durationMs })
  }
  }
  // 可观测 CPU 不足也必须停在未验收状态，不能把没有报错当成满足 Free CPU 预算。
  const best = candidates.sort((a, b) => a.durationMs / a.mib - b.durationMs / b.mib || b.mib - a.mib)[0]
  if (!best) {
    await caseRun('100/500/1024 MiB 扩大验证', async () => {}, '没有具备 CPU 余量和完整观测的候选；不扩大流量')
    return
  }
  report.browserTrials!.push({ runId, selectedMiB: best.mib, cacheEnabled })
  await save()
  platformLimited = false
  platformSince = Date.now()
  let stable = true
  for (const mib of [100, 500, 1024]) {
    stable = await caseRun(`${mib} MiB 独立分片完整下载 SHA-256`, async () => {
      const file = await register(`browser-large-${mib}`, mib * MiB)
      await browserFull(file, best.mib * MiB)
      const id = new URL(file.url).pathname.split('/')[2]
      const cpuCoverage = await trialCpu([id])
      const requests = run.http.filter((item) => item.path === `/api/files/${id}/chunk`).length
      report.browserTrials!.push({ runId, fullSizeMiB: mib, requests, cpuCoverage, cacheEnabled })
      await save()
      // 小样本余量不能代替整文件证据；缺少调用或出现标称预算外 CPU 都阻止扩大。
      if (cpuCoverage.gateway.length < requests || cpuCoverage.chunkEntry.length < requests || Math.max(...cpuCoverage.gateway, ...cpuCoverage.chunkEntry) >= 10) throw new Error('完整性已通过，但CPU超出标称预算或Tail覆盖不足；停止扩大')
      await setTimeout(2000)
      await refreshPlatformLimit()
      if (platformLimited) throw new Error('扩大验证出现平台限制')
    }, stable && !platformLimited ? undefined : '前一级未通过，停止扩大')
  }
  await caseRun('1 GiB 分片中断后重试 SHA-256', async () => {
    await browserFull(await register('browser-recovery', 1024 * MiB), best.mib * MiB, true)
  }, stable && !platformLimited ? undefined : '完整下载阶段未通过，不执行额外大文件')
}
