<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { RotateCcw, ArrowDownToLine, Box, Upload, Lock, Unlock } from '@lucide/vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { t, language } from '../i18n.mjs'
import { nozzleThermalGlow } from '../thermal.mjs'
import { DEFAULT_ACCENT_COLOR, normalizeAccentColor } from '../model-config.mjs'
import {
  LED_DISCRETE_LERP_MS,
  applyLedTargets,
  stepLedMeshes,
  createStudioLights,
  computeExactFitDistance,
  buildThermalGlowTexture,
  buildStudioFloorVeil,
  classifyModelNodes,
  detectNozzleTip,
  detectFilamentInlet,
  disposeObjectTree,
  createModelLoadGuard,
} from '../scene-utils.mjs'

const props = defineProps({
  sceneConfig: { type: Object, required: true },
  tool: { type: Object, default: () => ({}) },
  online: { type: Boolean, default: false },
  printerName: { type: String, default: '' },
  printerId: { type: String, default: '' },
  bedSize: { type: Object, default: null },
  canWrite: { type: Boolean, default: true },
  lightweight: { type: Boolean, default: false },
})

const emit = defineEmits(['open-settings'])

const viewport = ref(null)

function sceneViewStorageKey() {
  const key = (props.printerId || props.printerName || 'default').trim().toLowerCase()
  return `dockyard.sceneView.${key}`
}

function readSavedSceneView() {
  try {
    const saved = globalThis.localStorage?.getItem(sceneViewStorageKey())
    if (saved === 'printer' || saved === 'toolhead') return saved
  } catch {
    // Ignore restricted storage
  }
  return null
}

function saveSceneView(view) {
  try {
    globalThis.localStorage?.setItem(sceneViewStorageKey(), view)
  } catch {
    // Ignore restricted storage
  }
}

function initialViewChoice() {
  const views = props.sceneConfig?.views ?? {}
  const saved = readSavedSceneView()
  if (saved && views[saved]) return saved
  if (props.sceneConfig?.defaultView === 'printer' && views.printer) return 'printer'
  return views.toolhead ? 'toolhead' : 'printer'
}

const activeView = ref(initialViewChoice())
const cameraPreset = ref('iso')
const orbitUnlocked = ref(!props.lightweight)
const loading = ref(false)
const failure = ref('')

const hasBothViews = computed(
  () => Boolean(props.sceneConfig?.views?.toolhead && props.sceneConfig?.views?.printer),
)
const activeSource = computed(() => {
  const views = props.sceneConfig?.views ?? {}
  if (activeView.value === 'printer' && views.printer) return views.printer
  if (activeView.value === 'toolhead' && views.toolhead) return views.toolhead
  return views.toolhead ?? views.printer ?? null
})
const activeViewKind = computed(() => {
  const views = props.sceneConfig?.views ?? {}
  if (activeView.value === 'printer' && views.printer) return 'printer'
  if (activeView.value === 'toolhead' && views.toolhead) return 'toolhead'
  return views.toolhead ? 'toolhead' : 'printer'
})
const isEmptyCustom = computed(() => Boolean(props.sceneConfig?.emptyCustom) || !activeSource.value)
const ready = computed(() => !loading.value && !failure.value && !isEmptyCustom.value)

const badgeText = computed(() => {
  const src = activeSource.value
  if (!src) return t('Eigenes CAD · noch nicht hochgeladen')
  if (src.sourceKind === 'template') {
    return t('{0} · Vorlage', [src.label])
  }
  const sizeStr = src.bytes ? ` · ${(src.bytes / 1048576 >= 1 ? `${(src.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(src.bytes / 1024))} KB`)}` : ''
  return `${src.filename || src.label} · ${t('Eigenes CAD')}${sizeStr}`
})

let renderer = null
let composer = null
let bloom = null
let world = null
let camera = null
let controls = null
let resize = null
let observer = null
let floor = null
let floorVeil = null
let thermalGroup = null
let thermalTexture = null
let feedGroup = null
let currentModel = null
let currentBox = null
let accentMeshes = []
let ledMeshes = []
let nozzleTip = null
let filamentInlet = null
let filamentStrand = null

