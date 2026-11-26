import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { validateGlbBuffer } from '../server/models.mjs'
import { classifyModelNodes } from '../src/scene-utils.mjs'
import {
  MAX_RAW_MODEL_BYTES,
  MAX_UPLOAD_MODEL_BYTES,
  OPTIMIZE_THRESHOLD_BYTES,
  inspectGlbHeader,
  shouldOptimizeGlb,
  optimizeGlbBuffer,
} from '../src/glb-optimizer.mjs'

function makeDenseSphereMesh(segments = 24, offsetX = 0) {
  const geo = new THREE.SphereGeometry(0.05, segments, segments)
  geo.translate(offsetX, 0.05, 0)
  const pos = Array.from(geo.attributes.position.array)
  const norm = Array.from(geo.attributes.normal.array)
  const idx = Array.from(geo.index.array)
  geo.dispose()
  return { pos, norm, idx }
}

function buildTestGlb({ segments = 24 } = {}) {
  const parts = [
    { name: 'VORON_ACCENT', role: 'accent', color: [0.84, 0.12, 0.12, 1], ...makeDenseSphereMesh(segments, 0) },
    { name: 'FRAME_BLACK', role: null, color: [0.03, 0.03, 0.03, 1], ...makeDenseSphereMesh(segments, 0.12) },
    { name: 'GLASS_PANEL', role: null, color: [0.18, 0.28, 0.32, 0.14], ...makeDenseSphereMesh(8, -0.12) },
    { name: 'LED_LOGO', role: 'led-logo', color: [0.2, 0.2, 0.2, 1], ...makeDenseSphereMesh(8, 0.0) },
    { name: 'LED_NOZZLE_L', role: 'led-nozzle-l', color: [0.2, 0.2, 0.2, 1], ...makeDenseSphereMesh(8, -0.02) },
    { name: 'LED_NOZZLE_R', role: 'led-nozzle-r', color: [0.2, 0.2, 0.2, 1], ...makeDenseSphereMesh(8, 0.02) },
  ]

  const binChunks = []
  let byteOffset = 0
  const bufferViews = []
  const accessors = []
  const materials = []
  const meshes = []
  const nodes = []

  const appendView = (typedArray, target) => {
    const raw = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength)
    const pad = (4 - (raw.length % 4)) % 4
    const idx = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset, byteLength: raw.length, target })
    binChunks.push(raw)
    if (pad) binChunks.push(Buffer.alloc(pad))
    byteOffset += raw.length + pad
    return idx
  }

  for (const part of parts) {
    const posArr = new Float32Array(part.pos)
    const normArr = new Float32Array(part.norm)
    const idxArr = new Uint32Array(part.idx)
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < posArr.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (posArr[i + a] < min[a]) min[a] = posArr[i + a]
        if (posArr[i + a] > max[a]) max[a] = posArr[i + a]
      }
    }
    const posAcc = accessors.length
    accessors.push({ bufferView: appendView(posArr, 34962), componentType: 5126, count: posArr.length / 3, type: 'VEC3', min, max })
    const normAcc = accessors.length
    accessors.push({ bufferView: appendView(normArr, 34962), componentType: 5126, count: normArr.length / 3, type: 'VEC3' })
    const idxAcc = accessors.length
    accessors.push({ bufferView: appendView(idxArr, 34963), componentType: 5125, count: idxArr.length, type: 'SCALAR' })

    const matIdx = materials.length
    const mat = {
      name: `mat_${part.name}`,
      pbrMetallicRoughness: { baseColorFactor: part.color, metallicFactor: 0.1, roughnessFactor: 0.5 },
      doubleSided: true,
    }
    if (part.color[3] < 0.99) mat.alphaMode = 'BLEND'
    materials.push(mat)

    const meshIdx = meshes.length
    meshes.push({ name: part.name, primitives: [{ attributes: { POSITION: posAcc, NORMAL: normAcc }, indices: idxAcc, material: matIdx }] })
    const node = { name: part.name, mesh: meshIdx }
    if (part.role) node.extras = { dockyardRole: part.role }
    nodes.push(node)
  }

  // Empty anchors must survive optimization
  nodes.push({ name: 'NOZZLE_TIP', translation: [0, 0, 0], extras: { dockyardRole: 'nozzle-tip' } })
  nodes.push({ name: 'FILAMENT_INLET', translation: [0, 0.1, 0], extras: { dockyardRole: 'filament-inlet' } })

  const binBlob = Buffer.concat(binChunks)
  const gltf = {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBlob.length }],
  }
  const rawJson = Buffer.from(JSON.stringify(gltf), 'utf8')
  const jsonPad = (4 - (rawJson.length % 4)) % 4
  const jsonBuf = jsonPad ? Buffer.concat([rawJson, Buffer.alloc(jsonPad, 0x20)]) : rawJson

  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBlob.length, 8)
  const jh = Buffer.alloc(8)
  jh.writeUInt32LE(jsonBuf.length, 0)
  jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8)
  bh.writeUInt32LE(binBlob.length, 0)
  bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jh, jsonBuf, bh, binBlob])
}

