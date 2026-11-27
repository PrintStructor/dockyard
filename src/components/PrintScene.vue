<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { RotateCcw, Grid3x3, Box, Layers, Eye, EyeOff, Loader2 } from '@lucide/vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { t, language } from '../i18n.mjs'

const props = defineProps({
  model: Object, // { header, segments: Float32Array }
  loading: Boolean,
  error: String,
  toolColors: { type: Array, default: () => [] },
  colorMode: { type: String, default: 'filament' }, // 'filament' | 'tools'
  clipLayer: { type: Number, default: 999999 },
  showGhost: { type: Boolean, default: true },
  showSupport: { type: Boolean, default: true },
  isLiveJob: Boolean,
  livePosition: Array,
  activeTool: { type: Number, default: null },
  excludeObjects: { type: Object, default: null },
  bedSize: { type: Object, default: null }, // { originX, originY, width, depth }
  printerLabel: { type: String, default: '' },
  accentColor: { type: String, default: '#c5f76b' },
  showColorModeToggle: { type: Boolean, default: true },
})

const emit = defineEmits(['update:colorMode', 'update:showSupport', 'update:showGhost', 'reload'])

const TOOL_PALETTE = ['#c5f76b', '#6ed5e7', '#bca3ff', '#f3c67b', '#ff9a83', '#ed9fc8']

function resolvedBed() {
  const b = props.bedSize
  const width = Number.isFinite(b?.width) && b.width >= 50 ? b.width : 350
  const depth = Number.isFinite(b?.depth) && b.depth >= 50 ? b.depth : 350
  const originX = Number.isFinite(b?.originX) ? b.originX : 0
  const originY = Number.isFinite(b?.originY) ? b.originY : 0
  return {
    originX,
    originY,
    width,
    depth,
    centerX: originX + width / 2,
    centerY: originY + depth / 2,
    halfW: width / 2,
    halfD: depth / 2,
  }
}

const bedCaption = computed(() => {
  const b = resolvedBed()
  const dim = `${Math.round(b.width)} × ${Math.round(b.depth)} mm`
  const prefix = String(props.printerLabel ?? '').trim()
  return prefix ? `${prefix} · ${dim}` : dim
})

const viewport = ref(null)
const webglError = ref('')
const cameraPreset = ref('iso')

let renderer = null
let scene = null
let camera = null
let controls = null
let resizeObserver = null
let intersectionObserver = null
let solidMesh = null
let ghostMesh = null
let solidMaterial = null
let ghostMaterial = null
let activeGeometry = null
let bedGroup = null
let nozzleMarker = null
let bedCrosshair = null
let excludeGroup = null
let frame = 0
let running = false
let visible = true
let disposed = false
let animation = null

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const hasModel = computed(() => !!props.model?.header?.segmentCount && !props.loading && !props.error && !webglError.value)
const hasSupport = computed(() => !!props.model?.header?.hasSupport)

function invalidate() {
  if (!running && !disposed && visible && !document.hidden && renderer) {
    running = true
    frame = requestAnimationFrame(render)
  }
}

function render(now) {
  running = false
  if (disposed || !visible || document.hidden || !renderer) return
  let moving = false
  if (animation) {
    const progress = Math.min(1, (now - animation.start) / 550)
    const eased = 1 - Math.pow(1 - progress, 4)
    camera.position.lerpVectors(animation.fromPosition, animation.toPosition, eased)
    controls.target.lerpVectors(animation.fromTarget, animation.toTarget, eased)
    moving = progress < 1
    if (!moving) animation = null
  }
  const changed = controls.update()
  renderer.render(scene, camera)
  if (moving || changed) invalidate()
}

