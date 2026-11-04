import { readConfig } from './config'
import { createRemoteRepository } from '../db/prisma-repository'
import { startServer } from './server'

try {
  const config = readConfig(process.env)
  const repository = createRemoteRepository({ accountId: config.accountId, databaseId: config.databaseId, token: config.token, budget: config.d1Budget })
  const runtime = startServer(config, repository)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void runtime.close().then(() => process.exit(0), () => process.exit(1))
  })
} catch {
  console.error(JSON.stringify({ event: 'startup_failed', hint: 'Check required environment configuration' }))
  process.exitCode = 1
}