let disposed = false
let visible = true
let running = false
let frame = 0
let animation = null
const loadGuard = createModelLoadGuard()
let lastVisualKey = ''
let lastLedFrameAt = 0
let ledIntervalMs = 250

const reducedMotion = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false }

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
    const progress = Math.min(1, (now - animation.start) / 500)
    const eased = 1 - Math.pow(1 - progress, 4)
    camera.position.lerpVectors(animation.fromPosition, animation.toPosition, eased)
    controls.target.lerpVectors(animation.fromTarget, animation.toTarget, eased)
    moving = progress < 1
    if (!moving) animation = null
  }
  const ledAnimating = stepLedMeshes(ledMeshes, now)
  const changed = controls.update()
  if (composer) {
    composer.render()
  } else {
    renderer.render(world, camera)
  }
  if (moving || changed || ledAnimating) invalidate()
}

function directionForPreset(preset, isPrinter) {
  if (preset === 'underside') return new THREE.Vector3(0.24, -0.42, 0.88).normalize()
  if (preset === 'front') return new THREE.Vector3(0.0, 0.08, 1.0).normalize()
  if (preset === 'side') return new THREE.Vector3(1.0, 0.12, 0.08).normalize()
  return isPrinter
    ? new THREE.Vector3(0.52, 0.28, 0.81).normalize()
    : new THREE.Vector3(0.38, 0.14, 0.91).normalize()
}

function fitCamera(box, { animate = false, preset = 'iso' } = {}) {
  if (!box || !camera || !controls) return
  cameraPreset.value = preset
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z, 0.05)
  const isPrinter = activeViewKind.value === 'printer'
  const underside = preset === 'underside'

  const dir = directionForPreset(preset, isPrinter)
  const fov = THREE.MathUtils.degToRad(camera.fov)
  const aspect = Math.max(0.45, camera.aspect || 1)
  const margin = underside ? 1.06 : isPrinter ? 1.14 : 1.16
  const dist = computeExactFitDistance(box, dir, fov, aspect, margin)

  const target = center.clone()
  if (underside && nozzleTip) {
    target.set(nozzleTip.x, nozzleTip.y + size.y * 0.18, nozzleTip.z)
  } else if (!isPrinter) {
    target.y = center.y + size.y * 0.02
  }

  const nextPos = target.clone().addScaledVector(dir, dist)
  camera.near = Math.max(0.002, dist / 200)
  camera.far = Math.max(50, dist * 40)
  camera.updateProjectionMatrix()
  controls.minDistance = maxDim * 0.45
  controls.maxDistance = maxDim * 8

  if (animate && !reducedMotion.matches) {
    animation = {
      fromPosition: camera.position.clone(),
      toPosition: nextPos,
      fromTarget: controls.target.clone(),
      toTarget: target,
      start: performance.now(),
    }
  } else {
    animation = null
    camera.position.copy(nextPos)
    controls.target.copy(target)
    controls.update()
  }
  invalidate()
}

function setCameraPreset(preset) {
  if (currentBox) fitCamera(currentBox, { animate: true, preset })
}

function resetCamera() {
  if (currentBox) fitCamera(currentBox, { animate: true, preset: 'iso' })
}

function showUnderside() {
  if (currentBox && activeViewKind.value === 'toolhead') {
    fitCamera(currentBox, { animate: true, preset: 'underside' })
  }
}

function syncOrbitInteraction() {
  if (!controls || !renderer) return
  const active = !props.lightweight || orbitUnlocked.value
  controls.enabled = active
  renderer.domElement.style.touchAction = active ? 'none' : 'pan-y'
}

function toggleOrbitLock() {
  orbitUnlocked.value = !orbitUnlocked.value
  syncOrbitInteraction()
}

function applyAccentColor() {
  const hex = normalizeAccentColor(props.sceneConfig?.accentColor, DEFAULT_ACCENT_COLOR)
  for (const mesh of accentMeshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (mat?.color) mat.color.set(hex)
    }
  }
  invalidate()
}

