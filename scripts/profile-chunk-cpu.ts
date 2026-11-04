import assert from 'node:assert/strict'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setup, register, digest } from '../tests/helpers.ts'
import { bytesAt } from '../mocks/feishu-mock.ts'

// 只运行本地 workerd/Node 模拟源，不读取线上配置、凭据或预算。
const label = process.argv[2] ?? 'current'
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid profile label')
const scriptPath = process.argv[3] ?? 'dist/index.js'
const artifactSha256 = createHash('sha256').update(await readFile(scriptPath)).digest('hex')
const exec = promisify(execFile)
async function runtimeCpuMilliseconds(): Promise<number | null> {
  if (process.platform !== 'win32') return null
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', `$runtime = Get-CimInstance Win32_Process -Filter "Name='workerd.exe' AND ParentProcessId=${process.pid}"; if (@($runtime).Count -ne 1) { throw 'Expected one owned workerd' }; (Get-Process -Id $runtime.ProcessId).TotalProcessorTime.TotalMilliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)`], { windowsHide: true })
  const value = Number(stdout.trim())
  if (!Number.isFinite(value)) throw new Error('Missing workerd CPU evidence')
  return value
}
const h = await setup({ scriptPath, inspectorPort: 0, downloadRateLimit: 6000, bindings: { BROWSER_CHUNK_CACHE_ENABLED: 'false', UPSTREAM_READ_TIMEOUT_MS: '30000' } })
let socket: WebSocket | undefined
try {
  const file = await register(h, `profile-${label}`, 2 * 1024 * 1024)
  const meta = await (await h.request(`/api/files/${file.id}`)).json() as { etag: string }
  const headers = { Range: 'bytes=1-1048576', 'If-Match': meta.etag }
  const expected = createHash('sha256').update(bytesAt(1, 1048576)).digest('hex')
  for (let i = 0; i < 5; i++) assert.equal((await digest(await h.request(`/api/files/${file.id}/chunk`, { headers }))).sha256, expected)
  const inspector = await h.mf.getInspectorURL()
  const targets = await (await fetch(new URL('/json/list', inspector.href.replace('ws:', 'http:')))).json() as Array<{ title: string; webSocketDebuggerUrl: string }>
  const target = targets.find((item) => item.title.includes('relay'))
  if (!target) throw new Error(`Missing local relay inspector: ${targets.map((item) => item.title)}`)
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  let nextId = 0
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result: Record<string, unknown>; error?: unknown }
    if (message.id === undefined) return
    const call = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) call?.reject(new Error(JSON.stringify(message.error)))
    else call?.resolve(message.result)
  })
  const call = (method: string, params = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket!.send(JSON.stringify({ id, method, params }))
  })
  await call('Profiler.enable')
  await call('Profiler.setSamplingInterval', { interval: 100 })
  const cpuBefore = await runtimeCpuMilliseconds()
  await call('Profiler.start')
  const started = performance.now()
  const requests = 1000
  for (let i = 0; i < requests; i++) {
    const response = await h.request(`/api/files/${file.id}/chunk`, { headers })
    assert.equal(response.status, 206)
    assert.equal((await digest(response)).sha256, expected)
  }
  const durationMs = performance.now() - started
  const { profile } = await call('Profiler.stop') as unknown as { profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[]; timeDeltas: number[] } }
  const cpuAfter = await runtimeCpuMilliseconds()
  assert.equal(createHash('sha256').update(await readFile(scriptPath)).digest('hex'), artifactSha256, 'Profile artifact changed during run')
  const counts = new Map<number, number>()
  for (const sample of profile.samples) counts.set(sample, (counts.get(sample) ?? 0) + 1)
  const selfSamples = profile.nodes.filter((node) => counts.has(node.id)).map((node) => ({ ...node.callFrame, samples: counts.get(node.id)! })).sort((a, b) => b.samples - a.samples)
  await mkdir('.local/chunk-cpu', { recursive: true })
  await writeFile(`.local/chunk-cpu/${label}.cpuprofile`, JSON.stringify(profile))
  const report = { label, requests, bytes: requests * 1048576, durationMs, runtimeCpuMs: cpuAfter === null || cpuBefore === null ? null : cpuAfter - cpuBefore, artifactSha256, selfSamples, note: 'Local sampling profile, not Cloudflare request CPU or Free-plan proof; native/GC/idle samples are retained. OS CPU covers the entire owned workerd process including internal D1/bridge isolates. Source generation and client hashing run in Node outside this profiled isolate.' }
  await writeFile(`.local/chunk-cpu/${label}.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  socket?.close()
  await h.mf.dispose()
}
