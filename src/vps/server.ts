import { serve } from '@hono/node-server'
import type { Socket } from 'node:net'
import type { Config } from './config'
import type { RelayRepository } from '../db/repository'
import { createFeishuClient, type FeishuClient } from './feishu'
import { createApplication } from './app'
import { safeNodeResponse } from './node-response'

export function startServer(config: Config, repository: RelayRepository, feishu: FeishuClient = createFeishuClient(config)) {
  const application = createApplication(config, repository, feishu)
  const abort = new AbortController()
  const sockets = new Set<Socket>()
  const server = serve({ hostname: config.host, port: config.port,
    async fetch(request, bindings) {
      const disconnect = new AbortController()
      const cancel = () => { if (!bindings.outgoing.writableFinished) disconnect.abort() }
      bindings.outgoing.once('close', cancel)
      // 不使用 incoming 的正常 close 事件：完整读完 webhook 请求体也会触发它。
      const signal = AbortSignal.any([request.signal, disconnect.signal, abort.signal])
      return safeNodeResponse(await application.app.fetch(new Request(request, { signal }), bindings), bindings.outgoing)
    },
  })
  server.on('connection', (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  application.scheduler.start()
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    if (closing) return closing
    application.stop()
    closing = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const drained = Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), application.scheduler.drain()])
      await Promise.race([drained, new Promise<void>((resolve) => { timeout = setTimeout(resolve, config.shutdownMs) })])
      clearTimeout(timeout)
      abort.abort()
      application.scheduler.abort()
      feishu.close()
      for (const socket of sockets) socket.destroy()
      await repository.close()
    })()
    return closing
  }
  return { server, application, close }
}
