import type { Config } from './config'
import type { DownloadLocation } from './download-sessions'
import { trustedProxyCheck } from './trusted-proxy'

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

export function createLocationReader(config: Pick<Config, 'trustCloudflareGeo' | 'trustProxy' | 'trustedProxyIps'>) {
  const trusted = trustedProxyCheck(config.trustedProxyIps)
  return (request: Request, remote: string | undefined): DownloadLocation => {
    if (!config.trustCloudflareGeo || !config.trustProxy || !remote || !trusted(remote) ||
        request.headers.get('X-Relay-Geo-Trusted') !== '1') return {}
    const rawCountry = request.headers.get('X-Relay-Geo-Country')
    const country = rawCountry && /^[A-Z]{2}$/.test(rawCountry) && !['XX', 'ZZ'].includes(rawCountry) &&
      new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(rawCountry) ? rawCountry : undefined
    const region = locationText(request.headers.get('X-Relay-Geo-Region'))
    const city = locationText(request.headers.get('X-Relay-Geo-City'))
    return { ...(country ? { country } : {}), ...(region ? { region } : {}), ...(city ? { city } : {}) }
  }
}
