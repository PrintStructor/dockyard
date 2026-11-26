<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { RotateCcw, Focus, Info, Box, Move, ArrowDownToLine } from '@lucide/vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { t, language } from '../i18n.mjs'
import { nozzleThermalGlow } from '../thermal.mjs'
import {
  LED_DISCRETE_LERP_MS,
  LED_OFF_COLOR,
  LED_ZERO_COLOR,
  colorNear,
  stepLedMeshes,
  createStudioLights,
  buildThermalGlowTexture,
  disposeObjectTree,
} from '../scene-utils.mjs'

const props = defineProps({
  selected: Number,
  detected: Number,
  tools: Array,
  online: Boolean,
})

const emit = defineEmits(['select'])

const viewport = ref(null)
const mode = ref('tools')
const printerPreset = ref('overview')
const loading = ref(true)
const failure = ref('')
const labels = ref([])

let renderer = null
let composer = null
let outline = null
let bloom = null
let lightData = null
let floor = null
let floorVeil = null
let thermalGroup = null
let thermalTexture = null
let feeds = null
let world = null
let camera = null
let controls = null
let resize = null
let observer = null
let currentModel = null
let frame = 0
let disposed = false
let visible = true
let running = false
let animation = null
let focusAfterLoad = false
let zoomedToTool = false
let loadingKey = null
let down = null
let lastVisualKey = ''

const ready = computed(() => !loading.value && !failure.value)
const models = {}
const boxes = {}
const nozzleTips = {}
const pickables = []
const ledMeshes = []
let lastLedFrameAt = 0
let ledIntervalMs = 250
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

function invalidate() {
  if (!running && !disposed && visible && !document.hidden && renderer) {
    running = true
    frame = requestAnimationFrame(render)
  }
}

function render(now) {
  running = false
  if (disposed || !visible || document.hidden) return
  let moving = false
  if (animation) {
    const progress = Math.min(1, (now - animation.start) / 550)
    const eased = 1 - Math.pow(1 - progress, 4)
    camera.position.lerpVectors(animation.fromPosition, animation.toPosition, eased)
    controls.target.lerpVectors(animation.fromTarget, animation.toTarget, eased)
    moving = progress < 1
    if (!moving) animation = null
  }
  const ledAnimating = stepLedMeshes(ledMeshes, now)
  const changed = controls.update()
  composer.render()

  const width = viewport.value.clientWidth
  const height = viewport.value.clientHeight
  labels.value =
    mode.value === 'tools' && currentModel
      ? Object.entries(boxes.tools ?? {}).map(([id, box]) => {
          const numId = Number(id)
          const tip = nozzleTips[numId]
          const point = tip ? tip.clone() : box.getCenter(new THREE.Vector3())
          point.y = (tip ? tip.y : box.min.y) - 0.036
          point.z = (tip ? tip.z : point.z) + 0.022
          point.project(camera)
          return {
            id: numId,
            x: (point.x * 0.5 + 0.5) * width,
            y: (-point.y * 0.5 + 0.5) * height,
            shown: point.z < 1 && Math.abs(point.x) < 0.97 && Math.abs(point.y) < 0.94,
          }
        })
      : []

  if (moving || ledAnimating || changed) invalidate()
}

function fit(box, animate = true, detail = false, underside = false, dirOverride = null) {
  if (!box || box.isEmpty() || !camera) return
  box = box.clone()
  if (detail && !underside) {
    box.min.y -= 0.025
    box.max.y += 0.012
  }
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const vfov = THREE.MathUtils.degToRad(camera.fov)
  const horizontal = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect)
  let distance =
    Math.max(size.y / (2 * Math.tan(vfov / 2)), size.x / (2 * Math.tan(horizontal / 2)), size.z) *
    (detail ? 1.1 : mode.value === 'tools' ? 1.2 : 1.35)
  const direction = dirOverride
    ? dirOverride.clone().normalize()
    : underside
      ? new THREE.Vector3(0, -1.4, 0.75).normalize()
      : mode.value === 'printer'
        ? new THREE.Vector3(0.9, 0.65, 1.3).normalize()
        : new THREE.Vector3(0, 0.16, 1).normalize()
  if (underside) distance *= 0.9
  const toPosition = center.clone().addScaledVector(direction, distance)

  controls.minDistance = Math.max(0.03, size.length() * 0.1)
  controls.maxDistance = Math.max(10, size.length() * 10)
  camera.near = Math.max(0.001, size.length() / 1000)
  camera.far = Math.max(50, size.length() * 100)
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

