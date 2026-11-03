export interface ByteRange { start: number; end: number; partial: boolean }

export function parseRange(value: string | null, size: number): ByteRange | null {
  const full = { start: 0, end: size - 1, partial: false }
  if (!value || value.includes(',')) return full
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || size <= 0) return null
  const total = BigInt(size)
  if (!match[1]) {
    const suffix = BigInt(match[2])
    if (suffix === 0n) return null
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1, partial: true }
  }
  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : total - 1n
  if (start >= total || end < start) return null
  return { start: Number(start), end: Number(end >= total ? total - 1n : end), partial: true }
}

export function ifRangeMatches(value: string | null, etag: string, lastModified: string): boolean {
  if (!value) return true
  if (value.startsWith('"') || value.startsWith('W/')) return value === etag
  const date = Date.parse(value)
  return Number.isFinite(date) && date >= Date.parse(lastModified)
}