function clearStageExtras() {
  if (floor) {
    world.remove(floor)
    floor.dispose?.()
    floor.geometry?.dispose?.()
    floor = null
  }
  if (floorVeil) {
    world.remove(floorVeil)
    disposeObjectTree(floorVeil)
    floorVeil = null
  }
  if (thermalGroup) {
    world.remove(thermalGroup)
    disposeObjectTree(thermalGroup)
    thermalGroup = null
  }
  if (feedGroup) {
    world.remove(feedGroup)
    disposeObjectTree(feedGroup)
    feedGroup = null
    filamentStrand = null
  }
}

function rebuildStageExtras(box) {
  clearStageExtras()
  if (!box || !world) return

  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z, 0.08)
  const floorW = maxDim * 3.8
  const floorD = maxDim * 2.8
  const floorY = box.min.y - Math.max(0.0003, maxDim * 0.002)

  if (props.lightweight) {
    // Pi / kiosk mode: skip heavy Reflector secondary render pass for crisp touch responsiveness.
    floor = new THREE.Mesh(
      new THREE.CircleGeometry(maxDim * 1.15, 36),
      new THREE.MeshBasicMaterial({ color: 0x223037, transparent: true, opacity: 0.45 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.set(center.x, floorY, center.z)
    world.add(floor)
  } else {
    floor = new Reflector(new THREE.PlaneGeometry(floorW * 0.9, floorD * 0.82), {
      textureWidth: 512,
      textureHeight: 512,
      color: 0x6f797e,
      clipBias: 0.00003,
      multisample: 0,
    })
    const origBefore = floor.onBeforeRender
    floor.onBeforeRender = function (r, scene, cam, ...rest) {
      if (scene.overrideMaterial) return
      const veilWas = floorVeil?.visible ?? false
      const thermalWas = thermalGroup?.visible ?? false
      if (floorVeil) floorVeil.visible = false
      if (thermalGroup) thermalGroup.visible = false
      origBefore.call(this, r, scene, cam, ...rest)
      if (floorVeil) floorVeil.visible = veilWas
      if (thermalGroup) thermalGroup.visible = thermalWas
    }
    floor.rotation.x = -Math.PI / 2
    floor.position.set(center.x, floorY, center.z)
    world.add(floor)

    floorVeil = buildStudioFloorVeil({ width: floorW, depth: floorD })
    if (floorVeil) {
      floorVeil.position.set(center.x, floorY + 0.00025, center.z)
      world.add(floorVeil)
    }
  }

  if (activeViewKind.value === 'toolhead') {
    if (!thermalTexture) thermalTexture = buildThermalGlowTexture()
    const tipPos = nozzleTip ?? new THREE.Vector3(center.x, box.min.y, center.z)
    thermalGroup = new THREE.Group()

    const tipSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: thermalTexture,
        color: 0xf3c67b,
        transparent: true,
        opacity: 0,
        blending: THREE.NormalBlending,
        depthWrite: false,
      }),
    )
    tipSprite.position.set(tipPos.x, tipPos.y + 0.0045, tipPos.z)
    tipSprite.scale.set(0.026, 0.026, 1)
    tipSprite.visible = false
    tipSprite.renderOrder = 2
    tipSprite.userData.thermalRole = 'tip'
    thermalGroup.add(tipSprite)

    const poolMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.062, 0.062),
      new THREE.MeshBasicMaterial({
        map: thermalTexture,
        color: 0xf3c67b,
        transparent: true,
        opacity: 0,
        blending: THREE.NormalBlending,
        depthWrite: false,
      }),
    )
    poolMesh.rotation.x = -Math.PI / 2
    poolMesh.position.set(tipPos.x, floorY + 0.0005, tipPos.z)
    poolMesh.visible = false
    poolMesh.renderOrder = 2
    poolMesh.userData.thermalRole = 'pool'
    thermalGroup.add(poolMesh)
    world.add(thermalGroup)

    const inletPos = detectFilamentInlet(currentModel, filamentInlet, nozzleTip)
    if (inletPos) {
      feedGroup = new THREE.Group()
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(inletPos.x, inletPos.y - 0.002, inletPos.z),
        new THREE.Vector3(inletPos.x, inletPos.y + 0.022, inletPos.z),
        new THREE.Vector3(inletPos.x - 0.005, inletPos.y + 0.052, inletPos.z - 0.004),
        new THREE.Vector3(inletPos.x - 0.011, inletPos.y + 0.088, inletPos.z - 0.012),
      ])
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 20, 0.002, 8, false),
        new THREE.MeshStandardMaterial({
          color: 0x879499,
          transparent: true,
          opacity: 0.28,
          roughness: 0.3,
          metalness: 0,
          depthWrite: false,
        }),
      )
      feedGroup.add(tube)

      filamentStrand = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 20, 0.000875, 8, false),
        new THREE.MeshStandardMaterial({ color: 0xbec9cc, roughness: 0.45 }),
      )
      filamentStrand.visible = false
      feedGroup.add(filamentStrand)
      world.add(feedGroup)
    }
  }
}