function overviewBox() {
  const box = new THREE.Box3().setFromObject(currentModel)
  if (mode.value === 'tools') {
    box.max.y += 0.012
    box.min.y -= 0.036
  }
  return box
}

function reset() {
  zoomedToTool = false
  printerPreset.value = 'overview'
  if (currentModel) fit(overviewBox())
}

function focusPrinterPreset(preset) {
  if (mode.value !== 'printer' || !currentModel) return
  printerPreset.value = preset
  if (preset === 'overview') {
    fit(overviewBox(), true)
    return
  }
  if (preset === 'dock') {
    const dockBox = new THREE.Box3()
    for (const box of Object.values(boxes.printer ?? {})) dockBox.union(box)
    if (!dockBox.isEmpty()) {
      dockBox.expandByVector(new THREE.Vector3(0.03, 0.025, 0.04))
      fit(dockBox, true, false, false, new THREE.Vector3(0.08, 0.28, 1.0))
      return
    }
  }
  if (preset === 'shuttle') {
    const full = overviewBox()
    const center = full.getCenter(new THREE.Vector3())
    const size = full.getSize(new THREE.Vector3())
    const shuttleBox = new THREE.Box3(
      new THREE.Vector3(center.x - size.x * 0.28, full.min.y + size.y * 0.16, center.z - size.z * 0.26),
      new THREE.Vector3(center.x + size.x * 0.28, full.min.y + size.y * 0.66, center.z + size.z * 0.28),
    )
    fit(shuttleBox, true, false, false, new THREE.Vector3(0.55, 0.34, 1.0))
  }
}

async function focusSelected() {
  zoomedToTool = true
  if (mode.value !== 'tools') {
    focusAfterLoad = true
    mode.value = 'tools'
    return
  }
  if (loading.value) {
    focusAfterLoad = true
    return
  }
  if (boxes.tools?.[props.selected]) fit(boxes.tools[props.selected], true, true)
}

defineExpose({ focusSelected, ready })

function visualSignature() {
  const parts = Array.from({ length: 6 }, (_, id) => {
    const tool = props.tools?.[id]
    const leds = props.online ? tool?.leds : null
    const filamentOn = props.online && tool?.filamentEnabled === true && tool?.filamentDetected === true
    const color = filamentOn ? (tool?.material?.color ?? '#bec9cc') : ''
    const thermalBucket = nozzleThermalGlow(tool?.temperature, props.online).bucket
    return [
      leds?.number?.join(',') ?? '',
      leds?.left?.join(',') ?? '',
      leds?.right?.join(',') ?? '',
      filamentOn ? '1' : '0',
      color,
      String(thermalBucket),
    ].join('|')
  })
  return `${mode.value}:${props.selected}:${props.online ? 1 : 0}:${parts.join(';')}`
}

