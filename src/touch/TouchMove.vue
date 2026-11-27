<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Home,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Power,
  Disc,
  ArrowDownToLine,
  ArrowUpFromLine,
  Sparkles,
  Droplets,
  Move,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { quickHomeAxisReason, quickJogReason } from '../aux-action-state.mjs'
import { toolActionReason } from '../tool-action-state.mjs'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  initialMode: { type: String, default: 'axes' },
})

const emit = defineEmits(['open-numpad'])

const mode = ref(props.initialMode === 'extrude' ? 'extrude' : 'axes')
watch(
  () => props.initialMode,
  next => {
    if (next === 'extrude' || next === 'axes') mode.value = next
  },
)

const bedSmall = computed(() => {
  const w = props.status?.bedSize?.width
  const d = props.status?.bedSize?.depth
  return (Number.isFinite(w) && w <= 180) || (Number.isFinite(d) && d <= 180)
})
const xySteps = computed(() => (bedSmall.value ? [0.1, 1, 10, 50] : [0.1, 1, 10, 50, 100]))
const zSteps = [0.1, 1, 10]
const xyStep = ref(10)
const zStep = ref(1)

const EXTRUDE_LENGTHS = [5, 10, 25, 50, 100]
const EXTRUDE_SPEEDS = [2, 5, 10]
const extrudeLength = ref(10)
const extrudeSpeed = ref(5)

const confirmMotors = ref(false)
let motorsTimer = null

function resetMotorsConfirm() {
  confirmMotors.value = false
  clearTimeout(motorsTimer)
  motorsTimer = null
}

onBeforeUnmount(() => resetMotorsConfirm())

const busy = computed(() => props.pending || Boolean(props.status?.control?.job))
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)
const moving = computed(
  () => ['printing', 'paused'].includes(props.status?.printState) || props.status?.idleState === 'Printing' || props.status?.loadWatchActive,
)
const motion = computed(() => enabled.value && !moving.value && !props.status?.detectionMismatch)
const homing = computed(
  () => enabled.value && !moving.value && (!props.status?.detectionMismatch || props.status?.homingCanInitialize),
)

const homed = axis => props.status?.homedAxes?.includes(axis) === true
const allHomed = computed(() => ['x', 'y', 'z'].every(homed))
const levelingKind = computed(() => {
  if (props.status?.capabilities?.qgl) return 'qgl'
  if (props.status?.capabilities?.zTilt) return 'z_tilt'
  return null
})
const levelingApplied = computed(() => Boolean(props.status?.qglApplied || props.status?.zTiltApplied))

const axisHomeReason = axis => quickHomeAxisReason(props.status, axis, props.online, props.pending)
const axisJogReason = (axis, distance) => quickJogReason(props.status, axis, distance, props.online, props.pending)

function jog(axis, dist) {
  if (!axisJogReason(axis, dist)) props.send({ action: 'jog', axis, distance: dist })
}

function home(axis) {
  if (axis === 'all') {
    if (homing.value) props.send({ action: 'home', axis: 'all' })
    return
  }
  if (!axisHomeReason(axis)) props.send({ action: 'home', axis })
}

function handleMotorsOff() {
  if (!motion.value) return
  if (levelingApplied.value && !confirmMotors.value) {
    confirmMotors.value = true
    clearTimeout(motorsTimer)
    motorsTimer = setTimeout(resetMotorsConfirm, 5000)
    return
  }
  resetMotorsConfirm()
  props.send({ action: 'motors_off' })
}

function axisPos(axis, idx) {
  if (!props.online || !homed(axis)) return '—'
  const val = props.status?.position?.[idx]
  return Number.isFinite(val) ? val.toLocaleString(locale.value, { maximumFractionDigits: axis === 'z' ? 2 : 1 }) : '—'
}

function editAxis(axis, idx) {
  if (!motion.value || !homed(axis)) return
  const min = props.status?.axisMinimum?.[idx]
  const max = props.status?.axisMaximum?.[idx]
  if (!Number.isFinite(min) || !Number.isFinite(max)) return
  emit('open-numpad', {
    title: t('Zielposition {0}', [axis.toUpperCase()]),
    unit: 'mm',
    initialValue: props.status?.position?.[idx] ?? 0,
    min: Math.ceil(min),
    max: Math.floor(max),
    allowDecimal: true,
    presets: [
      { label: '0', value: Math.max(0, Math.ceil(min)) },
      { label: `${Math.round((min + max) / 2)}`, value: Math.round((min + max) / 2) },
    ],
    onConfirm: target => props.send({ action: 'move_to', axis, target }),
  })
}

// Extruder sub-mode
const isToolchanger = computed(() => Boolean(props.status?.isToolchanger))
const mountedToolId = computed(() => {
  if (!isToolchanger.value) return 0
  const id = props.status?.active
  return Number.isInteger(id) && id >= 0 && id < (props.status?.tools?.length ?? 1) ? id : null
})
const mountedTool = computed(() => (mountedToolId.value != null ? props.status?.tools?.[mountedToolId.value] ?? null : null))
const minExtrudeTemp = computed(() => props.status?.capabilities?.extrusionMin?.[mountedToolId.value ?? 0] ?? 170)

