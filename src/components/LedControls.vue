<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Lightbulb, RotateCw, Home } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import {
  ledProfiles,
  auxActionReason,
  quickMotionReason,
  quickHomeAxisReason,
  quickJogReason,
} from '../aux-action-state.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
})

const emit = defineEmits(['command'])

const axisRows = [
  { axis: 'x', neg: [-10, -1], pos: [1, 10] },
  { axis: 'y', neg: [-10, -1], pos: [1, 10] },
  { axis: 'z', neg: [-1, -0.1], pos: [0.1, 1] },
]

const extra = ref('')
const confirmMotors = ref(false)
let confirmMotorsTimer = null

const reason = action => auxActionReason(props.status, action, props.online, props.pending)
const homeReason = computed(() => quickMotionReason(props.status, 'home', props.online, props.pending))
const qglReason = computed(() => quickMotionReason(props.status, 'qgl', props.online, props.pending))
const motorsReason = computed(() => quickMotionReason(props.status, 'motors_off', props.online, props.pending))
const homed = axis => props.status?.homedAxes?.includes(axis) === true
const allHomed = computed(() => [...'xyz'].every(homed))
const axisHomeReason = axis => quickHomeAxisReason(props.status, axis, props.online, props.pending)
const axisJogReason = (axis, distance) => quickJogReason(props.status, axis, distance, props.online, props.pending)
const formatStep = value => `${value > 0 ? '+' : '−'}${Math.abs(value).toLocaleString(locale.value)}`
const axisPosition = axis => {
  const index = ['x', 'y', 'z'].indexOf(axis)
  const val = props.status?.position?.[index]
  return homed(axis) && Number.isFinite(val)
    ? val.toLocaleString(locale.value, { maximumFractionDigits: 2 })
    : null
}
const available = id => props.status?.capabilities?.ledProfiles?.includes(id)
const main = computed(() => ledProfiles.slice(0, 5).filter(profile => available(profile.id)))
const others = computed(() => ledProfiles.slice(5).filter(profile => available(profile.id)))
const otherOptions = computed(() => others.value.map(profile => ({ value: profile.id, label: profile.label })))

function resetMotorsConfirm() {
  confirmMotors.value = false
  clearTimeout(confirmMotorsTimer)
  confirmMotorsTimer = null
}

watch(
  others,
  list => {
    if (!list.some(profile => profile.id === extra.value)) {
      extra.value = list[0]?.id ?? ''
    }
  },
  { immediate: true },
)

watch(motorsReason, blocked => {
  if (blocked) resetMotorsConfirm()
})

onBeforeUnmount(() => {
  resetMotorsConfirm()
})

function led(profile) {
  if (!reason('led') && available(profile)) emit('command', { action: 'led', profile })
}

function homeAll() {
  if (!homeReason.value) emit('command', { action: 'home', axis: 'all' })
}

function homeAxis(axis) {
  if (!axisHomeReason(axis)) emit('command', { action: 'home', axis })
}

function jogAxis(axis, distance) {
  if (!axisJogReason(axis, distance)) emit('command', { action: 'jog', axis, distance })
}

function runQgl() {
  if (!qglReason.value) emit('command', { action: 'qgl' })
}

function releaseMotors() {
  if (motorsReason.value) return
  if (props.status?.qglApplied && !confirmMotors.value) {
    confirmMotors.value = true
    clearTimeout(confirmMotorsTimer)
    confirmMotorsTimer = setTimeout(resetMotorsConfirm, 5000)
    return
  }
  resetMotorsConfirm()
  emit('command', { action: 'motors_off' })
}

function initialize() {
  if (!reason('initialize')) emit('command', { action: 'initialize' })
}
</script>

