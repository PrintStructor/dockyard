import * as THREE from 'three'

export const LED_DISCRETE_LERP_MS = 140
export const LED_OFF_COLOR = new THREE.Color('#697479')
export const LED_ZERO_COLOR = new THREE.Color(0)

export function colorNear(a, b, eps = 1e-4) {
  return Math.abs(a.r - b.r) < eps && Math.abs(a.g - b.g) < eps && Math.abs(a.b - b.b) < eps
}

export function klipperRgbwToColor(rgbw) {
  if (!Array.isArray(rgbw) || rgbw.length < 3) return LED_OFF_COLOR.clone()
  const w = Number.isFinite(rgbw[3]) ? rgbw[3] : 0
  return new THREE.Color().setRGB(
    Math.min(1, Math.max(0, (Number(rgbw[0]) || 0) + w)),
    Math.min(1, Math.max(0, (Number(rgbw[1]) || 0) + w)),
    Math.min(1, Math.max(0, (Number(rgbw[2]) || 0) + w)),
  )
}

export function stepLedMeshes(ledMeshes, now) {
  let animating = false
  for (const object of ledMeshes) {
    const anim = object.userData.ledAnim
    if (!anim) continue
    const progress = Math.min(1, Math.max(0, (now - anim.start) / Math.max(1, anim.duration)))
    object.material.color.lerpColors(anim.fromColor, anim.toColor, progress)
    object.material.emissive.lerpColors(anim.fromEmissive, anim.toEmissive, progress)
    object.material.emissiveIntensity = anim.fromIntensity + (anim.toIntensity - anim.fromIntensity) * progress
    if (progress < 1) {
      animating = true
    } else {
      object.userData.ledAnim = null
    }
  }
  return animating
}

export function applyLedTargets(
  ledMeshes,
  getRgbwForMesh,
  { now = 0, duration = LED_DISCRETE_LERP_MS, force = false, reducedMotion = false, nozzleIntensity = 4.5 } = {},
) {
  let anyChanged = false
  for (const object of ledMeshes) {
    const c = getRgbwForMesh(object)
    const toColor = c ? klipperRgbwToColor(c) : LED_OFF_COLOR
    const toEmissive = c ? toColor : LED_ZERO_COLOR
    const toIntensity = c ? (object.userData.ledRole === 'number' ? 2.3 : nozzleIntensity) : 0

    if (force || reducedMotion || !object.userData.ledInit) {
      object.material.color.copy(toColor)
      object.material.emissive.copy(toEmissive)
      object.material.emissiveIntensity = toIntensity
      object.userData.ledAnim = null
      object.userData.ledInit = true
    } else {
      const pendingAnim = object.userData.ledAnim
      const targetUnchanged =
        pendingAnim &&
        colorNear(pendingAnim.toColor, toColor) &&
        colorNear(pendingAnim.toEmissive, toEmissive) &&
        Math.abs(pendingAnim.toIntensity - toIntensity) <= 1e-3
      const alreadyAtTarget =
        !pendingAnim &&
        colorNear(object.material.color, toColor) &&
        colorNear(object.material.emissive, toEmissive) &&
        Math.abs(object.material.emissiveIntensity - toIntensity) <= 1e-3
      if (!targetUnchanged && !alreadyAtTarget) {
        anyChanged = true
        object.userData.ledAnim = {
          fromColor: object.material.color.clone(),
          toColor: toColor.clone(),
          fromEmissive: object.material.emissive.clone(),
          toEmissive: toEmissive.clone(),
          fromIntensity: object.material.emissiveIntensity,
          toIntensity,
          start: now,
          duration,
        }
      }
    }
  }
  return anyChanged
}

export function createStudioLights() {
  const hemi = new THREE.HemisphereLight(0xe3edff, 0x65716a, 2.25)
  const key = new THREE.DirectionalLight(0xfff6e9, 3.9)
  key.position.set(3, 5, 5)
  const fill = new THREE.DirectionalLight(0xc5d4ef, 1.8)
  fill.position.set(-4, 2, -3)
  const rim = new THREE.DirectionalLight(0xd4ecff, 2.2)
  rim.position.set(0, 1.9, -4.5)
  return [hemi, key, fill, rim]
}

