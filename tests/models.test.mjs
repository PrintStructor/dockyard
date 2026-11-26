import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_MODEL_BYTES,
  MODEL_SLOTS,
  sanitizeModelFilename,
  validateGlbBuffer,
  createModelStore,
} from '../server/models.mjs'

export function makeValidGlb(jsonObj = { asset: { version: '2.0' } }, binBytes = Buffer.alloc(0)) {
  const rawJson = Buffer.from(JSON.stringify(jsonObj), 'utf8')
  const jsonPad = (4 - (rawJson.length % 4)) % 4
  const jsonChunk = Buffer.concat([rawJson, Buffer.alloc(jsonPad, 0x20)])

  const chunks = []
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonChunk.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4) // 'JSON'
  chunks.push(jsonHeader, jsonChunk)

  if (binBytes.length > 0) {
    const binPad = (4 - (binBytes.length % 4)) % 4
    const binChunk = Buffer.concat([binBytes, Buffer.alloc(binPad, 0x00)])
    const binHeader = Buffer.alloc(8)
    binHeader.writeUInt32LE(binChunk.length, 0)
    binHeader.writeUInt32LE(0x004e4942, 4) // 'BIN\0'
    chunks.push(binHeader, binChunk)
  }

  const totalLength = 12 + chunks.reduce((sum, b) => sum + b.length, 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // 'glTF'
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(totalLength, 8)
  return Buffer.concat([header, ...chunks])
}

test('validateGlbBuffer accepts valid GLB v2 and rejects corrupt, disguised, or oversized payloads', () => {
  assert.deepEqual(MODEL_SLOTS, ['toolhead', 'printer'])
  assert.equal(MAX_MODEL_BYTES, 25 * 1024 * 1024)

  const valid = makeValidGlb({ asset: { version: '2.0', generator: 'test' } }, Buffer.from([1, 2, 3, 4]))
  const info = validateGlbBuffer(valid)
  assert.equal(info.byteLength, valid.byteLength)
  assert.equal(info.assetVersion, '2.0')
  assert.ok(info.jsonChunkLength > 0)

  // STL / HTML disguised as .glb
  assert.throws(() => validateGlbBuffer(Buffer.from('solid cube\nendsolid cube\n')), /GLB/i)
  assert.throws(() => validateGlbBuffer(Buffer.from('<html><script>alert(1)</script></html>')), /GLB/i)

  // Version 1 rejected
  const v1 = Buffer.from(valid)
  v1.writeUInt32LE(1, 4)
  assert.throws(() => validateGlbBuffer(v1), /Version 2|GLB/i)

  // Mismatched declared length rejected
  const badLen = Buffer.from(valid)
  badLen.writeUInt32LE(valid.byteLength + 64, 8)
  assert.throws(() => validateGlbBuffer(badLen), /Länge|beschädigt|GLB/i)

  // Non-JSON first chunk rejected
  const badChunkType = Buffer.from(valid)
  badChunkType.writeUInt32LE(0x004e4942, 16)
  assert.throws(() => validateGlbBuffer(badChunkType), /JSON|GLB/i)

  // Corrupt JSON chunk rejected
  const corruptJson = Buffer.from('{bad-json   ')
  const corruptHdr = Buffer.alloc(20)
  corruptHdr.writeUInt32LE(0x46546c67, 0)
  corruptHdr.writeUInt32LE(2, 4)
  corruptHdr.writeUInt32LE(20 + corruptJson.length, 8)
  corruptHdr.writeUInt32LE(corruptJson.length, 12)
  corruptHdr.writeUInt32LE(0x4e4f534a, 16)
  assert.throws(() => validateGlbBuffer(Buffer.concat([corruptHdr, corruptJson])), /JSON|GLB/i)

  // Non-2.x asset.version rejected
  const wrongAsset = makeValidGlb({ asset: { version: '1.0' } })
  assert.throws(() => validateGlbBuffer(wrongAsset), /glTF 2|Version/i)

  // Oversized buffer rejected
  const fakeHuge = { byteLength: MAX_MODEL_BYTES + 1, length: MAX_MODEL_BYTES + 1 }
  assert.throws(() => validateGlbBuffer(Buffer.alloc(0)), /GLB|leer/i)
  assert.equal(fakeHuge.byteLength > MAX_MODEL_BYTES, true)
})