function buildBeadBaseGeometry() {
  // 5-sided beveled extrusion profile in (acrossU, heightV) along X in [0..1]
  const profile = [
    [-0.5, -0.52],
    [-0.3, 0.0],
    [0.3, 0.0],
    [0.5, -0.52],
    [0.0, -1.0],
  ]

  const positions = []
  const profileNormals = []

  for (let i = 0; i < profile.length; i++) {
    const [u0, v0] = profile[i]
    const [u1, v1] = profile[(i + 1) % profile.length]
    // Outward normal in (u, v) plane: rotate edge (du, dv) by -90 deg -> (-dv, du)
    const du = u1 - u0
    const dv = v1 - v0
    const nLen = Math.hypot(du, dv) || 1
    const nu = -dv / nLen
    const nv = du / nLen

    // Two triangles forming the quad from x=0 to x=1
    const quad = [
      [0, u0, v0],
      [1, u0, v0],
      [1, u1, v1],
      [0, u0, v0],
      [1, u1, v1],
      [0, u1, v1],
    ]
    for (const [px, py, pz] of quad) {
      positions.push(px, py, pz)
      profileNormals.push(nu, nv)
    }
  }

  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aProfileNormal', new THREE.Float32BufferAttribute(profileNormals, 2))
  return geometry
}

const VERTEX_SHADER = `
  attribute vec2 aProfileNormal;
  attribute vec4 aStartEnd;
  attribute vec3 aDims;
  attribute float aMeta;

  uniform vec3 uToolColors[6];
  uniform vec3 uSupportColor;
  uniform vec2 uBedCenter;
  uniform float uClipLayer;
  uniform float uMode;
  uniform float uShowSupport;

  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vWorldPos;
  varying float vHeightV;
  varying float vLayerIdx;

  vec3 pickToolColor(float idx) {
    if (idx < 0.5) return uToolColors[0];
    if (idx < 1.5) return uToolColors[1];
    if (idx < 2.5) return uToolColors[2];
    if (idx < 3.5) return uToolColors[3];
    if (idx < 4.5) return uToolColors[4];
    return uToolColors[5];
  }

  void main() {
    float isSupport = mod(aMeta, 2.0);
    float toolIdx = mod(floor(aMeta / 2.0), 8.0);
    float layerIdx = floor(aMeta / 16.0);

    if (isSupport > 0.5 && uShowSupport < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    if (uMode < 0.5 && layerIdx > uClipLayer + 0.01) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    if (uMode > 0.5 && layerIdx <= uClipLayer + 0.01) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec2 p1 = vec2(aStartEnd.x - uBedCenter.x, -(aStartEnd.y - uBedCenter.y));
    vec2 p2 = vec2(aStartEnd.z - uBedCenter.x, -(aStartEnd.w - uBedCenter.y));
    vec2 delta = p2 - p1;
    float segLen = length(delta);
    if (segLen < 0.001) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec2 dir = delta / segLen;
    vec2 perp = vec2(-dir.y, dir.x);
    float w = max(aDims.y, 0.25) * 1.18;
    float h = max(aDims.z, 0.08) * 1.08;
    float cap = w * 0.34;
    float s = mix(-cap, segLen + cap, position.x);

    vec3 worldPos = vec3(
      p1.x + dir.x * s + perp.x * (position.y * w),
      max(0.0, aDims.x + position.z * h),
      p1.y + dir.y * s + perp.y * (position.y * w)
    );
    vec3 worldNormal = normalize(vec3(
      perp.x * aProfileNormal.x,
      aProfileNormal.y,
      perp.y * aProfileNormal.x
    ));

    vWorldPos = worldPos;
    vNormal = worldNormal;
    vHeightV = position.z;
    vLayerIdx = layerIdx;
    vColor = isSupport > 0.5 ? uSupportColor : pickToolColor(toolIdx);

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`

