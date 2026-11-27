<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Pause,
  Play,
  Square,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  Gauge,
  Droplets,
  Check,
  Ban,
  Save,
  SlidersHorizontal,
  ChevronDown,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { auxActionReason } from '../aux-action-state.mjs'
import { printControlReason, SPEED_MIN, SPEED_MAX, FLOW_MIN, FLOW_MAX } from '../print-control-state.mjs'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  compact: { type: Boolean, default: false },
})

const zSteps = [0.005, 0.01, 0.025, 0.05]
const zStep = ref(0.01)

const speedDraft = ref(null)
const flowDraft = ref(null)
const showAdvanced = ref(false)
const paAdvanceDraft = ref(null)
const paSmoothDraft = ref(null)
const velDraft = ref(null)
const accelDraft = ref(null)
const cruiseDraft = ref(null)
const scvDraft = ref(null)
const retractLenDraft = ref(null)
const retractSpdDraft = ref(null)
const unretractExtraDraft = ref(null)
const unretractSpdDraft = ref(null)

const confirmCancel = ref(false)
const confirmExclude = ref('')
let cancelTimer = null
let excludeTimer = null

function resetCancelConfirm() {
  confirmCancel.value = false
  clearTimeout(cancelTimer)
  cancelTimer = null
}

function resetExcludeConfirm() {
  confirmExclude.value = ''
  clearTimeout(excludeTimer)
  excludeTimer = null
}

onBeforeUnmount(() => {
  resetCancelConfirm()
  resetExcludeConfirm()
})

const isPrintActive = computed(() => props.online && ['printing', 'paused'].includes(props.status?.printState))
watch(isPrintActive, active => {
  if (!active) {
    resetCancelConfirm()
    resetExcludeConfirm()
    speedDraft.value = null
    flowDraft.value = null
    paAdvanceDraft.value = null
    paSmoothDraft.value = null
    velDraft.value = null
    accelDraft.value = null
    cruiseDraft.value = null
    scvDraft.value = null
    retractLenDraft.value = null
    retractSpdDraft.value = null
    unretractExtraDraft.value = null
    unretractSpdDraft.value = null
  }
})

const pauseAction = computed(() => (props.status?.printState === 'paused' ? 'resume' : 'pause'))
const pauseReason = computed(() => auxActionReason(props.status, pauseAction.value, props.online, props.pending))
const cancelReason = computed(() => printControlReason(props.status, 'print_cancel', props.online, props.pending))
const speedReason = computed(() => printControlReason(props.status, 'tune_speed', props.online, props.pending))
const flowReason = computed(() => printControlReason(props.status, 'tune_flow', props.online, props.pending))
const zReason = computed(() => printControlReason(props.status, 'tune_z_offset', props.online, props.pending))
const saveZReason = computed(() => printControlReason(props.status, 'save_z_offset', props.online, props.pending))
const paReason = computed(() => printControlReason(props.status, 'tune_pressure_advance', props.online, props.pending))
const velReason = computed(() => printControlReason(props.status, 'tune_velocity_limits', props.online, props.pending))
const retractReason = computed(() => printControlReason(props.status, 'tune_retraction', props.online, props.pending))
const excludeReason = computed(() => printControlReason(props.status, 'exclude_object', props.online, props.pending))

const activeToolIdx = computed(() => {
  const idx = props.status?.active
  return Number.isInteger(idx) && idx >= 0 && idx < (props.status?.tools?.length ?? 1) ? idx : 0
})
const lockedPaTool = ref(null)
const selectedPaTool = computed(() => {
  const count = props.status?.tools?.length ?? 1
  if (lockedPaTool.value !== null && lockedPaTool.value >= 0 && lockedPaTool.value < count) {
    return lockedPaTool.value
  }
  return activeToolIdx.value
})
const paToolObj = computed(() => props.status?.tools?.[selectedPaTool.value] ?? null)