function highlight(force = false) {
  if (!currentModel) return
  const signature = visualSignature()
  if (!force && signature === lastVisualKey) return
  lastVisualKey = signature

  const now = performance.now()
  const dt = lastLedFrameAt ? now - lastLedFrameAt : Infinity
  const isContinuousStream = dt >= 40 && dt <= 600
  const ledDuration = isContinuousStream
    ? Math.round((ledIntervalMs * 0.6 + Math.min(340, Math.max(80, dt)) * 0.4) * 1.05)
    : LED_DISCRETE_LERP_MS
  let anyLedChanged = false

  currentModel.traverse(object => {
    if (!object.isMesh) return
    if (!object.userData.ledRole) {
      if (Number.isInteger(object.userData.toolId)) {
        if (!object.userData.baseColor) object.userData.baseColor = object.material.color.clone()
        object.material.color
          .copy(object.userData.baseColor)
          .multiplyScalar(object.userData.toolId === props.selected ? 1 : 0.55)
      }
      return
    }
    const c = props.online ? props.tools?.[object.userData.toolId]?.leds?.[object.userData.ledRole] : null
    object.visible = true
    const toColor = c ? new THREE.Color().setRGB(...c.slice(0, 3).map(v => Math.min(1, v + c[3]))) : LED_OFF_COLOR
    const toEmissive = c ? toColor : LED_ZERO_COLOR
    const toIntensity = c ? (object.userData.ledRole === 'number' ? 2.3 : 5) : 0

    if (force || reducedMotion.matches || !object.userData.ledInit) {
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
        anyLedChanged = true
        object.userData.ledAnim = {
          fromColor: object.material.color.clone(),
          toColor: toColor.clone(),
          fromEmissive: object.material.emissive.clone(),
          toEmissive: toEmissive.clone(),
          fromIntensity: object.material.emissiveIntensity,
          toIntensity,
          start: now,
          duration: ledDuration,
        }
      }
    }
  })

  if (anyLedChanged) {
    if (isContinuousStream) ledIntervalMs = ledIntervalMs * 0.6 + Math.min(340, Math.max(80, dt)) * 0.4
    lastLedFrameAt = now
  }

  if (outline) outline.selectedObjects = pickables.filter(object => object.userData.toolId === props.selected)

  if (feeds) {
    feeds.children.forEach(mesh => {
      if (mesh.userData.filament == null) return
      const tool = props.tools?.[mesh.userData.filament]
      mesh.visible = props.online && tool?.filamentEnabled === true && tool?.filamentDetected === true
      mesh.material.color.set(tool?.material?.color ?? '#bec9cc')
    })
  }

  if (thermalGroup) {
    thermalGroup.visible = mode.value === 'tools'
    thermalGroup.children.forEach(node => {
      const id = node.userData.thermalTool
      if (!Number.isInteger(id)) return
      const glow = nozzleThermalGlow(props.tools?.[id]?.temperature, props.online)
      node.visible = glow.active
      if (!glow.active) return
      if (node.userData.thermalRole === 'tip') {
        node.material.color.set(glow.tipHex)
        node.material.opacity = Math.min(0.56, glow.intensity * 0.62)
      } else {
        node.material.color.set(glow.poolHex)
        node.material.opacity = Math.min(0.46, glow.intensity * 0.48)
      }
    })
  }
  invalidate()
}

function addLights(root, key) {
  for (const part of lightData.parts) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.position, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.normal, 3))
    geometry.setIndex(part.index)

    const material = new THREE.MeshStandardMaterial({
      color: part.role === 'numberBase' ? 0x737a80 : 0,
      emissive: 0,
      roughness: 0.45,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    const mesh = new THREE.Mesh(geometry, material)
    const ledParts = lightData.parts
      .filter(candidate => candidate.toolId === part.toolId && candidate.role === 'led')
      .sort((a, b) => a.position[0] - b.position[0])
    mesh.userData = {
      toolId: part.toolId,
      ...(part.role !== 'numberBase' && {
        ledRole: part.role === 'number' ? 'number' : ledParts[0] === part ? 'left' : 'right',
      }),
    }
    if (key === 'tools') mesh.position.fromArray(part.lineupOffset)
    mesh.visible = part.role === 'numberBase'
    root.add(mesh)
  }
}

async function underside() {
  if (mode.value !== 'tools') {
    await loadModel('tools')
    mode.value = 'tools'
    return
  }
  fit(boxes.tools?.[props.selected], true, true, true)
}