const FRAGMENT_SHADER = `
  uniform float uMode;
  uniform float uClipLayer;
  uniform float uHasFrontier;

  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vWorldPos;
  varying float vHeightV;
  varying float vLayerIdx;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);

    if (uMode > 0.5) {
      float fresnel = pow(1.0 - abs(dot(N, V)), 1.8);
      vec3 ghostCol = mix(vec3(0.45, 0.58, 0.64), vec3(0.76, 0.90, 0.94), fresnel);
      gl_FragColor = vec4(ghostCol, 0.13 + 0.22 * fresnel);
      return;
    }

    vec3 keyDir = normalize(vec3(0.55, 0.82, 0.45));
    vec3 fillDir = normalize(vec3(-0.65, 0.35, -0.55));
    vec3 rimDir = normalize(vec3(0.0, 0.35, -0.94));

    float keyDiff = max(dot(N, keyDir), 0.0);
    float fillDiff = max(dot(N, fillDir), 0.0);
    float rimDiff = max(dot(N, rimDir), 0.0);

    vec3 hemi = mix(vec3(0.18, 0.22, 0.25), vec3(0.48, 0.52, 0.56), N.y * 0.5 + 0.5);
    vec3 diffuse = vColor * (hemi + vec3(0.78, 0.76, 0.72) * keyDiff + vec3(0.24, 0.30, 0.36) * fillDiff + vec3(0.16, 0.20, 0.22) * rimDiff);

    vec3 H = normalize(keyDir + V);
    float spec = pow(max(dot(N, H), 0.0), 30.0) * 0.22;

    float layerShade = 0.85 + 0.15 * clamp(vHeightV + 1.0, 0.0, 1.0);
    float bedAo = mix(0.86, 1.0, smoothstep(0.0, 4.0, vWorldPos.y));

    vec3 color = diffuse * layerShade * bedAo + vec3(spec);
    color = color / (color + vec3(0.22)) * 1.12;

    float isFrontier = uHasFrontier * step(abs(vLayerIdx - uClipLayer), 0.5);
    if (isFrontier > 0.5) {
      float fresnel = pow(1.0 - abs(dot(N, V)), 2.0);
      color = color * 1.20 + vec3(0.09, 0.12, 0.09) * (0.45 + 0.55 * fresnel);
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`

function buildBedPlate() {
  const { width, depth } = resolvedBed()
  const group = new THREE.Group()
  const cw = 1024
  const ch = Math.max(256, Math.min(1024, Math.round(1024 * (depth / width))))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')

  // Matte dark PEI surface
  ctx.fillStyle = '#141c20'
  ctx.fillRect(0, 0, cw, ch)

  const pxPerMmX = cw / width
  const pxPerMmY = ch / depth
  // 10 mm minor grid
  ctx.strokeStyle = '#1d272d'
  ctx.lineWidth = 1
  for (let mm = 10; mm < width; mm += 10) {
    if (mm % 50 === 0) continue
    const p = Math.round(mm * pxPerMmX) + 0.5
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, ch)
    ctx.stroke()
  }
  for (let mm = 10; mm < depth; mm += 10) {
    if (mm % 50 === 0) continue
    const p = Math.round(mm * pxPerMmY) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, p)
    ctx.lineTo(cw, p)
    ctx.stroke()
  }

  // 50 mm major grid
  ctx.strokeStyle = '#2c3b43'
  ctx.lineWidth = 1.5
  for (let mm = 50; mm < width; mm += 50) {
    const p = Math.round(mm * pxPerMmX) + 0.5
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, ch)
    ctx.stroke()
  }
  for (let mm = 50; mm < depth; mm += 50) {
    const p = Math.round(mm * pxPerMmY) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, p)
    ctx.lineTo(cw, p)
    ctx.stroke()
  }

  // Outer perimeter & subtle lime front edge
  ctx.strokeStyle = '#42555f'
  ctx.lineWidth = 4
  ctx.strokeRect(2, 2, cw - 4, ch - 4)

  ctx.fillStyle = props.accentColor || '#c5f76b'
  ctx.fillRect(0, ch - 6, cw, 6)

  ctx.fillStyle = '#7b8f97'
  ctx.font = '600 22px Onest, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(bedCaption.value, cw / 2, ch - 22)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4

  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({ map: texture }),
  )
  plate.rotation.x = -Math.PI / 2
  plate.position.y = -0.15
  group.add(plate)

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(width + 4, 4, depth + 4),
    new THREE.MeshBasicMaterial({ color: 0x0e1417 }),
  )
  slab.position.y = -2.25
  group.add(slab)

  return group
}