export function buildThermalGlowTexture() {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(128, 128, 4, 128, 128, 126)
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
  grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.55)')
  grad.addColorStop(0.62, 'rgba(255, 255, 255, 0.16)')
  grad.addColorStop(0.88, 'rgba(255, 255, 255, 0.03)')
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 256, 256)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function buildStudioFloorVeil({ width = 0.86, depth = 0.42, tickXs = [] } = {}) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#1b252a'
  ctx.fillRect(0, 0, 512, 256)

  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.translate(256, 128)
  ctx.scale(1.0, 0.52)
  const cutout = ctx.createRadialGradient(0, 0, 48, 0, 0, 238)
  cutout.addColorStop(0, 'rgba(0, 0, 0, 0.90)')
  cutout.addColorStop(0.55, 'rgba(0, 0, 0, 0.72)')
  cutout.addColorStop(0.84, 'rgba(0, 0, 0, 0.22)')
  cutout.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = cutout
  ctx.beginPath()
  ctx.arc(0, 0, 240, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  if (tickXs.length > 0) {
    ctx.strokeStyle = 'rgba(128, 152, 162, 0.34)'
    ctx.lineWidth = 1.25
    for (const worldX of tickXs) {
      const px = Math.round(((worldX / width) + 0.5) * 512) + 0.5
      ctx.beginPath()
      ctx.moveTo(px, 198)
      ctx.lineTo(px, 212)
      ctx.stroke()
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const veil = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  )
  veil.rotation.x = -Math.PI / 2
  veil.renderOrder = 1
  return veil
}

function resolveRole(object) {
  const extraRole = String(object.userData?.dockyardRole ?? '').trim().toLowerCase()
  if (
    extraRole === 'led-logo' ||
    extraRole === 'led-nozzle-l' ||
    extraRole === 'led-nozzle-r' ||
    extraRole === 'accent' ||
    extraRole === 'nozzle-tip' ||
    extraRole === 'filament-inlet'
  ) {
    return extraRole
  }

  const name = String(object.name ?? '').toUpperCase()
  if (name.includes('LED_NOZZLE_L')) return 'led-nozzle-l'
  if (name.includes('LED_NOZZLE_R')) return 'led-nozzle-r'
  if (name.includes('LED_LOGO')) return 'led-logo'
  if (name.includes('VORON_ACCENT')) return 'accent'
  if (name.includes('NOZZLE_TIP')) return 'nozzle-tip'
  if (name.includes('FILAMENT_INLET')) return 'filament-inlet'

  const mats = Array.isArray(object.material) ? object.material : object.material ? [object.material] : []
  const matNames = mats.map(m => String(m?.name ?? '').toUpperCase())
  if (matNames.some(m => m.includes('LED_NOZZLE_L'))) return 'led-nozzle-l'
  if (matNames.some(m => m.includes('LED_NOZZLE_R'))) return 'led-nozzle-r'
  if (matNames.some(m => m.includes('LED_LOGO'))) return 'led-logo'
  if (matNames.some(m => m.includes('VORON_ACCENT'))) return 'accent'
  if (matNames.some(m => m.includes('NOZZLE_TIP'))) return 'nozzle-tip'
  if (matNames.some(m => m.includes('FILAMENT_INLET'))) return 'filament-inlet'

  return null
}

export function createModelLoadGuard() {
  let generation = 0
  let loadedUrl = ''
  let loading = false

  function begin(url, { hasLoadedModel = false, forceReload = false } = {}) {
    const gen = ++generation
    if (!forceReload && url && url === loadedUrl && hasLoadedModel) {
      loading = false
      return { gen, skip: true }
    }
    loading = true
    return { gen, skip: false }
  }

  function markLoaded(gen, url) {
    if (gen !== generation) return false
    loadedUrl = url || ''
    loading = false
    return true
  }

  function finish(gen) {
    if (gen !== generation) return false
    loading = false
    return true
  }

  function isCurrent(gen) {
    return gen === generation
  }

  function isLoading() {
    return loading
  }

  function clearLoaded() {
    loadedUrl = ''
  }

  function reset() {
    generation++
    loadedUrl = ''
    loading = false
  }

  return { begin, markLoaded, finish, isCurrent, isLoading, clearLoaded, reset }
}

export function classifyModelNodes(root) {
  const accentMeshes = []
  const ledMeshes = []
  let nozzleTipNode = null
  let filamentInletNode = null

  root.traverse(object => {
    const role = resolveRole(object)
    if (!role) return
    if (role === 'nozzle-tip') {
      if (!nozzleTipNode) nozzleTipNode = object
      return
    }
    if (role === 'filament-inlet') {
      if (!filamentInletNode) filamentInletNode = object
      return
    }
    if (!object.isMesh) return
    if (role === 'accent') {
      accentMeshes.push(object)
    } else if (role === 'led-logo' || role === 'led-nozzle-l' || role === 'led-nozzle-r') {
      object.userData.ledRole = role === 'led-logo' ? 'number' : role === 'led-nozzle-l' ? 'left' : 'right'
      ledMeshes.push(object)
    }
  })

  return { accentMeshes, ledMeshes, nozzleTipNode, filamentInletNode }
}

export function detectNozzleTip(root, nozzleTipNode = null) {
  root.updateMatrixWorld(true)
  if (nozzleTipNode) {
    if (nozzleTipNode.isMesh && nozzleTipNode.geometry?.attributes?.position) {
      const box = new THREE.Box3().setFromObject(nozzleTipNode)
      if (!box.isEmpty()) {
        const center = box.getCenter(new THREE.Vector3())
        return new THREE.Vector3(center.x, box.min.y, center.z)
      }
    }
    return nozzleTipNode.getWorldPosition(new THREE.Vector3())
  }
  let minY = Infinity
  const meshes = []
  root.traverse(object => {
    if (!object.isMesh || !object.geometry?.attributes?.position) return
    meshes.push(object)
    const box = new THREE.Box3().setFromObject(object)
    if (box.min.y < minY) minY = box.min.y
  })
  if (!Number.isFinite(minY)) return null

  const threshold = minY + 0.0025
  const v = new THREE.Vector3()
  let sumX = 0
  let sumZ = 0
  let count = 0
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position
    const mat = mesh.matrixWorld
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat)
      if (v.y <= threshold) {
        sumX += v.x
        sumZ += v.z
        count++
      }
    }
  }
  return count > 0 ? new THREE.Vector3(sumX / count, minY, sumZ / count) : null
}

