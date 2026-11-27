<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Terminal,
  Fan,
  Sun,
  Power,
  RotateCw,
  Moon,
  Monitor,
  Globe,
  Save,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
} from '@lucide/vue'
import { t, language, setLanguage } from '../i18n.mjs'
import { ledProfiles } from '../aux-action-state.mjs'
import { withPrinterParam } from './touch-config.mjs'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  printerId: { type: String, default: '' },
  locked: { type: Boolean, default: false },
  canWrite: { type: Boolean, default: true },
})

const emit = defineEmits(['sleep', 'exit-desktop', 'refresh', 'toast'])

const subtab = ref('macros') // 'macros' | 'devices' | 'system'
const macroPage = ref(0)
const MACRO_PAGE_SIZE = 8

const busy = computed(() => props.pending || Boolean(props.status?.control?.job))
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)
const readyOnly = computed(() => props.online && props.status?.klipperState === 'ready')
const macroEnabled = computed(
  () =>
    enabled.value &&
    props.status?.printState !== 'printing' &&
    props.status?.idleState !== 'Printing' &&
    !props.status?.loadWatchActive,
)

const macros = computed(() => props.status?.publicMacros ?? [])
const totalMacroPages = computed(() => Math.max(1, Math.ceil(macros.value.length / MACRO_PAGE_SIZE)))
const pagedMacros = computed(() => {
  const start = macroPage.value * MACRO_PAGE_SIZE
  return macros.value.slice(start, start + MACRO_PAGE_SIZE)
})

const controllableFans = computed(() => (props.status?.fans ?? []).filter(f => f.controllable !== false))
const neopixels = computed(() => props.status?.neopixels ?? [])
const outputPins = computed(() => props.status?.outputPins ?? [])
const installedLedProfiles = computed(() => {
  const installed = props.status?.capabilities?.ledProfiles ?? []
  return ledProfiles.filter(p => installed.includes(p.id))
})

const FAN_STEPS = [0, 25, 50, 75, 100]

function setFan(fan, percent) {
  if (!readyOnly.value) return
  props.send({ action: 'fan', fan: fan.name, percent })
}

function quickLed(neo, kind) {
  if (!readyOnly.value) return
  if (kind === 'off') {
    props.send({ action: 'set_led', led: neo.name, red: 0, green: 0, blue: 0, ...(neo.hasWhite ? { white: 0 } : {}) })
  } else if (kind === 'white') {
    props.send({
      action: 'set_led',
      led: neo.name,
      red: neo.hasWhite ? 0 : 1,
      green: neo.hasWhite ? 0 : 1,
      blue: neo.hasWhite ? 0 : 1,
      ...(neo.hasWhite ? { white: 1 } : {}),
    })
  } else {
    props.send({
      action: 'set_led',
      led: neo.name,
      red: 1,
      green: 0.72,
      blue: 0.35,
      ...(neo.hasWhite ? { white: 0.4 } : {}),
    })
  }
}

function togglePin(pin) {
  if (!readyOnly.value) return
  const next = (pin.value ?? 0) > 0 ? 0 : (pin.scale > 0 ? pin.scale : 1)
  props.send({ action: 'output_pin', pin: pin.name, value: next })
}

// System power devices & restart actions (strict 2-step confirm)
const powerDevices = ref([])
const confirmAction = ref('')
const systemBusy = ref(false)
let confirmTimer = null

function resetConfirm() {
  confirmAction.value = ''
  clearTimeout(confirmTimer)
  confirmTimer = null
}

onBeforeUnmount(() => resetConfirm())

function requestOrRun(key, runner) {
  if (confirmAction.value !== key) {
    confirmAction.value = key
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(resetConfirm, 5000)
    return
  }
  resetConfirm()
  runner()
}