function disposeBedPlate(group) {
  if (!group) return
  group.traverse(o => {
    o.geometry?.dispose()
    o.material?.map?.dispose()
    o.material?.dispose()
  })
}

function buildNozzleMarker() {
  const group = new THREE.Group()
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(2.4, 8, 16),
    new THREE.MeshBasicMaterial({ color: 0xc5f76b }),
  )
  cone.rotation.x = Math.PI
  cone.position.y = 4.2
  cone.userData.role = 'tint'
  group.add(cone)

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.2, 4.4, 24),
    new THREE.MeshBasicMaterial({ color: 0xc5f76b, side: THREE.DoubleSide, transparent: true, opacity: 0.75 }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.25
  ring.userData.role = 'tint'
  group.add(ring)
  group.visible = false
  return group
}

function buildBedCrosshair() {
  const { halfW, halfD } = resolvedBed()
  const group = new THREE.Group()
  const mat = new THREE.LineBasicMaterial({ color: 0xc5f76b, transparent: true, opacity: 0.32 })
  const xLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-halfW, 0.08, 0),
      new THREE.Vector3(halfW, 0.08, 0),
    ]),
    mat,
  )
  const yLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.08, -halfD),
      new THREE.Vector3(0, 0.08, halfD),
    ]),
    mat,
  )
  group.userData = { xLine, yLine, mat }
  group.add(xLine, yLine)
  group.visible = false
  return group
}

function disposeBedCrosshair(group) {
  if (!group) return
  group.userData.xLine?.geometry?.dispose()
  group.userData.yLine?.geometry?.dispose()
  group.userData.mat?.dispose()
}

function clearGroup(group) {
  if (!group) return
  while (group.children.length) {
    const child = group.children[0]
    child.geometry?.dispose?.()
    child.material?.dispose?.()
    group.remove(child)
  }
}

function updateExcludeDatums() {
  if (!excludeGroup) return
  clearGroup(excludeGroup)
  const ex = props.excludeObjects
  if (!props.isLiveJob || !ex?.available || !Array.isArray(ex.objects) || !ex.objects.length) {
    excludeGroup.visible = false
    invalidate()
    return
  }
  const { centerX, centerY } = resolvedBed()
  const excludedSet = new Set(ex.excluded ?? [])
  for (const obj of ex.objects) {
    if (!Array.isArray(obj.center) || obj.center.length < 2) continue
    const [cx, cy] = obj.center
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
    const wx = cx - centerX
    const wz = -(cy - centerY)
    const isExcluded = excludedSet.has(obj.name)
    const isCurrent = ex.current === obj.name
    const color = isExcluded ? 0xb56563 : isCurrent ? 0xc5f76b : 0x8ea2ab
    const opacity = isExcluded ? 0.72 : isCurrent ? 0.85 : 0.45

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.8, 5.8, 24),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.set(wx, 0.14, wz)
    excludeGroup.add(ring)

    if (isExcluded) {
      const s = 4.2
      const cross = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(wx - s, 0.16, wz - s),
          new THREE.Vector3(wx + s, 0.16, wz + s),
          new THREE.Vector3(wx + s, 0.16, wz - s),
          new THREE.Vector3(wx - s, 0.16, wz + s),
        ]),
        new THREE.LineBasicMaterial({ color: 0xb56563, transparent: true, opacity: 0.82 }),
      )
      excludeGroup.add(cross)
    }
  }
  excludeGroup.visible = excludeGroup.children.length > 0
  invalidate()
}

function resolvedPaletteVectors() {
  return Array.from({ length: 6 }, (_, id) => {
    const hex =
      props.colorMode === 'tools'
        ? TOOL_PALETTE[id]
        : (props.toolColors?.[id] || TOOL_PALETTE[id])
    const color = new THREE.Color(hex)
    // Lift near-black filament slightly so surface shading stays legible against dark cockpit background.
    const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
    if (luma < 0.07) color.lerp(new THREE.Color('#3b464c'), 0.45)
    return new THREE.Vector3(color.r, color.g, color.b)
  })
}