function visualSignature() {
  const t0 = props.tool ?? {}
  const leds = t0.leds
  const filamentVisible =
    props.online && !(t0.filamentEnabled === true && t0.filamentDetected === false)
  const matColor = t0.material?.color ?? '#bec9cc'
  const glow = nozzleThermalGlow(t0.temperature, props.online)
  return [
    activeViewKind.value,
    props.online ? '1' : '0',
    leds?.number?.join(',') ?? '',
    leds?.left?.join(',') ?? '',
    leds?.right?.join(',') ?? '',
    filamentVisible ? '1' : '0',
    matColor,
    String(glow.bucket),
    props.sceneConfig?.accentColor ?? '',
  ].join('|')
}

function syncVisuals(force = false) {
  if (!currentModel) return
  const sig = visualSignature()
  if (!force && sig === lastVisualKey) return
  lastVisualKey = sig

  const now = performance.now()
  const dt = lastLedFrameAt ? now - lastLedFrameAt : Infinity
  const isContinuousStream = dt >= 40 && dt <= 600
  const ledDuration = isContinuousStream
    ? Math.round((ledIntervalMs * 0.6 + Math.min(340, Math.max(80, dt)) * 0.4) * 1.05)
    : LED_DISCRETE_LERP_MS

  const anyChanged = applyLedTargets(
    ledMeshes,
    mesh => (props.online ? props.tool?.leds?.[mesh.userData.ledRole] : null),
    { now, duration: ledDuration, force, reducedMotion: reducedMotion.matches, nozzleIntensity: 4.5 },
  )
  if (anyChanged) {
    if (isContinuousStream) ledIntervalMs = ledIntervalMs * 0.6 + Math.min(340, Math.max(80, dt)) * 0.4
    lastLedFrameAt = now
  }

  if (filamentStrand) {
    filamentStrand.visible =
      props.online && !(props.tool?.filamentEnabled === true && props.tool?.filamentDetected === false)
    filamentStrand.material.color.set(props.tool?.material?.color ?? '#bec9cc')
  }

  if (thermalGroup) {
    const glow = nozzleThermalGlow(props.tool?.temperature, props.online)
    thermalGroup.visible = activeViewKind.value === 'toolhead' && glow.active
    for (const node of thermalGroup.children) {
      node.visible = glow.active
      if (!glow.active) continue
      if (node.userData.thermalRole === 'tip') {
        node.material.color.set(glow.tipHex)
        node.material.opacity = Math.min(0.58, glow.intensity * 0.64)
      } else {
        node.material.color.set(glow.poolHex)
        node.material.opacity = Math.min(0.46, glow.intensity * 0.48)
      }
    }
  }

  invalidate()
}

