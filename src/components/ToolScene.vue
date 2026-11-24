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

const props = defineProps({
  selected: Number,
  detected: Number,
  tools: Array,
  online: Boolean,
})

const emit = defineEmits(['select'])

const viewport = ref(null)
const mode = ref('tools')
const loading = ref(true)
const failure = ref('')
const labels = ref([])

let renderer = null
let composer = null
let outline = null
let bloom = null
let lightData = null
let floor = null
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
const pickables = []
const ledMeshes = []
const LED_DISCRETE_LERP_MS = 140
const LED_OFF_COLOR = new THREE.Color('#697479')
const LED_ZERO_COLOR = new THREE.Color(0)
let lastLedFrameAt = 0
let ledIntervalMs = 250
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

function colorNear(a, b) {
  return Math.abs(a.r - b.r) < 1e-4 && Math.abs(a.g - b.g) < 1e-4 && Math.abs(a.b - b.b) < 1e-4
}

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
  let ledAnimating = false
  for (const object of ledMeshes) {
    const anim = object.userData.ledAnim
    if (!anim) continue
    const progress = Math.min(1, (now - anim.start) / anim.duration)
    object.material.color.lerpColors(anim.fromColor, anim.toColor, progress)
    object.material.emissive.lerpColors(anim.fromEmissive, anim.toEmissive, progress)
    object.material.emissiveIntensity = anim.fromIntensity + (anim.toIntensity - anim.fromIntensity) * progress
    if (progress < 1) {
      ledAnimating = true
    } else {
      object.userData.ledAnim = null
    }
  }
  const changed = controls.update()
  composer.render()

  const width = viewport.value.clientWidth
  const height = viewport.value.clientHeight
  labels.value =
    mode.value === 'tools' && currentModel
      ? Object.entries(boxes.tools ?? {}).map(([id, box]) => {
          const point = box.getCenter(new THREE.Vector3())
          point.y = box.min.y - box.getSize(new THREE.Vector3()).y * 0.15
          point.project(camera)
          return {
            id: Number(id),
            x: (point.x * 0.5 + 0.5) * width,
            y: (-point.y * 0.5 + 0.5) * height,
            shown: point.z < 1 && Math.abs(point.x) < 0.97 && Math.abs(point.y) < 0.94,
          }
        })
      : []

  if (moving || ledAnimating || changed) invalidate()
}

function fit(box, animate = true, detail = false, underside = false) {
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
  const direction = underside
    ? new THREE.Vector3(0, -1.4, 0.75).normalize()
    : mode.value === 'printer'
      ? new THREE.Vector3(0.9, 0.65, 1.3).normalize()
      : new THREE.Vector3(0.07, 0.28, 1).normalize()
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
    box.max.y += 0.014
    box.min.y -= 0.02
  }
  return box
}

function reset() {
  zoomedToTool = false
  if (currentModel) fit(overviewBox())
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
    return [
      leds?.number?.join(',') ?? '',
      leds?.left?.join(',') ?? '',
      leds?.right?.join(',') ?? '',
      filamentOn ? '1' : '0',
      color,
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
  root.traverse(object => {
    if (!object.isMesh) return
    object.material = object.material.clone()
    object.material.metalness = Math.min(object.material.metalness ?? 0, 0.35)
    object.material.roughness = Math.max(object.material.roughness ?? 0.5, 0.42)
    if (Number.isInteger(object.userData.toolId)) {
      const id = object.userData.toolId
      if (!boxes[key][id]) boxes[key][id] = new THREE.Box3()
      boxes[key][id].union(new THREE.Box3().setFromObject(object))
    }
  })
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
    feeds.visible = key === 'tools'
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

function disposeModel(root) {
  const geometries = new Set()
  const materials = new Set()
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry)
    if (object.material) materials.add(object.material)
  })
  geometries.forEach(geometry => geometry.dispose())
  materials.forEach(material => material.dispose())
}

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

    world.add(new THREE.HemisphereLight(0xe3edff, 0x65716a, 3))
    const key = new THREE.DirectionalLight(0xfff6e9, 4)
    key.position.set(3, 5, 5)
    world.add(key)
    const fill = new THREE.DirectionalLight(0xc5d4ef, 2)
    fill.position.set(-4, 2, -3)
    world.add(fill)

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
      if (!scene.overrideMaterial) reflect.call(this, r, scene, cam, ...rest)
    }
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, -0.0003, 0.015)
    world.add(floor)

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
      <div class="segmented" :aria-label="t('3D-Modell')">
        <button type="button" :aria-pressed="mode === 'tools'" @click="mode = 'tools'">
          {{ t('Werkzeuge') }}
        </button>
        <button type="button" :aria-pressed="mode === 'printer'" @click="mode = 'printer'">
          {{ t('Drucker') }}
        </button>
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
          /><span v-if="online && label.id === detected" class="active-tool-mark"> {{ t('· aktiv') }}</span>
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
