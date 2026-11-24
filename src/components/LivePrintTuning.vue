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
  }
})

const pauseAction = computed(() => (props.status?.printState === 'paused' ? 'resume' : 'pause'))
const pauseReason = computed(() => auxActionReason(props.status, pauseAction.value, props.online, props.pending))
const cancelReason = computed(() => printControlReason(props.status, 'print_cancel', props.online, props.pending))
const speedReason = computed(() => printControlReason(props.status, 'tune_speed', props.online, props.pending))
const flowReason = computed(() => printControlReason(props.status, 'tune_flow', props.online, props.pending))
const zReason = computed(() => printControlReason(props.status, 'tune_z_offset', props.online, props.pending))
const excludeReason = computed(() => printControlReason(props.status, 'exclude_object', props.online, props.pending))

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