function updateUniforms() {
  if (!solidMaterial || !ghostMaterial) return
  const { centerX, centerY } = resolvedBed()
  const palette = resolvedPaletteVectors()
  const maxLayer = props.model?.header?.maxLayer ?? 999999
  const clip = Math.min(props.clipLayer, maxLayer)
  const support = props.showSupport ? 1.0 : 0.0

  const hasFrontier = clip < maxLayer ? 1.0 : 0.0

  solidMaterial.uniforms.uToolColors.value = palette
  solidMaterial.uniforms.uBedCenter.value.set(centerX, centerY)
  solidMaterial.uniforms.uClipLayer.value = clip
  solidMaterial.uniforms.uShowSupport.value = support
  solidMaterial.uniforms.uHasFrontier.value = hasFrontier

  ghostMaterial.uniforms.uToolColors.value = palette
  ghostMaterial.uniforms.uBedCenter.value.set(centerX, centerY)
  ghostMaterial.uniforms.uClipLayer.value = clip
  ghostMaterial.uniforms.uShowSupport.value = support
  ghostMaterial.uniforms.uHasFrontier.value = 0.0
  if (ghostMesh) ghostMesh.visible = props.showGhost && clip < maxLayer

  updateNozzle()
  invalidate()
}

function updateNozzle() {
  if (!nozzleMarker) return
  const { centerX, centerY } = resolvedBed()
  const pos = props.livePosition
  if (props.isLiveJob && Array.isArray(pos) && [pos[0], pos[1], pos[2]].every(Number.isFinite)) {
    const wx = pos[0] - centerX
    const wy = Math.max(0, pos[2])
    const wz = -(pos[1] - centerY)
    const palette = resolvedPaletteVectors()
    const toolVec =
      Number.isInteger(props.activeTool) && props.activeTool >= 0 && props.activeTool < 6
        ? palette[props.activeTool]
        : null
    const markerColor = toolVec ? new THREE.Color(toolVec.x, toolVec.y, toolVec.z) : new THREE.Color(0xc5f76b)

    nozzleMarker.position.set(wx, wy, wz)
    nozzleMarker.children.forEach(child => {
      if (child.userData.role === 'tint') child.material.color.copy(markerColor)
    })
    nozzleMarker.visible = true

    if (bedCrosshair) {
      bedCrosshair.userData.xLine.position.z = wz
      bedCrosshair.userData.yLine.position.x = wx
      bedCrosshair.userData.mat.color.copy(markerColor)
      bedCrosshair.visible = true
    }
  } else {
    nozzleMarker.visible = false
    if (bedCrosshair) bedCrosshair.visible = false
  }
  invalidate()
}

function modelBoundingBox() {
  const { centerX, centerY, halfW, halfD } = resolvedBed()
  const b = props.model?.header?.bounds
  if (!b) return new THREE.Box3(new THREE.Vector3(-halfW, 0, -halfD), new THREE.Vector3(halfW, 40, halfD))
  return new THREE.Box3(
    new THREE.Vector3(b.minX - centerX, Math.max(0, b.minZ), -(b.maxY - centerY)),
    new THREE.Vector3(b.maxX - centerX, Math.max(2, b.maxZ), -(b.minY - centerY)),
  )
}

function fitBox(box, animate = true, padding = 1.45, dirOverride = null) {
  if (!box || box.isEmpty() || !camera || !controls) return
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const radius = Math.max(12, size.length() * 0.5)
  const vfov = THREE.MathUtils.degToRad(camera.fov)
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * (padding * 0.65)
  const dir = (dirOverride ? dirOverride.clone() : new THREE.Vector3(0.68, 0.58, 1.0)).normalize()
  const toPosition = center.clone().addScaledVector(dir, Math.max(45, dist))

  controls.minDistance = Math.max(8, radius * 0.25)
  controls.maxDistance = Math.max(750, radius * 6)
  camera.near = 0.5
  camera.far = Math.max(2000, dist * 5)
  camera.updateProjectionMatrix()

  if (animate && !reducedMotion.matches) {
    animation = {
      fromPosition: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPosition,
      toTarget: center,
      start: performance.now(),
    }
  } else {
    animation = null
    camera.position.copy(toPosition)
    controls.target.copy(center)
    controls.update()
  }
  invalidate()
}

