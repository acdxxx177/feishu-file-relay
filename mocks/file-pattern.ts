const blockSize = 65536
const pattern = new Uint8Array(blockSize)
for (let index = 0; index < pattern.length; index++) pattern[index] = (index * 31 + (index >>> 8) * 17) % 256

// 纯 Web API 实现供 Node 和线上 Worker 共用；每个块都携带绝对块号，避免整片错序仍通过哈希。
export function patternBytesAt(start: number, length: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(length)
  let written = 0
  while (written < length) {
    const offset = (start + written) % blockSize
    const count = Math.min(length - written, blockSize - offset)
    output.set(pattern.subarray(offset, offset + count), written)
    const block = Math.floor((start + written) / blockSize)
    for (let index = offset; index < Math.min(offset + count, 16); index++) {
      output[written + index - offset] = (block >>> ((index % 4) * 8)) & 255
    }
    written += count
  }
  return output
}

export function patternStream(start: number, length: number, onBytes?: (bytes: number) => void): ReadableStream<Uint8Array> {
  let offset = start
  const end = start + length
  return new ReadableStream({
    pull(controller) {
      if (offset === end) { controller.close(); return }
      const count = Math.min(blockSize, end - offset)
      controller.enqueue(patternBytesAt(offset, count))
      offset += count
      onBytes?.(count)
    },
  }, { highWaterMark: 0 })
}