function disposeCurrentModel() {
  if (currentModel && world) {
    world.remove(currentModel)
    disposeObjectTree(currentModel)
  }
  currentModel = null
  currentBox = null
  accentMeshes = []
  ledMeshes = []
  nozzleTip = null
  filamentInlet = null
  loadGuard.clearLoaded()
  clearStageExtras()
}

async function loadActiveModel(forceReload = false) {
  const src = activeSource.value
  if (!src || !renderer || !world) return
  const { gen, skip } = loadGuard.begin(src.url, { hasLoadedModel: Boolean(currentModel), forceReload })
  loading.value = loadGuard.isLoading()
  failure.value = ''
  if (skip) {
    applyAccentColor()
    syncVisuals(false)
    return
  }

  try {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(src.url)
    if (disposed || !world || !loadGuard.isCurrent(gen)) {
      disposeObjectTree(gltf.scene)
      return
    }

    disposeCurrentModel()
    const root = gltf.scene
    root.traverse(object => {
      if (!object.isMesh) return
      if (Array.isArray(object.material)) {
        object.material = object.material.map(m => m.clone())
      } else if (object.material) {
        object.material = object.material.clone()
      }
      const mats = Array.isArray(object.material) ? object.material : [object.material]
      let hasTransparentGlass = false
      for (const mat of mats) {
        if (!mat) continue
        const isGlass = Boolean(mat.transparent) && mat.opacity != null && mat.opacity < 0.95
        if (isGlass) {
          hasTransparentGlass = true
          mat.depthWrite = false
          if (mat.roughness != null) mat.roughness = Math.min(mat.roughness, 0.16)
          if (mat.metalness != null) mat.metalness = Math.min(mat.metalness, 0.15)
        } else {
          if (mat.metalness != null) mat.metalness = Math.min(mat.metalness, 0.38)
          if (mat.roughness != null) mat.roughness = Math.max(mat.roughness, 0.42)
        }
      }
      if (hasTransparentGlass) object.renderOrder = 1
    })

    const classified = classifyModelNodes(root)
    accentMeshes = classified.accentMeshes
    ledMeshes = classified.ledMeshes
    filamentInlet = classified.filamentInletNode
    for (const led of ledMeshes) {
      if (!led.material?.emissive) {
        led.material = new THREE.MeshStandardMaterial({ color: 0x697479, emissive: 0x000000, roughness: 0.4, metalness: 0 })
      }
    }

    currentModel = root
    loadGuard.markLoaded(gen, src.url)
    world.add(currentModel)
    currentModel.updateMatrixWorld(true)
    currentBox = new THREE.Box3().setFromObject(currentModel)
    nozzleTip = activeViewKind.value === 'toolhead' ? detectNozzleTip(currentModel, classified.nozzleTipNode) : null

    applyAccentColor()
    rebuildStageExtras(currentBox)
    fitCamera(currentBox, { animate: false, preset: 'iso' })
    syncVisuals(true)
  } catch {
    if (!disposed && loadGuard.isCurrent(gen)) {
      failure.value = 'Das 3D-Modell konnte nicht geladen werden.'
    }
  } finally {
    if (!disposed && loadGuard.finish(gen)) {
      loading.value = loadGuard.isLoading()
    }
  }
}

function resizeView() {
  if (!renderer || !viewport.value?.clientWidth || !viewport.value?.clientHeight) return
  camera.aspect = viewport.value.clientWidth / viewport.value.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(viewport.value.clientWidth, viewport.value.clientHeight, false)
  composer?.setSize(viewport.value.clientWidth, viewport.value.clientHeight)
  invalidate()
}

function onVisibility() {
  if (!document.hidden) invalidate()
}

function updateCanvasLabels() {
  renderer?.domElement.setAttribute('role', 'img')
  renderer?.domElement.setAttribute('title', t('Ziehen zum Drehen · Scrollen zum Zoomen'))
  renderer?.domElement.setAttribute('aria-label', t('Interaktive 3D-Ansicht des Druckers.'))
}

function onContextLost(event) {
  event.preventDefault()
  failure.value = 'Die 3D-Ansicht wurde unterbrochen. Seite neu laden, um sie wiederherzustellen.'
}