function focusObject(animate = true) {
  cameraPreset.value = 'iso'
  fitBox(modelBoundingBox(), animate, 1.38)
}

function focusPreset(preset) {
  cameraPreset.value = preset
  const { halfW, halfD } = resolvedBed()
  const box = hasModel.value
    ? modelBoundingBox()
    : new THREE.Box3(new THREE.Vector3(-halfW, 0, -halfD), new THREE.Vector3(halfW, 50, halfD))
  if (preset === 'top') {
    fitBox(box, true, 1.28, new THREE.Vector3(0.0, 1.0, 0.015))
  } else if (preset === 'front') {
    fitBox(box, true, 1.32, new THREE.Vector3(0.0, 0.14, 1.0))
  } else {
    fitBox(box, true, 1.38)
  }
}

function focusBed(animate = true) {
  cameraPreset.value = 'iso'
  const { halfW, halfD } = resolvedBed()
  const box = new THREE.Box3(new THREE.Vector3(-halfW, 0, -halfD), new THREE.Vector3(halfW, 50, halfD))
  fitBox(box, animate, 1.25)
}

function rebuildBedGeometry() {
  if (!scene) return
  if (bedGroup) {
    scene.remove(bedGroup)
    disposeBedPlate(bedGroup)
    bedGroup = null
  }
  if (bedCrosshair) {
    scene.remove(bedCrosshair)
    disposeBedCrosshair(bedCrosshair)
    bedCrosshair = null
  }
  bedGroup = buildBedPlate()
  scene.add(bedGroup)
  bedCrosshair = buildBedCrosshair()
  scene.add(bedCrosshair)
  updateUniforms()
  updateExcludeDatums()
  if (hasModel.value) focusObject(false)
  else focusBed(false)
}

function rebuildMesh() {
  if (!scene) return
  if (solidMesh) {
    scene.remove(solidMesh)
    solidMesh = null
  }
  if (ghostMesh) {
    scene.remove(ghostMesh)
    ghostMesh = null
  }
  if (activeGeometry) {
    activeGeometry.dispose()
    activeGeometry = null
  }

  const segments = props.model?.segments
  const count = props.model?.header?.segmentCount ?? 0
  if (!segments || count <= 0) {
    invalidate()
    return
  }

  activeGeometry = buildBeadBaseGeometry()
  const interleaved = new THREE.InstancedInterleavedBuffer(segments, 8)
  activeGeometry.setAttribute('aStartEnd', new THREE.InterleavedBufferAttribute(interleaved, 4, 0))
  activeGeometry.setAttribute('aDims', new THREE.InterleavedBufferAttribute(interleaved, 3, 4))
  activeGeometry.setAttribute('aMeta', new THREE.InterleavedBufferAttribute(interleaved, 1, 7))
  activeGeometry.instanceCount = count

  solidMesh = new THREE.Mesh(activeGeometry, solidMaterial)
  solidMesh.frustumCulled = false
  scene.add(solidMesh)

  ghostMesh = new THREE.Mesh(activeGeometry, ghostMaterial)
  ghostMesh.frustumCulled = false
  ghostMesh.renderOrder = 2
  scene.add(ghostMesh)

  updateUniforms()
  focusObject(false)
}

function resizeView() {
  if (!renderer || !viewport.value?.clientWidth || !viewport.value?.clientHeight) return
  camera.aspect = viewport.value.clientWidth / viewport.value.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(viewport.value.clientWidth, viewport.value.clientHeight, false)
  invalidate()
}

function updateCanvasLabels() {
  renderer?.domElement.setAttribute('title', t('Ziehen zum Drehen · Scrollen zum Zoomen'))
  renderer?.domElement.setAttribute('aria-label', t('Interaktive 3D-Druckvorschau'))
}

