<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Flame,
  Thermometer,
  Compass,
  Activity,
  Layers,
  ArrowDownToLine,
  ArrowUpFromLine,
  Sparkles,
  Droplets,
  Snowflake,
  Home,
  Move,
  Check,
  Clock,
  ChartNoAxesCombined,
  ChevronDown,
  Disc,
  Power,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
  Camera,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { heatState } from '../../server/status.mjs'
import { ledProfiles, quickHomeAxisReason, quickJogReason } from '../aux-action-state.mjs'
import { toolActionReason } from '../tool-action-state.mjs'
import ThermalGauge from './ThermalGauge.vue'
import TemperatureTarget from './TemperatureTarget.vue'
import FanControl from './FanControl.vue'
import LedControls from './LedControls.vue'
import SpoolmanPicker from './SpoolmanPicker.vue'
import TemperatureGraph from './TemperatureGraph.vue'
import MacroDeck from './MacroDeck.vue'
import CameraView from './CameraView.vue'
import LivePrintTuning from './LivePrintTuning.vue'

const PrinterScene = defineAsyncComponent(() => import('./PrinterScene.vue'))

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  time: String,
  printerSubtitle: String,
  printerName: { type: String, default: '' },
  printerId: { type: String, default: '' },
  sceneConfig: { type: Object, default: () => ({ kind: 'none' }) },
  canWrite: { type: Boolean, default: true },
  displayMode: { type: Boolean, default: false },
  cameras: { type: Array, default: () => [] },
})

const emit = defineEmits(['command', 'open-settings', 'refresh'])

const DEFAULT_FALLBACK_PRESETS = [
  { name: 'PLA', bed: 60, tools: [210] },
  { name: 'PETG', bed: 80, tools: [240] },
  { name: 'ABS', bed: 110, tools: [255] },
]

const EXTRUDE_LENGTHS = [5, 10, 25, 50, 100]
const EXTRUDE_SPEEDS = [2, 5, 10]

const presets = ref(DEFAULT_FALLBACK_PRESETS)
const presetEditorOpen = ref(false)
const presetNameDraft = ref('')
const presetExtruderDraft = ref(210)
const presetBedDraft = ref(60)
const presetSaving = ref(false)
const presetError = ref('')
const extrudeLength = ref(10)
const extrudeSpeed = ref(5)
const axisDrafts = ref({})
const confirmMotors = ref(false)
let confirmMotorsTimer = null
const presetController = new AbortController()

const extruder = computed(() => props.status?.tools?.[0] ?? {})
const bed = computed(() => props.status?.bed ?? {})
const has3dScene = computed(() => props.sceneConfig?.kind === 'printer-scene')
const activeSpool = computed(() => props.status?.spoolman?.activeSpool ?? null)

const number = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'

const ledColor = c =>
  c ? `rgb(${c.slice(0, 3).map(v => Math.round(Math.min(1, v + c[3]) * 255)).join(',')})` : 'transparent'

const hasExtruderLeds = computed(() => {
  const leds = extruder.value?.leds
  return Boolean(leds?.number || leds?.left || leds?.right)
})

const filamentSensors = computed(() => {
  const list = props.status?.filamentSensors
  if (Array.isArray(list) && list.length > 0) return list
  const tool = extruder.value
  if (tool.filamentSensorName || tool.filamentEnabled != null) {
    return [
      {
        id: tool.filamentSensorName || 'filament_sensor',
        name: tool.filamentSensorName || '',
        kind: 'switch',
        label: tool.filamentSensorName || 'Filament',
        enabled: tool.filamentEnabled,
        detected: tool.filamentDetected,
      },
    ]
  }
  return []
})

function sensorVisual(sensor) {
  const multi = filamentSensors.value.length > 1
  const prefix = multi ? `${sensor.label}: ` : ''
  if (!props.online || sensor.enabled == null) return { kind: 'unknown', label: `${prefix}${t('Filament ?')}` }
  if (sensor.enabled === false) return { kind: 'disabled', label: `${prefix}${t('Überwachung aus')}` }
  if (sensor.detected === true) return { kind: 'present', label: `${prefix}${t('Filament erkannt')}` }
  if (sensor.detected === false) return { kind: 'empty', label: `${prefix}${t('Kein Filament')}` }
  return { kind: 'unknown', label: `${prefix}${t('Filament ?')}` }
}

const canToggleSensor = computed(
  () => props.online && props.canWrite && props.status?.klipperState === 'ready' && !busy.value,
)

function toggleFilamentSensor(sensor) {
  if (!canToggleSensor.value || !sensor?.name || sensor.enabled == null) return
  emit('command', { action: 'filament_sensor', sensor: sensor.name, enabled: !sensor.enabled })
}

const bedHeat = computed(() => heatState(bed.value))
const extruderHeat = computed(() => heatState(extruder.value))

function heatPillMode(stateLabel) {
  if (!props.online) return 'idle'
  if (stateLabel === 'Heizt auf') return 'heating'
  if (stateLabel === 'Auf Solltemperatur') return 'holding'
  if (stateLabel === 'Heizung aus · heiß' || stateLabel === 'Über Solltemperatur') return 'cooling'
  return 'idle'
}

const extruderPillMode = computed(() => heatPillMode(extruderHeat.value))
const bedPillMode = computed(() => heatPillMode(bedHeat.value))

const busy = computed(() => props.pending || !!props.status?.control?.job)
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)
const isPrinting = computed(() => props.status?.printState === 'printing')
const isPrintActive = computed(() => ['printing', 'paused'].includes(props.status?.printState))
const canCooldown = computed(() => enabled.value && !isPrinting.value)
const macroEnabled = computed(
  () => enabled.value && !isPrinting.value && props.status?.idleState !== 'Printing' && !props.status?.loadWatchActive,
)
const primaryCamera = computed(() => (Array.isArray(props.cameras) && props.cameras.length > 0 ? props.cameras[0] : null))
const moving = computed(
  () =>
    ['printing', 'paused'].includes(props.status?.printState) ||
    props.status?.idleState === 'Printing' ||
    props.status?.loadWatchActive,
)
const motion = computed(() => enabled.value && !moving.value && !props.status?.detectionMismatch)
const homing = computed(
  () => enabled.value && !moving.value && (!props.status?.detectionMismatch || props.status?.homingCanInitialize),
)

const extruderMax = computed(() => props.status?.capabilities?.toolMax?.[0] ?? null)
const bedMax = computed(() => props.status?.capabilities?.bedMax ?? null)
const minExtrudeTemp = computed(() => props.status?.capabilities?.extrusionMin?.[0] ?? 170)

