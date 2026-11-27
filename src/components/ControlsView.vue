<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { Home, Move, Thermometer, Snowflake, Check } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { quickHomeAxisReason, quickJogReason } from '../aux-action-state.mjs'
import FanControl from './FanControl.vue'
import CameraView from './CameraView.vue'
import TemperatureGraph from './TemperatureGraph.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  selected: Number,
  send: Function,
  showCameras: { type: Boolean, default: true },
  cameras: { type: Array, default: () => [] },
  modelPreset: { type: String, default: 'auto' },
})

const emit = defineEmits(['command', 'select', 'refresh', 'context'])

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
const allTools = ref(false)
const drafts = ref({})
const submitted = ref({})
const axisDrafts = ref({})
const confirmMotors = ref(false)
let confirmMotorsTimer = null

const toolCount = computed(
  () => props.status?.toolCount ?? props.status?.tools?.length ?? (props.modelPreset === 'stormtrooper-6tc' ? 6 : 1),
)
const isSingleTool = computed(() =>
  props.status ? !props.status.isToolchanger && toolCount.value === 1 : props.modelPreset !== 'stormtrooper-6tc',
)
const toolIds = computed(() => Array.from({ length: toolCount.value }, (_, id) => id))
const activeToolId = computed(() => (isSingleTool.value ? 0 : props.selected))
const levelingKind = computed(() => {
  if (props.status?.capabilities?.qgl) return 'qgl'
  if (props.status?.capabilities?.zTilt) return 'z_tilt'
  return null
})
const showBedMeshButton = computed(() =>
  props.status ? Boolean(props.status.capabilities?.mesh) : props.modelPreset === 'stormtrooper-6tc',
)
const prepButtonCount = computed(() => 2 + (levelingKind.value ? 1 : 0) + (showBedMeshButton.value ? 1 : 0))
const levelingApplied = computed(() => Boolean(props.status?.qglApplied || props.status?.zTiltApplied))

watch(isSingleTool, single => {
  if (single) allTools.value = false
}, { immediate: true })

const heaterName = computed(() => {
  if (isSingleTool.value) return t('Extruder')
  if (allTools.value) return t('Alle Tools T0–T{0}', [toolCount.value - 1])
  return t('Werkzeug T{0}', [props.selected])
})
const heaterMax = computed(() => {
  const limits = props.status?.capabilities?.toolMax
  return allTools.value
    ? limits?.length === toolCount.value && limits.every(Number.isFinite)
      ? Math.min(...limits)
      : null
    : limits?.[activeToolId.value]
})

const presetTarget = preset =>
  allTools.value
    ? preset.tools.every(value => value === preset.tools[0])
      ? preset.tools[0]
      : null
    : preset.tools?.[activeToolId.value] ?? null

const liveTarget = id => (id === 'bed' ? props.status?.bed?.target : props.status?.tools?.[id]?.target)
const draftValue = id => drafts.value[id] ?? (liveTarget(id) == null ? '' : String(Math.round(liveTarget(id))))
const limitFor = id => (id === 'bed' ? props.status?.capabilities?.bedMax : props.status?.capabilities?.toolMax?.[id])
const dirty = id => drafts.value[id] != null && (drafts.value[id] === '' || Number(drafts.value[id]) !== liveTarget(id))
const valid = id =>
  draftValue(id) !== '' &&
  Number.isInteger(Number(draftValue(id))) &&
  Number(draftValue(id)) >= 0 &&
  limitFor(id) != null &&
  Number(draftValue(id)) <= limitFor(id)

function selectHeater(id) {
  allTools.value = false
  emit('select', id)
}

function toggleAllTools() {
  allTools.value = !allTools.value
}

function editTarget(id, value) {
  drafts.value[id] = value
  if (id !== 'bed') selectHeater(id)
}

function acknowledgeTargets() {
  for (const [id, value] of Object.entries(submitted.value)) {
    if (liveTarget(id) === value) {
      if (Number(drafts.value[id]) === value) delete drafts.value[id]
      delete submitted.value[id]
    }
  }
}

watch(() => [props.status?.bed?.target, ...(props.status?.tools ?? []).map(tool => tool.target)], acknowledgeTargets)

async function applyTarget(id) {
  if (!enabled.value || !valid(id) || !dirty(id)) return
  const target = Number(draftValue(id))
  const ok = await props.send({
    action: 'temperature',
    heater: id === 'bed' ? 'heater_bed' : Number(id) ? `extruder${id}` : 'extruder',
    target,
  })
  if (ok) {
    submitted.value[id] = target
    acknowledgeTargets()
  }
}