function registerModel(root, key) {
  root.updateMatrixWorld(true)
  boxes[key] = {}
  const minYByTool = {}
  const meshesByTool = {}
  root.traverse(object => {
    if (!object.isMesh) return
    object.material = object.material.clone()
    object.material.metalness = Math.min(object.material.metalness ?? 0, 0.35)
    object.material.roughness = Math.max(object.material.roughness ?? 0.5, 0.42)
    if (Number.isInteger(object.userData.toolId)) {
      const id = object.userData.toolId
      const meshBox = new THREE.Box3().setFromObject(object)
      if (!boxes[key][id]) boxes[key][id] = new THREE.Box3()
      boxes[key][id].union(meshBox)
      if (key === 'tools') {
        ;(meshesByTool[id] ||= []).push(object)
        if (minYByTool[id] == null || meshBox.min.y < minYByTool[id]) minYByTool[id] = meshBox.min.y
      }
    }
  })

  // Derive each nozzle tip directly from the lowest world-space vertices of the CAD toolhead.
  if (key === 'tools') {
    const v = new THREE.Vector3()
    for (const [rawId, meshList] of Object.entries(meshesByTool)) {
      const id = Number(rawId)
      const minY = minYByTool[id]
      const threshold = minY + 0.0025
      let sumX = 0
      let sumZ = 0
      let count = 0
      for (const mesh of meshList) {
        const pos = mesh.geometry?.attributes?.position
        if (!pos) continue
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
      if (count > 0) {
        nozzleTips[id] = new THREE.Vector3(sumX / count, minY, sumZ / count)
      }
    }
  }
}

async function loadModel(key, noFit = false) {
  if (loadingKey === key) return
  loadingKey = key
  loading.value = true
  failure.value = ''
  try {
    if (!models[key]) {
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`/models/${key}.glb`)
      if (disposed) {
        disposeModel(gltf.scene)
        return
      }
      models[key] = gltf.scene
      registerModel(models[key], key)
      if (!lightData) {
        const response = await fetch('/models/lights.json')
        if (!response.ok) throw new Error('LED geometry unavailable')
        lightData = await response.json()
      }
      if (disposed) return
      addLights(models[key], key)
    }
    if (mode.value !== key || disposed) return
    if (currentModel) world.remove(currentModel)
    currentModel = models[key]
    world.add(currentModel)
    floor.visible = key === 'tools'
    if (floorVeil) floorVeil.visible = key === 'tools'
    if (thermalGroup) {
      thermalGroup.visible = key === 'tools'
      if (key === 'tools') syncThermalPositions()
    }
    feeds.visible = key === 'tools'
    if (key === 'printer') printerPreset.value = 'overview'
    pickables.length = 0
    ledMeshes.length = 0
    currentModel.traverse(object => {
      if (!object.isMesh) return
      if (object.userData.ledRole) {
        ledMeshes.push(object)
      } else if (Number.isInteger(object.userData.toolId)) {
        pickables.push(object)
      }
    })
    if (focusAfterLoad && key === 'tools') {
      focusAfterLoad = false
      zoomedToTool = true
      fit(boxes.tools[props.selected], false, true)
    } else if (!noFit) {
      zoomedToTool = false
      fit(overviewBox(), false)
    }
    highlight(true)
  } catch {
    if (!disposed && mode.value === key) failure.value = 'Das CAD-Modell konnte nicht geladen werden.'
  } finally {
    if (loadingKey === key) {
      loadingKey = null
      loading.value = false
    }
  }
}

function pointerDown(event) {
  down = { x: event.clientX, y: event.clientY }
  animation = null
}

function pointerUp(event) {
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) {
    down = null
    return
  }
  down = null
  const rect = viewport.value.getBoundingClientRect()
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(pickables, false)[0]
  if (hit) emit('select', hit.object.userData.toolId)
}

function doubleClick(event) {
  if (mode.value !== 'tools' || !viewport.value) return
  const rect = viewport.value.getBoundingClientRect()
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObjects(pickables, false)[0]
  if (hit) {
    const id = hit.object.userData.toolId
    emit('select', id)
    if (boxes.tools?.[id]) {
      zoomedToTool = true
      fit(boxes.tools[id], true, true)
    }
  }
}

function resizeView() {
  if (!renderer || !viewport.value.clientWidth || !viewport.value.clientHeight) return
  camera.aspect = viewport.value.clientWidth / viewport.value.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(viewport.value.clientWidth, viewport.value.clientHeight, false)
  composer?.setSize(viewport.value.clientWidth, viewport.value.clientHeight)
  invalidate()
}

function visibility() {
  if (!document.hidden) invalidate()
}

function updateCanvasLabels() {
  renderer?.domElement.setAttribute('title', t('Ziehen zum Drehen · Scrollen zum Zoomen'))
  renderer?.domElement.setAttribute(
    'aria-label',
    t('Interaktive CAD-Ansicht. Werkzeuge alternativ mit den Tasten darunter auswählen.'),
  )
}

