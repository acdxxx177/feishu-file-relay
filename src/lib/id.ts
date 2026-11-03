const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function newFileId(): string {
  let result = ''
  while (result.length < 22) {
    for (const value of crypto.getRandomValues(new Uint8Array(32))) {
      // 拒绝尾部余数，避免取模偏差；22 位 base62 提供约 131 bit 熵。
      if (value < 248 && result.length < 22) result += alphabet[value % 62]
    }
  }
  return result
}

export function cleanFileName(input: string): string {
  const encoder = new TextEncoder()
  const safe = input.replace(/[\\/\u0000-\u001f\u007f-\u009f]/g, '_').replace(/[\uD800-\uDFFF]/gu, '_').trim()
  let result = ''
  for (const character of safe) {
    if (encoder.encode(result + character).length > 255) break
    result += character
  }
  return result || 'download'
}
