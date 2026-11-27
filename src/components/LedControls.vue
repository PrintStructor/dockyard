<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Lightbulb, RotateCw, Home, Wrench } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import {
  ledProfiles,
  auxActionReason,
  quickMotionReason,
  quickHomeAxisReason,
} from '../aux-action-state.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  hidePrep: { type: Boolean, default: false },
})

const emit = defineEmits(['command'])

const extra = ref('')
const confirmMotors = ref(false)
let confirmMotorsTimer = null

const isToolchanger = computed(() => Boolean(props.status?.isToolchanger))
const levelingKind = computed(() => {
  if (props.status?.capabilities?.qgl) return 'qgl'
  if (props.status?.capabilities?.zTilt) return 'z_tilt'
  return null
})
const levelingApplied = computed(() => Boolean(props.status?.qglApplied || props.status?.zTiltApplied))

const reason = action => auxActionReason(props.status, action, props.online, props.pending)
const homeReason = computed(() => quickMotionReason(props.status, 'home', props.online, props.pending))
const levelingReason = computed(() =>
  levelingKind.value ? quickMotionReason(props.status, levelingKind.value, props.online, props.pending) : '',
)
const motorsReason = computed(() => quickMotionReason(props.status, 'motors_off', props.online, props.pending))
const homed = axis => props.status?.homedAxes?.includes(axis) === true
const allHomed = computed(() => [...'xyz'].every(homed))
const axisHomeReason = axis => quickHomeAxisReason(props.status, axis, props.online, props.pending)
const prepNote = computed(() => {
  if (confirmMotors.value) {
    return props.status?.zTiltApplied && !props.status?.qglApplied
      ? 'Erneut klicken zum Bestätigen · Z-Tilt muss danach erneut ausgeführt werden.'
      : 'Erneut klicken zum Bestätigen · QGL muss danach erneut ausgeführt werden.'
  }
  if (homeReason.value) return homeReason.value
  if (!homed('x') || !homed('y')) {
    if (levelingKind.value === 'qgl') return 'Für Z und QGL zuerst X/Y oder ALL homen.'
    if (levelingKind.value === 'z_tilt') return 'Für Z und Z-Tilt zuerst X/Y oder ALL homen.'
    return 'Für Z zuerst X/Y oder ALL homen.'
  }
  if (!homed('z')) {
    if (levelingKind.value === 'qgl') return 'Für QGL zuerst Z homen.'
    if (levelingKind.value === 'z_tilt') return 'Für Z-Tilt zuerst Z homen.'
    return 'Z-Achse noch nicht referenziert.'
  }
  return isToolchanger.value ? 'Homet bei Bedarf X/Y und fährt zur Bettmitte.' : 'Alle Achsen referenziert.'
})
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
const hasLedProfiles = computed(() => main.value.length > 0 || others.value.length > 0)
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

function runLeveling() {
  if (levelingKind.value && !levelingReason.value) emit('command', { action: levelingKind.value })
}

function releaseMotors() {
  if (motorsReason.value) return
  if (levelingApplied.value && !confirmMotors.value) {
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
  <section v-if="!hidePrep" class="initialize-control" :aria-label="isToolchanger ? t('Vorbereitung & Toolchanger') : t('Maschine & Vorbereitung')">
    <div class="machine-deck-head">
      <h3><Wrench :size="14" />{{ t('Maschine & Vorbereitung') }}</h3>
      <p :class="{ 'prep-note-warn': confirmMotors || !!homeReason }" :title="t(prepNote)" role="status">
        {{ t(prepNote) }}
      </p>
    </div>
    <div class="prep-grid-wrap">
      <div class="prep-actions" :class="{ 'no-leveling': !levelingKind }">
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
          <Home :size="13" /><span>ALL</span>
        </button>
        <button
          v-if="levelingKind === 'qgl'"
          class="subtle-button"
          :class="{ 'prep-done': status?.qglApplied && online }"
          type="button"
          :disabled="!!levelingReason"
          :aria-label="
            status?.qglApplied
              ? t('Gantry bereits ausgerichtet. QGL erneut ausführen')
              : t('Gantry ausrichten · QGL')
          "
          :title="
            levelingReason
              ? t(levelingReason)
              : status?.qglApplied
                ? t('Bereits ausgerichtet · QGL erneut ausführen')
                : t('Gantry ausrichten')
          "
          @click="runLeveling"
        >
          <span>QGL</span>
        </button>
        <button
          v-else-if="levelingKind === 'z_tilt'"
          class="subtle-button"
          :class="{ 'prep-done': status?.zTiltApplied && online }"
          type="button"
          :disabled="!!levelingReason"
          :aria-label="
            status?.zTiltApplied
              ? t('Bett bereits ausgerichtet. Z-Tilt erneut ausführen')
              : t('Z-Tilt ausrichten')
          "
          :title="
            levelingReason
              ? t(levelingReason)
              : status?.zTiltApplied
                ? t('Bereits ausgerichtet · Z-Tilt erneut ausführen')
                : t('Z-Tilt ausrichten')
          "
          @click="runLeveling"
        >
          <span>Z-Tilt</span>
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
          @keydown.esc="resetMotorsConfirm"
        >
          <svg class="motor-off-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <defs>
              <mask id="motor-off-cut-tools">
                <rect width="24" height="24" fill="white" />
                <line x1="2" y1="2" x2="22" y2="22" stroke="black" stroke-width="4.4" stroke-linecap="round" />
              </mask>
            </defs>
            <path
              d="M7 4v2h3v2H7l-2 2v3H3v-3H1v8h2v-3h2v3h3l2 2h8v-4h2v3h3V9h-3v3h-2V8h-6V6h3V4H7z"
              fill="currentColor"
              mask="url(#motor-off-cut-tools)"
            />
            <line x1="2.5" y1="2.5" x2="21.5" y2="21.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" />
          </svg>
          <span>{{ confirmMotors ? t('Aus?') : t('Aus') }}</span>
        </button>
      </div>

      <div class="prep-axes-row" :aria-label="t('Einzelne Achsen homen')">
        <button
          v-for="axis in ['x', 'y', 'z']"
          :key="axis"
          class="subtle-button"
          :class="{ 'prep-done': homed(axis) && online }"
          type="button"
          :disabled="!!axisHomeReason(axis)"
          :aria-label="t('{0} homen', [axis.toUpperCase()])"
          :title="
            axisHomeReason(axis)
              ? t(axisHomeReason(axis))
              : axisPosition(axis) != null
                ? t('{0} = {1} mm · {0} erneut homen', [axis.toUpperCase(), axisPosition(axis)])
                : t('{0} homen', [axis.toUpperCase()])
          "
          @click="homeAxis(axis)"
        >
          <Home :size="13" /><span>{{ axis.toUpperCase() }}</span>
        </button>
      </div>
    </div>

    <button
      v-if="isToolchanger && status?.capabilities?.initialize"
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
      <RotateCw :size="14" />{{ t('Toolchanger initialisieren') }}
    </button>
  </section>

  <section v-if="hasLedProfiles" class="led-controls" :aria-label="t('LED-Befehle')">
    <div class="machine-deck-head">
      <h3><Lightbulb :size="14" />{{ t('LED-Steuerung') }}</h3>
      <p
        :title="isToolchanger ? t('LED-Status für Tools und Drucker.') : t('LED-Status für den Drucker.')"
      >
        {{ isToolchanger ? t('LED-Status für Tools und Drucker.') : t('LED-Status für den Drucker.') }}
      </p>
    </div>
    <div class="led-actions" :data-count="main.length">
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
  </section>
</template>