function onVisibility() {
  if (!document.hidden) invalidate()
}

function onContextLost(event) {
  event.preventDefault()
  webglError.value = 'Die 3D-Ansicht wurde unterbrochen. Seite neu laden, um sie wiederherzustellen.'
}

onMounted(() => {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setClearColor(0x161f24, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    updateCanvasLabels()

    viewport.value.appendChild(renderer.domElement)
    scene = new THREE.Scene()
    scene.background = new THREE.Color('#161f24')
    camera = new THREE.PerspectiveCamera(36, 1, 0.5, 2500)

    bedGroup = buildBedPlate()
    scene.add(bedGroup)

    nozzleMarker = buildNozzleMarker()
    scene.add(nozzleMarker)

    bedCrosshair = buildBedCrosshair()
    scene.add(bedCrosshair)

    excludeGroup = new THREE.Group()
    excludeGroup.visible = false
    scene.add(excludeGroup)

    const { centerX, centerY } = resolvedBed()
    const baseUniforms = mode => ({
      uToolColors: { value: resolvedPaletteVectors() },
      uSupportColor: { value: new THREE.Vector3(0.41, 0.49, 0.53) },
      uBedCenter: { value: new THREE.Vector2(centerX, centerY) },
      uClipLayer: { value: 999999 },
      uMode: { value: mode },
      uShowSupport: { value: 1.0 },
      uHasFrontier: { value: 0.0 },
    })

    solidMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: baseUniforms(0.0),
      side: THREE.DoubleSide,
    })

    ghostMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: baseUniforms(1.0),
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    })

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = !reducedMotion.matches
    controls.dampingFactor = 0.12
    controls.maxPolarAngle = Math.PI * 0.495
    controls.addEventListener('change', invalidate)
    renderer.domElement.addEventListener('pointerdown', () => { animation = null })
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)

    resizeObserver = new ResizeObserver(resizeView)
    resizeObserver.observe(viewport.value)
    resizeView()

    intersectionObserver = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting
      invalidate()
    })
    intersectionObserver.observe(viewport.value)

    document.addEventListener('visibilitychange', onVisibility)

    focusBed(false)
    if (props.model) rebuildMesh()
    updateNozzle()
    updateExcludeDatums()
  } catch {
    webglError.value = '3D ist in diesem Browser nicht verfügbar.'
  }
})

watch(language, updateCanvasLabels)
watch(() => props.model, rebuildMesh)
watch(
  [
    () => props.bedSize?.originX,
    () => props.bedSize?.originY,
    () => props.bedSize?.width,
    () => props.bedSize?.depth,
    () => props.printerLabel,
    () => props.accentColor,
  ],
  rebuildBedGeometry,
)
watch(
  [
    () => props.toolColors,
    () => props.colorMode,
    () => props.clipLayer,
    () => props.showGhost,
    () => props.showSupport,
  ],
  updateUniforms,
  { deep: true },
)
watch(
  [
    () => props.isLiveJob,
    () => props.livePosition?.[0],
    () => props.livePosition?.[1],
    () => props.livePosition?.[2],
    () => props.activeTool,
  ],
  updateNozzle,
)
watch(
  [() => props.isLiveJob, () => props.excludeObjects],
  updateExcludeDatums,
  { deep: true },
)

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  intersectionObserver?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  controls?.dispose()
  activeGeometry?.dispose()
  solidMaterial?.dispose()
  ghostMaterial?.dispose()
  disposeBedPlate(bedGroup)
  if (nozzleMarker) {
    nozzleMarker.traverse(o => {
      o.geometry?.dispose()
      o.material?.dispose()
    })
  }
  disposeBedCrosshair(bedCrosshair)
  if (excludeGroup) clearGroup(excludeGroup)
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.dispose()
  }
})
</script>

