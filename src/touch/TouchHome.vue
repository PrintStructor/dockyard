<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Flame,
  Thermometer,
  Snowflake,
  Home,
  Printer,
  Pause,
  Play,
  Square,
  ArrowUp,
  ArrowDown,
  Save,
  Gauge,
  Droplets,
  Ban,
  Check,
  X,
  Layers,
  Move,
  Sparkles,
  ArrowDownToLine,
  ArrowUpFromLine,
  Eye,
  MessageSquare,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { heatState } from '../../server/status.mjs'
import { auxActionReason } from '../aux-action-state.mjs'
import { toolActionReason } from '../tool-action-state.mjs'
import { printControlReason, SPEED_MIN, SPEED_MAX, FLOW_MIN, FLOW_MAX } from '../print-control-state.mjs'
import { withPrinterParam } from './touch-config.mjs'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  presets: { type: Array, default: () => [] },
  printerId: { type: String, default: '' },
  canWrite: { type: Boolean, default: true },
})

const emit = defineEmits(['open-numpad', 'navigate', 'command'])

const isToolchanger = computed(() => Boolean(props.status?.isToolchanger))
const tools = computed(() => props.status?.tools ?? [])
const extruder0 = computed(() => tools.value[0] ?? {})
const bed = computed(() => props.status?.bed ?? {})

const isPrintActive = computed(() => props.online && ['printing', 'paused'].includes(props.status?.printState))
const peekStandby = ref(false)
const showPrintHud = computed(() => isPrintActive.value && !peekStandby.value)

watch(isPrintActive, active => {
  if (!active) {
    peekStandby.value = false
    excludeModalOpen.value = false
    resetCancelConfirm()
    resetExcludeConfirm()
  }
})

// Print metadata (thumbnail & ETA) for Active Print HUD
const printMeta = ref(null)
let metaAbort = null

async function loadPrintMeta(filename) {
  metaAbort?.abort()
  if (!filename) {
    printMeta.value = null
    return
  }
  metaAbort = new AbortController()
  try {
    const url = withPrinterParam(`/api/print/metadata?filename=${encodeURIComponent(filename)}`, props.printerId)
    const res = await fetch(url, { signal: metaAbort.signal })
    if (!res.ok) return
    printMeta.value = await res.json().catch(() => null)
  } catch {
    // Ignore transient errors
  }
}

watch(
  [() => props.status?.printFilename, () => isPrintActive.value, () => props.printerId],
  ([filename, active]) => {
    if (active && filename) loadPrintMeta(filename)
    else if (!active) printMeta.value = null
  },
  { immediate: true },
)

const thumbnailUrl = computed(() =>
  printMeta.value?.thumbnail
    ? withPrinterParam(`/api/print/thumbnail?path=${encodeURIComponent(printMeta.value.thumbnail)}`, props.printerId)
    : '',
)

const progressPercent = computed(() =>
  Number.isFinite(props.status?.progress) ? Math.round(Math.max(0, Math.min(1, props.status.progress)) * 100) : null,
)

const remainingSeconds = computed(() => {
  const elapsed = props.status?.printDuration
  const est = printMeta.value?.estimatedTime
  const prog = props.status?.progress
  if (Number.isFinite(est) && Number.isFinite(elapsed) && est > elapsed) return est - elapsed
  if (Number.isFinite(elapsed) && Number.isFinite(prog) && prog > 0.02) return (elapsed / prog) * (1 - prog)
  return null
})

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs}h ${String(mins).padStart(2, '0')}m`
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`
  return `${secs}s`
}

const number = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'