test('inspectGlbHeader and shouldOptimizeGlb enforce size and compression thresholds', () => {
  const glb = buildTestGlb({ segments: 8 })
  const info = inspectGlbHeader(glb)
  assert.equal(info.valid, true)
  assert.equal(info.hasMeshopt, false)
  assert.equal(info.bytes, glb.byteLength)

  assert.equal(inspectGlbHeader(Buffer.from('not a glb')).valid, false)

  // Small uncompressed file skips optimization
  assert.equal(shouldOptimizeGlb({ valid: true, bytes: 500_000, hasMeshopt: false, hasDraco: false }), false)
  // Already Meshopt file under 25 MB skips optimization
  assert.equal(shouldOptimizeGlb({ valid: true, bytes: 5_000_000, hasMeshopt: true, hasDraco: false }), false)
  // Uncompressed file above threshold triggers optimization
  assert.equal(
    shouldOptimizeGlb({ valid: true, bytes: OPTIMIZE_THRESHOLD_BYTES + 1, hasMeshopt: false, hasDraco: false }),
    true,
  )
  // Oversized Meshopt file above 25 MB still triggers re-optimization
  assert.equal(
    shouldOptimizeGlb({ valid: true, bytes: MAX_UPLOAD_MODEL_BYTES + 1000, hasMeshopt: true, hasDraco: false }),
    true,
  )
  assert.ok(MAX_RAW_MODEL_BYTES >= 100 * 1024 * 1024)
})

test('optimizeGlbBuffer applies Meshopt + Simplify while preserving colors, alphaMode BLEND, and all 6 live DOCKYARD tags', async () => {
  const raw = buildTestGlb({ segments: 32 })
  const result = await optimizeGlbBuffer(raw, { slot: 'printer', force: true })
  assert.equal(result.optimized, true)
  assert.ok(result.optimizedBytes < result.originalBytes * 0.5, `expected >50% reduction (${result.originalBytes} -> ${result.optimizedBytes})`)

  const outBuf = Buffer.from(result.bytes)
  const validated = validateGlbBuffer(outBuf)
  assert.equal(validated.assetVersion, '2.0')

  const gltf = JSON.parse(outBuf.subarray(20, 20 + validated.jsonChunkLength).toString('utf8'))
  assert.ok(gltf.extensionsUsed?.includes('EXT_meshopt_compression'), 'must use EXT_meshopt_compression')
  assert.ok(
    !gltf.materials.some(m => String(m.name || '').startsWith('PaletteMaterial')),
    'must not merge distinct solid colors into a palette texture',
  )
  assert.ok(gltf.materials.some(m => m.alphaMode === 'BLEND'), 'must preserve transparent glass BLEND material')

  // Verify all live nodes & roles classify cleanly via scene-utils
  const root = new THREE.Group()
  const mats = (gltf.materials ?? []).map(m => new THREE.MeshStandardMaterial({ name: m.name ?? '' }))
  for (const node of gltf.nodes ?? []) {
    let obj
    if (Number.isInteger(node.mesh)) {
      const mi = gltf.meshes[node.mesh]?.primitives?.[0]?.material
      obj = new THREE.Mesh(new THREE.BufferGeometry(), Number.isInteger(mi) ? mats[mi] : new THREE.MeshStandardMaterial())
    } else {
      obj = new THREE.Object3D()
    }
    obj.name = node.name ?? ''
    if (node.extras) obj.userData = { ...node.extras }
    root.add(obj)
  }
  const classified = classifyModelNodes(root)
  assert.ok(classified.accentMeshes.length >= 1)
  assert.ok(classified.nozzleTipNode)
  assert.ok(classified.filamentInletNode)
  assert.deepEqual(
    classified.ledMeshes.map(m => m.userData.ledRole).sort(),
    ['left', 'number', 'right'],
  )
})
