// Secret 值由 Wrangler 注入；示例文件只提供占位符，禁止提交实际凭据。
interface Env {
  FEISHU_APP_ID: string
  FEISHU_APP_SECRET: string
  FEISHU_VERIFICATION_TOKEN: string
  FEISHU_ENCRYPT_KEY: string
  ALLOWED_OPEN_IDS?: string
  ADMIN_OPEN_IDS?: string
}