watch(language, updateCanvasLabels)

function contextLost(event) {
  event.preventDefault()
  failure.value = 'Die 3D-Ansicht wurde unterbrochen. Seite neu laden, um sie wiederherzustellen.'
}

function buildFloorVeil() {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')

  // Seamless studio cyclorama mask: subtle transparent core over Reflector fading to opaque #1b252a at edges.
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

  // Subtle CNC bay datum ticks for T0–T5 along the bench front edge.
  ctx.strokeStyle = 'rgba(128, 152, 162, 0.34)'
  ctx.lineWidth = 1.25
  for (let i = 0; i < 6; i++) {
    const worldX = (i - 2.5) * 0.095
    const px = Math.round(((worldX / 0.86) + 0.5) * 512) + 0.5
    ctx.beginPath()
    ctx.moveTo(px, 198)
    ctx.lineTo(px, 212)
    ctx.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const veil = new THREE.Mesh(
    new THREE.PlaneGeometry(0.86, 0.42),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  )
  veil.rotation.x = -Math.PI / 2
  veil.position.set(0, -0.00005, 0.015)
  veil.renderOrder = 1
  return veil
}

function buildThermalGroup() {
  thermalTexture = buildThermalGlowTexture()
  const group = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    const x = (i - 2.5) * 0.095
    const tip = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: thermalTexture,
        color: 0xf3c67b,
        transparent: true,
        opacity: 0,
        blending: THREE.NormalBlending,
        depthWrite: false,
      }),
    )
    tip.position.set(x, 0.008, 0.015)
    tip.scale.set(0.026, 0.026, 1)
    tip.visible = false
    tip.renderOrder = 2
    tip.userData = { thermalTool: i, thermalRole: 'tip' }
    group.add(tip)

    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(0.058, 0.058),
      new THREE.MeshBasicMaterial({
        map: thermalTexture,
        color: 0xf3c67b,
        transparent: true,
        opacity: 0,
        blending: THREE.NormalBlending,
        depthWrite: false,
      }),
    )
    pool.rotation.x = -Math.PI / 2
    pool.position.set(x, 0.0002, 0.015)
    pool.visible = false
    pool.renderOrder = 2
    pool.userData = { thermalTool: i, thermalRole: 'pool' }
    group.add(pool)
  }
  return group
}

function syncThermalPositions() {
  if (!thermalGroup) return
  for (const node of thermalGroup.children) {
    const id = node.userData.thermalTool
    const tip = nozzleTips[id]
    const box = boxes.tools?.[id]
    if (!tip && !box) continue
    const pos = tip ?? box.getCenter(new THREE.Vector3())
    const minY = tip ? tip.y : box.min.y
    if (node.userData.thermalRole === 'tip') {
      node.position.set(pos.x, minY + 0.0045, pos.z)
    } else {
      node.position.set(pos.x, 0.0002, pos.z)
    }
  }
}

const disposeModel = disposeObjectTree

