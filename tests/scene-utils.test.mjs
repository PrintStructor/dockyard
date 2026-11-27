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
  computeExactFitDistance,
  classifyModelNodes,
  detectNozzleTip,
  detectFilamentInlet,
  disposeObjectTree,
  createModelLoadGuard,
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

  // Fan ducts hovering 2 mm above the nozzle tip must NOT skew the nozzle centroid
  const ducts = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.05), new THREE.MeshStandardMaterial())
  ducts.position.set(0.01, 0.012, -0.04) // minY = 0.002 m (2 mm above nozzle tip)
  root.add(ducts)
  const tight = detectNozzleTip(root, null)
  assert.ok(Math.abs(tight.x - 0.01) < 1e-5, `expected nozzle x=0.01, got ${tight.x}`)
  assert.ok(Math.abs(tight.z - -0.02) < 1e-5, `expected nozzle z=-0.02, got ${tight.z}`)
})

test('detectFilamentInlet supports explicit anchors, baked Fusion meshes, and nozzle-axis auto-detection', () => {
  const root = new THREE.Group()

  // Toolhead body along nozzle axis (x=0.004, z=0.003, height 0..0.118m)
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.118, 0.03), new THREE.MeshStandardMaterial())
  body.position.set(0.004, 0.059, 0.003)

  // Taller rear CAN board sticking up behind the extruder (z=-0.032, height 0.129m)
  const rearCan = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.01), new THREE.MeshStandardMaterial())
  rearCan.position.set(0.004, 0.109, -0.032)

  root.add(body, rearCan)

  // 1. Auto-detection follows the vertical nozzle column and ignores the taller rear CAN board
  const tip = new THREE.Vector3(0.004, 0, 0.003)
  const autoInlet = detectFilamentInlet(root, null, tip)
  assert.ok(Math.abs(autoInlet.x - 0.004) < 1e-5)
  assert.ok(Math.abs(autoInlet.y - 0.118) < 1e-4, `expected collet top 0.118, got ${autoInlet.y}`)
  assert.ok(Math.abs(autoInlet.z - 0.003) < 1e-5)

  // 2. Baked Fusion mesh named FILAMENT_INLET (node at origin, vertices offset in world space)
  const bakedGeo = new THREE.BoxGeometry(0.008, 0.006, 0.008)
  bakedGeo.translate(0.012, 0.115, -0.002)
  const bakedInlet = new THREE.Mesh(bakedGeo, new THREE.MeshStandardMaterial())
  bakedInlet.name = 'FILAMENT_INLET'
  root.add(bakedInlet)
  const fromMesh = detectFilamentInlet(root, bakedInlet, tip)
  assert.ok(Math.abs(fromMesh.x - 0.012) < 1e-5)
  assert.ok(Math.abs(fromMesh.y - 0.118) < 1e-5)
  assert.ok(Math.abs(fromMesh.z - -0.002) < 1e-5)

  // 3. Explicit empty Object3D anchor (built-in templates)
  const emptyAnchor = new THREE.Object3D()
  emptyAnchor.name = 'FILAMENT_INLET'
  emptyAnchor.position.set(-0.002, 0.124, 0.001)
  root.add(emptyAnchor)
  const fromAnchor = detectFilamentInlet(root, emptyAnchor, tip)
  assert.ok(Math.abs(fromAnchor.x - -0.002) < 1e-5)
  assert.ok(Math.abs(fromAnchor.y - 0.124) < 1e-5)
  assert.ok(Math.abs(fromAnchor.z - 0.001) < 1e-5)
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

test('classifyModelNodes prioritizes dockyardRole and node name over deduplicated material name', () => {
  const root = new THREE.Group()
  const sharedMat = new THREE.MeshStandardMaterial({ name: 'LED_LOGO_MAT' })

  const nozzleL = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), sharedMat)
  nozzleL.name = 'LED_NOZZLE_L'

  const nozzleR = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), sharedMat)
  nozzleR.name = 'SomeMesh'
  nozzleR.userData = { dockyardRole: 'led-nozzle-r' }

  const logo = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), sharedMat)
  logo.name = 'LED_LOGO'

  root.add(logo, nozzleL, nozzleR)
  const classified = classifyModelNodes(root)
  assert.deepEqual(
    classified.ledMeshes.map(m => m.userData.ledRole),
    ['number', 'left', 'right'],
  )
})

test('createModelLoadGuard cancels in-flight loads when switching back to already-loaded URL or tearing down', () => {
  const guard = createModelLoadGuard()
  const reqA = guard.begin('/a.glb', { hasLoadedModel: false })
  assert.equal(reqA.skip, false)
  guard.markLoaded(reqA.gen, '/a.glb')
  assert.equal(guard.isLoading(), false)

  // Start loading B while A is still mounted
  const reqB = guard.begin('/b.glb', { hasLoadedModel: true })
  assert.equal(reqB.skip, false)
  assert.equal(guard.isLoading(), true)

  // Rapidly switch back to A before B resolves -> must invalidate B and clear loading
  const backToA = guard.begin('/a.glb', { hasLoadedModel: true })
  assert.equal(backToA.skip, true)
  assert.equal(guard.isCurrent(reqB.gen), false)
  assert.equal(guard.isLoading(), false)

  // Start loading C, then teardown before C resolves -> must invalidate C and clear loading
  const reqC = guard.begin('/c.glb', { hasLoadedModel: true })
  assert.equal(guard.isLoading(), true)
  guard.reset()
  assert.equal(guard.isCurrent(reqC.gen), false)
  assert.equal(guard.isLoading(), false)
})

test('computeExactFitDistance frames tall printer boxes without corner cropping and balanced lights tame glare', () => {
  const tallPrinter = new THREE.Box3(new THREE.Vector3(-0.15, 0, -0.15), new THREE.Vector3(0.15, 0.44, 0.15))
  const dir = new THREE.Vector3(0.52, 0.28, 0.81).normalize()
  const vFov = THREE.MathUtils.degToRad(36)
  const aspect = 1.6
  const dist = computeExactFitDistance(tallPrinter, dir, vFov, aspect, 1.14)

  // Verify all 8 bounding-box corners project inside NDC [-1, 1] with margin
  const center = tallPrinter.getCenter(new THREE.Vector3())
  const cam = new THREE.PerspectiveCamera(36, aspect, 0.01, 50)
  cam.position.copy(center).addScaledVector(dir, dist)
  cam.lookAt(center)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()

  for (const x of [tallPrinter.min.x, tallPrinter.max.x]) {
    for (const y of [tallPrinter.min.y, tallPrinter.max.y]) {
      for (const z of [tallPrinter.min.z, tallPrinter.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(cam)
        assert.ok(Math.abs(p.x) <= 0.92, `corner X clipped: ${p.x}`)
        assert.ok(Math.abs(p.y) <= 0.92, `corner Y clipped: ${p.y}`)
      }
    }
  }

  const defaultLights = createStudioLights()
  const balancedLights = createStudioLights({ balanced: true })
  assert.equal(balancedLights.length, 4)
  assert.ok(balancedLights[0].intensity < defaultLights[0].intensity)
  assert.ok(balancedLights[1].intensity < defaultLights[1].intensity)
})