async function loadPowerDevices() {
  try {
    const res = await fetch(withPrinterParam('/api/system/power', props.printerId), {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    powerDevices.value = data?.available && Array.isArray(data.devices) ? data.devices : []
  } catch {
    powerDevices.value = []
  }
}

async function postSystem(url, body) {
  if (!props.canWrite || systemBusy.value) return
  systemBusy.value = true
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Cockpit-Request': '1' }
    if (props.printerId) headers['X-Dockyard-Printer'] = props.printerId
    const res = await fetch(withPrinterParam(url, props.printerId), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Aktion fehlgeschlagen.')
    emit('toast', { ok: true, message: data.message || 'Ausgeführt.' })
    emit('refresh')
    if (url.includes('/power')) loadPowerDevices()
  } catch (err) {
    emit('toast', { ok: false, message: err.message || 'Aktion fehlgeschlagen.' })
  } finally {
    systemBusy.value = false
  }
}

watch(
  [subtab, () => props.printerId],
  ([next]) => {
    resetConfirm()
    if (next === 'system') loadPowerDevices()
  },
)

onMounted(() => {
  if (subtab.value === 'system') loadPowerDevices()
})

const canSaveConfig = computed(
  () =>
    props.online &&
    props.status?.klipperState === 'ready' &&
    props.status?.saveConfigPending === true &&
    !['printing', 'paused'].includes(props.status?.printState) &&
    !busy.value,
)
</script>

<template>
  <section class="touch-more-view" :aria-label="t('Mehr')">
    <div class="touch-subnav">
      <button type="button" class="touch-subtab" :aria-pressed="subtab === 'macros'" @click="subtab = 'macros'">
        <Terminal :size="16" />{{ t('Makros') }}
      </button>
      <button type="button" class="touch-subtab" :aria-pressed="subtab === 'devices'" @click="subtab = 'devices'">
        <Fan :size="16" />{{ t('Lüfter & Licht') }}
      </button>
      <button type="button" class="touch-subtab" :aria-pressed="subtab === 'system'" @click="subtab = 'system'">
        <SlidersHorizontal :size="16" />{{ t('System') }}
      </button>

      <div v-if="subtab === 'macros' && totalMacroPages > 1" class="touch-pager">
        <button
          type="button"
          class="touch-btn touch-btn-surface touch-btn-icon"
          :disabled="macroPage <= 0"
          :aria-label="t('Zurück')"
          @click="macroPage = Math.max(0, macroPage - 1)"
        >
          <ChevronLeft :size="18" />
        </button>
        <span class="touch-page-label">{{ macroPage + 1 }} / {{ totalMacroPages }}</span>
        <button
          type="button"
          class="touch-btn touch-btn-surface touch-btn-icon"
          :disabled="macroPage >= totalMacroPages - 1"
          :aria-label="t('Weiter')"
          @click="macroPage = Math.min(totalMacroPages - 1, macroPage + 1)"
        >
          <ChevronRight :size="18" />
        </button>
      </div>
    </div>

    <!-- SUBTAB 1: MACROS -->
    <div v-if="subtab === 'macros'" class="touch-macro-grid">
      <template v-if="pagedMacros.length">
        <button
          v-for="m in pagedMacros"
          :key="m.name"
          type="button"
          class="touch-btn touch-macro-tile"
          :class="confirmAction === `macro:${m.name}` ? 'touch-btn-amber' : 'touch-btn-surface'"
          :disabled="!macroEnabled"
          @click="requestOrRun(`macro:${m.name}`, () => send({ action: 'macro', name: m.name }))"
        >
          <strong>{{ confirmAction === `macro:${m.name}` ? t('Ausführen?') : m.name }}</strong>
          <small v-if="m.description">{{ m.description }}</small>
        </button>
      </template>
      <div v-else class="touch-empty-state">
        <Terminal :size="26" />
        <p>{{ t('Keine öffentlichen Makros konfiguriert.') }}</p>
      </div>
    </div>

    <!-- SUBTAB 2: FANS, LEDs & PINS -->
    <div v-else-if="subtab === 'devices'" class="touch-devices-grid">
      <div v-for="fan in controllableFans.slice(0, 3)" :key="fan.name" class="touch-device-row">
        <div class="touch-device-head">
          <strong><Fan :size="15" />{{ t(fan.label) }}</strong>
          <span>{{ fan.percent != null ? `${fan.percent} %` : '—' }}</span>
        </div>
        <div class="touch-chip-row">
          <button
            v-for="pct in FAN_STEPS"
            :key="pct"
            type="button"
            class="touch-chip"
            :aria-pressed="fan.percent != null && Math.abs(fan.percent - pct) <= 3"
            :disabled="!readyOnly"
            @click="setFan(fan, pct)"
          >
            {{ pct === 0 ? t('Aus') : `${pct}%` }}
          </button>
        </div>
      </div>

      <div v-if="installedLedProfiles.length" class="touch-device-row">
        <div class="touch-device-head">
          <strong><Sun :size="15" />{{ t('LED-Profile') }}</strong>
        </div>
        <div class="touch-chip-row">
          <button
            v-for="prof in installedLedProfiles"
            :key="prof.id"
            type="button"
            class="touch-chip"
            :disabled="!readyOnly"
            @click="send({ action: 'led', profile: prof.id })"
          >
            {{ t(prof.label) }}
          </button>
        </div>
      </div>

      <div v-for="neo in neopixels.slice(0, 2)" :key="neo.id" class="touch-device-row">
        <div class="touch-device-head">
          <strong><Sun :size="15" />{{ t(neo.label) }}</strong>
        </div>
        <div class="touch-chip-row">
          <button type="button" class="touch-chip" :disabled="!readyOnly" @click="quickLed(neo, 'white')">{{ t('Weiß') }}</button>
          <button type="button" class="touch-chip" :disabled="!readyOnly" @click="quickLed(neo, 'warm')">{{ t('Warm') }}</button>
          <button type="button" class="touch-chip" :disabled="!readyOnly" @click="quickLed(neo, 'off')">{{ t('Aus') }}</button>
        </div>
      </div>

      <div v-if="outputPins.length" class="touch-device-row">
        <div class="touch-device-head">
          <strong><Power :size="15" />{{ t('Ausgänge') }}</strong>
        </div>
        <div class="touch-chip-row">
          <button
            v-for="pin in outputPins"
            :key="pin.id"
            type="button"
            class="touch-chip"
            :aria-pressed="online && (pin.value ?? 0) > 0"
            :disabled="!readyOnly"
            @click="togglePin(pin)"
          >
            {{ t(pin.label) }} · {{ (pin.value ?? 0) > 0 ? t('An') : t('Aus') }}
          </button>
        </div>
      </div>
    </div>

    <!-- SUBTAB 3: SYSTEM, POWER & DISPLAY -->
    <div v-else class="touch-system-grid">
      <button
        v-if="canSaveConfig"
        type="button"
        class="touch-btn touch-btn-lg"
        :class="confirmAction === 'save_config' ? 'touch-btn-amber' : 'touch-btn-accent'"
        @click="requestOrRun('save_config', () => send({ action: 'save_config' }))"
      >
        <Save :size="18" />{{ confirmAction === 'save_config' ? t('Jetzt speichern?') : 'SAVE_CONFIG' }}
      </button>

      <button
        type="button"
        class="touch-btn touch-btn-lg"
        :class="confirmAction === 'klipper_restart' ? 'touch-btn-amber' : 'touch-btn-surface'"
        :disabled="!canWrite || systemBusy"
        @click="requestOrRun('klipper_restart', () => postSystem('/api/system/service/restart', { target: 'klipper_restart' }))"
      >
        <RotateCw :size="18" />{{ confirmAction === 'klipper_restart' ? t('Klipper neu starten?') : t('Klipper neu starten') }}
      </button>

      <button
        type="button"
        class="touch-btn touch-btn-lg"
        :class="confirmAction === 'firmware_restart' ? 'touch-btn-amber' : 'touch-btn-surface'"
        :disabled="!canWrite || systemBusy"
        @click="requestOrRun('firmware_restart', () => postSystem('/api/system/service/restart', { target: 'firmware_restart' }))"
      >
        <Power :size="18" />{{ confirmAction === 'firmware_restart' ? t('Firmware neu starten?') : t('Firmware-Neustart') }}
      </button>

      <button
        type="button"
        class="touch-btn touch-btn-lg"
        :class="confirmAction === 'host_reboot' ? 'touch-btn-danger' : 'touch-btn-surface'"
        :disabled="!canWrite || systemBusy"
        @click="requestOrRun('host_reboot', () => postSystem('/api/system/host/reboot', {}))"
      >
        <RotateCw :size="18" />{{ confirmAction === 'host_reboot' ? t('Host wirklich neu starten?') : t('Host neu starten') }}
      </button>

      <button
        type="button"
        class="touch-btn touch-btn-lg"
        :class="confirmAction === 'host_shutdown' ? 'touch-btn-danger' : 'touch-btn-surface'"
        :disabled="!canWrite || systemBusy"
        @click="requestOrRun('host_shutdown', () => postSystem('/api/system/host/shutdown', {}))"
      >
        <Power :size="18" />{{ confirmAction === 'host_shutdown' ? t('Host wirklich herunterfahren?') : t('Host herunterfahren') }}
      </button>

      <button
        v-for="dev in powerDevices.slice(0, 2)"
        :key="dev.device"
        type="button"
        class="touch-btn touch-btn-lg"
        :class="dev.status === 'on' ? 'touch-btn-ok' : 'touch-btn-surface'"
        :disabled="!canWrite || systemBusy"
        @click="
          requestOrRun(`power:${dev.device}`, () =>
            postSystem('/api/system/power', { device: dev.device, action: dev.status === 'on' ? 'off' : 'on' }),
          )
        "
      >
        <Power :size="18" />
        {{
          confirmAction === `power:${dev.device}`
            ? dev.status === 'on'
              ? t('{0} ausschalten?', [dev.device])
              : t('{0} einschalten?', [dev.device])
            : `${dev.device} · ${dev.status === 'on' ? t('An') : t('Aus')}`
        }}
      </button>

      <button type="button" class="touch-btn touch-btn-lg touch-btn-surface" @click="emit('sleep')">
        <Moon :size="18" />{{ t('Standby') }}
      </button>

      <button
        type="button"
        class="touch-btn touch-btn-lg touch-btn-surface"
        @click="setLanguage(language === 'de' ? 'en' : 'de')"
      >
        <Globe :size="18" />{{ language === 'de' ? 'DE → EN' : 'EN → DE' }}
      </button>

      <button
        v-if="!locked"
        type="button"
        class="touch-btn touch-btn-lg touch-btn-surface"
        @click="emit('exit-desktop')"
      >
        <Monitor :size="18" />{{ t('Desktop-Ansicht') }}
      </button>
    </div>
  </section>
</template>