export function detectFilamentInlet(root, filamentInletNode = null, nozzleTip = null) {
  if (!root) return null
  root.updateMatrixWorld(true)
  if (filamentInletNode) {
    if (filamentInletNode.isMesh && filamentInletNode.geometry?.attributes?.position) {
      const box = new THREE.Box3().setFromObject(filamentInletNode)
      if (!box.isEmpty()) {
        const center = box.getCenter(new THREE.Vector3())
        return new THREE.Vector3(center.x, box.max.y, center.z)
      }
    }
    return filamentInletNode.getWorldPosition(new THREE.Vector3())
  }

  const fullBox = new THREE.Box3().setFromObject(root)
  if (fullBox.isEmpty()) return null
  const height = fullBox.max.y - fullBox.min.y
  if (!Number.isFinite(height) || height <= 0.01) return null

  const tip = nozzleTip ?? detectNozzleTip(root)
  const center = fullBox.getCenter(new THREE.Vector3())
  const ax = tip ? tip.x : center.x
  const az = tip ? tip.z : center.z

  const meshes = []
  root.traverse(object => {
    if (object.isMesh && object.geometry?.attributes?.position) {
      meshes.push(object)
    }
  })

  // Cast a compact 5-ray crosshair straight down along the vertical filament axis
  // (center + 4mm collet rim ring) so flat top plates and hollow 4mm ECAS bores
  // both hit the exact extruder top without being fooled by taller rear CAN boards.
  const down = new THREE.Vector3(0, -1, 0)
  const startY = fullBox.max.y + 0.05
  const ring = 0.004
  const rayOffsets = [
    [0, 0],
    [ring, 0],
    [-ring, 0],
    [0, ring],
    [0, -ring],
  ]
  const raycaster = new THREE.Raycaster()
  let bestY = -Infinity
  for (const [dx, dz] of rayOffsets) {
    raycaster.set(new THREE.Vector3(ax + dx, startY, az + dz), down)
    const hits = raycaster.intersectObjects(meshes, false)
    if (hits.length > 0 && hits[0].point.y > bestY) {
      bestY = hits[0].point.y
    }
  }

  if (bestY <= fullBox.min.y + height * 0.45) {
    const radius = Math.max(0.006, Math.min(0.012, height * 0.07))
    const v = new THREE.Vector3()
    for (const mesh of meshes) {
      const pos = mesh.geometry.attributes.position
      const mat = mesh.matrixWorld
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mat)
        if (Math.abs(v.x - ax) <= radius && Math.abs(v.z - az) <= radius && v.y > bestY) {
          bestY = v.y
        }
      }
    }
  }

  const inletY = bestY > fullBox.min.y + height * 0.45 ? bestY : fullBox.max.y
  return new THREE.Vector3(ax, inletY, az)
}

export function disposeObjectTree(root) {
  if (!root) return
  const geometries = new Set()
  const materials = new Set()
  const textures = new Set()
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry)
    if (object.material) {
      const list = Array.isArray(object.material) ? object.material : [object.material]
      for (const mat of list) {
        if (!mat) continue
        materials.add(mat)
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap']) {
          if (mat[key]?.dispose) textures.add(mat[key])
        }
      }
    }
  })
  geometries.forEach(geometry => geometry.dispose?.())
  textures.forEach(texture => texture.dispose?.())
  materials.forEach(material => material.dispose?.())
}
