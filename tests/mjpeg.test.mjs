import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJpegFrames, concatBytes } from '../src/mjpeg.mjs'

test('extractJpegFrames extracts complete frames across split multipart chunks', () => {
  const header = new TextEncoder().encode('--123456\r\nContent-Type: image/jpeg\r\n\r\n')
  const frame1 = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9])
  const frame2 = new Uint8Array([0xff, 0xd8, 0x0a, 0x0b, 0xff, 0xd9])

  // Split right inside SOI (0xFF | 0xD8) and inside frame2
  const chunkA = concatBytes(header, frame1.slice(0, 1))
  const chunkB = concatBytes(frame1.slice(1), concatBytes(header, frame2.slice(0, 4)))
  const chunkC = frame2.slice(4)

  const resA = extractJpegFrames(chunkA)
  assert.equal(resA.frames.length, 0)
  assert.deepEqual(resA.remainder, new Uint8Array([0xff]))

  const resB = extractJpegFrames(concatBytes(resA.remainder, chunkB))
  assert.equal(resB.frames.length, 1)
  assert.deepEqual(resB.frames[0], frame1)
  assert.deepEqual(resB.remainder, frame2.slice(0, 4))

  const resC = extractJpegFrames(concatBytes(resB.remainder, chunkC))
  assert.equal(resC.frames.length, 1)
  assert.deepEqual(resC.frames[0], frame2)
  assert.equal(resC.remainder.length, 0)
})