const extrudeBlockReason = computed(() => {
  if (!props.online) return 'Keine aktuellen Druckerdaten.'
  if (props.status?.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (busy.value) return 'Ein Befehl läuft noch oder muss geprüft werden.'
  if (props.status?.loadWatchActive) return 'Einlegehilfe ist scharf. Zuerst mit „Fertig“ beenden.'
  if (isPrinting.value) return 'Manuelles Extrudieren ist während eines laufenden Drucks gesperrt.'
  if (props.status?.idleState === 'Printing') return 'Der Drucker führt bereits eine Bewegung oder einen Befehl aus.'
  if (extruder.value?.canExtrude !== true) {
    return t('Extruder zu kalt — mindestens {0} °C erforderlich.', [minExtrudeTemp.value])
  }
  return ''
})

function runManualExtrude(sign) {
  if (extrudeBlockReason.value) return
  emit('command', {
    action: 'extrude',
    distance: sign * extrudeLength.value,
    speed: extrudeSpeed.value,
  })
}

const spoolPreheat = computed(() => {
  const s = activeSpool.value
  if (!s) return null
  const e = Number.isFinite(s.settingsExtruderTemp) ? Math.round(s.settingsExtruderTemp) : null
  const b = Number.isFinite(s.settingsBedTemp) ? Math.round(s.settingsBedTemp) : null
  if (e == null && b == null) return null
  return {
    name: s.material || 'Spule',
    color: s.color || null,
    extruder: e,
    bed: b,
  }
})

function presetExtruderTemp(preset) {
  const temp = preset?.tools?.[0]
  return Number.isFinite(temp) ? Math.round(temp) : null
}

function preheatPairAllowed(e, b) {
  if (!enabled.value) return false
  if (e == null && b == null) return false
  if (e != null && (extruderMax.value == null || e > extruderMax.value)) return false
  if (b != null && (bedMax.value == null || b > bedMax.value)) return false
  return true
}

function presetAllowed(preset) {
  const e = presetExtruderTemp(preset)
  const b = Number.isFinite(preset?.bed) ? Math.round(preset.bed) : null
  return preheatPairAllowed(e, b)
}

function sendPreheat(e, b) {
  if (!preheatPairAllowed(e, b)) return
  const payload = { action: 'preheat' }
  if (e != null) payload.extruder = e
  if (b != null) payload.bed = b
  emit('command', payload)
}

function applyPreheatPreset(preset) {
  const e = presetExtruderTemp(preset)
  const b = Number.isFinite(preset?.bed) ? Math.round(preset.bed) : null
  sendPreheat(e, b)
}

function preheatStandby140() {
  if (!enabled.value || extruderMax.value == null || extruderMax.value < 140) return
  emit('command', { action: 'temperature', heater: 'extruder', target: 140 })
}

function cooldownAll() {
  if (!canCooldown.value) return
  emit('command', { action: 'heaters_off' })
}

function editPresetItem(preset) {
  presetNameDraft.value = preset.name
  presetExtruderDraft.value = presetExtruderTemp(preset) ?? 0
  presetBedDraft.value = Number.isFinite(preset?.bed) ? Math.round(preset.bed) : 0
  presetError.value = ''
}

async function savePreset() {
  const name = presetNameDraft.value.trim()
  if (!name || presetSaving.value || !props.canWrite) return
  presetSaving.value = true
  presetError.value = ''
  try {
    const extVal = presetExtruderDraft.value !== '' && presetExtruderDraft.value != null ? Math.round(Number(presetExtruderDraft.value)) : null
    const bedVal = presetBedDraft.value !== '' && presetBedDraft.value != null ? Math.round(Number(presetBedDraft.value)) : null
    const res = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Request': '1' },
      body: JSON.stringify({ action: 'upsert', name, extruder: extVal, bed: bedVal }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Preset konnte nicht gespeichert werden.')
    if (Array.isArray(data.presets) && data.presets.length) presets.value = data.presets
    presetNameDraft.value = ''
  } catch (err) {
    presetError.value = err.message || 'Preset konnte nicht gespeichert werden.'
  } finally {
    presetSaving.value = false
  }
}

async function deletePreset(name) {
  if (!name || presetSaving.value || !props.canWrite) return
  presetSaving.value = true
  presetError.value = ''
  try {
    const res = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Request': '1' },
      body: JSON.stringify({ action: 'delete', name }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Preset konnte nicht gelöscht werden.')
    if (Array.isArray(data.presets) && data.presets.length) presets.value = data.presets
  } catch (err) {
    presetError.value = err.message || 'Preset konnte nicht gelöscht werden.'
  } finally {
    presetSaving.value = false
  }
}

const levelingKind = computed(() => {
  if (props.status?.capabilities?.qgl) return 'qgl'
  if (props.status?.capabilities?.zTilt) return 'z_tilt'
  return null
})
const levelingApplied = computed(() => Boolean(props.status?.qglApplied || props.status?.zTiltApplied))
const showBedMeshButton = computed(() => Boolean(props.status?.capabilities?.mesh))

const levelingBadge = computed(() => {
  const caps = props.status?.capabilities
  if (caps?.qgl) {
    return {
      applied: Boolean(props.status?.qglApplied),
      label: props.status?.qglApplied ? 'QGL ausgerichtet' : 'QGL offen',
    }
  }
  if (caps?.zTilt) {
    return {
      applied: Boolean(props.status?.zTiltApplied),
      label: props.status?.zTiltApplied ? 'Z-Tilt ausgerichtet' : 'Z-Tilt offen',
    }
  }
  return null
})

const bedSizeText = computed(() => {
  const size = props.status?.bedSize
  if (!size) return ''
  return `${Math.round(size.width)} × ${Math.round(size.depth)} mm`
})

const axisRows = computed(() => {
  const bedW = props.status?.bedSize?.width
  const bedD = props.status?.bedSize?.depth
  const bigX = Number.isFinite(bedW) && bedW <= 180 ? 50 : 100
  const bigY = Number.isFinite(bedD) && bedD <= 180 ? 50 : 100
  return [
    { axis: 'x', neg: [-bigX, -10, -1], pos: [1, 10, bigX] },
    { axis: 'y', neg: [-bigY, -10, -1], pos: [1, 10, bigY] },
    { axis: 'z', neg: [-10, -1, -0.1], pos: [0.1, 1, 10] },
  ]
})

const homedAxis = axis => props.status?.homedAxes?.includes(axis) === true
const allHomed = computed(() => [...'xyz'].every(homedAxis))
const axisIndex = axis => ['x', 'y', 'z'].indexOf(axis)

const axisDisplay = (axis, idx) => {
  if (!props.online || !homedAxis(axis)) return '—'
  const val = props.status?.position?.[idx]
  return Number.isFinite(val) ? number(val, axis === 'z' ? 2 : 1) : '—'
}

const axisLive = axis => {
  const value = props.status?.position?.[axisIndex(axis)]
  return homedAxis(axis) && Number.isFinite(value) ? Number(value.toFixed(2)) : null
}
const axisMin = axis => {
  const v = props.status?.axisMinimum?.[axisIndex(axis)]
  return Number.isFinite(v) ? v : null
}
const axisMax = axis => {
  const v = props.status?.axisMaximum?.[axisIndex(axis)]
  return Number.isFinite(v) ? v : null
}
const axisDraftValue = axis => {
  if (axisDrafts.value[axis] != null) return axisDrafts.value[axis]
  const live = axisLive(axis)
  return live == null ? '' : String(live)
}
const axisDirty = axis => {
  if (axisDrafts.value[axis] == null) return false
  if (axisDrafts.value[axis] === '') return true
  const live = axisLive(axis)
  return live == null || Math.abs(Number(axisDrafts.value[axis]) - live) > 1e-3
}
const axisValid = axis => {
  const raw = axisDraftValue(axis)
  if (raw === '') return false
  const num = Number(raw)
  const min = axisMin(axis)
  const max = axisMax(axis)
  return Number.isFinite(num) && min != null && max != null && num >= min && num <= max
}

async function applyAxisTarget(axis) {
  if (!motion.value || !homedAxis(axis) || !axisDirty(axis) || !axisValid(axis)) return
  const target = Number(Number(axisDraftValue(axis)).toFixed(3))
  const ok = await props.send({ action: 'move_to', axis, target })
  if (ok) delete axisDrafts.value[axis]
}

const axisHomeReason = axis => quickHomeAxisReason(props.status, axis, props.online, props.pending)
const axisJogReason = (axis, distance) => quickJogReason(props.status, axis, distance, props.online, props.pending)
const formatStep = value => `${value > 0 ? '+' : '−'}${Math.abs(value).toLocaleString(locale.value)}`
const jogStep = (axis, distance) => {
  if (!axisJogReason(axis, distance)) emit('command', { action: 'jog', axis, distance })
}

function resetMotorsConfirm() {
  confirmMotors.value = false
  clearTimeout(confirmMotorsTimer)
  confirmMotorsTimer = null
}

function releaseMotors() {
  if (!motion.value) return
  if (levelingApplied.value && !confirmMotors.value) {
    confirmMotors.value = true
    clearTimeout(confirmMotorsTimer)
    confirmMotorsTimer = setTimeout(resetMotorsConfirm, 5000)
    return
  }
  resetMotorsConfirm()
  emit('command', { action: 'motors_off' })
}

const motionHint = computed(() => {
  if (!props.online) return 'Keine aktuellen Druckerdaten.'
  if (props.status?.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (busy.value) return props.status?.control?.job?.label ?? 'Befehl läuft …'
  if (confirmMotors.value) {
    return props.status?.zTiltApplied && !props.status?.qglApplied
      ? 'Erneut klicken zum Bestätigen · Z-Tilt geht verloren.'
      : 'Erneut klicken zum Bestätigen · QGL geht verloren.'
  }
  if (moving.value) return 'Während Druck oder Pause gesperrt.'
  if (!allHomed.value) return 'Zuerst Achsen homen.'
  return 'Achsen referenziert.'
})

const printLabel = computed(
  () =>
    ({
      standby: 'Bereit',
      printing: 'Druckt',
      paused: 'Pausiert',
      complete: 'Abgeschlossen',
      cancelled: 'Abgebrochen',
      error: 'Fehler',
    })[props.status?.printState] ?? 'Unbekannt',
)

const activityLabel = computed(() => {
  const a = props.status?.activity ?? {}
  if (a.homing) return 'Homing läuft'
  if (a.qgling) return props.status?.capabilities?.zTilt && !props.status?.capabilities?.qgl ? 'Z-Tilt läuft' : 'Gantry wird ausgerichtet'
  if (a.probing) return 'Vermessung läuft'
  if (a.paused) return 'Druck pausiert'
  if (a.printing) return 'Druck läuft'
  if (a.heating_bed) return 'Bett heizt auf'
  if (a.heating_nozzle) return 'Düse heizt auf'
  if (props.online) {
    if (extruderHeat.value === 'Heizt auf') return 'Düse heizt auf'
    if (bedHeat.value === 'Heizt auf') return 'Bett heizt auf'
  }
  return null
})

const sensors = computed(() => props.status?.sensors ?? [])
const genericHeaters = computed(() => props.status?.genericHeaters ?? [])
const outputPins = computed(() => props.status?.outputPins ?? [])
const neopixels = computed(() => props.status?.neopixels ?? [])
const publicMacros = computed(() => props.status?.publicMacros ?? [])

const ledDrafts = ref({})

function rgbFloatToHex(r, g, b) {
  const toHex = v =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function hexToRgbFloat(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return [1, 1, 1]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function ledStateFor(neo) {
  const draft = ledDrafts.value[neo.name]
  if (draft) return draft
  const c = Array.isArray(neo.color) ? neo.color : [0, 0, 0, 0]
  const maxRgb = Math.max(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0)
  const brightness = Math.round(maxRgb * 100)
  const hex = maxRgb > 0.001 ? rgbFloatToHex(c[0] / maxRgb, c[1] / maxRgb, c[2] / maxRgb) : '#ffffff'
  const white = Math.round((c[3] ?? 0) * 100)
  return { hex, brightness, white }
}

function updateLedDraft(neo, patch) {
  ledDrafts.value = {
    ...ledDrafts.value,
    [neo.name]: { ...ledStateFor(neo), ...patch },
  }
}

function applyLed(neo, override = null) {
  if (!enabled.value) return
  const st = override ?? ledStateFor(neo)
  const [r, g, b] = hexToRgbFloat(st.hex)
  const scale = Math.max(0, Math.min(1, Number(st.brightness ?? 100) / 100))
  const payload = {
    action: 'set_led',
    led: neo.name,
    red: Number((r * scale).toFixed(3)),
    green: Number((g * scale).toFixed(3)),
    blue: Number((b * scale).toFixed(3)),
  }
  if (neo.hasWhite) {
    payload.white = Number(Math.max(0, Math.min(1, Number(st.white ?? 0) / 100)).toFixed(3))
  }
  emit('command', payload)
  const next = { ...ledDrafts.value }
  delete next[neo.name]
  ledDrafts.value = next
}

function quickLed(neo, kind) {
  if (!enabled.value) return
  if (kind === 'off') {
    emit('command', { action: 'set_led', led: neo.name, red: 0, green: 0, blue: 0, ...(neo.hasWhite ? { white: 0 } : {}) })
  } else if (kind === 'white') {
    emit('command', {
      action: 'set_led',
      led: neo.name,
      red: neo.hasWhite ? 0 : 1,
      green: neo.hasWhite ? 0 : 1,
      blue: neo.hasWhite ? 0 : 1,
      ...(neo.hasWhite ? { white: 1 } : {}),
    })
  } else if (kind === 'warm') {
    emit('command', {
      action: 'set_led',
      led: neo.name,
      red: 1,
      green: 0.72,
      blue: 0.35,
      ...(neo.hasWhite ? { white: 0.4 } : {}),
    })
  }
  const next = { ...ledDrafts.value }
  delete next[neo.name]
  ledDrafts.value = next
}

const tempFanEditing = ref('')
const tempFanDraft = ref(0)
const pinDrafts = ref({})

function openTempFanEditor(sensor) {
  if (!enabled.value || sensor.kind !== 'temperature_fan') return
  if (tempFanEditing.value === sensor.name) {
    tempFanEditing.value = ''
    return
  }
  tempFanEditing.value = sensor.name
  tempFanDraft.value = Number.isFinite(sensor.target) ? Math.round(sensor.target) : 0
}

async function applyTempFanTarget(sensor) {
  if (!enabled.value) return
  const target = Math.round(Number(tempFanDraft.value))
  const max = Number.isFinite(sensor.maxTemp) ? Math.floor(sensor.maxTemp) : 100
  if (!Number.isInteger(target) || target < 0 || target > max) return
  const ok = await props.send({ action: 'temperature_fan', fan: sensor.name, target })
  if (ok) tempFanEditing.value = ''
}

function pinValueFor(pin) {
  return pinDrafts.value[pin.name] != null ? pinDrafts.value[pin.name] : (pin.value ?? 0)
}

function pinPercent(pin, val) {
  const scale = pin.scale > 0 ? pin.scale : 1
  return Math.round(Math.max(0, Math.min(1, val / scale)) * 100)
}

async function setOutputPin(pin, value) {
  if (!enabled.value) return
  const prior = pinDrafts.value[pin.name]
  const ok = await props.send({ action: 'output_pin', pin: pin.name, value })
  if (ok && pinDrafts.value[pin.name] === prior) {
    delete pinDrafts.value[pin.name]
  }
}

function toggleOutputPin(pin) {
  if (!enabled.value) return
  const isOn = (pin.value ?? 0) > 0
  setOutputPin(pin, isOn ? 0 : (pin.scale > 0 ? pin.scale : 1))
}

const hasLedDeck = computed(() => {
  const installed = props.status?.capabilities?.ledProfiles ?? []
  return ledProfiles.some(p => installed.includes(p.id))
})

const QUICK_ACTIONS = [
  { id: 'load', label: 'Laden', icon: ArrowDownToLine },
  { id: 'unload', label: 'Entladen', icon: ArrowUpFromLine },
  { id: 'clean', label: 'Düse reinigen', icon: Sparkles },
  { id: 'purge', label: 'Purge', icon: Droplets },
]

const configuredQuickActions = computed(() => {
  const caps = props.status?.capabilities?.toolActions ?? {}
  return QUICK_ACTIONS.filter(item => Boolean(caps[item.id]))
})

const actionReason = id => toolActionReason(props.status, id, 0, props.online, props.pending)

function triggerQuickAction(id) {
  if (!actionReason(id)) emit('command', { action: id, tool: 0 })
}

watch(
  [() => props.online, () => moving.value, () => props.status?.homedAxes],
  ([isOnline, isMoving, homedAxes]) => {
    if (!isOnline || isMoving) {
      axisDrafts.value = {}
      return
    }
    for (const axis of ['x', 'y', 'z']) {
      if (!homedAxes?.includes(axis)) delete axisDrafts.value[axis]
    }
  },
)

watch(motion, allowed => {
  if (!allowed) resetMotorsConfirm()
})

onMounted(async () => {
  try {
    const response = await fetch('/api/presets', {
      signal: AbortSignal.any([presetController.signal, AbortSignal.timeout(7000)]),
    })
    const data = await response.json()
    if (response.ok && Array.isArray(data.presets) && data.presets.length) {
      presets.value = data.presets
    }
  } catch {
    // Keep safe defaults
  }
})

onBeforeUnmount(() => {
  presetController.abort()
  resetMotorsConfirm()
})
</script>

<template>
  <div class="single-cockpit">
    <!-- Band 1: Side-by-Side 3D Stage + Thermal & Quick-Preheat Deck -->
    <div class="single-hero-grid" :class="{ 'no-scene': !has3dScene }">
      <PrinterScene
        v-if="has3dScene"
        class="single-hero-scene"
        :scene-config="sceneConfig"
        :tool="extruder"
        :online="online"
        :printer-name="printerName"
        :printer-id="printerId"
        :bed-size="status?.bedSize ?? null"
        :can-write="canWrite"
        :lightweight="displayMode"
        @open-settings="emit('open-settings')"
      />

      <div class="single-thermal-deck" :aria-label="t('Temperaturen und Vorheizen')">
        <!-- 1-Click Preheat & Cooldown Bar -->
        <div class="single-preheat-bar" role="group" :aria-label="t('Schnell-Vorheizen')">
          <div class="single-preheat-chips">
            <button
              v-if="spoolPreheat"
              type="button"
              class="subtle-button single-preset-chip spool-chip"
              :disabled="!preheatPairAllowed(spoolPreheat.extruder, spoolPreheat.bed)"
              :title="
                t('Aktive Spule vorheizen · Extruder {0} °C · Bett {1} °C', [
                  spoolPreheat.extruder ?? '—',
                  spoolPreheat.bed ?? '—',
                ])
              "
              @click="sendPreheat(spoolPreheat.extruder, spoolPreheat.bed)"
            >
              <span
                class="spoolman-dot"
                :style="{ background: spoolPreheat.color ?? 'var(--muted)' }"
                aria-hidden="true"
              />
              <strong>{{ spoolPreheat.name }}</strong>
              <small>{{ spoolPreheat.extruder ?? '—' }}/{{ spoolPreheat.bed ?? '—' }}°</small>
            </button>
            <button
              v-for="preset in presets"
              :key="preset.name"
              type="button"
              class="subtle-button single-preset-chip"
              :disabled="!presetAllowed(preset)"
              :title="
                t('{0}: Extruder {1} °C · Bett {2} °C', [
                  preset.name,
                  presetExtruderTemp(preset) ?? '—',
                  preset.bed ?? '—',
                ])
              "
              @click="applyPreheatPreset(preset)"
            >
              <strong>{{ preset.name }}</strong>
              <small>
                {{ presetExtruderTemp(preset) ?? '—' }}/{{ preset.bed ?? '—' }}°
              </small>
            </button>
            <button
              type="button"
              class="subtle-button single-preset-chip"
              :disabled="!enabled || extruderMax == null || extruderMax < 140"
              :title="t('Düse auf 140 °C vorheizen (Standby)')"
              @click="preheatStandby140"
            >
              <strong>140°</strong>
              <small>{{ t('Düse') }}</small>
            </button>
          </div>
          <div class="single-preheat-end-actions">
            <button
              v-if="canWrite"
              type="button"
              class="icon-button single-preset-edit-btn"
              :class="{ active: presetEditorOpen }"
              :aria-expanded="presetEditorOpen"
              :title="t('Vorheiz-Presets bearbeiten')"
              :aria-label="t('Vorheiz-Presets bearbeiten')"
              @click="presetEditorOpen = !presetEditorOpen"
            >
              <SlidersHorizontal :size="14" />
            </button>
            <button
              type="button"
              class="subtle-button single-cooldown-btn"
              :disabled="!canCooldown"
              :aria-label="t('Alle Heizungen ausschalten')"
              :title="
                isPrinting
                  ? t('Cooldown ist während eines laufenden Drucks gesperrt. Bei einer Druckpause ist Cooldown verfügbar.')
                  : t('Alle Heizungen ausschalten')
              "
              @click="cooldownAll"
            >
              <Snowflake :size="14" />{{ t('Abkühlen') }}
            </button>
          </div>
        </div>

        <section
          v-if="presetEditorOpen && canWrite"
          class="single-preset-editor"
          :aria-label="t('Vorheiz-Presets bearbeiten')"
        >
          <div class="single-preset-editor-head">
            <strong>{{ t('Vorheiz-Presets (Moonraker DB)') }}</strong>
            <button
              type="button"
              class="icon-button"
              :aria-label="t('Schließen')"
              @click="presetEditorOpen = false"
            >
              <X :size="14" />
            </button>
          </div>

          <div class="single-preset-editor-chips">
            <div v-for="preset in presets" :key="preset.name" class="single-preset-pill-item">
              <button type="button" class="subtle-button" @click="editPresetItem(preset)">
                {{ preset.name }} · {{ presetExtruderTemp(preset) ?? '—' }}/{{ preset.bed ?? '—' }}°
              </button>
              <button
                v-if="!['ABS', 'PLA', 'PETG'].includes(preset.name.toUpperCase())"
                type="button"
                class="icon-button"
                :disabled="presetSaving"
                :title="t('Preset löschen')"
                :aria-label="t('{0} löschen', [preset.name])"
                @click="deletePreset(preset.name)"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </div>

          <form class="single-preset-form" @submit.prevent="savePreset">
            <input
              v-model="presetNameDraft"
              type="text"
              maxlength="32"
              :placeholder="t('Name (z. B. ASA, TPU)')"
              :aria-label="t('Preset-Name')"
              :disabled="presetSaving"
            />
            <label class="single-preset-num">
              <span>{{ t('Düse') }}</span>
              <input
                v-model.number="presetExtruderDraft"
                type="number"
                min="0"
                :max="extruderMax ?? 360"
                step="5"
                :disabled="presetSaving"
              />
            </label>
            <label class="single-preset-num">
              <span>{{ t('Bett') }}</span>
              <input
                v-model.number="presetBedDraft"
                type="number"
                min="0"
                :max="bedMax ?? 160"
                step="5"
                :disabled="presetSaving"
              />
            </label>
            <button type="submit" class="subtle-button" :disabled="presetSaving || !presetNameDraft.trim()">
              <Check :size="13" />{{ t('Speichern') }}
            </button>
          </form>
          <p v-if="presetError" class="system-inline-error" style="margin: 0">{{ t(presetError) }}</p>
        </section>

        <div class="single-thermal-stack" :class="{ horizontal: !has3dScene }">
          <!-- Extruder Card -->
          <article class="single-thermal-card" :class="{ stale: !online }">
            <div class="single-thermal-head">
              <div class="single-thermal-title">
                <Flame :size="16" class="single-icon-state" :class="extruderPillMode" />
                <h2>Extruder</h2>
                <div
                  v-if="hasExtruderLeds && online"
                  class="single-led-dots"
                  role="img"
                  :aria-label="t('Toolhead-LEDs')"
                >
                  <span
                    v-for="[role, lbl] in [['number', 'Logo'], ['left', 'Düse 1'], ['right', 'Düse 2']]"
                    :key="role"
                    class="led-swatch"
                    :style="{ background: ledColor(extruder.leds?.[role]) }"
                    :title="t(lbl)"
                  />
                </div>
              </div>
              <span class="single-heat-pill" :class="extruderPillMode">
                {{ t(extruderHeat) }}
              </span>
            </div>

            <div class="single-thermal-readout">
              <div class="single-big-temp">
                {{ number(extruder.temperature, 1) }}<span>°C</span>
              </div>
              <span v-if="online && extruder.power != null" class="single-power-pill">
                {{ number(extruder.power * 100, 0) }} %
              </span>
            </div>

            <ThermalGauge
              :label="t('Extruder')"
              :temperature="extruder.temperature"
              :target="extruder.target"
              :power="extruder.power"
              :max-temperature="extruderMax"
              :online="online"
              hide-label
            />

            <TemperatureTarget
              heater="extruder"
              :label="t('Extruder')"
              :target="extruder.target"
              :max="extruderMax"
              :online="online"
              :ready="status?.klipperState === 'ready'"
              :pending="busy"
              :send="send"
              :steppers="displayMode"
              :step-size="5"
            />

            <div
              v-if="filamentSensors.length || Number.isFinite(extruder.pressureAdvance) || (status?.spoolman?.available && status?.spoolman?.connected)"
              class="single-thermal-meta"
            >
              <SpoolmanPicker
                v-if="status?.spoolman?.available && status?.spoolman?.connected"
                :spoolman="status.spoolman"
                :online="online"
                :can-write="canWrite"
                @changed="emit('refresh')"
              />
              <button
                v-for="sensor in filamentSensors"
                :key="sensor.id"
                type="button"
                class="single-meta-pill sensor-toggle"
                :class="sensorVisual(sensor).kind"
                :disabled="!canToggleSensor || !sensor.name || sensor.enabled == null"
                :aria-pressed="sensor.enabled === true"
                :title="
                  sensor.enabled === true
                    ? t('{0} deaktivieren (während Druck möglich)', [sensor.label])
                    : t('{0} aktivieren', [sensor.label])
                "
                @click="toggleFilamentSensor(sensor)"
              >
                <span class="single-meta-dot" />
                <span>{{ sensorVisual(sensor).label }}</span>
              </button>
              <span
                v-if="Number.isFinite(extruder.pressureAdvance)"
                class="single-meta-pill neutral"
                title="Pressure Advance"
              >
                PA {{ number(extruder.pressureAdvance, 3) }}
              </span>
            </div>
          </article>

          <!-- Bed Card -->
          <article class="single-thermal-card" :class="{ stale: !online }">
            <div class="single-thermal-head">
              <div class="single-thermal-title">
                <Thermometer :size="16" class="single-icon-state" :class="bedPillMode" />
                <h2>{{ t('Druckbett') }}</h2>
              </div>
              <span class="single-heat-pill" :class="bedPillMode">
                {{ t(bedHeat) }}
              </span>
            </div>

            <div class="single-thermal-readout">
              <div class="single-big-temp">
                {{ number(bed.temperature, 1) }}<span>°C</span>
              </div>
              <span v-if="online && bed.power != null" class="single-power-pill">
                {{ number(bed.power * 100, 0) }} %
              </span>
            </div>

            <ThermalGauge
              :label="t('Druckbett')"
              :temperature="bed.temperature"
              :target="bed.target"
              :power="bed.power"
              :max-temperature="bedMax"
              :online="online"
              hide-label
            />

            <TemperatureTarget
              heater="heater_bed"
              :label="t('Druckbett')"
              :target="bed.target"
              :max="bedMax"
              :online="online"
              :ready="status?.klipperState === 'ready'"
              :pending="busy"
              :send="send"
              :steppers="displayMode"
              :step-size="5"
            />

            <div v-if="bedSizeText || levelingBadge" class="single-thermal-meta">
              <span v-if="bedSizeText" class="single-meta-pill neutral">
                <Layers :size="12" />{{ bedSizeText }}
              </span>
              <span
                v-if="levelingBadge"
                class="single-meta-pill"
                :class="levelingBadge.applied && online ? 'present' : 'neutral'"
              >
                {{ t(levelingBadge.label) }}
              </span>
            </div>
          </article>

          <!-- Active Generic Heaters (e.g. Chamber Heater) -->
          <article
            v-for="gh in genericHeaters"
            :key="gh.id"
            class="single-thermal-card"
            :class="{ stale: !online }"
          >
            <div class="single-thermal-head">
              <div class="single-thermal-title">
                <Flame :size="16" class="single-icon-state" :class="heatPillMode(heatState(gh))" />
                <h2>{{ t(gh.label) }}</h2>
              </div>
              <span class="single-heat-pill" :class="heatPillMode(heatState(gh))">
                {{ t(heatState(gh)) }}
              </span>
            </div>

            <div class="single-thermal-readout">
              <div class="single-big-temp">
                {{ number(gh.temperature, 1) }}<span>°C</span>
              </div>
              <span v-if="online && gh.power != null" class="single-power-pill">
                {{ number(gh.power * 100, 0) }} %
              </span>
            </div>

            <ThermalGauge
              :label="t(gh.label)"
              :temperature="gh.temperature"
              :target="gh.target"
              :power="gh.power"
              :max-temperature="gh.maxTemp"
              :online="online"
              hide-label
            />

            <TemperatureTarget
              :heater="gh.id"
              :label="t(gh.label)"
              :target="gh.target"
              :max="gh.maxTemp"
              :online="online"
              :ready="status?.klipperState === 'ready'"
              :pending="busy"
              :send="send"
              :steppers="displayMode"
              :step-size="5"
            />
          </article>
        </div>
      </div>
    </div>

    <!-- Band 2: Live Position, State, Dynamic Sensors & Update Timestamp -->
    <section class="single-metrics-strip" :aria-label="t('Position und Sensoren')">
      <div class="single-metric-cell">
        <span class="single-metric-label"><Compass :size="12" />{{ t('Position') }}</span>
        <strong class="single-metric-value single-tabular">
          <span><em>X</em> {{ axisDisplay('x', 0) }}</span>
          <span><em>Y</em> {{ axisDisplay('y', 1) }}</span>
          <span><em>Z</em> {{ axisDisplay('z', 2) }}</span>
        </strong>
      </div>

      <div class="single-metric-cell">
        <span class="single-metric-label"><Activity :size="12" />{{ t('Status') }}</span>
        <strong class="single-metric-value">
          {{ t(printLabel) }}
          <span v-if="activityLabel" class="single-activity-tag">{{ t(activityLabel) }}</span>
        </strong>
      </div>

      <div
        v-for="sensor in sensors"
        :key="sensor.id"
        class="single-metric-cell"
        :class="{ 'is-temp-fan': sensor.kind === 'temperature_fan' }"
      >
        <span class="single-metric-label">
          {{ t(sensor.label) }}
          <button
            v-if="sensor.kind === 'temperature_fan'"
            type="button"
            class="temp-fan-edit-trigger"
            :disabled="!enabled"
            :aria-expanded="tempFanEditing === sensor.name"
            :title="t('Zieltemperatur für {0} einstellen', [t(sensor.label)])"
            @click="openTempFanEditor(sensor)"
          >
            <SlidersHorizontal :size="11" />
          </button>
        </span>
        <form
          v-if="sensor.kind === 'temperature_fan' && tempFanEditing === sensor.name"
          class="temp-fan-inline-form"
          @submit.prevent="applyTempFanTarget(sensor)"
          @keydown.esc="tempFanEditing = ''"
        >
          <input
            v-model.number="tempFanDraft"
            type="number"
            min="0"
            :max="sensor.maxTemp ?? 100"
            step="1"
            inputmode="numeric"
            :aria-label="t('Zieltemperatur für {0} in Grad Celsius', [t(sensor.label)])"
          />
          <button type="submit" class="apply-temperature" :disabled="!enabled" :aria-label="t('Übernehmen')">
            <Check :size="12" />
          </button>
        </form>
        <strong v-else class="single-metric-value single-tabular">
          {{ number(sensor.temperature, 1) }} °C
          <small v-if="sensor.target != null && sensor.target > 0">/ {{ Math.round(sensor.target) }}°</small>
        </strong>
      </div>

      <div v-if="time" class="single-metric-cell single-metric-time">
        <span class="single-metric-label"><Clock :size="12" />{{ t('Stand') }}</span>
        <strong class="single-metric-value single-tabular">{{ time }}</strong>
      </div>
    </section>

    <!-- Band 3: Unified Motion & Machine Controls + Extruder/Filament, Fans & LEDs -->
    <div class="single-control-deck">
      <article class="control-panel single-motion-card" :aria-label="t('Achsen & Bewegung')">
        <div class="single-card-head">
          <h2><Move :size="17" />{{ t('Achsen & Bewegung') }}</h2>
          <p class="single-motion-hint" :class="{ warn: confirmMotors || !allHomed }" role="status">
            {{ t(motionHint) }}
          </p>
        </div>

        <div class="axis-readings">
          <form
            v-for="axis in ['x', 'y', 'z']"
            :key="axis"
            class="axis-reading-card"
            :class="{ homed: homedAxis(axis), dirty: axisDirty(axis) }"
            novalidate
            @submit.prevent="applyAxisTarget(axis)"
          >
            <span class="axis-reading-label">{{ axis.toUpperCase() }}</span>
            <input
              type="number"
              step="0.1"
              inputmode="decimal"
              :min="axisMin(axis) ?? undefined"
              :max="axisMax(axis) ?? undefined"
              :value="axisDraftValue(axis)"
              :disabled="!motion || !homedAxis(axis) || axisMin(axis) == null || axisMax(axis) == null"
              placeholder="—"
              :aria-label="t('Zielposition für {0} in Millimetern', [axis.toUpperCase()])"
              :title="
                !homedAxis(axis)
                  ? t('Zuerst {0} homen.', [axis.toUpperCase()])
                  : axisMin(axis) != null && axisMax(axis) != null
                    ? t('Verfahrbereich: {0} bis {1} mm · Enter fährt an, Escape verwirft', [
                        Math.round(axisMin(axis)),
                        Math.round(axisMax(axis)),
                      ])
                    : ''
              "
              @input="axisDrafts[axis] = $event.target.value"
              @keydown.esc="delete axisDrafts[axis]"
              @blur="!axisDirty(axis) && delete axisDrafts[axis]"
            />
            <small class="axis-reading-unit">mm</small>
            <button
              class="apply-temperature axis-apply-btn"
              type="submit"
              :disabled="!motion || !homedAxis(axis) || !axisDirty(axis) || !axisValid(axis)"
              :aria-label="t('Zielposition für {0} anfahren', [axis.toUpperCase()])"
              :title="t('Zielposition für {0} anfahren', [axis.toUpperCase()])"
            >
              <Check :size="13" />
            </button>
          </form>
        </div>

        <div class="single-prep-bar">
          <button
            class="subtle-button"
            :class="{ 'prep-done': allHomed && online }"
            type="button"
            :disabled="!homing"
            :aria-label="t('Alle Achsen homen')"
            :title="allHomed ? t('Alle Achsen referenziert · erneut homen') : t('Alle Achsen homen')"
            @click="emit('command', { action: 'home', axis: 'all' })"
          >
            <Home :size="14" /><span>{{ t('Alle') }}</span>
          </button>
          <button
            v-if="levelingKind === 'qgl'"
            class="subtle-button"
            :class="{ 'prep-done': status?.qglApplied && online }"
            type="button"
            :disabled="!motion || !allHomed || !status?.capabilities?.qgl"
            :title="status?.qglApplied ? t('Bereits ausgerichtet · QGL erneut ausführen') : t('Gantry ausrichten')"
            @click="emit('command', { action: 'qgl' })"
          >
            <span>QGL</span>
          </button>
          <button
            v-else-if="levelingKind === 'z_tilt'"
            class="subtle-button"
            :class="{ 'prep-done': status?.zTiltApplied && online }"
            type="button"
            :disabled="!motion || !allHomed || !status?.capabilities?.zTilt"
            :title="status?.zTiltApplied ? t('Bereits ausgerichtet · Z-Tilt erneut ausführen') : t('Z-Tilt ausrichten')"
            @click="emit('command', { action: 'z_tilt' })"
          >
            <span>Z-Tilt</span>
          </button>
          <button
            v-if="showBedMeshButton"
            class="subtle-button"
            type="button"
            :disabled="!motion || !allHomed || !status?.capabilities?.mesh"
            :title="t('Bett vermessen')"
            @click="emit('command', { action: 'mesh' })"
          >
            <span>{{ t('Bett-Mesh') }}</span>
          </button>
          <button
            class="subtle-button prep-motors-btn"
            :class="{ 'confirm-danger': confirmMotors }"
            type="button"
            :disabled="!motion"
            :aria-label="confirmMotors ? t('Wirklich lösen?') : t('Motoren lösen')"
            :title="
              confirmMotors
                ? status?.zTiltApplied && !status?.qglApplied
                  ? t('Erneut klicken zum Bestätigen · Z-Tilt muss danach erneut ausgeführt werden')
                  : t('Erneut klicken zum Bestätigen · QGL muss danach erneut ausgeführt werden')
                : t('Motoren lösen')
            "
            @click="releaseMotors"
            @keydown.esc="resetMotorsConfirm"
          >
            <svg class="motor-off-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <defs>
                <mask id="motor-off-cut-single">
                  <rect width="24" height="24" fill="white" />
                  <line x1="2" y1="2" x2="22" y2="22" stroke="black" stroke-width="4.4" stroke-linecap="round" />
                </mask>
              </defs>
              <path
                d="M7 4v2h3v2H7l-2 2v3H3v-3H1v8h2v-3h2v3h3l2 2h8v-4h2v3h3V9h-3v3h-2V8h-6V6h3V4H7z"
                fill="currentColor"
                mask="url(#motor-off-cut-single)"
              />
              <line x1="2.5" y1="2.5" x2="21.5" y2="21.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" />
            </svg>
            <span>{{ confirmMotors ? t('Wirklich aus?') : t('Motoren aus') }}</span>
          </button>
        </div>

        <div class="axis-jog-stack controls-axis-stack" :aria-label="t('Achsen bewegen')">
          <div v-for="row in axisRows" :key="row.axis" class="axis-jog-row controls-axis-row">
            <button
              v-for="dist in row.neg"
              :key="dist"
              type="button"
              class="axis-jog-btn"
              :disabled="!!axisJogReason(row.axis, dist)"
              :title="axisJogReason(row.axis, dist) ? t(axisJogReason(row.axis, dist)) : `${row.axis.toUpperCase()} ${formatStep(dist)} mm`"
              :aria-label="`${row.axis.toUpperCase()} ${formatStep(dist)} mm`"
              @click="jogStep(row.axis, dist)"
            >
              {{ formatStep(dist) }}
            </button>
            <button
              type="button"
              class="axis-home-btn"
              :class="{ 'axis-homed': homedAxis(row.axis) && online }"
              :disabled="!!axisHomeReason(row.axis)"
              :title="
                axisHomeReason(row.axis)
                  ? t(axisHomeReason(row.axis))
                  : homedAxis(row.axis)
                    ? t('{0} = {1} mm · {0} erneut homen', [row.axis.toUpperCase(), axisDisplay(row.axis, axisIndex(row.axis))])
                    : t('{0} homen', [row.axis.toUpperCase()])
              "
              :aria-label="t('{0} homen', [row.axis.toUpperCase()])"
              @click="emit('command', { action: 'home', axis: row.axis })"
            >
              {{ row.axis.toUpperCase() }}
            </button>
            <button
              v-for="dist in row.pos"
              :key="dist"
              type="button"
              class="axis-jog-btn"
              :disabled="!!axisJogReason(row.axis, dist)"
              :title="axisJogReason(row.axis, dist) ? t(axisJogReason(row.axis, dist)) : `${row.axis.toUpperCase()} ${formatStep(dist)} mm`"
              :aria-label="`${row.axis.toUpperCase()} ${formatStep(dist)} mm`"
              @click="jogStep(row.axis, dist)"
            >
              {{ formatStep(dist) }}
            </button>
          </div>
        </div>
      </article>

      <aside class="single-side-stack" :aria-label="t('Aktionen, Lüfter und LEDs')">
        <!-- Manual Extrude / Retract + Configured Filament Macros -->
        <section class="single-actions-card single-extrude-card" :aria-label="t('Extruder & Filament')">
          <div class="single-extrude-head">
            <h3><Disc :size="15" />{{ t('Extruder & Filament') }}</h3>
            <span
              class="single-heat-pill"
              :class="online && extruder.canExtrude === true ? 'holding' : 'heating'"
            >
              {{
                !online
                  ? t('Offline')
                  : extruder.canExtrude === true
                    ? t('Extrusion bereit')
                    : t('Kalt · ≥ {0} °C', [minExtrudeTemp])
              }}
            </span>
          </div>

          <div class="single-extrude-selectors">
            <div class="segmented single-extrude-chips" role="group" :aria-label="t('Extrusionslänge')">
              <button
                v-for="len in EXTRUDE_LENGTHS"
                :key="len"
                type="button"
                :aria-pressed="extrudeLength === len"
                @click="extrudeLength = len"
              >
                {{ len }} mm
              </button>
            </div>
            <div class="segmented single-extrude-chips" role="group" :aria-label="t('Extrusionsgeschwindigkeit')">
              <button
                v-for="spd in EXTRUDE_SPEEDS"
                :key="spd"
                type="button"
                :aria-pressed="extrudeSpeed === spd"
                @click="extrudeSpeed = spd"
              >
                {{ spd }} mm/s
              </button>
            </div>
          </div>

          <div class="single-extrude-actions">
            <button
              type="button"
              class="subtle-button"
              :disabled="!!extrudeBlockReason"
              :title="extrudeBlockReason ? t(extrudeBlockReason) : t('Filament um {0} mm mit {1} mm/s einziehen', [extrudeLength, extrudeSpeed])"
              @click="runManualExtrude(-1)"
            >
              <ArrowUpFromLine :size="14" />{{ t('Einziehen') }} −{{ extrudeLength }}
            </button>
            <button
              type="button"
              class="subtle-button single-extrude-push"
              :disabled="!!extrudeBlockReason"
              :title="extrudeBlockReason ? t(extrudeBlockReason) : t('Filament um {0} mm mit {1} mm/s extrudieren', [extrudeLength, extrudeSpeed])"
              @click="runManualExtrude(1)"
            >
              <ArrowDownToLine :size="14" />{{ t('Extrudieren') }} +{{ extrudeLength }}
            </button>
          </div>

          <div v-if="configuredQuickActions.length" class="single-actions-grid single-macro-divider">
            <button
              v-for="act in configuredQuickActions"
              :key="act.id"
              type="button"
              class="subtle-button"
              :disabled="!!actionReason(act.id)"
              :title="actionReason(act.id) ? t(actionReason(act.id)) : t(act.label)"
              @click="triggerQuickAction(act.id)"
            >
              <component :is="act.icon" :size="14" />
              {{ t(act.label) }}
            </button>
          </div>
        </section>

        <FanControl :status="status" :online="online" :pending="pending" :send="send" />

        <section v-if="outputPins.length" class="control-panel single-pins-card" :aria-label="t('Ausgänge')">
          <div class="fan-heading">
            <h2><Power :size="17" />{{ t('Ausgänge') }}</h2>
          </div>
          <div class="pin-list">
            <div v-for="pin in outputPins" :key="pin.id" class="pin-item">
              <template v-if="pin.pwm">
                <form class="fan-item" @submit.prevent="setOutputPin(pin, pinValueFor(pin))">
                  <div class="fan-item-head">
                    <strong>{{ t(pin.label) }}</strong>
                    <span>{{ online && pin.value != null ? `${pinPercent(pin, pin.value)} %` : '—' }}</span>
                  </div>
                  <div class="fan-setting">
                    <input
                      type="range"
                      min="0"
                      :max="pin.scale"
                      :step="pin.scale / 100"
                      :value="pinValueFor(pin)"
                      :disabled="!enabled"
                      :aria-label="t('Ausgangsleistung für {0}', [t(pin.label)])"
                      @input="pinDrafts[pin.name] = Number($event.target.value)"
                    />
                    <output>{{ pinPercent(pin, pinValueFor(pin)) }} %</output>
                  </div>
                  <div class="fan-actions">
                    <button type="button" class="subtle-button" :disabled="!enabled" @click="setOutputPin(pin, 0)">
                      <Power :size="13" />{{ t('Aus') }}
                    </button>
                    <button
                      class="subtle-button"
                      type="submit"
                      :disabled="!enabled || Math.abs(pinValueFor(pin) - (pin.value ?? 0)) < 1e-4"
                    >
                      <Check :size="13" />{{ t('Setzen') }}
                    </button>
                  </div>
                </form>
              </template>
              <div v-else class="pin-toggle-row">
                <strong>{{ t(pin.label) }}</strong>
                <button
                  type="button"
                  class="subtle-button pin-toggle-btn"
                  :class="{ active: online && (pin.value ?? 0) > 0 }"
                  :disabled="!enabled"
                  :aria-pressed="online && (pin.value ?? 0) > 0"
                  @click="toggleOutputPin(pin)"
                >
                  <Power :size="13" />{{ online && (pin.value ?? 0) > 0 ? t('An') : t('Aus') }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section v-if="neopixels.length" class="control-panel single-rgb-card" :aria-label="t('Beleuchtung & LEDs')">
          <div class="fan-heading">
            <h2><Sun :size="17" />{{ t('Beleuchtung & LEDs') }}</h2>
          </div>
          <div class="rgb-led-list">
            <div v-for="neo in neopixels" :key="neo.id" class="rgb-led-item">
              <div class="rgb-led-head">
                <span class="rgb-led-title">
                  <span
                    class="led-swatch"
                    :style="{ background: ledColor(neo.color) }"
                    aria-hidden="true"
                  />
                  <strong>{{ t(neo.label) }}</strong>
                </span>
                <div class="rgb-quick-btns">
                  <button type="button" class="subtle-button" :disabled="!enabled" @click="quickLed(neo, 'white')">
                    {{ t('Weiß') }}
                  </button>
                  <button type="button" class="subtle-button" :disabled="!enabled" @click="quickLed(neo, 'warm')">
                    {{ t('Warm') }}
                  </button>
                  <button type="button" class="subtle-button" :disabled="!enabled" @click="quickLed(neo, 'off')">
                    {{ t('Aus') }}
                  </button>
                </div>
              </div>
              <form class="rgb-led-controls" @submit.prevent="applyLed(neo)">
                <label class="rgb-color-field" :title="t('Farbe wählen')">
                  <input
                    type="color"
                    :value="ledStateFor(neo).hex"
                    :disabled="!enabled"
                    :aria-label="t('LED-Farbe für {0}', [t(neo.label)])"
                    @input="updateLedDraft(neo, { hex: $event.target.value, brightness: ledStateFor(neo).brightness || 100 })"
                  />
                </label>
                <div class="rgb-sliders">
                  <label class="rgb-slider-row">
                    <span>{{ t('Helligkeit') }}</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      :value="ledStateFor(neo).brightness"
                      :disabled="!enabled"
                      @input="updateLedDraft(neo, { brightness: Number($event.target.value) })"
                    />
                    <output>{{ ledStateFor(neo).brightness }} %</output>
                  </label>
                  <label v-if="neo.hasWhite" class="rgb-slider-row">
                    <span>W</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      :value="ledStateFor(neo).white"
                      :disabled="!enabled"
                      @input="updateLedDraft(neo, { white: Number($event.target.value) })"
                    />
                    <output>{{ ledStateFor(neo).white }} %</output>
                  </label>
                </div>
                <button type="submit" class="apply-temperature" :disabled="!enabled" :title="t('Farbe anwenden')" :aria-label="t('Farbe anwenden')">
                  <Check :size="13" />
                </button>
              </form>
            </div>
          </div>
        </section>

        <section v-if="hasLedDeck" class="single-led-card" :aria-label="t('LED-Steuerung')">
          <LedControls
            :status="status"
            :online="online"
            :pending="pending"
            hide-prep
            @command="emit('command', $event)"
          />
        </section>

        <MacroDeck
          :macros="publicMacros"
          :printer-id="printerId"
          :enabled="macroEnabled"
          @run="emit('command', $event)"
        />

        <details v-if="primaryCamera" class="single-cam-peek" :open="!displayMode">
          <summary>
            <span><Camera :size="15" />{{ primaryCamera.name || t('Kamera') }}</span>
            <ChevronDown :size="15" class="single-graph-chevron" />
          </summary>
          <div class="single-cam-peek-body">
            <CameraView
              :id="primaryCamera.id"
              :name="primaryCamera.name"
              :description="primaryCamera.description"
              :service="primaryCamera.service"
              :preferred-mode="primaryCamera.preferredMode"
              :flip-x="primaryCamera.flipX"
              :flip-y="primaryCamera.flipY"
              :rotate="primaryCamera.rotate"
            />
          </div>
        </details>
      </aside>
    </div>

    <!-- Band 4: Collapsible Standby Tuning & Temperature History Graph -->
    <details v-if="online && !isPrintActive" class="single-graph-disclosure single-standby-tuning">
      <summary>
        <span><SlidersHorizontal :size="15" />{{ t('Standby-Tuning · PA & Kinematik') }}</span>
        <ChevronDown :size="15" class="single-graph-chevron" />
      </summary>
      <div class="single-graph-body">
        <LivePrintTuning
          allow-standby
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
        />
      </div>
    </details>

    <details class="single-graph-disclosure" :open="!displayMode">
      <summary>
        <span><ChartNoAxesCombined :size="15" />{{ t('Temperaturverlauf') }}</span>
        <ChevronDown :size="15" class="single-graph-chevron" />
      </summary>
      <div class="single-graph-body">
        <TemperatureGraph :online="online" :status="status" />
      </div>
    </details>
  </div>
</template>
