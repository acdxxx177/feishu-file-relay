import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export function startBrowser(executable: string, args: string[]) {
  let stderr = ''
  let spawnError: Error | undefined
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  // 只保留测试浏览器的有界错误尾部，启动失败时输出，避免仅剩调试端口超时。
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
  child.on('error', error => { spawnError = error })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => { exit = { code, signal }; resolve(exit) })
  })
  const failure = (reason: string) => new Error([
    reason, `Browser: ${executable}`,
    ...(spawnError ? [`Spawn error: ${spawnError.message}`] : []),
    ...(exit ? [`Exit code: ${exit.code}; signal: ${exit.signal}`] : []),
    `Chromium stderr: ${stderr.trim() || '(empty)'}`,
  ].join('\n'))

  return {
    closed,
    failure,
    async endpoint(profile: string, timeoutMs = 30_000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (spawnError || exit) throw failure('Chromium exited before exposing its debugging endpoint')
        try {
          const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
          if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && path?.startsWith('/devtools/browser/')) {
            return `ws://127.0.0.1:${Number(port)}${path}`
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await Promise.race([delay(50), closed])
      }
      throw failure('Timed out waiting for Chromium debugging endpoint')
    },
    async stop() {
      if (exit) return
      child.kill()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await closed } finally { clearTimeout(timer) }
    },
  }
}
