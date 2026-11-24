const MAX_BUFFER_BYTES = 8 * 1024 * 1024

function findMarker(bytes, first, second, start = 0) {
  for (let i = start; i < bytes.length - 1; i++) {
    if (bytes[i] === first && bytes[i + 1] === second) return i
  }
  return -1
}

export function concatBytes(a, b) {
  if (!a.length) return b
  if (!b.length) return a
  const merged = new Uint8Array(a.length + b.length)
  merged.set(a, 0)
  merged.set(b, a.length)
  return merged
}

/**
 * Extract complete JPEG frames (SOI 0xFF 0xD8 .. EOI 0xFF 0xD9) from a streaming MJPEG buffer.
 * Returns extracted frame slices plus the unconsumed trailing remainder.
 */
export function extractJpegFrames(buffer) {
  const frames = []
  let cursor = 0

  while (cursor < buffer.length - 1) {
    const start = findMarker(buffer, 0xff, 0xd8, cursor)
    if (start === -1) {
      // Keep the very last byte in case it is 0xFF preceding 0xD8 in the next chunk.
      const keep = buffer.length > 0 && buffer[buffer.length - 1] === 0xff ? buffer.slice(-1) : new Uint8Array(0)
      return { frames, remainder: keep }
    }

    const end = findMarker(buffer, 0xff, 0xd9, start + 2)
    if (end === -1) {
      const slice = buffer.slice(start)
      return {
        frames,
        remainder: slice.length > MAX_BUFFER_BYTES ? new Uint8Array(0) : slice,
      }
    }

    frames.push(buffer.slice(start, end + 2))
    cursor = end + 2
  }

  return { frames, remainder: cursor < buffer.length ? buffer.slice(cursor) : new Uint8Array(0) }
}