<template>
  <section class="scene-panel print-scene-panel" :aria-label="t('3D-Druckvorschau')">
    <div class="scene-toolbar">
      <div class="scene-toolbar-left">
        <div v-if="showColorModeToggle" class="segmented" :aria-label="t('Farbmodus')">
          <button
            type="button"
            :aria-pressed="colorMode === 'filament'"
            @click="emit('update:colorMode', 'filament')"
          >
            Filament
          </button>
          <button
            type="button"
            :aria-pressed="colorMode === 'tools'"
            @click="emit('update:colorMode', 'tools')"
          >
            {{ t('Werkzeuge') }}
          </button>
        </div>

        <div class="segmented scene-presets" :aria-label="t('Kameraperspektive')">
          <button type="button" :disabled="!!webglError" :aria-pressed="cameraPreset === 'iso'" @click="focusPreset('iso')">
            Iso
          </button>
          <button type="button" :disabled="!!webglError" :aria-pressed="cameraPreset === 'top'" @click="focusPreset('top')">
            {{ t('Oben') }}
          </button>
          <button type="button" :disabled="!!webglError" :aria-pressed="cameraPreset === 'front'" @click="focusPreset('front')">
            {{ t('Vorne') }}
          </button>
        </div>
      </div>

      <div class="scene-actions">
        <button
          v-if="hasSupport"
          class="icon-button"
          :class="{ 'toggle-on': showSupport }"
          type="button"
          :aria-pressed="showSupport"
          :title="showSupport ? t('Stützstruktur ausblenden') : t('Stützstruktur einblenden')"
          :aria-label="showSupport ? t('Stützstruktur ausblenden') : t('Stützstruktur einblenden')"
          @click="emit('update:showSupport', !showSupport)"
        >
          <Layers :size="15" />
        </button>
        <button
          class="icon-button"
          :class="{ 'toggle-on': showGhost }"
          type="button"
          :disabled="!hasModel"
          :aria-pressed="showGhost"
          :title="showGhost ? t('Restvorschau ausblenden') : t('Restvorschau einblenden')"
          :aria-label="showGhost ? t('Restvorschau ausblenden') : t('Restvorschau einblenden')"
          @click="emit('update:showGhost', !showGhost)"
        >
          <Eye v-if="showGhost" :size="15" />
          <EyeOff v-else :size="15" />
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="!!webglError"
          :title="t('Gesamtes Druckbett zeigen')"
          :aria-label="t('Gesamtes Druckbett zeigen')"
          @click="focusBed(true)"
        >
          <Grid3x3 :size="15" />
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="!hasModel"
          :title="t('Modell fokussieren & Ansicht zurücksetzen')"
          :aria-label="t('Modell fokussieren & Ansicht zurücksetzen')"
          @click="focusObject(true)"
        >
          <RotateCcw :size="15" />
        </button>
      </div>
    </div>

    <div ref="viewport" class="scene-viewport print-scene-viewport">
      <div v-if="loading || error || webglError || !hasModel" class="scene-loading" role="status">
        <Loader2 v-if="loading && !webglError && !error" :size="26" class="spinning" />
        <Box v-else :size="26" />
        <span>
          {{
            webglError
              ? t(webglError)
              : error
                ? t(error)
                : loading
                  ? t('3D-Druckmodell wird aus G-Code berechnet …')
                  : t('Keine Druckdatei ausgewählt.')
          }}
        </span>
        <button v-if="error && !loading" class="subtle-button" type="button" @click="emit('reload')">
          {{ t('Modell erneut laden') }}
        </button>
      </div>
    </div>

    <div class="scene-bottom">
      <span class="scene-badge">
        <Box :size="13" />
        <template v-if="hasModel">
          {{
            t('{0} Layer · {1} Segmente · 3D-G-Code', [
              model.header.layerCount,
              model.header.segmentCount.toLocaleString(),
            ])
          }}
        </template>
        <template v-else>{{ bedCaption }}</template>
      </span>
      <span class="orbit-hint">{{ t('Ziehen zum Drehen · Scrollen zum Zoomen') }}</span>
    </div>
  </section>
</template>