const selectedIds = computed(() => (allTools.value ? toolIds.value : [activeToolId.value]))

function stagePreset(target) {
  if (target != null) selectedIds.value.forEach(id => { drafts.value[id] = String(target) })
}

const groupReady = computed(
  () =>
    selectedIds.value.every(valid) &&
    selectedIds.value.some(dirty) &&
    selectedIds.value.every(id => Number(draftValue(id)) === Number(draftValue(selectedIds.value[0]))),
)

async function heatTools() {
  if (!groupReady.value || !enabled.value || (allTools.value && moving.value)) return
  if (!allTools.value) return applyTarget(activeToolId.value)
  const target = Number(draftValue(0))
  const ids = [...selectedIds.value]
  const ok = await props.send({ action: 'temperature_all', target })
  if (ok) {
    ids.forEach(id => { submitted.value[id] = target })
    acknowledgeTargets()
  }
}

function coolAll() {
  if (!canCooldown.value) return
  drafts.value = {}
  submitted.value = {}
  emit('command', { action: 'heaters_off' })
}

async function coolBed() {
  if (await props.send({ action: 'temperature', heater: 'heater_bed', target: 0 })) {
    delete drafts.value.bed
    delete submitted.value.bed
  }
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

const presets = ref([])
const presetError = ref('')
const presetRequest = new AbortController()

onMounted(async () => {
  try {
    const response = await fetch('/api/presets', {
      signal: AbortSignal.any([presetRequest.signal, AbortSignal.timeout(7000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    presets.value = data.presets
    if (!data.presets.length) presetError.value = 'Keine ABS-, PLA- oder PETG-Presets gespeichert.'
  } catch (error) {
    if (error.name !== 'AbortError') presetError.value = 'Temperatur-Presets gerade nicht erreichbar.'
  }
})

onBeforeUnmount(() => {
  presetRequest.abort()
  resetMotorsConfirm()
})

const busy = computed(() => props.pending || !!props.status?.control?.job)
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)
const isPrinting = computed(() => props.status?.printState === 'printing')
const canCooldown = computed(() => enabled.value && !isPrinting.value)
const moving = computed(
  () => ['printing', 'paused'].includes(props.status?.printState) || props.status?.idleState === 'Printing' || props.status?.loadWatchActive,
)
const motion = computed(() => enabled.value && !moving.value && !props.status?.detectionMismatch)
const homing = computed(
  () => enabled.value && !moving.value && (!props.status?.detectionMismatch || props.status?.homingCanInitialize),
)
const homed = axis => props.status?.homedAxes?.includes(axis) === true
const allHomed = computed(() => [...'xyz'].every(homed))

const position = axis => {
  const index = ['x', 'y', 'z'].indexOf(axis)
  const value = props.status?.position?.[index]
  return homed(axis) && value != null ? value.toLocaleString(locale.value, { maximumFractionDigits: 2 }) : '—'
}

const axisIndex = axis => ['x', 'y', 'z'].indexOf(axis)
const axisLive = axis => {
  const value = props.status?.position?.[axisIndex(axis)]
  return homed(axis) && Number.isFinite(value) ? Number(value.toFixed(2)) : null
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
  if (!motion.value || !homed(axis) || !axisDirty(axis) || !axisValid(axis)) return
  const target = Number(Number(axisDraftValue(axis)).toFixed(3))
  const ok = await props.send({ action: 'move_to', axis, target })
  if (ok) delete axisDrafts.value[axis]
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

const temperature = value => (value == null ? '—' : Math.round(value))

const axisHomeReason = axis => quickHomeAxisReason(props.status, axis, props.online, props.pending)
const axisJogReason = (axis, distance) => quickJogReason(props.status, axis, distance, props.online, props.pending)
const formatStep = value => `${value > 0 ? '+' : '−'}${Math.abs(value).toLocaleString(locale.value)}`
const jogStep = (axis, distance) => {
  if (!axisJogReason(axis, distance)) emit('command', { action: 'jog', axis, distance })
}

const restriction = computed(() => {
  if (!props.online) return 'Bedienung gesperrt: keine aktuellen Druckerdaten.'
  if (props.status?.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (busy.value) return props.status?.control?.job?.label ?? 'Befehl läuft …'
  if (confirmMotors.value) {
    return props.status?.zTiltApplied && !props.status?.qglApplied
      ? 'Erneut klicken zum Bestätigen · Z-Tilt muss danach erneut ausgeführt werden.'
      : 'Erneut klicken zum Bestätigen · QGL muss danach erneut ausgeführt werden.'
  }
  if (props.status?.loadWatchActive) return 'Einlegehilfe ist scharf. Unter Werkzeuge mit Fertig beenden.'
  if (moving.value) return 'Bewegungen sind während eines Drucks, einer Pause oder laufender Befehle gesperrt.'
  if (props.status?.homingCanInitialize) return 'Homen ist bereit. Dein Beacon-Makro initialisiert das erkannte Tool vor dem Z-Homen.'
  if (props.status?.detectionMismatch) return 'Werkzeugerkennung prüfen, bevor du bewegst.'
  if (!allHomed.value) return 'Noch nicht alle Achsen referenziert. Zuerst homen, dann bewegen.'
  return 'Achsen referenziert. Bewegungsschritte werden in Millimetern ausgeführt.'
})

watch(restriction, value => emit('context', value), { immediate: true })
watch(motion, allowed => {
  if (!allowed) resetMotorsConfirm()
})
</script>

<template>
  <section class="operation-layout" :class="{ 'no-cameras': !showCameras }" :aria-label="t('Drucker bedienen')">
    <div class="controls-layout">
      <article class="control-panel motion-panel">
        <h2><Move :size="20" />{{ t('Achsen & Bewegung') }}</h2>
        <div class="axis-readings">
          <form
            v-for="axis in ['x', 'y', 'z']"
            :key="axis"
            class="axis-reading-card"
            :class="{ homed: homed(axis), dirty: axisDirty(axis) }"
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
              :disabled="!motion || !homed(axis) || axisMin(axis) == null || axisMax(axis) == null"
              placeholder="—"
              :aria-label="t('Zielposition für {0} in Millimetern', [axis.toUpperCase()])"
              :title="
                !homed(axis)
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
              :disabled="!motion || !homed(axis) || !axisDirty(axis) || !axisValid(axis)"
              :aria-label="t('Zielposition für {0} anfahren', [axis.toUpperCase()])"
              :title="t('Zielposition für {0} anfahren', [axis.toUpperCase()])"
            >
              <Check :size="13" />
            </button>
          </form>
        </div>

        <div class="motion-prep-bar" :data-count="prepButtonCount">
          <button
            class="subtle-button"
            :class="{ 'prep-done': allHomed && online }"
            type="button"
            :disabled="!homing"
            :aria-label="t('Alle Achsen homen')"
            :title="
              allHomed
                ? t('Alle Achsen referenziert · erneut homen')
                : t('Alle Achsen homen')
            "
            @click="emit('command', { action: 'home', axis: 'all' })"
          >
            <Home :size="15" /><span>{{ t('Alle') }}</span>
          </button>
          <button
            v-if="levelingKind === 'qgl'"
            class="subtle-button"
            :class="{ 'prep-done': status?.qglApplied && online }"
            type="button"
            :disabled="!motion || !allHomed || !status?.capabilities?.qgl"
            :title="
              status?.qglApplied ? t('Bereits ausgerichtet · QGL erneut ausführen') : t('Gantry ausrichten')
            "
            :aria-label="
              status?.qglApplied
                ? t('Gantry bereits ausgerichtet. QGL erneut ausführen')
                : t('Gantry ausrichten · QGL')
            "
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
            :title="
              status?.zTiltApplied ? t('Bereits ausgerichtet · Z-Tilt erneut ausführen') : t('Z-Tilt ausrichten')
            "
            :aria-label="
              status?.zTiltApplied
                ? t('Bett bereits ausgerichtet. Z-Tilt erneut ausführen')
                : t('Z-Tilt ausrichten')
            "
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
            :aria-label="t('Bett vermessen')"
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
                : status?.qglApplied
                  ? t('Motoren lösen · Gantry senkt sich ab (QGL geht verloren)')
                  : status?.zTiltApplied
                    ? t('Motoren lösen · Ausrichtung geht verloren (Z-Tilt)')
                    : t('Motoren lösen')
            "
            @click="releaseMotors"
            @blur="resetMotorsConfirm"
            @keydown.esc="resetMotorsConfirm"
          >
            <svg class="motor-off-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <defs>
                <mask id="motor-off-cut-controls">
                  <rect width="24" height="24" fill="white" />
                  <line x1="2" y1="2" x2="22" y2="22" stroke="black" stroke-width="4.4" stroke-linecap="round" />
                </mask>
              </defs>
              <path
                d="M7 4v2h3v2H7l-2 2v3H3v-3H1v8h2v-3h2v3h3l2 2h8v-4h2v3h3V9h-3v3h-2V8h-6V6h3V4H7z"
                fill="currentColor"
                mask="url(#motor-off-cut-controls)"
              />
              <line x1="2.5" y1="2.5" x2="21.5" y2="21.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" />
            </svg>
            <span v-if="confirmMotors" class="prep-confirm-mark">?</span>
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
              :class="{ 'axis-homed': homed(row.axis) && online }"
              :disabled="!!axisHomeReason(row.axis)"
              :title="
                axisHomeReason(row.axis)
                  ? t(axisHomeReason(row.axis))
                  : homed(row.axis)
                    ? t('{0} = {1} mm · {0} erneut homen', [row.axis.toUpperCase(), position(row.axis)])
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

      <article class="control-panel heat-panel">
        <div class="heat-toolbar">
          <h2><Thermometer :size="18" />{{ isSingleTool ? t('Heizungen') : t('Werkzeuge') }}</h2>
          <button
            v-if="!isSingleTool"
            type="button"
            class="subtle-button all-tools-control"
            :aria-pressed="allTools"
            @click="toggleAllTools"
          >
            {{ t('Alle Tools') }}
          </button>
          <button
            class="subtle-button cooldown-control"
            type="button"
            :disabled="!canCooldown"
            :aria-label="t('Cooldown · alle Heizungen aus')"
            :title="
              isPrinting
                ? t('Cooldown ist während eines laufenden Drucks gesperrt. Bei einer Druckpause ist Cooldown verfügbar.')
                : t('Alle Heizungen ausschalten')
            "
            @click="coolAll"
          >
            <Snowflake :size="15" />{{ t('Abkühlen') }}
          </button>
        </div>

        <p
          v-if="status?.isToolchanger && online && !status?.detectionMismatch && (!status?.hasDetection || status?.detected == null)"
          class="tool-detection-note"
        >
          {{ !status?.hasDetection ? t('Werkzeugerkennung nicht verfügbar.') : t('Kein Werkzeug verbunden.') }}
        </p>

        <div class="temperature-list" :aria-label="isSingleTool ? t('Extruder-Temperatur') : t('Werkzeug zum Heizen auswählen')">
          <div class="temperature-list-label">
            <span>
              {{
                isSingleTool
                  ? t('Extruder')
                  : allTools
                    ? t('Alle {0} ausgewählt', [toolCount])
                    : t('Einzelnes Werkzeug wählen')
              }}
            </span>
            <span>{{ t('Ist / Ziel') }}</span>
          </div>
          <form
            v-for="id in toolIds"
            :key="id"
            class="temperature-row editable-temperature"
            :class="{ selected: isSingleTool || allTools || selected === id, dirty: dirty(id) }"
            @submit.prevent="applyTarget(id)"
          >
            <button
              type="button"
              class="temperature-tool-name"
              :aria-pressed="isSingleTool || allTools || selected === id"
              @click="selectHeater(id)"
            >
              {{ isSingleTool ? t('Extruder') : `${t('Werkzeug T')}${id}` }}
              <small
                v-if="status?.isToolchanger && online && status?.hasDetection && !status?.detectionConflict && status?.detected === id"
                class="connected-tool-label"
              >
                {{ t('Aufgenommen') }}
              </small>
            </button>
            <span class="temperature-reading">{{ temperature(status?.tools?.[id]?.temperature) }}<small> / </small></span>
            <input
              :aria-label="
                isSingleTool
                  ? t('Zieltemperatur für {0} in Grad Celsius', [t('Extruder')])
                  : t('Zieltemperatur für Werkzeug T{0} in Grad Celsius', [id])
              "
              :title="t('Aktuelles Ziel: {0} °C · Enter übernimmt, Escape verwirft', [temperature(liveTarget(id))])"
              type="number"
              :value="draftValue(id)"
              min="0"
              :max="limitFor(id)"
              step="1"
              required
              inputmode="numeric"
              :disabled="!enabled || limitFor(id) == null"
              placeholder="—"
              @input="editTarget(id, $event.target.value)"
              @keydown.esc="delete drafts[id]"
            />
            <small class="temperature-unit">°C</small>
            <button
              class="apply-temperature"
              type="submit"
              :disabled="!enabled || !valid(id) || !dirty(id)"
              :aria-label="
                isSingleTool
                  ? t('Zieltemperatur für {0} übernehmen', [t('Extruder')])
                  : t('Zieltemperatur für T{0} übernehmen', [id])
              "
              :title="t('Zieltemperatur übernehmen')"
            >
              <Check :size="14" />
            </button>
          </form>
        </div>

        <form class="heater-editor" @submit.prevent="heatTools">
          <p class="preset-selection">{{ heaterName }}</p>
          <div class="temperature-presets tool-presets" :aria-label="t('{0}-Presets', [heaterName])">
            <button
              v-for="preset in presets"
              :key="preset.name"
              type="button"
              :disabled="presetTarget(preset) == null || heaterMax == null || presetTarget(preset) > heaterMax"
              @click="stagePreset(presetTarget(preset))"
            >
              {{ preset.name }}<span>{{ presetTarget(preset) ?? '—' }} °C</span>
            </button>
            <button type="button" :disabled="heaterMax == null || heaterMax < 140" @click="stagePreset(140)">
              {{ t('Vorheizen') }}<span>140 °C</span>
            </button>
          </div>
          <button class="subtle-button preset-apply" :disabled="!enabled || !groupReady || (allTools && moving)">
            {{ allTools ? t('Alle übernehmen') : isSingleTool ? t('Extruder übernehmen') : t('T{0} übernehmen', [selected]) }}
          </button>
        </form>

        <form class="bed-editor" @submit.prevent="applyTarget('bed')">
          <div class="bed-top-row">
            <div class="editable-temperature bed-temperature-row" :class="{ dirty: dirty('bed') }">
              <h3 class="bed-title">{{ t('Druckbett') }}</h3>
              <span class="temperature-reading">{{ temperature(status?.bed?.temperature) }}<small> / </small></span>
              <input
                :aria-label="t('Zieltemperatur für das Druckbett in Grad Celsius')"
                :title="t('Aktuelles Ziel: {0} °C', [temperature(liveTarget('bed'))])"
                :value="draftValue('bed')"
                type="number"
                min="0"
                :max="limitFor('bed')"
                step="1"
                required
                inputmode="numeric"
                :disabled="!enabled || limitFor('bed') == null"
                placeholder="—"
                @input="editTarget('bed', $event.target.value)"
                @keydown.esc="delete drafts.bed"
              />
              <small class="temperature-unit">°C</small>
              <button
                class="apply-temperature"
                type="submit"
                :disabled="!enabled || !valid('bed') || !dirty('bed')"
                :aria-label="t('Zieltemperatur für das Druckbett übernehmen')"
                :title="t('Zieltemperatur übernehmen')"
              >
                <Check :size="14" />
              </button>
            </div>
            <button
              type="button"
              class="subtle-button bed-cooldown"
              :disabled="!enabled || limitFor('bed') == null"
              :title="t('Nur das Druckbett ausschalten')"
              :aria-label="t('Cooldown nur für das Druckbett')"
              @click="coolBed"
            >
              <Snowflake :size="14" />{{ t('Abkühlen') }}
            </button>
          </div>

          <div class="temperature-presets bed-presets" :aria-label="t('Druckbett-Presets')">
            <button
              v-for="preset in presets"
              :key="preset.name"
              type="button"
              :disabled="preset.bed == null || limitFor('bed') == null || preset.bed > limitFor('bed')"
              @click="drafts.bed = String(preset.bed)"
            >
              {{ preset.name }}<span>{{ preset.bed ?? '—' }} °C</span>
            </button>
          </div>
        </form>

        <p v-if="presetError" class="preset-note">{{ t(presetError) }}</p>
      </article>

      <div v-if="!showCameras" class="controls-bottom-row">
        <TemperatureGraph :online="online" :status="status" />
        <FanControl :status="status" :online="online" :pending="pending" :send="send" />
      </div>
      <TemperatureGraph v-else :online="online" :status="status" />
    </div>

    <aside v-if="showCameras" class="control-cameras" :aria-label="t('Livekameras während der Bedienung')">
      <CameraView
        v-for="cam in cameras"
        :key="cam.id"
        :id="cam.id"
        :name="cam.name"
        :description="cam.description"
        :service="cam.service"
        :preferred-mode="cam.preferredMode"
        :flip-x="cam.flipX"
        :flip-y="cam.flipY"
        :rotate="cam.rotate"
      />
      <FanControl :status="status" :online="online" :pending="pending" :send="send" />
    </aside>
  </section>
</template>
