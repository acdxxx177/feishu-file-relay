import { defineConfig } from 'prisma/config'

// 只供 schema 校验和离线 diff；生产 D1 由显式 Wrangler 迁移命令管理。
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.PRISMA_SCHEMA_URL ?? 'file:./.local/prisma-schema.db' },
})