onMounted(() => {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setClearColor(0x1b252a, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.3
    updateCanvasLabels()

    viewport.value.appendChild(renderer.domElement)
    world = new THREE.Scene()
    world.background = new THREE.Color('#1b252a')
    camera = new THREE.PerspectiveCamera(36, 1, 0.01, 200)

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType })
    target.texture.colorSpace = THREE.LinearSRGBColorSpace
    composer = new EffectComposer(renderer, target)
    composer.addPass(new RenderPass(world, camera))

    outline = new OutlinePass(new THREE.Vector2(1, 1), world, camera)
    outline.edgeStrength = 1.5
    outline.edgeGlow = 0
    outline.edgeThickness = 0.7
    outline.visibleEdgeColor.set('#dce6e2')
    outline.hiddenEdgeColor.set(0)
    composer.addPass(outline)

    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.25, 1.8)
    composer.addPass(bloom)
    composer.addPass(new OutputPass())

    createStudioLights().forEach(light => world.add(light))

    floor = new Reflector(new THREE.PlaneGeometry(0.76, 0.3), {
      textureWidth: 1024,
      textureHeight: 512,
      color: 0x888888,
      clipBias: 0.00003,
      multisample: 0,
    })
    // OutlinePass renders depth/mask materials; these must not replace the mirror image.
    const reflect = floor.onBeforeRender
    floor.onBeforeRender = function (r, scene, cam, ...rest) {
      if (scene.overrideMaterial) return
      const veilWas = floorVeil?.visible ?? false
      const thermalWas = thermalGroup?.visible ?? false
      if (floorVeil) floorVeil.visible = false
      if (thermalGroup) thermalGroup.visible = false
      reflect.call(this, r, scene, cam, ...rest)
      if (floorVeil) floorVeil.visible = veilWas
      if (thermalGroup) thermalGroup.visible = thermalWas
    }
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, -0.0003, 0.015)
    world.add(floor)

    floorVeil = buildFloorVeil()
    world.add(floorVeil)

    thermalGroup = buildThermalGroup()
    world.add(thermalGroup)

    feeds = new THREE.Group()
    world.add(feeds)
    for (let i = 0; i < 6; i++) {
      const x = (i - 2.5) * 0.095
      const height = 0.11885
      const inletZ = 0.00931
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, height - 0.0008, inletZ),
        new THREE.Vector3(x, height + 0.025, inletZ),
        new THREE.Vector3(x - 0.004, height + 0.065, inletZ - 0.003),
        new THREE.Vector3(x - 0.009, height + 0.115, inletZ - 0.012),
      ])
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, 0.002, 8, false),
        new THREE.MeshStandardMaterial({
          color: 0x879499,
          transparent: true,
          opacity: 0.25,
          roughness: 0.3,
          metalness: 0,
          depthWrite: false,
        }),
      )
      feeds.add(tube)

      const filament = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, 0.000875, 8, false),
        new THREE.MeshStandardMaterial({ color: 0xbec9cc, roughness: 0.45 }),
      )
      filament.userData.filament = i
      filament.visible = false
      feeds.add(filament)
    }

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = !reducedMotion.matches
    controls.dampingFactor = 0.12
    controls.maxPolarAngle = Math.PI * 0.92
    controls.addEventListener('change', invalidate)

    renderer.domElement.addEventListener('pointerdown', pointerDown)
    renderer.domElement.addEventListener('pointerup', pointerUp)
    renderer.domElement.addEventListener('dblclick', doubleClick)
    renderer.domElement.addEventListener('webglcontextlost', contextLost)

    resize = new ResizeObserver(resizeView)
    resize.observe(viewport.value)
    resizeView()

    observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting
      invalidate()
    })
    observer.observe(viewport.value)

    document.addEventListener('visibilitychange', visibility)
    loadModel('tools')
  } catch {
    loading.value = false
    failure.value = '3D ist in diesem Browser nicht verfügbar. Die Werkzeugauswahl darunter funktioniert weiterhin.'
  }
})

watch(() => [props.tools, props.online], () => highlight(false))
watch(
  () => props.selected,
  () => {
    highlight(false)
    if (zoomedToTool) focusSelected()
  },
)
watch(mode, key => {
  if (renderer) loadModel(key)
})

onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(frame)
  resize?.disconnect()
  observer?.disconnect()
  document.removeEventListener('visibilitychange', visibility)
  controls?.dispose()
  floor?.dispose()
  floor?.geometry.dispose()
  if (floorVeil) {
    floorVeil.geometry.dispose()
    floorVeil.material.map?.dispose()
    floorVeil.material.dispose()
  }
  if (thermalGroup) disposeModel(thermalGroup)
  thermalTexture?.dispose()
  if (feeds) disposeModel(feeds)
  composer?.passes.forEach(pass => pass.dispose?.())
  composer?.dispose()
  Object.values(models).forEach(disposeModel)
  if (renderer) {
    renderer.domElement.removeEventListener('pointerdown', pointerDown)
    renderer.domElement.removeEventListener('pointerup', pointerUp)
    renderer.domElement.removeEventListener('dblclick', doubleClick)
    renderer.domElement.removeEventListener('webglcontextlost', contextLost)
    renderer.dispose()
  }
})
</script>

