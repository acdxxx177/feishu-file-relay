import { spawn } from 'node:child_process'
import { access, appendFile, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface Manifest { accountId: string; gatewayName: string; mockName: string; configPath: string; mockConfigPath: string }
const manifest = JSON.parse(await readFile('.local/online-test.json', 'utf8')) as Manifest
const logPath = '.local/online-tail.jsonl'
const limitPath = '.local/online-platform-limits.json'
const stopPath = '.local/online-tail.stop'
await unlink(stopPath).catch(() => {})
const allowedKeys = new Set(['event', 'file_id', 'status', 'bytes', 'index', 'cache', 'origin_requests', 'origin_calls', 'duration_ms', 'attempt', 'attempts'])
let writing = Promise.resolve()
function record(worker: string, value: Record<string, unknown>) {
  const logs = Array.isArray(value.logs) ? value.logs.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('message' in item) || !Array.isArray(item.message)) return []
    return item.message.flatMap((message: unknown) => {
      if (typeof message !== 'string') return []
      try {
        const parsed: unknown = JSON.parse(message)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
        return [Object.fromEntries(Object.entries(parsed).filter(([key]) => allowedKeys.has(key)))]
      } catch { return [] }
    })
  }) : []
  const outcome = typeof value.outcome === 'string' ? value.outcome : ''
  const exceptions = Array.isArray(value.exceptions) ? value.exceptions.map((item: unknown) => {
    const exception = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      name: typeof exception.name === 'string' ? exception.name.slice(0, 80) : '',
      // 只保留平台错误类别，不保存可能携带URL/凭据的原始异常文本。
      resourceLimit: typeof exception.message === 'string' && /1102|exceeded|CPU|too many subrequests|memory limit/i.test(exception.message),
    }
  }) : []
  const safe = { time: new Date().toISOString(), worker, outcome, cpuTime: value.cpuTime, wallTime: value.wallTime, exceptions, logs }
  writing = writing.then(async () => {
    await appendFile(logPath, JSON.stringify(safe) + '\n')
    if (/exceeded|limit/i.test(outcome) || exceptions.some((item) => item.resourceLimit)) {
      await writeFile(`${limitPath}.tmp`, JSON.stringify({ limited: true, time: safe.time, worker, outcome }) + '\n')
      const { rename } = await import('node:fs/promises')
      await rename(`${limitPath}.tmp`, limitPath)
    }
  }).catch(() => { process.stderr.write('保存脱敏测试日志失败\n') })
}

const children = [
  { name: manifest.gatewayName, config: manifest.configPath },
  { name: manifest.mockName, config: manifest.mockConfigPath },
].map(({ name, config }) => {
  const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'tail', name, '--config', config, '--format', 'json'], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: manifest.accountId }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    while (true) {
      const start = buffer.indexOf('{')
      if (start < 0) { buffer = ''; break }
      let depth = 0
      let quoted = false
      let escaped = false
      let end = -1
      for (let i = start; i < buffer.length; i++) {
        const character = buffer[i]
        if (quoted) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') quoted = false
        } else if (character === '"') quoted = true
        else if (character === '{') depth++
        else if (character === '}' && --depth === 0) { end = i + 1; break }
      }
      if (end < 0) { buffer = buffer.slice(start); break }
      try { record(name, JSON.parse(buffer.slice(start, end)) as Record<string, unknown>) } catch { /* 丢弃非事件输出 */ }
      buffer = buffer.slice(end)
    }
    if (buffer.length > 1024 * 1024) buffer = ''
  })
  child.stderr.on('data', () => { /* 不保存未经筛选的CLI文本 */ })
  child.on('error', () => process.stderr.write(`测试日志连接失败：${name}\n`))
  child.on('exit', (code) => { if (code) process.stderr.write(`测试日志连接退出：${name} (${code})\n`) })
  return child
})
console.log('正在采集两个隔离Worker的脱敏事件，不保存请求头、请求体或原始异常内容')
const stop = () => { clearInterval(stopWatcher); for (const child of children) child.kill(); void writing.finally(() => process.exit()) }
const stopWatcher = setInterval(() => { void access(stopPath).then(stop, () => {}) }, 2000)
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setTimeout(stop, 30 * 60 * 1000)
