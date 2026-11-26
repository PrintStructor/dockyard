import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  LED_OFF_COLOR,
  LED_ZERO_COLOR,
  LED_DISCRETE_LERP_MS,
  colorNear,
  klipperRgbwToColor,
  stepLedMeshes,
  applyLedTargets,
  createStudioLights,
  classifyModelNodes,
  detectNozzleTip,
  disposeObjectTree,
} from '../src/scene-utils.mjs'

test('klipperRgbwToColor boosts RGB by W channel and clamps to [0, 1]', () => {
  const c = klipperRgbwToColor([0.8, 0.1, 0.1, 0.3])
  assert.ok(Math.abs(c.r - 1.0) < 1e-6)
  assert.ok(Math.abs(c.g - 0.4) < 1e-6)
  assert.ok(Math.abs(c.b - 0.4) < 1e-6)
  assert.equal(colorNear(LED_ZERO_COLOR, new THREE.Color(0, 0, 0)), true)
  assert.ok(LED_OFF_COLOR instanceof THREE.Color)
  assert.ok(LED_DISCRETE_LERP_MS > 0)
})

test('classifyModelNodes detects VORON_ACCENT, LED_* nodes/roles, NOZZLE_TIP and FILAMENT_INLET', () => {
  const root = new THREE.Group()

  const accentByMat = new THREE.Mesh(
    new THREE.BoxGeometry(0.01, 0.01, 0.01),
    new THREE.MeshStandardMaterial({ name: 'VORON_ACCENT', color: 0xff0000 }),
  )
  accentByMat.name = 'FrontFaceplate'

  const accentByName = new THREE.Mesh(
    new THREE.BoxGeometry(0.01, 0.01, 0.01),
    new THREE.MeshStandardMaterial({ name: 'Generic', color: 0xffffff }),
  )
  accentByName.name = 'Cowling_VORON_ACCENT'

  const ledLogo = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshStandardMaterial())
  ledLogo.name = 'LED_LOGO'

  const ledLeft = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshStandardMaterial())
  ledLeft.name = 'LED_NOZZLE_L'

  const ledRight = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshStandardMaterial())
  ledRight.name = 'LED_NOZZLE_R'

  const ledByExtra = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshStandardMaterial())
  ledByExtra.name = 'CustomBadge'
  ledByExtra.userData = { dockyardRole: 'led-logo' }

  const nozzleTip = new THREE.Object3D()
  nozzleTip.name = 'NOZZLE_TIP'
  nozzleTip.position.set(0.002, 0, -0.005)

  const inlet = new THREE.Object3D()
  inlet.name = 'FILAMENT_INLET'
  inlet.position.set(0.002, 0.13, -0.005)

  root.add(accentByMat, accentByName, ledLogo, ledLeft, ledRight, ledByExtra, nozzleTip, inlet)
  const classified = classifyModelNodes(root)

  assert.equal(classified.accentMeshes.length, 2)
  assert.equal(classified.ledMeshes.length, 4)
  assert.deepEqual(
    classified.ledMeshes.map(m => m.userData.ledRole),
    ['number', 'left', 'right', 'number'],
  )
  assert.equal(classified.nozzleTipNode, nozzleTip)
  assert.equal(classified.filamentInletNode, inlet)
})

test('detectNozzleTip prefers explicit NOZZLE_TIP node and falls back to lowest-vertex centroid', () => {
  const root = new THREE.Group()
  const cone = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 0.02), new THREE.MeshStandardMaterial())
  cone.position.set(0.01, 0.05, -0.02)
  root.add(cone)

  const tipNode = new THREE.Object3D()
  tipNode.name = 'NOZZLE_TIP'
  tipNode.position.set(0.005, 0.001, -0.01)
  root.add(tipNode)

  const explicit = detectNozzleTip(root, tipNode)
  assert.ok(Math.abs(explicit.x - 0.005) < 1e-5)
  assert.ok(Math.abs(explicit.y - 0.001) < 1e-5)
  assert.ok(Math.abs(explicit.z - -0.01) < 1e-5)

  const fallback = detectNozzleTip(root, null)
  assert.ok(Math.abs(fallback.x - 0.01) < 1e-5)
  assert.ok(Math.abs(fallback.y - 0.0) < 1e-5)
  assert.ok(Math.abs(fallback.z - -0.02) < 1e-5)
})

test('applyLedTargets and stepLedMeshes handle immediate updates and smooth interpolation', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0, emissive: 0 }))
  mesh.userData.ledRole = 'number'

  // Initial forced update sets target immediately without animation
  applyLedTargets([mesh], () => [1, 0, 0, 0], { now: 100, duration: 200, force: true, reducedMotion: false })
  assert.equal(mesh.userData.ledAnim, null)
  assert.ok(Math.abs(mesh.material.color.r - 1) < 1e-5)
  assert.ok(Math.abs(mesh.material.emissiveIntensity - 2.3) < 1e-5)

  // Subsequent change creates smooth interpolation
  const changed = applyLedTargets([mesh], () => [0, 1, 0, 0], { now: 200, duration: 200, force: false, reducedMotion: false })
  assert.equal(changed, true)
  assert.ok(mesh.userData.ledAnim)

  const stillMoving = stepLedMeshes([mesh], 300)
  assert.equal(stillMoving, true)
  assert.ok(mesh.material.color.r > 0.4 && mesh.material.color.r < 0.6)
  assert.ok(mesh.material.color.g > 0.4 && mesh.material.color.g < 0.6)

  const finished = stepLedMeshes([mesh], 450)
  assert.equal(finished, false)
  assert.equal(mesh.userData.ledAnim, null)
  assert.ok(Math.abs(mesh.material.color.g - 1) < 1e-5)
})

test('createStudioLights builds 4-light rig and disposeObjectTree disposes shared resources once', () => {
  const lights = createStudioLights()
  assert.equal(lights.length, 4)

  let geoDisposes = 0
  let matDisposes = 0
  const sharedGeo = { dispose: () => geoDisposes++ }
  const matA = { dispose: () => matDisposes++ }
  const matB = { dispose: () => matDisposes++ }
  const root = new THREE.Group()
  const m1 = new THREE.Object3D()
  m1.geometry = sharedGeo
  m1.material = matA
  const m2 = new THREE.Object3D()
  m2.geometry = sharedGeo
  m2.material = [matA, matB]
  root.add(m1, m2)

  disposeObjectTree(root)
  assert.equal(geoDisposes, 1)
  assert.equal(matDisposes, 2)
})