<template>
  <section class="scene-panel" :aria-label="t('3D-Darstellung')">
    <div class="scene-toolbar">
      <div class="scene-toolbar-left">
        <div class="segmented" :aria-label="t('3D-Modell')">
          <button type="button" :aria-pressed="mode === 'tools'" @click="mode = 'tools'">
            {{ t('Werkzeuge') }}
          </button>
          <button type="button" :aria-pressed="mode === 'printer'" @click="mode = 'printer'">
            {{ t('Drucker') }}
          </button>
        </div>
        <div v-if="mode === 'printer' && ready" class="segmented scene-presets" :aria-label="t('Drucker-Kamerawinkel')">
          <button
            type="button"
            :aria-pressed="printerPreset === 'overview'"
            @click="focusPrinterPreset('overview')"
          >
            {{ t('Gesamt') }}
          </button>
          <button
            type="button"
            :aria-pressed="printerPreset === 'dock'"
            @click="focusPrinterPreset('dock')"
          >
            Dock-Rail
          </button>
          <button
            type="button"
            :aria-pressed="printerPreset === 'shuttle'"
            @click="focusPrinterPreset('shuttle')"
          >
            Shuttle
          </button>
        </div>
      </div>
      <div class="scene-actions">
        <button
          class="icon-button"
          type="button"
          :disabled="loading || !!failure"
          :aria-label="t('Ausgewähltes Werkzeug fokussieren')"
          :title="t('Auswahl fokussieren')"
          @click="focusSelected"
        >
          <Focus :size="16" />
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="loading || !!failure || mode !== 'tools'"
          :aria-label="t('Ausgewähltes Werkzeug von unten ansehen')"
          :title="t('Unterseite')"
          @click="underside"
        >
          <ArrowDownToLine :size="16" />
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="loading || !!failure"
          :aria-label="t('3D-Ansicht zurücksetzen')"
          :title="t('Ansicht zurücksetzen')"
          @click="reset"
        >
          <RotateCcw :size="16" />
        </button>
      </div>
    </div>

    <div ref="viewport" class="scene-viewport">
      <template v-for="label in labels" :key="label.id">
        <button
          v-if="label.shown"
          type="button"
          :class="['tool-label', { active: label.id === selected, detected: online && label.id === detected }]"
          :style="{ left: `${label.x}px`, top: `${label.y}px` }"
          :aria-label="t('T{0} in 3D auswählen', [label.id])"
          @click="emit('select', label.id)"
        >
          T{{ label.id }}<span
            v-if="online && tools?.[label.id]?.filamentEnabled === true && tools?.[label.id]?.filamentDetected === true"
            class="filament-mark"
            :style="{ '--filament-color': tools[label.id]?.material?.color ?? '#bec9cc' }"
            :title="t('Filament am Eingang erkannt')"
          /><span v-if="online && label.id === detected" class="active-tool-mark"> {{ t('· aufgenommen') }}</span>
        </button>
      </template>

      <div v-if="loading || failure" class="scene-loading" role="status">
        <Box :size="26" />
        <span>{{ failure ? t(failure) : t('CAD-Modell wird geladen …') }}</span>
        <button v-if="failure && renderer" class="subtle-button" type="button" @click="loadModel(mode)">
          {{ t('Modell erneut laden') }}
        </button>
      </div>
    </div>

    <details class="model-disclaimer">
      <summary>
        <Info :size="13" />{{ mode === 'tools' ? t('Älterer Shuttle-Stand') : t('Älterer Dock- & Shuttle-Stand') }}
      </summary>
      <p>
        {{
          t(
            'Originalgeometrie aus Fusion. Die Gesamtbaugruppe enthält ältere Docks ohne KNOMI und ein älteres Shuttle. Die 3D-Positionen sind keine Live-Bewegungen.',
          )
        }}
      </p>
    </details>

    <div class="scene-bottom">
      <span class="scene-badge">
        <Box :size="13" />{{ mode === 'tools' ? t('6 Werkzeuge · CAD-Referenz') : t('VORON 2.4 · CAD-Referenz') }}
      </span>
      <span class="orbit-hint"><Move :size="12" />{{ t('Ziehen zum Drehen · Scrollen zum Zoomen') }}</span>
    </div>
  </section>
</template>