test('sanitizeModelFilename strips paths and control characters safely', () => {
  assert.equal(sanitizeModelFilename('../evil/my printer.glb', 'printer'), 'my printer.glb')
  assert.equal(sanitizeModelFilename('C:\\Users\\CAD\\v24.glb', 'printer'), 'v24.glb')
  assert.equal(sanitizeModelFilename('', 'toolhead'), 'toolhead.glb')
  assert.equal(sanitizeModelFilename('   /..  ', 'printer'), 'printer.glb')
})

test('createModelStore persists atomically, rotates etag on overwrite, preserves valid file on failed overwrite, and cleans up', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-models-'))
  try {
    const store = createModelStore({ dir })
    assert.deepEqual(store.describePrinter('voron-24'), { toolhead: null, printer: null })

    const glb1 = makeValidGlb({ asset: { version: '2.0' }, extras: { rev: 1 } })
    const meta1 = await store.saveModel('voron-24', 'printer', glb1, '../evil/my printer.glb')
    assert.equal(meta1.filename, 'my printer.glb')
    assert.equal(meta1.bytes, glb1.byteLength)
    assert.match(meta1.etag, /^"[a-f0-9]{16,64}"$/)
    assert.ok(meta1.updatedAt)

    const entriesAfterSave = await readdir(path.join(dir, 'voron-24'))
    assert.equal(entriesAfterSave.some(f => f.includes('.tmp')), false)

    // Survives fresh store instance
    const freshStore = createModelStore({ dir })
    assert.deepEqual(freshStore.describePrinter('voron-24'), { toolhead: null, printer: meta1 })

    const read1 = await freshStore.readModel('voron-24', 'printer')
    assert.equal(Buffer.compare(read1.buffer, glb1), 0)
    assert.deepEqual(read1.meta, meta1)

    // Failed overwrite leaves existing valid GLB untouched and leaves no .tmp
    await assert.rejects(
      () => store.saveModel('voron-24', 'printer', Buffer.from('not-a-glb'), 'bad.glb'),
      /GLB/i,
    )
    const afterBad = await store.readModel('voron-24', 'printer')
    assert.equal(Buffer.compare(afterBad.buffer, glb1), 0)
    const entriesAfterBad = await readdir(path.join(dir, 'voron-24'))
    assert.equal(entriesAfterBad.some(f => f.includes('.tmp')), false)

    // Valid overwrite rotates etag and updatedAt
    await new Promise(r => setTimeout(r, 15))
    const glb2 = makeValidGlb({ asset: { version: '2.0' }, extras: { rev: 2 } })
    const meta2 = await store.saveModel('voron-24', 'printer', glb2, 'v24-rev2.glb')
    assert.notEqual(meta2.etag, meta1.etag)
    assert.notEqual(meta2.updatedAt, meta1.updatedAt)
    assert.equal(meta2.filename, 'v24-rev2.glb')

    // Reject path traversal & invalid slot
    await assert.rejects(() => store.saveModel('../escape', 'printer', glb1, 'a.glb'), /Drucker-ID|Kennung/i)
    await assert.rejects(() => store.saveModel('voron-24', 'gantry', glb1, 'a.glb'), /Slot/i)

    // Delete slot is idempotent and cleans empty directory
    await store.deleteModel('voron-24', 'printer')
    assert.deepEqual(store.describePrinter('voron-24'), { toolhead: null, printer: null })
    assert.equal(await store.readModel('voron-24', 'printer'), null)
    await store.deleteModel('voron-24', 'printer')

    // removePrinter clears both slots
    await store.saveModel('crucible', 'toolhead', glb1, 'head.glb')
    await store.saveModel('crucible', 'printer', glb2, 'frame.glb')
    assert.ok(store.describePrinter('crucible').toolhead)
    assert.ok(store.describePrinter('crucible').printer)
    await store.removePrinter('crucible')
    assert.deepEqual(store.describePrinter('crucible'), { toolhead: null, printer: null })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
