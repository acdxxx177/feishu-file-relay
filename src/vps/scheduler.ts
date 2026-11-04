import type { Config } from './config'
import type { RelayRepository } from '../db/repository'
import type { FeishuClient } from './feishu'
import { runScheduled, type IntakeContext } from './intake'

export function createScheduler(config: Config, repository: RelayRepository, feishu: FeishuClient) {
  const abort = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let requested = false
  let cleanupAt = 0
  const context: IntakeContext = {
    repository, feishu, signal: abort.signal, shouldStop: () => stopped,
    waitUntil(promise) {
      pending.add(promise)
      void promise.catch(() => {}).finally(() => pending.delete(promise))
    },
    wake,
  }
  function wake() {
    if (stopped) return
    if (running) { requested = true; return }
    clearTimeout(timer)
    running = (async () => {
      try {
        await runScheduled(config, context)
        if (!stopped && Date.now() >= cleanupAt) {
          await repository.cleanupEvents()
          cleanupAt = Date.now() + 3600000
        }
      } catch { console.error(JSON.stringify({ event: 'background_processing_failed' })) }
    })().finally(() => {
      running = undefined
      if (!stopped) {
        timer = setTimeout(wake, requested ? 0 : config.pollMs)
        timer.unref()
      }
      requested = false
    })
  }
  return {
    context, start: wake,
    stop() { stopped = true; clearTimeout(timer) },
    abort() { abort.abort() },
    async drain() { await running; await Promise.allSettled([...pending]) },
  }
}