function parseDraftNum(raw) {
  if (raw === '' || raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function selectPaTool(idx) {
  lockedPaTool.value = idx
  paAdvanceDraft.value = null
  paSmoothDraft.value = null
}

const paAdvanceValue = computed(() =>
  paAdvanceDraft.value !== null ? paAdvanceDraft.value : String(paToolObj.value?.pressureAdvance ?? 0),
)
const paSmoothValue = computed(() =>
  paSmoothDraft.value !== null ? paSmoothDraft.value : String(paToolObj.value?.pressureAdvanceSmoothTime ?? 0.04),
)
const paDirty = computed(() => paAdvanceDraft.value !== null || paSmoothDraft.value !== null)
const paValid = computed(() => {
  const a = parseDraftNum(paAdvanceValue.value)
  const s = parseDraftNum(paSmoothValue.value)
  return a != null && a >= 0 && a <= 2 && s != null && s >= 0.005 && s <= 0.2
})

const motionLimits = computed(() => props.status?.motionLimits ?? null)
const velValue = computed(() =>
  velDraft.value !== null ? velDraft.value : String(motionLimits.value?.maxVelocity ?? 300),
)
const accelValue = computed(() =>
  accelDraft.value !== null ? accelDraft.value : String(motionLimits.value?.maxAccel ?? 3000),
)
const cruiseValue = computed(() =>
  cruiseDraft.value !== null ? cruiseDraft.value : String(motionLimits.value?.minCruiseRatio ?? 0.5),
)
const scvValue = computed(() =>
  scvDraft.value !== null ? scvDraft.value : String(motionLimits.value?.squareCornerVelocity ?? 5),
)
const velDirty = computed(
  () => velDraft.value !== null || accelDraft.value !== null || cruiseDraft.value !== null || scvDraft.value !== null,
)
const velValid = computed(() => {
  const v = parseDraftNum(velValue.value)
  const a = parseDraftNum(accelValue.value)
  const s = parseDraftNum(scvValue.value)
  const maxV = motionLimits.value?.configMaxVelocity ?? 1000
  const maxA = motionLimits.value?.configMaxAccel ?? 50000
  if (v == null || v < 1 || v > maxV) return false
  if (a == null || a < 50 || a > maxA) return false
  if (s == null || s < 0.5 || s > 50) return false
  if (motionLimits.value?.minCruiseRatio != null) {
    const c = parseDraftNum(cruiseValue.value)
    if (c == null || c < 0 || c >= 1) return false
  }
  return true
})

const hasRetraction = computed(() => Boolean(props.status?.capabilities?.firmwareRetraction && props.status?.firmwareRetraction))
const retractLenValue = computed(() =>
  retractLenDraft.value !== null ? retractLenDraft.value : String(props.status?.firmwareRetraction?.retractLength ?? 0.5),
)
const retractSpdValue = computed(() =>
  retractSpdDraft.value !== null ? retractSpdDraft.value : String(props.status?.firmwareRetraction?.retractSpeed ?? 35),
)
const unretractExtraValue = computed(() =>
  unretractExtraDraft.value !== null
    ? unretractExtraDraft.value
    : String(props.status?.firmwareRetraction?.unretractExtraLength ?? 0),
)
const unretractSpdValue = computed(() =>
  unretractSpdDraft.value !== null
    ? unretractSpdDraft.value
    : String(props.status?.firmwareRetraction?.unretractSpeed ?? 35),
)
const retractDirty = computed(
  () =>
    retractLenDraft.value !== null ||
    retractSpdDraft.value !== null ||
    unretractExtraDraft.value !== null ||
    unretractSpdDraft.value !== null,
)
const retractValid = computed(() => {
  const rl = parseDraftNum(retractLenValue.value)
  const rs = parseDraftNum(retractSpdValue.value)
  const ue = parseDraftNum(unretractExtraValue.value)
  const us = parseDraftNum(unretractSpdValue.value)
  return (
    rl != null && rl >= 0 && rl <= 15 &&
    rs != null && rs >= 1 && rs <= 200 &&
    ue != null && ue >= 0 && ue <= 5 &&
    us != null && us >= 1 && us <= 200
  )
})

const actualSpeed = computed(() => props.status?.speedPercent ?? null)
const speedValue = computed(() => (speedDraft.value != null ? speedDraft.value : actualSpeed.value))
const actualFlow = computed(() => props.status?.flowPercent ?? null)
const flowValue = computed(() => (flowDraft.value != null ? flowDraft.value : actualFlow.value))

const zOffset = computed(() => props.status?.zOffset ?? null)
const canResetZ = computed(
  () =>
    !zReason.value &&
    zOffset.value != null &&
    Math.abs(zOffset.value) > 1e-5 &&
    (props.status?.capabilities?.zAdjustReset || !props.status?.capabilities?.perToolZAdjust),
)
const canSaveZ = computed(() => !saveZReason.value && Boolean(props.status?.capabilities?.zOffsetSaveTarget))
const saveZTargetLabel = computed(() => {
  const target = props.status?.capabilities?.zOffsetSaveTarget
  if (target === 'beacon') return 'Z-Offset für Beacon vormerken (danach SAVE_CONFIG)'
  if (target === 'probe') return 'Z-Offset für Probe vormerken (danach SAVE_CONFIG)'
  return 'Z-Offset für Endstop vormerken (danach SAVE_CONFIG)'
})

const formattedZOffset = computed(() => {
  if (zOffset.value == null) return '—'
  const sign = zOffset.value > 0 ? '+' : ''
  return `${sign}${zOffset.value.toLocaleString(locale.value, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} mm`
})

const excludeData = computed(() => props.status?.excludeObjects ?? { available: false, objects: [], excluded: [], current: null })
const excludedSet = computed(() => new Set(excludeData.value.excluded ?? []))

async function togglePause() {
  if (!pauseReason.value) await props.send({ action: pauseAction.value })
}

async function requestOrRunCancel() {
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

async function adjustZ(delta) {
  if (zReason.value) return
  await props.send({ action: 'tune_z_offset', delta })
}

async function resetZ() {
  if (!canResetZ.value) return
  await props.send({ action: 'tune_z_offset', reset: true })
}

async function saveZOffset() {
  if (!canSaveZ.value) return
  await props.send({ action: 'save_z_offset' })
}

async function applySpeed(percent) {
  if (speedReason.value || !Number.isInteger(percent)) return
  const prior = speedDraft.value
  if ((await props.send({ action: 'tune_speed', percent })) && speedDraft.value === prior) {
    speedDraft.value = null
  }
}

async function applyFlow(percent) {
  if (flowReason.value || !Number.isInteger(percent)) return
  const prior = flowDraft.value
  if ((await props.send({ action: 'tune_flow', percent })) && flowDraft.value === prior) {
    flowDraft.value = null
  }
}

async function applyPressureAdvance() {
  if (paReason.value || !paDirty.value || !paValid.value) return
  const advance = parseDraftNum(paAdvanceValue.value)
  const smoothTime = parseDraftNum(paSmoothValue.value)
  if (advance == null || smoothTime == null) return
  const payload = { action: 'tune_pressure_advance', advance, smoothTime }
  if ((props.status?.toolCount ?? 1) > 1) payload.tool = selectedPaTool.value
  if (await props.send(payload)) {
    paAdvanceDraft.value = null
    paSmoothDraft.value = null
  }
}

async function applyVelocityLimits() {
  if (velReason.value || !velDirty.value || !velValid.value) return
  const payload = { action: 'tune_velocity_limits' }
  const v = parseDraftNum(velValue.value)
  const a = parseDraftNum(accelValue.value)
  const c = parseDraftNum(cruiseValue.value)
  const s = parseDraftNum(scvValue.value)
  if (v != null) payload.velocity = v
  if (a != null) payload.accel = a
  if (c != null && motionLimits.value?.minCruiseRatio != null) payload.minCruiseRatio = c
  if (s != null) payload.squareCornerVelocity = s
  if (await props.send(payload)) {
    velDraft.value = null
    accelDraft.value = null
    cruiseDraft.value = null
    scvDraft.value = null
  }
}

async function applyRetraction() {
  if (retractReason.value || !hasRetraction.value || !retractDirty.value || !retractValid.value) return
  const payload = {
    action: 'tune_retraction',
    retractLength: parseDraftNum(retractLenValue.value),
    retractSpeed: parseDraftNum(retractSpdValue.value),
    unretractExtraLength: parseDraftNum(unretractExtraValue.value),
    unretractSpeed: parseDraftNum(unretractSpdValue.value),
  }
  if (await props.send(payload)) {
    retractLenDraft.value = null
    retractSpdDraft.value = null
    unretractExtraDraft.value = null
    unretractSpdDraft.value = null
  }
}

async function requestOrRunExclude(name) {
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
</script>

<template>
  <section
    v-if="isPrintActive"
    class="live-tuning"
    :class="{ compact }"
    :aria-label="t('Live-Drucksteuerung')"
  >
    <div class="live-tuning-actions">
      <button
        type="button"
        class="subtle-button"
        :disabled="!!pauseReason"
        :title="
          pauseReason
            ? t(pauseReason)
            : pauseAction === 'pause'
              ? t('Laufenden Druck pausieren')
              : t('Pausierten Druck fortsetzen')
        "
        @click="togglePause"
      >
        <Pause v-if="pauseAction === 'pause'" :size="14" />
        <Play v-else :size="14" />
        {{ pauseAction === 'pause' ? t('Pause') : t('Fortsetzen') }}
      </button>

      <button
        type="button"
        class="subtle-button tuning-cancel-btn"
        :class="{ confirming: confirmCancel }"
        :disabled="!!cancelReason"
        :title="
          cancelReason
            ? t(cancelReason)
            : confirmCancel
              ? t('Erneut klicken, um den Druck endgültig abzubrechen')
              : t('Druck kontrolliert abbrechen und sicher parken')
        "
        @click="requestOrRunCancel"
        @blur="resetCancelConfirm"
        @keydown.esc="resetCancelConfirm"
      >
        <Square :size="13" />
        {{ confirmCancel ? t('Wirklich?') : t('Abbrechen') }}
      </button>
    </div>

    <div class="live-tuning-grid">
      <div class="tuning-block">
        <div class="tuning-block-head">
          <span>
            {{ t('Z-Offset') }}
            <small v-if="status?.capabilities?.perToolZAdjust && status?.active != null" class="tuning-tool-tag">
              T{{ status.active }}
            </small>
          </span>
          <strong>{{ formattedZOffset }}</strong>
        </div>
        <div class="segmented tuning-steps" :aria-label="t('Z-Offset-Schrittweite')">
          <button
            v-for="step in zSteps"
            :key="step"
            type="button"
            :aria-pressed="zStep === step"
            @click="zStep = step"
          >
            {{ step.toLocaleString(locale, { minimumFractionDigits: step < 0.01 ? 3 : 2 }) }}
          </button>
        </div>
        <div class="tuning-z-buttons">
          <button
            type="button"
            class="subtle-button"
            :disabled="!!zReason"
            :title="zReason ? t(zReason) : t('Düse näher ans Bett (-{0} mm)', [zStep])"
            @click="adjustZ(-zStep)"
          >
            <ArrowDown :size="14" />−{{ zStep.toLocaleString(locale) }}
          </button>
          <button
            type="button"
            class="subtle-button"
            :disabled="!!zReason"
            :title="zReason ? t(zReason) : t('Düse weiter vom Bett (+{0} mm)', [zStep])"
            @click="adjustZ(zStep)"
          >
            <ArrowUp :size="14" />+{{ zStep.toLocaleString(locale) }}
          </button>
          <button
            type="button"
            class="subtle-button tuning-reset-btn"
            :disabled="!canResetZ"
            :title="t('Live-Z-Offset zurücksetzen')"
            :aria-label="t('Live-Z-Offset zurücksetzen')"
            @click="resetZ"
          >
            <RotateCcw :size="13" />
          </button>
          <button
            v-if="status?.capabilities?.zOffsetSaveTarget"
            type="button"
            class="subtle-button tuning-savez-btn"
            :disabled="!canSaveZ"
            :title="saveZReason ? t(saveZReason) : t(saveZTargetLabel)"
            :aria-label="t('Z-Offset übernehmen')"
            @click="saveZOffset"
          >
            <Save :size="13" />
          </button>
        </div>
      </div>

      <div class="tuning-block">
        <form class="tuning-factor-row" @submit.prevent="applySpeed(speedValue)">
          <div class="tuning-block-head">
            <span><Gauge :size="13" />{{ t('Geschwindigkeit') }}</span>
            <div class="tuning-factor-meta">
              <strong>{{ actualSpeed != null ? `${actualSpeed} %` : '—' }}</strong>
              <button
                v-if="actualSpeed != null && actualSpeed !== 100"
                type="button"
                class="tuning-chip-reset"
                :disabled="!!speedReason"
                :title="t('Auf 100 % zurücksetzen')"
                @click="applySpeed(100)"
              >
                100 %
              </button>
            </div>
          </div>
          <div class="tuning-slider-row">
            <input
              type="range"
              :min="SPEED_MIN"
              :max="SPEED_MAX"
              step="5"
              :value="speedValue ?? 100"
              :disabled="!!speedReason"
              :aria-label="t('Druckgeschwindigkeit in Prozent')"
              @input="speedDraft = Number($event.target.value)"
            />
            <output>{{ speedValue != null ? `${speedValue} %` : '—' }}</output>
            <button
              class="apply-temperature"
              type="submit"
              :disabled="!!speedReason || speedValue == null || speedValue === actualSpeed"
              :title="t('Geschwindigkeit übernehmen')"
              :aria-label="t('Geschwindigkeit übernehmen')"
            >
              <Check :size="13" />
            </button>
          </div>
        </form>

        <form class="tuning-factor-row" @submit.prevent="applyFlow(flowValue)">
          <div class="tuning-block-head">
            <span><Droplets :size="13" />{{ t('Fluss') }}</span>
            <div class="tuning-factor-meta">
              <strong>{{ actualFlow != null ? `${actualFlow} %` : '—' }}</strong>
              <button
                v-if="actualFlow != null && actualFlow !== 100"
                type="button"
                class="tuning-chip-reset"
                :disabled="!!flowReason"
                :title="t('Auf 100 % zurücksetzen')"
                @click="applyFlow(100)"
              >
                100 %
              </button>
            </div>
          </div>
          <div class="tuning-slider-row">
            <input
              type="range"
              :min="FLOW_MIN"
              :max="FLOW_MAX"
              step="1"
              :value="flowValue ?? 100"
              :disabled="!!flowReason"
              :aria-label="t('Extrusionsfluss in Prozent')"
              @input="flowDraft = Number($event.target.value)"
            />
            <output>{{ flowValue != null ? `${flowValue} %` : '—' }}</output>
            <button
              class="apply-temperature"
              type="submit"
              :disabled="!!flowReason || flowValue == null || flowValue === actualFlow"
              :title="t('Fluss übernehmen')"
              :aria-label="t('Fluss übernehmen')"
            >
              <Check :size="13" />
            </button>
          </div>
        </form>
      </div>
    </div>

    <div class="tuning-advanced-wrap">
      <button
        type="button"
        class="tuning-advanced-toggle"
        :aria-expanded="showAdvanced"
        @click="showAdvanced = !showAdvanced"
      >
        <span class="tuning-advanced-label">
          <SlidersHorizontal :size="13" />
          {{ t('Erweitert · PA & Kinematik') }}
        </span>
        <ChevronDown :size="14" class="tuning-chevron" :class="{ open: showAdvanced }" />
      </button>

      <div v-if="showAdvanced" class="tuning-advanced-grid">
        <form class="tuning-adv-card" @submit.prevent="applyPressureAdvance">
          <div class="tuning-block-head">
            <span>{{ t('Pressure Advance') }}</span>
            <div v-if="(status?.toolCount ?? 1) > 1" class="segmented tuning-pa-tools" :aria-label="t('Werkzeug für Pressure Advance')">
              <button
                v-for="idx in (status?.toolCount ?? 1)"
                :key="idx - 1"
                type="button"
                :aria-pressed="selectedPaTool === idx - 1"
                @click="selectPaTool(idx - 1)"
              >
                T{{ idx - 1 }}
              </button>
            </div>
          </div>
          <div class="tuning-adv-fields">
            <label>
              <span>PA</span>
              <input
                type="number"
                min="0"
                max="2"
                step="0.005"
                :value="paAdvanceValue"
                :disabled="!!paReason"
                @input="
                  lockedPaTool = selectedPaTool;
                  paAdvanceDraft = $event.target.value
                "
              />
            </label>
            <label>
              <span>{{ t('Smooth Time') }} (s)</span>
              <input
                type="number"
                min="0.005"
                max="0.2"
                step="0.005"
                :value="paSmoothValue"
                :disabled="!!paReason"
                @input="
                  lockedPaTool = selectedPaTool;
                  paSmoothDraft = $event.target.value
                "
              />
            </label>
            <button type="submit" class="subtle-button tuning-adv-apply" :disabled="!!paReason || !paDirty || !paValid">
              <Check :size="13" />{{ t('Übernehmen') }}
            </button>
          </div>
        </form>

        <form v-if="motionLimits" class="tuning-adv-card" @submit.prevent="applyVelocityLimits">
          <div class="tuning-block-head">
            <span>{{ t('Bewegungslimits') }}</span>
          </div>
          <div class="tuning-adv-fields">
            <label>
              <span>{{ t('Max. Speed') }} (mm/s)</span>
              <input
                type="number"
                min="1"
                :max="motionLimits.configMaxVelocity ?? 1000"
                step="10"
                :value="velValue"
                :disabled="!!velReason"
                @input="velDraft = $event.target.value"
              />
            </label>
            <label>
              <span>{{ t('Beschleunigung') }}</span>
              <input
                type="number"
                min="50"
                :max="motionLimits.configMaxAccel ?? 50000"
                step="250"
                :value="accelValue"
                :disabled="!!velReason"
                @input="accelDraft = $event.target.value"
              />
            </label>
            <label v-if="motionLimits.minCruiseRatio != null">
              <span>Cruise Ratio</span>
              <input
                type="number"
                min="0"
                max="0.99"
                step="0.05"
                :value="cruiseValue"
                :disabled="!!velReason"
                @input="cruiseDraft = $event.target.value"
              />
            </label>
            <label>
              <span>SCV (mm/s)</span>
              <input
                type="number"
                min="0.5"
                max="50"
                step="0.5"
                :value="scvValue"
                :disabled="!!velReason"
                @input="scvDraft = $event.target.value"
              />
            </label>
            <button type="submit" class="subtle-button tuning-adv-apply" :disabled="!!velReason || !velDirty || !velValid">
              <Check :size="13" />{{ t('Übernehmen') }}
            </button>
          </div>
        </form>

        <form v-if="hasRetraction" class="tuning-adv-card" @submit.prevent="applyRetraction">
          <div class="tuning-block-head">
            <span>{{ t('Firmware Retraction') }}</span>
          </div>
          <div class="tuning-adv-fields">
            <label>
              <span>{{ t('Einzug') }} (mm)</span>
              <input
                type="number"
                min="0"
                max="15"
                step="0.05"
                :value="retractLenValue"
                :disabled="!!retractReason"
                @input="retractLenDraft = $event.target.value"
              />
            </label>
            <label>
              <span>{{ t('Einzugsgeschw.') }}</span>
              <input
                type="number"
                min="1"
                max="200"
                step="1"
                :value="retractSpdValue"
                :disabled="!!retractReason"
                @input="retractSpdDraft = $event.target.value"
              />
            </label>
            <label>
              <span>{{ t('Extra-Länge') }} (mm)</span>
              <input
                type="number"
                min="0"
                max="5"
                step="0.05"
                :value="unretractExtraValue"
                :disabled="!!retractReason"
                @input="unretractExtraDraft = $event.target.value"
              />
            </label>
            <label>
              <span>{{ t('Vorschubgeschw.') }}</span>
              <input
                type="number"
                min="1"
                max="200"
                step="1"
                :value="unretractSpdValue"
                :disabled="!!retractReason"
                @input="unretractSpdDraft = $event.target.value"
              />
            </label>
            <button
              type="submit"
              class="subtle-button tuning-adv-apply"
              :disabled="!!retractReason || !retractDirty || !retractValid"
            >
              <Check :size="13" />{{ t('Übernehmen') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="excludeData.objects.length" class="tuning-exclude-section">
      <div class="tuning-block-head">
        <span><Ban :size="13" />{{ t('Objekte im Druck') }}</span>
        <small class="tuning-exclude-count">
          {{ t('{0} aktiv · {1} übersprungen', [excludeData.objects.length - excludedSet.size, excludedSet.size]) }}
        </small>
      </div>
      <ul class="exclude-object-list">
        <li
          v-for="obj in excludeData.objects"
          :key="obj.name"
          class="exclude-object-row"
          :class="{
            current: excludeData.current === obj.name,
            excluded: excludedSet.has(obj.name),
          }"
        >
          <span class="exclude-object-name" :title="obj.name">
            <span class="exclude-object-label">{{ obj.name }}</span>
            <small v-if="excludeData.current === obj.name" class="connected-tool-label">{{ t('Aktiv') }}</small>
          </span>
          <span v-if="excludedSet.has(obj.name)" class="exclude-done-pill">{{ t('Übersprungen') }}</span>
          <button
            v-else
            type="button"
            class="subtle-button exclude-action-btn"
            :class="{ confirming: confirmExclude === obj.name }"
            :disabled="!!excludeReason"
            :title="
              excludeReason
                ? t(excludeReason)
                : confirmExclude === obj.name
                  ? t('Erneut klicken: Objekt dauerhaft aus diesem Druck ausschließen')
                  : t('Objekt im laufenden Druck überspringen')
            "
            @click="requestOrRunExclude(obj.name)"
            @blur="confirmExclude === obj.name && resetExcludeConfirm()"
            @keydown.esc="resetExcludeConfirm"
          >
            {{ confirmExclude === obj.name ? t('Wirklich?') : t('Überspringen') }}
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