const tempInt = value => (typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}°` : '—')

// Active Print HUD Controls
const zSteps = [0.005, 0.01, 0.025, 0.05]
const zStep = ref(0.01)
const confirmCancel = ref(false)
let cancelTimer = null

function resetCancelConfirm() {
  confirmCancel.value = false
  clearTimeout(cancelTimer)
  cancelTimer = null
}

const pauseAction = computed(() => (props.status?.printState === 'paused' ? 'resume' : 'pause'))
const pauseReason = computed(() => auxActionReason(props.status, pauseAction.value, props.online, props.pending))
const cancelReason = computed(() => printControlReason(props.status, 'print_cancel', props.online, props.pending))
const zReason = computed(() => printControlReason(props.status, 'tune_z_offset', props.online, props.pending))
const saveZReason = computed(() => printControlReason(props.status, 'save_z_offset', props.online, props.pending))
const speedReason = computed(() => printControlReason(props.status, 'tune_speed', props.online, props.pending))
const flowReason = computed(() => printControlReason(props.status, 'tune_flow', props.online, props.pending))
const excludeReason = computed(() => printControlReason(props.status, 'exclude_object', props.online, props.pending))
const pauseNextReason = computed(() => printControlReason(props.status, 'pause_next_layer', props.online, props.pending))

const canSaveZ = computed(() => !saveZReason.value && Boolean(props.status?.capabilities?.zOffsetSaveTarget))
const formattedZOffset = computed(() => {
  const z = props.status?.zOffset
  if (z == null) return '—'
  const sign = z > 0 ? '+' : ''
  return `${sign}${z.toLocaleString(locale.value, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`
})

async function handleCancelTap() {
  if (cancelReason.value) return
  if (!confirmCancel.value) {
    confirmCancel.value = true
    clearTimeout(cancelTimer)
    cancelTimer = setTimeout(resetCancelConfirm, 6000)
    return
  }
  resetCancelConfirm()
  await props.send({ action: 'print_cancel' })
}

// Exclude Object Modal (2D SVG Bed Map + List)
const excludeModalOpen = ref(false)
const confirmExclude = ref('')
let excludeTimer = null
function resetExcludeConfirm() {
  confirmExclude.value = ''
  clearTimeout(excludeTimer)
  excludeTimer = null
}

const excludeData = computed(() => props.status?.excludeObjects ?? { available: false, objects: [], excluded: [], current: null })
const excludedSet = computed(() => new Set(excludeData.value.excluded ?? []))

const excludeMap = computed(() => {
  const objs = excludeData.value.objects ?? []
  const mappable = objs.filter(o => (Array.isArray(o.polygon) && o.polygon.length >= 3) || Array.isArray(o.center))
  if (!mappable.length) return null
  const b = props.status?.bedSize
  let minX = Number.isFinite(b?.originX) ? b.originX : 0
  let minY = Number.isFinite(b?.originY) ? b.originY : 0
  let maxX = minX + (Number.isFinite(b?.width) && b.width > 10 ? b.width : 250)
  let maxY = minY + (Number.isFinite(b?.depth) && b.depth > 10 ? b.depth : 250)
  for (const obj of mappable) {
    if (Array.isArray(obj.polygon)) {
      for (const [x, y] of obj.polygon) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (Array.isArray(obj.center)) {
      const [cx, cy] = obj.center
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy
      if (cy > maxY) maxY = cy
    }
  }
  const w = Math.max(10, maxX - minX)
  const h = Math.max(10, maxY - minY)
  const fallbackR = Math.max(4, Math.min(w, h) * 0.04)
  return {
    viewBox: `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`,
    width: w,
    height: h,
    items: mappable.map(obj => ({
      name: obj.name,
      points:
        Array.isArray(obj.polygon) && obj.polygon.length >= 3
          ? obj.polygon.map(([x, y]) => `${(x - minX).toFixed(2)},${(maxY - y).toFixed(2)}`).join(' ')
          : '',
      cx: Array.isArray(obj.center) ? obj.center[0] - minX : w / 2,
      cy: Array.isArray(obj.center) ? maxY - obj.center[1] : h / 2,
      r: fallbackR,
    })),
  }
})

async function handleExcludeTap(name) {
  if (excludeReason.value || excludedSet.value.has(name)) return
  if (confirmExclude.value !== name) {
    confirmExclude.value = name
    clearTimeout(excludeTimer)
    excludeTimer = setTimeout(resetExcludeConfirm, 6000)
    return
  }
  resetExcludeConfirm()
  await props.send({ action: 'exclude_object', name })
}

// Active tool in print HUD
const activeToolId = computed(() => {
  const id = props.status?.active
  return Number.isInteger(id) && id >= 0 && id < tools.value.length ? id : 0
})
const activeToolObj = computed(() => tools.value[activeToolId.value] ?? extruder0.value)

// 6-Toolchanger Tool Action Sheet
const sheetToolId = ref(null)
const sheetTool = computed(() => (sheetToolId.value != null ? tools.value[sheetToolId.value] ?? null : null))

function openToolSheet(id) {
  sheetToolId.value = id
}

function closeToolSheet() {
  sheetToolId.value = null
}

function toolReason(action, id) {
  return toolActionReason(props.status, action, id, props.online, props.pending)
}

async function runToolSheetAction(action) {
  const id = sheetToolId.value
  if (id == null || toolReason(action, id)) return
  closeToolSheet()
  await props.send({ action, tool: id })
}

function toggleSheetFilamentSensor() {
  const tool = sheetTool.value
  if (!tool?.filamentSensorName || tool.filamentEnabled == null || !props.canWrite || !props.online) return
  props.send({ action: 'filament_sensor', sensor: tool.filamentSensorName, enabled: !tool.filamentEnabled })
}

// Shared Standby Helpers
const busy = computed(() => props.pending || Boolean(props.status?.control?.job))
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)
const moving = computed(
  () => ['printing', 'paused'].includes(props.status?.printState) || props.status?.idleState === 'Printing' || props.status?.loadWatchActive,
)
const motion = computed(() => enabled.value && !moving.value && !props.status?.detectionMismatch)
const homing = computed(
  () => enabled.value && !moving.value && (!props.status?.detectionMismatch || props.status?.homingCanInitialize),
)
const allHomed = computed(() => ['x', 'y', 'z'].every(a => props.status?.homedAxes?.includes(a)))

const levelingKind = computed(() => {
  if (props.status?.capabilities?.qgl) return 'qgl'
  if (props.status?.capabilities?.zTilt) return 'z_tilt'
  return null
})
const levelingApplied = computed(() => Boolean(props.status?.qglApplied || props.status?.zTiltApplied))

const watchAction = computed(() => (props.status?.loadWatchActive ? 'watch_stop' : 'watch_start'))
const watchReason = computed(() => auxActionReason(props.status, watchAction.value, props.online, props.pending))

const chamberTemp = computed(
  () =>
    props.status?.chamber ??
    props.status?.sensors?.find(s => /chamber|kammer/i.test(`${s.name ?? ''} ${s.label ?? ''}`))?.temperature ??
    null,
)

const primaryFilamentSensor = computed(() => {
  const list = props.status?.filamentSensors
  if (Array.isArray(list) && list.length > 0) return list[0]
  const t0 = extruder0.value
  if (t0.filamentSensorName || t0.filamentEnabled != null) {
    return {
      name: t0.filamentSensorName || '',
      label: t0.filamentSensorName || 'Filament',
      enabled: t0.filamentEnabled,
      detected: t0.filamentDetected,
    }
  }
  return null
})

function togglePrimarySensor() {
  const s = primaryFilamentSensor.value
  if (!s?.name || s.enabled == null || !props.canWrite || !props.online || props.status?.klipperState !== 'ready') return
  props.send({ action: 'filament_sensor', sensor: s.name, enabled: !s.enabled })
}

function heatClass(heater) {
  const s = heatState(heater)
  if (!props.online) return 'idle'
  if (s === 'Heizt auf') return 'heating'
  if (s === 'Auf Solltemperatur') return 'holding'
  if (s === 'Heizung aus · heiß' || s === 'Über Solltemperatur') return 'cooling'
  return 'idle'
}

function openNozzleNumpad(toolId = 0) {
  if (!enabled.value) return
  const toolObj = tools.value[toolId] ?? {}
  const max = props.status?.capabilities?.toolMax?.[toolId] ?? 300
  emit('open-numpad', {
    title: isToolchanger.value ? t('Werkzeug T{0}', [toolId]) : t('Extruder'),
    unit: '°C',
    initialValue: toolObj.target ?? 0,
    min: 0,
    max,
    presets: [
      { label: t('Aus'), value: 0 },
      { label: '140°', value: 140 },
      { label: '210°', value: 210 },
      { label: '240°', value: 240 },
      { label: '260°', value: 260 },
    ],
    onConfirm: target =>
      props.send({ action: 'temperature', heater: toolId ? `extruder${toolId}` : 'extruder', target }),
  })
}

function openBedNumpad() {
  if (!enabled.value) return
  const max = props.status?.capabilities?.bedMax ?? 120
  emit('open-numpad', {
    title: t('Druckbett'),
    unit: '°C',
    initialValue: bed.value.target ?? 0,
    min: 0,
    max,
    presets: [
      { label: t('Aus'), value: 0 },
      { label: '60°', value: 60 },
      { label: '80°', value: 80 },
      { label: '105°', value: 105 },
      { label: '110°', value: 110 },
    ],
    onConfirm: target => props.send({ action: 'temperature', heater: 'heater_bed', target }),
  })
}

function openSpeedNumpad() {
  if (speedReason.value) return
  emit('open-numpad', {
    title: t('Geschwindigkeit'),
    unit: '%',
    initialValue: props.status?.speedPercent ?? 100,
    min: SPEED_MIN,
    max: SPEED_MAX,
    presets: [
      { label: '50 %', value: 50 },
      { label: '100 %', value: 100 },
      { label: '125 %', value: 125 },
      { label: '150 %', value: 150 },
    ],
    onConfirm: percent => props.send({ action: 'tune_speed', percent }),
  })
}

function openFlowNumpad() {
  if (flowReason.value) return
  emit('open-numpad', {
    title: t('Fluss'),
    unit: '%',
    initialValue: props.status?.flowPercent ?? 100,
    min: FLOW_MIN,
    max: FLOW_MAX,
    presets: [
      { label: '90 %', value: 90 },
      { label: '95 %', value: 95 },
      { label: '100 %', value: 100 },
      { label: '105 %', value: 105 },
    ],
    onConfirm: percent => props.send({ action: 'tune_flow', percent }),
  })
}

const topPresets = computed(() => (props.presets ?? []).slice(0, 3))

function apply1ToolPreset(preset) {
  if (!enabled.value) return
  const e = Number.isFinite(preset?.tools?.[0]) ? Math.round(preset.tools[0]) : null
  const b = Number.isFinite(preset?.bed) ? Math.round(preset.bed) : null
  if (e == null && b == null) return
  const payload = { action: 'preheat' }
  if (e != null) payload.extruder = e
  if (b != null) payload.bed = b
  props.send(payload)
}

function axisPos(axis, idx) {
  if (!props.online || !props.status?.homedAxes?.includes(axis)) return '—'
  const v = props.status?.position?.[idx]
  return Number.isFinite(v) ? v.toFixed(axis === 'z' ? 2 : 1) : '—'
}

onBeforeUnmount(() => {
  metaAbort?.abort()
  resetCancelConfirm()
  resetExcludeConfirm()
})
</script>

<template>
  <!-- MODE A: AUTO ACTIVE PRINT HUD -->
  <section v-if="showPrintHud" class="touch-stage-grid touch-print-hud" :aria-label="t('Aktiver Druck')">
    <div class="touch-hud-left">
      <div class="touch-hud-header">
        <div class="touch-hud-thumb">
          <img v-if="thumbnailUrl" :src="thumbnailUrl" :alt="status.filename || ''" />
          <Printer v-else :size="32" />
        </div>
        <div class="touch-hud-title">
          <div class="touch-hud-badges">
            <span class="touch-pill" :class="status.printState === 'paused' ? 'amber' : 'accent'">
              {{ status.printState === 'paused' ? t('Pausiert') : t('Druckt') }}
            </span>
            <span v-if="isToolchanger && status.active != null" class="touch-pill muted">T{{ status.active }}</span>
            <button type="button" class="touch-pill-btn" @click="peekStandby = true">
              <Eye :size="13" />{{ t('Übersicht') }}
            </button>
          </div>
          <h2 :title="status.filename || ''">{{ status.filename || t('Unbekannte Datei') }}</h2>
          <p v-if="status.displayMessage || status.printMessage" class="touch-hud-m117">
            <MessageSquare :size="12" />{{ status.displayMessage || status.printMessage }}
          </p>
        </div>
      </div>

      <div class="touch-hud-progress">
        <div class="touch-hud-progress-head">
          <strong>{{ progressPercent != null ? `${progressPercent} %` : '—' }}</strong>
          <span>
            <template v-if="status.printLayer != null">
              {{ t('Layer {0}/{1}', [status.printLayer, status.printTotalLayers ?? printMeta?.layerCount ?? '?']) }}
            </template>
          </span>
        </div>
        <div class="touch-progress-track">
          <div
            class="touch-progress-fill"
            :class="{ paused: status.printState === 'paused' }"
            :style="{ width: `${progressPercent ?? 0}%` }"
          />
        </div>
        <div class="touch-hud-times">
          <span>{{ t('Laufzeit') }}: <strong>{{ formatDuration(status.printDuration) }}</strong></span>
          <span>{{ t('Restzeit') }}: <strong>{{ formatDuration(remainingSeconds) }}</strong></span>
        </div>
      </div>

      <div class="touch-hud-main-actions">
        <button
          type="button"
          class="touch-btn touch-btn-lg"
          :class="pauseAction === 'resume' ? 'touch-btn-accent' : 'touch-btn-surface'"
          :disabled="!!pauseReason"
          @click="!pauseReason && send({ action: pauseAction })"
        >
          <Pause v-if="pauseAction === 'pause'" :size="20" />
          <Play v-else :size="20" />
          {{ pauseAction === 'pause' ? t('Pause') : t('Fortsetzen') }}
        </button>

        <button
          type="button"
          class="touch-btn touch-btn-lg"
          :class="confirmCancel ? 'touch-btn-danger' : 'touch-btn-surface'"
          :disabled="!!cancelReason"
          @click="handleCancelTap"
        >
          <Square :size="18" />
          {{ confirmCancel ? t('Wirklich?') : t('Abbrechen') }}
        </button>
      </div>
    </div>

    <div class="touch-hud-right">
      <div class="touch-hud-temps">
        <button type="button" class="touch-mini-card" @click="openNozzleNumpad(activeToolId)">
          <span class="touch-mini-label">
            <Flame :size="13" />{{ isToolchanger ? `T${activeToolId}` : t('Düse') }}
          </span>
          <strong>
            {{ tempInt(activeToolObj.temperature) }}
            <small>/ {{ activeToolObj.target ? `${Math.round(activeToolObj.target)}°` : t('Aus') }}</small>
          </strong>
        </button>
        <button type="button" class="touch-mini-card" @click="openBedNumpad">
          <span class="touch-mini-label"><Thermometer :size="13" />{{ t('Bett') }}</span>
          <strong>
            {{ tempInt(bed.temperature) }}
            <small>/ {{ bed.target ? `${Math.round(bed.target)}°` : t('Aus') }}</small>
          </strong>
        </button>
        <div v-if="chamberTemp != null" class="touch-mini-card static">
          <span class="touch-mini-label">{{ t('Kammer') }}</span>
          <strong>{{ tempInt(chamberTemp) }}</strong>
        </div>
      </div>

      <div class="touch-hud-zcard">
        <div class="touch-hud-zhead">
          <span>{{ t('Z-Offset') }}</span>
          <strong>{{ formattedZOffset }} mm</strong>
        </div>
        <div class="touch-chip-row">
          <button
            v-for="s in zSteps"
            :key="s"
            type="button"
            class="touch-chip"
            :aria-pressed="zStep === s"
            @click="zStep = s"
          >
            {{ s }}
          </button>
        </div>
        <div class="touch-z-buttons">
          <button
            type="button"
            class="touch-btn touch-btn-surface"
            :disabled="!!zReason"
            @click="!zReason && send({ action: 'tune_z_offset', delta: -zStep })"
          >
            <ArrowDown :size="18" />−{{ zStep }}
          </button>
          <button
            type="button"
            class="touch-btn touch-btn-surface"
            :disabled="!!zReason"
            @click="!zReason && send({ action: 'tune_z_offset', delta: zStep })"
          >
            <ArrowUp :size="18" />+{{ zStep }}
          </button>
          <button
            v-if="status?.capabilities?.zOffsetSaveTarget"
            type="button"
            class="touch-btn touch-btn-surface touch-btn-icon"
            :disabled="!canSaveZ"
            :aria-label="t('Z-Offset übernehmen')"
            @click="canSaveZ && send({ action: 'save_z_offset' })"
          >
            <Save :size="18" />
          </button>
        </div>
      </div>

      <div class="touch-hud-tune-row">
        <button type="button" class="touch-mini-card" :disabled="!!speedReason" @click="openSpeedNumpad">
          <span class="touch-mini-label"><Gauge :size="13" />{{ t('Tempo') }}</span>
          <strong>{{ status.speedPercent != null ? `${status.speedPercent} %` : '—' }}</strong>
        </button>
        <button type="button" class="touch-mini-card" :disabled="!!flowReason" @click="openFlowNumpad">
          <span class="touch-mini-label"><Droplets :size="13" />{{ t('Fluss') }}</span>
          <strong>{{ status.flowPercent != null ? `${status.flowPercent} %` : '—' }}</strong>
        </button>
      </div>

      <div class="touch-hud-extra-row">
        <button
          v-if="excludeData.objects.length"
          type="button"
          class="touch-btn touch-btn-surface"
          @click="excludeModalOpen = true"
        >
          <Ban :size="16" />{{ t('Objekte ({0})', [excludeData.objects.length - excludedSet.size]) }}
        </button>
        <button
          v-if="status?.capabilities?.pauseNextLayer"
          type="button"
          class="touch-btn"
          :class="status?.pauseAtLayer?.nextLayer ? 'touch-btn-amber' : 'touch-btn-surface'"
          :disabled="!!pauseNextReason"
          @click="!pauseNextReason && send({ action: 'pause_next_layer', enable: !status?.pauseAtLayer?.nextLayer })"
        >
          <Layers :size="16" />{{ status?.pauseAtLayer?.nextLayer ? t('Layer-Pause aktiv') : t('Nächster Layer') }}
        </button>
      </div>
    </div>
  </section>

  <!-- MODE B: 6-TOOLCHANGER STANDBY HOME -->
  <section v-else-if="isToolchanger" class="touch-tc-home" :aria-label="t('Werkzeuge')">
    <div v-if="isPrintActive" class="touch-return-hud-bar">
      <span>{{ t('Druck aktiv') }}: <strong>{{ status.filename }}</strong> ({{ progressPercent ?? 0 }} %)</span>
      <button type="button" class="touch-btn touch-btn-accent touch-btn-sm" @click="peekStandby = false">
        <Printer :size="15" />{{ t('Zur Druckansicht') }}
      </button>
    </div>

    <div class="touch-tc-grid">
      <button
        v-for="tool in tools"
        :key="tool.id"
        type="button"
        class="touch-tc-tile"
        :class="{
          mounted: online && tool.detected,
          heating: online && heatClass(tool) === 'heating',
          holding: online && heatClass(tool) === 'holding',
        }"
        @click="openToolSheet(tool.id)"
      >
        <div class="touch-tc-tile-head">
          <strong>T{{ tool.id }}</strong>
          <span v-if="online && tool.detected" class="touch-mounted-dot" :aria-label="t('Aufgenommen')">
            <Check :size="12" />
          </span>
          <span
            v-else-if="tool.filamentEnabled === true"
            class="touch-fil-dot"
            :class="tool.filamentDetected ? 'present' : 'empty'"
          />
        </div>
        <div class="touch-tc-temp">
          <span>{{ tempInt(tool.temperature) }}</span>
          <small v-if="tool.target > 0">/ {{ Math.round(tool.target) }}°</small>
        </div>
        <div class="touch-tc-meta">
          <span>{{ tool.material?.type || (tool.detected ? t('Aufgenommen') : t('Im Dock')) }}</span>
          <span
            v-if="tool.filamentEnabled === false"
            class="touch-tc-fil-off"
          >
            {{ t('Sensor aus') }}
          </span>
        </div>
      </button>
    </div>

    <div class="touch-tc-footer">
      <button type="button" class="touch-tc-bed-card" :disabled="!enabled" @click="openBedNumpad">
        <span class="touch-mini-label"><Thermometer :size="13" />{{ t('Druckbett') }}</span>
        <strong>
          {{ tempInt(bed.temperature) }}
          <small>/ {{ bed.target ? `${Math.round(bed.target)}°` : t('Aus') }}</small>
        </strong>
        <span v-if="chamberTemp != null" class="touch-tc-chamber">{{ t('Kammer') }} {{ tempInt(chamberTemp) }}</span>
      </button>

      <div class="touch-tc-quick-actions">
        <button
          type="button"
          class="touch-btn"
          :class="allHomed && online ? 'touch-btn-ok' : 'touch-btn-surface'"
          :disabled="!homing"
          @click="send({ action: 'home', axis: 'all' })"
        >
          <Home :size="17" />{{ t('Home All') }}
        </button>
        <button
          v-if="levelingKind"
          type="button"
          class="touch-btn"
          :class="levelingApplied && online ? 'touch-btn-ok' : 'touch-btn-surface'"
          :disabled="!motion || !allHomed"
          @click="send({ action: levelingKind })"
        >
          {{ levelingKind === 'qgl' ? 'QGL' : 'Z-Tilt' }}
        </button>
        <button
          type="button"
          class="touch-btn"
          :class="status?.loadWatchActive ? 'touch-btn-accent' : 'touch-btn-surface'"
          :disabled="!!watchReason"
          @click="!watchReason && send({ action: watchAction })"
        >
          {{ status?.loadWatchActive ? t('Einlegehilfe Fertig') : t('Einlegehilfe') }}
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-surface"
          :disabled="!enabled || status?.printState === 'printing'"
          @click="send({ action: 'heaters_off' })"
        >
          <Snowflake :size="17" />{{ t('Abkühlen') }}
        </button>
      </div>
    </div>
  </section>

  <!-- MODE C: 1-TOOL STANDBY HOME -->
  <section v-else class="touch-1t-home" :aria-label="t('Cockpit')">
    <div v-if="isPrintActive" class="touch-return-hud-bar">
      <span>{{ t('Druck aktiv') }}: <strong>{{ status.filename }}</strong> ({{ progressPercent ?? 0 }} %)</span>
      <button type="button" class="touch-btn touch-btn-accent touch-btn-sm" @click="peekStandby = false">
        <Printer :size="15" />{{ t('Zur Druckansicht') }}
      </button>
    </div>

    <div class="touch-1t-thermals">
      <button
        type="button"
        class="touch-hero-temp-card"
        :class="heatClass(extruder0)"
        :disabled="!enabled"
        @click="openNozzleNumpad(0)"
      >
        <div class="touch-hero-temp-head">
          <span><Flame :size="17" />{{ t('Extruder') }}</span>
          <small>{{ t(heatState(extruder0)) }}</small>
        </div>
        <div class="touch-hero-temp-val">
          <strong>{{ number(extruder0.temperature, 1) }}<span>°C</span></strong>
          <em>{{ extruder0.target > 0 ? `→ ${Math.round(extruder0.target)}°C` : t('Aus') }}</em>
        </div>
        <div class="touch-power-bar">
          <div class="touch-power-fill" :style="{ width: `${Math.round((extruder0.power ?? 0) * 100)}%` }" />
        </div>
      </button>

      <button
        type="button"
        class="touch-hero-temp-card"
        :class="heatClass(bed)"
        :disabled="!enabled"
        @click="openBedNumpad"
      >
        <div class="touch-hero-temp-head">
          <span><Thermometer :size="17" />{{ t('Druckbett') }}</span>
          <small>{{ t(heatState(bed)) }}</small>
        </div>
        <div class="touch-hero-temp-val">
          <strong>{{ number(bed.temperature, 1) }}<span>°C</span></strong>
          <em>{{ bed.target > 0 ? `→ ${Math.round(bed.target)}°C` : t('Aus') }}</em>
        </div>
        <div class="touch-power-bar">
          <div class="touch-power-fill" :style="{ width: `${Math.round((bed.power ?? 0) * 100)}%` }" />
        </div>
      </button>
    </div>

    <div class="touch-1t-meta-strip">
      <span class="touch-pos-readout">
        <em>X</em> {{ axisPos('x', 0) }} · <em>Y</em> {{ axisPos('y', 1) }} · <em>Z</em> {{ axisPos('z', 2) }}
      </span>
      <span v-if="chamberTemp != null" class="touch-pill muted">{{ t('Kammer') }} {{ tempInt(chamberTemp) }}</span>
      <button
        v-if="primaryFilamentSensor"
        type="button"
        class="touch-pill-btn"
        :class="{
          ok: online && primaryFilamentSensor.enabled && primaryFilamentSensor.detected,
          amber: online && primaryFilamentSensor.enabled && primaryFilamentSensor.detected === false,
        }"
        :disabled="!canWrite || !online || !primaryFilamentSensor.name"
        @click="togglePrimarySensor"
      >
        {{
          primaryFilamentSensor.enabled === false
            ? t('Sensor aus')
            : primaryFilamentSensor.detected
              ? t('Filament erkannt')
              : t('Kein Filament')
        }}
      </button>
      <span v-if="status?.spoolman?.activeSpool" class="touch-pill muted">
        {{ status.spoolman.activeSpool.material || status.spoolman.activeSpool.name }}
      </span>
    </div>

    <div class="touch-1t-preheat-row">
      <button
        v-for="preset in topPresets"
        :key="preset.name"
        type="button"
        class="touch-btn touch-btn-surface"
        :disabled="!enabled"
        @click="apply1ToolPreset(preset)"
      >
        <strong>{{ preset.name }}</strong>
        <small>{{ preset.tools?.[0] ?? '—' }}/{{ preset.bed ?? '—' }}°</small>
      </button>
      <button
        type="button"
        class="touch-btn touch-btn-surface"
        :disabled="!enabled"
        @click="send({ action: 'temperature', heater: 'extruder', target: 140 })"
      >
        <strong>140°</strong><small>{{ t('Düse') }}</small>
      </button>
      <button
        type="button"
        class="touch-btn touch-btn-surface"
        :disabled="!enabled || status?.printState === 'printing'"
        @click="send({ action: 'heaters_off' })"
      >
        <Snowflake :size="16" />{{ t('Abkühlen') }}
      </button>
    </div>

    <div class="touch-1t-actions-row">
      <button
        type="button"
        class="touch-btn touch-btn-lg"
        :class="allHomed && online ? 'touch-btn-ok' : 'touch-btn-surface'"
        :disabled="!homing"
        @click="send({ action: 'home', axis: 'all' })"
      >
        <Home :size="18" />{{ t('Home All') }}
      </button>
      <button
        v-if="levelingKind"
        type="button"
        class="touch-btn touch-btn-lg"
        :class="levelingApplied && online ? 'touch-btn-ok' : 'touch-btn-surface'"
        :disabled="!motion || !allHomed"
        @click="send({ action: levelingKind })"
      >
        {{ levelingKind === 'qgl' ? 'QGL' : 'Z-Tilt' }}
      </button>
      <button
        v-else
        type="button"
        class="touch-btn touch-btn-lg touch-btn-surface"
        @click="emit('navigate', 'move')"
      >
        <Move :size="18" />{{ t('Bewegen') }}
      </button>
      <button
        type="button"
        class="touch-btn touch-btn-lg touch-btn-surface"
        @click="emit('navigate', 'move', 'extrude')"
      >
        <ArrowDownToLine :size="18" />{{ t('Filament') }}
      </button>
      <button
        type="button"
        class="touch-btn touch-btn-lg touch-btn-accent"
        @click="emit('navigate', 'print')"
      >
        <Printer :size="18" />{{ t('Drucken') }}
      </button>
    </div>
  </section>

  <!-- 6-TOOLCHANGER TOOL QUICK-ACTION SHEET -->
  <div
    v-if="sheetTool"
    class="touch-overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="t('Werkzeug T{0}', [sheetTool.id])"
    @click.self="closeToolSheet"
  >
    <div class="touch-sheet">
      <div class="touch-sheet-head">
        <div>
          <h2>T{{ sheetTool.id }} · {{ tempInt(sheetTool.temperature) }} <small v-if="sheetTool.target > 0">/ {{ Math.round(sheetTool.target) }}°</small></h2>
          <p>{{ sheetTool.detected ? t('Aufgenommen') : t('Im Dock') }} · {{ sheetTool.material?.type || t('Material unbekannt') }}</p>
        </div>
        <button type="button" class="touch-btn touch-btn-ghost touch-btn-icon" :aria-label="t('Schließen')" @click="closeToolSheet">
          <X :size="20" />
        </button>
      </div>

      <div class="touch-sheet-grid">
        <button
          type="button"
          class="touch-btn touch-btn-accent"
          :disabled="!!toolReason(status?.detected != null && status?.detected !== sheetTool.id ? 'select' : 'pickup', sheetTool.id)"
          @click="runToolSheetAction(status?.detected != null && status?.detected !== sheetTool.id ? 'select' : 'pickup')"
        >
          {{ status?.detected != null && status?.detected !== sheetTool.id ? t('Wechseln') : t('Aufnehmen') }}
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-surface"
          :disabled="!!toolReason('park', sheetTool.id)"
          @click="runToolSheetAction('park')"
        >
          {{ t('Parken') }}
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-surface"
          :disabled="!enabled"
          @click="() => { const id = sheetTool.id; closeToolSheet(); openNozzleNumpad(id) }"
        >
          <Flame :size="17" />{{ t('Temperatur') }}
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-surface"
          :disabled="!!toolReason('load', sheetTool.id)"
          @click="runToolSheetAction('load')"
        >
          <ArrowDownToLine :size="17" />{{ t('Laden') }}
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-surface"
          :disabled="!!toolReason('unload', sheetTool.id)"
          @click="runToolSheetAction('unload')"
        >
          <ArrowUpFromLine :size="17" />{{ t('Entladen') }}
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-surface"
          :disabled="!!toolReason('clean', sheetTool.id)"
          @click="runToolSheetAction('clean')"
        >
          <Sparkles :size="17" />{{ t('Reinigen') }}
        </button>
        <button
          v-if="sheetTool.filamentSensorName && sheetTool.filamentEnabled != null"
          type="button"
          class="touch-btn touch-btn-surface touch-sheet-wide"
          :disabled="!canWrite || !online"
          @click="toggleSheetFilamentSensor"
        >
          {{ sheetTool.filamentEnabled ? t('Filamentsensor deaktivieren') : t('Filamentsensor aktivieren') }}
        </button>
      </div>
    </div>
  </div>

  <!-- EXCLUDE OBJECT TOUCH MODAL -->
  <div
    v-if="excludeModalOpen && excludeData.objects.length"
    class="touch-overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="t('Objekte im Druck')"
    @click.self="excludeModalOpen = false"
  >
    <div class="touch-sheet touch-exclude-sheet">
      <div class="touch-sheet-head">
        <h2><Ban :size="18" />{{ t('Objekte im Druck') }}</h2>
        <button type="button" class="touch-btn touch-btn-ghost touch-btn-icon" :aria-label="t('Schließen')" @click="excludeModalOpen = false">
          <X :size="20" />
        </button>
      </div>
      <div class="touch-exclude-body">
        <div v-if="excludeMap" class="touch-exclude-map">
          <svg :viewBox="excludeMap.viewBox" preserveAspectRatio="xMidYMid meet">
            <rect class="touch-ex-bed" x="0" y="0" :width="excludeMap.width" :height="excludeMap.height" rx="2" />
            <g
              v-for="item in excludeMap.items"
              :key="item.name"
              class="touch-ex-obj"
              :class="{
                current: excludeData.current === item.name,
                excluded: excludedSet.has(item.name),
                confirming: confirmExclude === item.name,
              }"
              @click="handleExcludeTap(item.name)"
            >
              <polygon v-if="item.points" :points="item.points" />
              <circle v-else :cx="item.cx" :cy="item.cy" :r="item.r" />
            </g>
          </svg>
        </div>
        <div class="touch-exclude-list">
          <button
            v-for="obj in excludeData.objects"
            :key="obj.name"
            type="button"
            class="touch-btn touch-exclude-item"
            :class="{
              'touch-btn-danger': confirmExclude === obj.name,
              'touch-btn-surface': confirmExclude !== obj.name,
              excluded: excludedSet.has(obj.name),
            }"
            :disabled="!!excludeReason || excludedSet.has(obj.name)"
            @click="handleExcludeTap(obj.name)"
          >
            <span>{{ obj.name }}</span>
            <small>
              {{
                excludedSet.has(obj.name)
                  ? t('Übersprungen')
                  : confirmExclude === obj.name
                    ? t('Wirklich?')
                    : excludeData.current === obj.name
                      ? t('Aktiv')
                      : t('Überspringen')
              }}
            </small>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
