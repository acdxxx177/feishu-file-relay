import { DatabaseSync } from 'node:sqlite'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// 仅创建本次专属本地影子库；从不连接或修改生产数据库。
await mkdir('.local', { recursive: true })
const databasePath = resolve(`.local/schema-${Date.now()}.db`)
const database = new DatabaseSync(databasePath)
for (const name of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
  database.exec(await readFile(`migrations/${name}`, 'utf8'))
}
database.close()
const result = spawnSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script', '--output', '.local/prisma-candidate.sql'], {
  env: { ...process.env, PRISMA_SCHEMA_URL: `file:${databasePath.replaceAll('\\', '/')}` }, stdio: 'inherit', windowsHide: true,
})
if (result.status !== 0) process.exitCode = result.status ?? 1
else console.log('候选 SQL 已写入 .local/prisma-candidate.sql；必须审查 CHECK、索引、默认值及表重建，禁止直接应用。影子库保留以供核对。')