function initWebGL() {
  if (renderer || !viewport.value || isEmptyCustom.value) return
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, props.lightweight ? 1.25 : 1.75))
    renderer.setClearColor(0x1b252a, 1)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.02
    updateCanvasLabels()

    viewport.value.appendChild(renderer.domElement)
    world = new THREE.Scene()
    world.background = new THREE.Color('#1b252a')
    camera = new THREE.PerspectiveCamera(36, 1, 0.005, 100)

    if (!props.lightweight) {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType })
      target.texture.colorSpace = THREE.LinearSRGBColorSpace
      composer = new EffectComposer(renderer, target)
      composer.addPass(new RenderPass(world, camera))
      bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.22, 2.2)
      composer.addPass(bloom)
      composer.addPass(new OutputPass())
    }

    createStudioLights({ balanced: true }).forEach(light => world.add(light))

    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = !reducedMotion.matches
    controls.dampingFactor = 0.12
    controls.maxPolarAngle = Math.PI * 0.92
    controls.addEventListener('change', invalidate)
    syncOrbitInteraction()

    renderer.domElement.addEventListener('pointerdown', () => {
      animation = null
    })
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)

    resize = new ResizeObserver(resizeView)
    resize.observe(viewport.value)
    resizeView()

    observer = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true
      invalidate()
    })
    observer.observe(viewport.value)

    document.addEventListener('visibilitychange', onVisibility)
    loadActiveModel(true)
  } catch {
    loading.value = false
    failure.value = '3D ist in diesem Browser nicht verfügbar.'
  }
}

function teardownWebGL() {
  loadGuard.reset()
  loading.value = false
  failure.value = ''
  cancelAnimationFrame(frame)
  running = false
  resize?.disconnect()
  resize = null
  observer?.disconnect()
  observer = null
  document.removeEventListener('visibilitychange', onVisibility)
  disposeCurrentModel()
  thermalTexture?.dispose?.()
  thermalTexture = null
  controls?.dispose?.()
  controls = null
  composer?.passes?.forEach(pass => pass.dispose?.())
  composer?.dispose?.()
  composer = null
  bloom = null
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.domElement.remove()
    renderer.dispose()
    renderer = null
  }
  world = null
  camera = null
}

watch(language, updateCanvasLabels)

watch(
  () => [props.sceneConfig?.views?.toolhead?.url, props.sceneConfig?.views?.printer?.url, props.sceneConfig?.emptyCustom],
  async () => {
    const views = props.sceneConfig?.views ?? {}
    if (activeView.value === 'printer' && !views.printer && views.toolhead) {
      activeView.value = 'toolhead'
    } else if (activeView.value === 'toolhead' && !views.toolhead && views.printer) {
      activeView.value = 'printer'
    }
    if (isEmptyCustom.value) {
      teardownWebGL()
      return
    }
    await nextTick()
    if (!renderer) {
      initWebGL()
    } else {
      loadActiveModel(false)
    }
  },
)

watch(activeView, next => {
  saveSceneView(next)
  if (renderer && !isEmptyCustom.value) loadActiveModel(false)
})

watch(
  () => props.lightweight,
  async next => {
    orbitUnlocked.value = !next
    if (renderer && !isEmptyCustom.value) {
      teardownWebGL()
      await nextTick()
      initWebGL()
    }
  },
)

watch(
  () => props.sceneConfig?.accentColor,
  () => {
    if (currentModel) applyAccentColor()
  },
)

watch(
  () => [props.tool, props.online],
  () => syncVisuals(false),
)

onMounted(() => {
  if (!isEmptyCustom.value) initWebGL()
})

onBeforeUnmount(() => {
  disposed = true
  teardownWebGL()
})
</script>

