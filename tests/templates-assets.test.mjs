import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as THREE from 'three'
import { validateGlbBuffer } from '../server/models.mjs'
import { classifyModelNodes } from '../src/scene-utils.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

function parseGlbJson(buf) {
  const jsonLen = buf.readUInt32LE(12)
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
}

function accessorDivisor(acc) {
  if (!acc?.normalized) return 1
  if (acc.componentType === 5122) return 32767 // SHORT
  if (acc.componentType === 5123) return 65535 // UNSIGNED_SHORT
  if (acc.componentType === 5120) return 127   // BYTE
  if (acc.componentType === 5121) return 255   // UNSIGNED_BYTE
  return 1
}

function collectBounds(gltf) {
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const node of gltf.nodes ?? []) {
    if (!Number.isInteger(node.mesh)) continue
    const mesh = gltf.meshes?.[node.mesh]
    const scale = node.scale ?? [1, 1, 1]
    const trans = node.translation ?? [0, 0, 0]
    for (const prim of mesh?.primitives ?? []) {
      const accIdx = prim.attributes?.POSITION
      if (!Number.isInteger(accIdx)) continue
      const acc = gltf.accessors?.[accIdx]
      if (!acc?.min || !acc?.max) continue
      const div = accessorDivisor(acc)
      const xs = [(acc.min[0] / div) * scale[0] + trans[0], (acc.max[0] / div) * scale[0] + trans[0]]
      const ys = [(acc.min[1] / div) * scale[1] + trans[1], (acc.max[1] / div) * scale[1] + trans[1]]
      const zs = [(acc.min[2] / div) * scale[2] + trans[2], (acc.max[2] / div) * scale[2] + trans[2]]
      minX = Math.min(minX, ...xs)
      maxX = Math.max(maxX, ...xs)
      minY = Math.min(minY, ...ys)
      maxY = Math.max(maxY, ...ys)
      minZ = Math.min(minZ, ...zs)
      maxZ = Math.max(maxZ, ...zs)
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ }
}

const TEMPLATES = [
  { name: 'stealthburner', file: 'public/models/templates/stealthburner.glb', maxBytes: 800_000 },
  { name: 'mini-stealthburner', file: 'public/models/templates/mini-stealthburner.glb', maxBytes: 600_000 },
]

for (const tpl of TEMPLATES) {
  test(`${tpl.name}.glb is valid Meshopt GLB v2 under ${tpl.maxBytes} bytes with required live tags`, async () => {
    const abs = path.join(ROOT, tpl.file)
    const buf = await readFile(abs)
    const info = validateGlbBuffer(buf)
    assert.equal(info.assetVersion, '2.0')
    assert.ok(buf.byteLength > 10_000, `${tpl.name}.glb too small (${buf.byteLength} B)`)
    assert.ok(buf.byteLength <= tpl.maxBytes, `${tpl.name}.glb exceeds budget (${buf.byteLength} > ${tpl.maxBytes})`)

    const gltf = parseGlbJson(buf)
    assert.ok(
      Array.isArray(gltf.extensionsUsed) && gltf.extensionsUsed.includes('EXT_meshopt_compression'),
      `${tpl.name}.glb must use EXT_meshopt_compression`,
    )

    const nodeNames = new Set((gltf.nodes ?? []).map(n => String(n.name ?? '').toUpperCase()))
    const matNames = new Set((gltf.materials ?? []).map(m => String(m.name ?? '').toUpperCase()))
    const allNames = new Set([...nodeNames, ...matNames])

    for (const required of ['VORON_ACCENT', 'LED_LOGO', 'LED_NOZZLE_L', 'LED_NOZZLE_R', 'NOZZLE_TIP', 'FILAMENT_INLET']) {
      const found = [...allNames].some(name => name.includes(required))
      assert.ok(found, `${tpl.name}.glb missing required tag ${required}; nodes=${[...nodeNames].join(',')}; mats=${[...matNames].join(',')}`)
    }

    const bounds = collectBounds(gltf)
    const height = bounds.maxY - bounds.minY
    assert.ok(height >= 0.05 && height <= 0.22, `${tpl.name}.glb height out of range: ${height.toFixed(4)} m`)
    assert.ok(
      bounds.minY >= -0.01 && bounds.minY <= 0.01,
      `${tpl.name}.glb bottom should be grounded near y=0 (got ${bounds.minY.toFixed(4)} m)`,
    )

    // Reconstruct scene graph from GLB JSON and verify classifyModelNodes maps all 3 distinct LED roles
    const root = new THREE.Group()
    const materials = (gltf.materials ?? []).map(m => new THREE.MeshStandardMaterial({ name: m.name ?? '' }))
    for (const node of gltf.nodes ?? []) {
      let obj
      if (Number.isInteger(node.mesh)) {
        const meshDef = gltf.meshes?.[node.mesh]
        const matIdx = meshDef?.primitives?.[0]?.material
        const mat = Number.isInteger(matIdx) ? materials[matIdx] : new THREE.MeshStandardMaterial()
        obj = new THREE.Mesh(new THREE.BufferGeometry(), mat)
      } else {
        obj = new THREE.Object3D()
      }
      obj.name = node.name ?? ''
      if (node.extras && typeof node.extras === 'object') obj.userData = { ...node.extras }
      root.add(obj)
    }
    const classified = classifyModelNodes(root)
    assert.ok(classified.accentMeshes.length >= 1, `${tpl.name}.glb must classify at least 1 accent mesh`)
    assert.ok(classified.nozzleTipNode, `${tpl.name}.glb must classify NOZZLE_TIP`)
    assert.ok(classified.filamentInletNode, `${tpl.name}.glb must classify FILAMENT_INLET`)
    const ledRoles = classified.ledMeshes.map(m => m.userData.ledRole).sort()
    assert.deepEqual(
      ledRoles,
      ['left', 'number', 'right'],
      `${tpl.name}.glb LED roles misclassified: ${ledRoles.join(', ')}`,
    )
  })
}