<template>
  <section class="led-controls" :aria-label="t('LED-Befehle')">
    <h3><Lightbulb :size="16" />LED Control</h3>
    <div class="led-actions">
      <button
        v-for="profile in main"
        :key="profile.id"
        class="subtle-button"
        type="button"
        :disabled="!!reason('led')"
        :title="reason('led') ? t(reason('led')) : profile.macro"
        @click="led(profile.id)"
      >
        {{ profile.label }}
      </button>
    </div>
    <form v-if="others.length" class="led-more" @submit.prevent="led(extra)">
      <CockpitSelect
        v-model="extra"
        :options="otherOptions"
        :aria-label="t('Weiterer LED-Status')"
        size="compact"
      />
      <button class="subtle-button" :disabled="!!reason('led') || !available(extra)">
        {{ t('Setzen') }}
      </button>
    </form>
    <p>{{ t('LED-Status für Tools und Drucker.') }}</p>
  </section>

  <section class="initialize-control" :aria-label="t('Vorbereitung & Toolchanger')">
    <div class="prep-actions">
      <button
        class="subtle-button"
        :class="{ 'prep-done': allHomed && online }"
        type="button"
        :disabled="!!homeReason"
        :aria-label="t('Alle Achsen homen')"
        :title="
          homeReason
            ? t(homeReason)
            : allHomed
              ? t('Alle Achsen referenziert · erneut homen')
              : t('Alle Achsen homen')
        "
        @click="homeAll"
      >
        <Home :size="15" /><span>ALL</span>
      </button>
      <button
        class="subtle-button"
        :class="{ 'prep-done': status?.qglApplied && online }"
        type="button"
        :disabled="!!qglReason"
        :aria-label="
          status?.qglApplied
            ? t('Gantry bereits ausgerichtet. QGL erneut ausführen')
            : t('Gantry ausrichten · QGL')
        "
        :title="
          qglReason
            ? t(qglReason)
            : status?.qglApplied
              ? t('Bereits ausgerichtet · QGL erneut ausführen')
              : t('Gantry ausrichten')
        "
        @click="runQgl"
      >
        <span>QGL</span>
      </button>
      <button
        class="subtle-button prep-motors-btn"
        :class="{ 'confirm-danger': confirmMotors }"
        type="button"
        :disabled="!!motorsReason"
        :aria-label="confirmMotors ? t('Wirklich lösen?') : t('Motoren lösen')"
        :title="
          motorsReason
            ? t(motorsReason)
            : confirmMotors
              ? t('Erneut klicken zum Bestätigen · QGL muss danach erneut ausgeführt werden')
              : status?.qglApplied
                ? t('Motoren lösen · Gantry senkt sich ab (QGL geht verloren)')
                : t('Motoren lösen')
        "
        @click="releaseMotors"
        @blur="resetMotorsConfirm"
        @keydown.esc="resetMotorsConfirm"
      >
        <svg class="motor-off-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <defs>
            <mask id="motor-off-cut">
              <rect width="24" height="24" fill="white" />
              <line x1="2" y1="2" x2="22" y2="22" stroke="black" stroke-width="4.4" stroke-linecap="round" />
            </mask>
          </defs>
          <path
            d="M7 4v2h3v2H7l-2 2v3H3v-3H1v8h2v-3h2v3h3l2 2h8v-4h2v3h3V9h-3v3h-2V8h-6V6h3V4H7z"
            fill="currentColor"
            mask="url(#motor-off-cut)"
          />
          <line x1="2.5" y1="2.5" x2="21.5" y2="21.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" />
        </svg>
        <span v-if="confirmMotors" class="prep-confirm-mark">?</span>
      </button>
    </div>

    <div class="axis-jog-stack" :aria-label="t('Achsen bewegen')">
      <div v-for="row in axisRows" :key="row.axis" class="axis-jog-row">
        <button
          v-for="dist in row.neg"
          :key="dist"
          type="button"
          class="axis-jog-btn"
          :disabled="!!axisJogReason(row.axis, dist)"
          :title="axisJogReason(row.axis, dist) ? t(axisJogReason(row.axis, dist)) : `${row.axis.toUpperCase()} ${formatStep(dist)} mm`"
          :aria-label="`${row.axis.toUpperCase()} ${formatStep(dist)} mm`"
          @click="jogAxis(row.axis, dist)"
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
              : axisPosition(row.axis) != null
                ? t('{0} = {1} mm · {0} erneut homen', [row.axis.toUpperCase(), axisPosition(row.axis)])
                : t('{0} homen', [row.axis.toUpperCase()])
          "
          :aria-label="t('{0} homen', [row.axis.toUpperCase()])"
          @click="homeAxis(row.axis)"
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
          @click="jogAxis(row.axis, dist)"
        >
          {{ formatStep(dist) }}
        </button>
      </div>
    </div>

    <button
      class="subtle-button"
      type="button"
      :disabled="!!reason('initialize')"
      :title="
        reason('initialize')
          ? t(reason('initialize'))
          : t('Homet bei Bedarf X/Y und fährt zur Bettmitte')
      "
      @click="initialize"
    >
      <RotateCw :size="15" />{{ t('Toolchanger initialisieren') }}
    </button>
    <p>{{ t('Homet bei Bedarf X/Y und fährt zur Bettmitte.') }}</p>
  </section>
</template>