<template>
  <section class="scene-panel printer-scene-panel" :aria-label="t('3D-Darstellung')">
    <div v-if="isEmptyCustom" class="printer-scene-empty">
      <Box :size="24" class="single-icon-accent" />
      <div class="printer-scene-empty-copy">
        <strong>{{ t('Eigenes 3D-CAD noch nicht hochgeladen') }}</strong>
        <p>{{ t('Lade in den Einstellungen eine .glb-Datei aus Fusion 360 oder 3D Print Rig für dieses Druckerprofil hoch.') }}</p>
      </div>
      <button type="button" class="subtle-button" @click="emit('open-settings')">
        <Upload :size="14" />{{ t('CAD in Einstellungen hochladen') }}
      </button>
    </div>

    <template v-else>
      <div class="scene-toolbar">
        <div class="scene-toolbar-left">
          <div v-if="hasBothViews" class="segmented scene-view-switch" role="group" :aria-label="t('3D-Modell')">
            <button type="button" :aria-pressed="activeViewKind === 'toolhead'" @click="activeView = 'toolhead'">
              {{ t('Toolhead') }}
            </button>
            <button type="button" :aria-pressed="activeViewKind === 'printer'" @click="activeView = 'printer'">
              {{ t('Drucker') }}
            </button>
          </div>
          <span v-else class="scene-single-title">
            <Box :size="14" />{{ activeSource?.label }}
          </span>
        </div>

        <div class="scene-actions">
          <div class="segmented scene-presets" role="group" :aria-label="t('Kameraperspektive')">
            <button
              type="button"
              :disabled="!ready"
              :aria-pressed="cameraPreset === 'iso'"
              @click="setCameraPreset('iso')"
            >
              Iso
            </button>
            <button
              type="button"
              :disabled="!ready"
              :aria-pressed="cameraPreset === 'front'"
              @click="setCameraPreset('front')"
            >
              {{ t('Front') }}
            </button>
            <button
              type="button"
              :disabled="!ready"
              :aria-pressed="cameraPreset === 'side'"
              @click="setCameraPreset('side')"
            >
              {{ t('Seite') }}
            </button>
          </div>
          <button
            v-if="lightweight"
            class="icon-button"
            :class="{ 'toggle-on': orbitUnlocked }"
            type="button"
            :disabled="!ready"
            :aria-pressed="orbitUnlocked"
            :aria-label="orbitUnlocked ? t('3D-Drehen sperren (Scrollen aktiv)') : t('3D-Drehen aktivieren')"
            :title="orbitUnlocked ? t('3D-Drehen sperren (Scrollen aktiv)') : t('3D-Drehen aktivieren')"
            @click="toggleOrbitLock"
          >
            <Unlock v-if="orbitUnlocked" :size="15" />
            <Lock v-else :size="15" />
          </button>
          <button
            v-if="activeViewKind === 'toolhead'"
            class="icon-button"
            type="button"
            :disabled="!ready"
            :aria-pressed="cameraPreset === 'underside'"
            :aria-label="t('Toolhead von unten ansehen')"
            :title="t('Unterseite')"
            @click="showUnderside"
          >
            <ArrowDownToLine :size="16" />
          </button>
          <button
            class="icon-button"
            type="button"
            :disabled="!ready"
            :aria-label="t('3D-Ansicht zurücksetzen')"
            :title="t('Ansicht zurücksetzen')"
            @click="resetCamera"
          >
            <RotateCcw :size="16" />
          </button>
        </div>
      </div>

      <div ref="viewport" class="scene-viewport printer-scene-viewport">
        <div v-if="loading || failure" class="scene-loading" role="status">
          <Box :size="24" />
          <span>{{ failure ? t(failure) : t('3D-Modell wird geladen …') }}</span>
          <button v-if="failure && renderer" class="subtle-button" type="button" @click="loadActiveModel(true)">
            {{ t('Modell erneut laden') }}
          </button>
        </div>
      </div>

      <div class="scene-bottom">
        <span class="scene-badge"><Box :size="13" />{{ badgeText }}</span>
        <span v-if="lightweight && !orbitUnlocked" class="scene-lock-hint">
          <Lock :size="11" />{{ t('Scroll-Schutz aktiv') }}
        </span>
      </div>
    </template>
  </section>
</template>
