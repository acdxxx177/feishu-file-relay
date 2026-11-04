import { BlockList, isIP } from 'node:net'

export function parseTrustedProxyIps(value = ''): string[] {
  if (!value.trim()) return []
  const addresses = value.split(',').map((address) => address.trim())
  if (addresses.some((address) => !isIP(address) || address.includes('%'))) {
    throw new Error('Invalid configuration: TRUSTED_PROXY_IPS')
  }
  return [...new Set(addresses)]
}

export function trustedProxyCheck(addresses: string[]): (address: string) => boolean {
  const trusted = new BlockList()
  for (const address of ['127.0.0.1', '::1', ...addresses]) {
    trusted.addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
  }
  // 使用 Node 的地址匹配处理 IPv4-mapped IPv6，避免字符串差异绕过可信来源判断。
  return (address) => {
    const family = isIP(address)
    return family !== 0 && trusted.check(address, family === 6 ? 'ipv6' : 'ipv4')
  }
}
