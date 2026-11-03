const encoder = new TextEncoder()

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object')
  return value as Record<string, unknown>
}

async function equal(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

function recent(value: unknown, skew: number): boolean {
  if (typeof value !== 'string' || !/^\d{10,16}$/.test(value)) return false
  const number = Number(value)
  const milliseconds = number > 1e12 ? number : number * 1000
  return Number.isSafeInteger(milliseconds) && Math.abs(Date.now() - milliseconds) <= skew * 1000
}

export async function decodeAndVerify(raw: string, request: Request, env: Env): Promise<Record<string, unknown>> {
  let body = record(JSON.parse(raw))
  if (typeof body.encrypt === 'string') {
    if (!env.FEISHU_ENCRYPT_KEY) throw new Error('Unexpected encryption')
    const ciphertext = Uint8Array.from(atob(body.encrypt), (value) => value.charCodeAt(0))
    if (ciphertext.length < 32 || ciphertext.length % 16 !== 0) throw new Error('Invalid ciphertext')
    const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(env.FEISHU_ENCRYPT_KEY))
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ciphertext.slice(0, 16) }, key, ciphertext.slice(16))
    body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)))
  }
  const header = body.type === 'url_verification' ? body : record(body.header)
  if (!env.FEISHU_VERIFICATION_TOKEN || typeof header.token !== 'string' || !await equal(header.token, env.FEISHU_VERIFICATION_TOKEN)) throw new Error('Invalid token')
  // 飞书 URL 校验不保证带事件签名/时间戳；challenge 仍必须通过 Token 与加密策略。
  if (body.type === 'url_verification') return body
  const skew = Number(env.WEBHOOK_MAX_SKEW_SECONDS || '300')
  if (!Number.isFinite(skew) || skew <= 0 || !recent(header.create_time, skew)) throw new Error('Expired event')
  if (header.app_id !== env.FEISHU_APP_ID) throw new Error('Wrong application')
  const timestamp = request.headers.get('X-Lark-Request-Timestamp')
  if (timestamp !== null && !recent(timestamp, skew)) throw new Error('Expired request')
  if (env.FEISHU_ENCRYPT_KEY) {
    const nonce = request.headers.get('X-Lark-Request-Nonce')
    const signature = request.headers.get('X-Lark-Signature')
    if (!timestamp || !nonce || !signature || !/^[a-f0-9]{64}$/i.test(signature)) throw new Error('Missing signature')
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(timestamp + nonce + env.FEISHU_ENCRYPT_KEY + raw))
    const expected = Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
    if (!await equal(signature.toLowerCase(), expected)) throw new Error('Invalid signature')
  }
  return body
}

export { record }