const extrudeBlockReason = computed(() => {
  if (!props.online) return 'Keine aktuellen Druckerdaten.'
  if (props.status?.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (busy.value) return 'Ein Befehl läuft noch oder muss geprüft werden.'
  if (props.status?.loadWatchActive) return 'Einlegehilfe ist scharf.'
  if (props.status?.printState === 'printing') return 'Während des Drucks gesperrt.'
  if (props.status?.idleState === 'Printing') return 'Drucker ist beschäftigt.'
  if (isToolchanger.value && mountedToolId.value == null) return 'Kein Werkzeug aufgenommen.'
  if (mountedTool.value?.canExtrude !== true) return t('Kalt · ≥ {0} °C', [minExtrudeTemp.value])
  return ''
})

function runExtrude(sign) {
  if (extrudeBlockReason.value) return
  const payload = {
    action: 'extrude',
    distance: sign * extrudeLength.value,
    speed: extrudeSpeed.value,
  }
  if (mountedToolId.value != null) payload.tool = mountedToolId.value
  props.send(payload)
}

const FILAMENT_MACROS = [
  { id: 'load', label: 'Laden', icon: ArrowDownToLine },
  { id: 'unload', label: 'Entladen', icon: ArrowUpFromLine },
  { id: 'clean', label: 'Reinigen', icon: Sparkles },
  { id: 'purge', label: 'Purge', icon: Droplets },
]

const configuredMacros = computed(() => {
  const caps = props.status?.capabilities?.toolActions ?? {}
  return FILAMENT_MACROS.filter(item => Boolean(caps[item.id]))
})

function macroReason(id) {
  return toolActionReason(props.status, id, mountedToolId.value ?? 0, props.online, props.pending)
}
</script>

<template>
  <section class="touch-move-view" :aria-label="t('Bewegen')">
    <div class="touch-subnav">
      <button type="button" class="touch-subtab" :aria-pressed="mode === 'axes'" @click="mode = 'axes'">
        <Move :size="16" />{{ t('Achsen') }}
      </button>
      <button type="button" class="touch-subtab" :aria-pressed="mode === 'extrude'" @click="mode = 'extrude'">
        <Disc :size="16" />{{ t('Extruder & Filament') }}
      </button>
      <div class="touch-subnav-coords">
        <button type="button" class="touch-coord-pill" :class="{ homed: homed('x') }" :disabled="!motion || !homed('x')" @click="editAxis('x', 0)">
          <em>X</em> {{ axisPos('x', 0) }}
        </button>
        <button type="button" class="touch-coord-pill" :class="{ homed: homed('y') }" :disabled="!motion || !homed('y')" @click="editAxis('y', 1)">
          <em>Y</em> {{ axisPos('y', 1) }}
        </button>
        <button type="button" class="touch-coord-pill" :class="{ homed: homed('z') }" :disabled="!motion || !homed('z')" @click="editAxis('z', 2)">
          <em>Z</em> {{ axisPos('z', 2) }}
        </button>
      </div>
    </div>

    <!-- SUB-VIEW 1: AXES D-PAD -->
    <div v-if="mode === 'axes'" class="touch-axes-layout">
      <div class="touch-dpad-cluster">
        <div class="touch-xy-pad" role="group" :aria-label="t('X/Y Bewegung')">
          <span />
          <button
            type="button"
            class="touch-dpad-btn"
            :disabled="!!axisJogReason('y', xyStep)"
            :aria-label="`Y +${xyStep} mm`"
            @click="jog('y', xyStep)"
          >
            <ArrowUp :size="24" /><small>Y+</small>
          </button>
          <span />
          <button
            type="button"
            class="touch-dpad-btn"
            :disabled="!!axisJogReason('x', -xyStep)"
            :aria-label="`X -${xyStep} mm`"
            @click="jog('x', -xyStep)"
          >
            <ArrowLeft :size="24" /><small>X−</small>
          </button>
          <button
            type="button"
            class="touch-dpad-btn touch-dpad-home"
            :class="{ homed: homed('x') && homed('y') && online }"
            :disabled="!!axisHomeReason('x') || !!axisHomeReason('y')"
            @click="home('all')"
          >
            <Home :size="22" /><small>XY</small>
          </button>
          <button
            type="button"
            class="touch-dpad-btn"
            :disabled="!!axisJogReason('x', xyStep)"
            :aria-label="`X +${xyStep} mm`"
            @click="jog('x', xyStep)"
          >
            <ArrowRight :size="24" /><small>X+</small>
          </button>
          <span />
          <button
            type="button"
            class="touch-dpad-btn"
            :disabled="!!axisJogReason('y', -xyStep)"
            :aria-label="`Y -${xyStep} mm`"
            @click="jog('y', -xyStep)"
          >
            <ArrowDown :size="24" /><small>Y−</small>
          </button>
          <span />
        </div>

        <div class="touch-z-pad" role="group" :aria-label="t('Z Bewegung')">
          <button
            type="button"
            class="touch-dpad-btn"
            :disabled="!!axisJogReason('z', zStep)"
            :aria-label="`Z +${zStep} mm`"
            @click="jog('z', zStep)"
          >
            <ArrowUp :size="24" /><small>Z+</small>
          </button>
          <button
            type="button"
            class="touch-dpad-btn touch-dpad-home"
            :class="{ homed: homed('z') && online }"
            :disabled="!!axisHomeReason('z')"
            @click="home('z')"
          >
            <Home :size="20" /><small>Z</small>
          </button>
          <button
            type="button"
            class="touch-dpad-btn"
            :disabled="!!axisJogReason('z', -zStep)"
            :aria-label="`Z -${zStep} mm`"
            @click="jog('z', -zStep)"
          >
            <ArrowDown :size="24" /><small>Z−</small>
          </button>
        </div>
      </div>

      <div class="touch-axes-sidebar">
        <div class="touch-step-box">
          <span class="touch-field-lbl">{{ t('XY-Schritt (mm)') }}</span>
          <div class="touch-chip-row">
            <button
              v-for="s in xySteps"
              :key="s"
              type="button"
              class="touch-chip"
              :aria-pressed="xyStep === s"
              @click="xyStep = s"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <div class="touch-step-box">
          <span class="touch-field-lbl">{{ t('Z-Schritt (mm)') }}</span>
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
        </div>

        <div class="touch-prep-grid">
          <button
            type="button"
            class="touch-btn"
            :class="allHomed && online ? 'touch-btn-ok' : 'touch-btn-surface'"
            :disabled="!homing"
            @click="home('all')"
          >
            <Home :size="16" />{{ t('Alle') }}
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
            v-if="status?.capabilities?.mesh"
            type="button"
            class="touch-btn touch-btn-surface"
            :disabled="!motion || !allHomed"
            @click="send({ action: 'mesh' })"
          >
            {{ t('Bett-Mesh') }}
          </button>
          <button
            type="button"
            class="touch-btn"
            :class="confirmMotors ? 'touch-btn-danger' : 'touch-btn-surface'"
            :disabled="!motion"
            @click="handleMotorsOff"
          >
            <Power :size="16" />{{ confirmMotors ? t('Wirklich?') : t('Motoren aus') }}
          </button>
        </div>
      </div>
    </div>

    <!-- SUB-VIEW 2: EXTRUDER & FILAMENT -->
    <div v-else class="touch-extrude-layout">
      <div class="touch-extrude-status">
        <strong>
          {{ isToolchanger ? (mountedToolId != null ? t('Aufgenommen: T{0}', [mountedToolId]) : t('Kein Werkzeug aufgenommen')) : t('Extruder') }}
        </strong>
        <span class="touch-pill" :class="mountedTool?.canExtrude ? 'ok' : 'amber'">
          {{
            mountedTool?.temperature != null ? `${Math.round(mountedTool.temperature)}°C · ` : ''
          }}{{ mountedTool?.canExtrude ? t('Extrusion bereit') : t('Kalt · ≥ {0} °C', [minExtrudeTemp]) }}
        </span>
      </div>

      <div class="touch-extrude-selectors">
        <div class="touch-step-box">
          <span class="touch-field-lbl">{{ t('Länge (mm)') }}</span>
          <div class="touch-chip-row">
            <button
              v-for="len in EXTRUDE_LENGTHS"
              :key="len"
              type="button"
              class="touch-chip"
              :aria-pressed="extrudeLength === len"
              @click="extrudeLength = len"
            >
              {{ len }} mm
            </button>
          </div>
        </div>
        <div class="touch-step-box">
          <span class="touch-field-lbl">{{ t('Geschwindigkeit') }}</span>
          <div class="touch-chip-row">
            <button
              v-for="spd in EXTRUDE_SPEEDS"
              :key="spd"
              type="button"
              class="touch-chip"
              :aria-pressed="extrudeSpeed === spd"
              @click="extrudeSpeed = spd"
            >
              {{ spd }} mm/s
            </button>
          </div>
        </div>
      </div>

      <div class="touch-extrude-btns">
        <button
          type="button"
          class="touch-btn touch-btn-lg touch-btn-surface"
          :disabled="!!extrudeBlockReason"
          @click="runExtrude(-1)"
        >
          <ArrowUpFromLine :size="20" />{{ t('Einziehen') }} −{{ extrudeLength }} mm
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-lg touch-btn-accent"
          :disabled="!!extrudeBlockReason"
          @click="runExtrude(1)"
        >
          <ArrowDownToLine :size="20" />{{ t('Extrudieren') }} +{{ extrudeLength }} mm
        </button>
      </div>

      <div v-if="configuredMacros.length" class="touch-extrude-macros">
        <button
          v-for="m in configuredMacros"
          :key="m.id"
          type="button"
          class="touch-btn touch-btn-surface"
          :disabled="!!macroReason(m.id)"
          @click="!macroReason(m.id) && send({ action: m.id, tool: mountedToolId ?? 0 })"
        >
          <component :is="m.icon" :size="16" />{{ t(m.label) }}
        </button>
      </div>
    </div>
  </section>
</template>
