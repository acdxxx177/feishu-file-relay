import type { Config } from './config'
import type { DownloadLocation } from './download-sessions'

function locationText(value: string | null): string | undefined {
  if (!value || value.length > 512) return
  if ([...value].some(char => char.charCodeAt(0) > 255)) return
  let decoded: string
  try {
    // Node 将原始 HTTP header 字节映射为 Latin-1；Cloudflare 的地理头使用 UTF-8。
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1'))
  } catch { return }
  decoded = decoded.trim().normalize('NFC')
  if (!decoded || decoded.length > 128 || /[\p{Cc}\p{Cf}]/u.test(decoded) || decoded.includes(',')) return
  return decoded
}

export function createLocationReader(config: Pick<Config, 'trustCloudflareGeo' | 'trustProxy'>) {
  return (request: Request): DownloadLocation => {
    // 地理头由部署入口覆盖；开关启用后仅检查标记，不再依赖容器来源 IP。
    if (!config.trustCloudflareGeo || !config.trustProxy ||
        request.headers.get('X-Relay-Geo-Trusted') !== '1') return {}
    const rawCountry = request.headers.get('X-Relay-Geo-Country')
    const country = rawCountry && /^[A-Z]{2}$/.test(rawCountry) && !['XX', 'ZZ'].includes(rawCountry) &&
      new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(rawCountry) ? rawCountry : undefined
    const region = locationText(request.headers.get('X-Relay-Geo-Region'))
    const city = locationText(request.headers.get('X-Relay-Geo-City'))
    return { ...(country ? { country } : {}), ...(region ? { region } : {}), ...(city ? { city } : {}) }
  }
}
