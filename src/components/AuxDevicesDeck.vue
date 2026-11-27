<script setup>
import { computed, ref } from 'vue'
import {
  Flame,
  Thermometer,
  Power,
  Sun,
  Check,
  SlidersHorizontal,
  Disc,
  ArrowDownToLine,
  ArrowUpFromLine,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { heatState } from '../../server/status.mjs'
import ThermalGauge from './ThermalGauge.vue'
import TemperatureTarget from './TemperatureTarget.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  showExtrude: { type: Boolean, default: true },
})

const emit = defineEmits(['command'])

const EXTRUDE_LENGTHS = [5, 10, 25, 50, 100]
const EXTRUDE_SPEEDS = [2, 5, 10]
const extrudeLength = ref(10)
const extrudeSpeed = ref(5)

const tempFanEditing = ref('')
const tempFanDraft = ref(0)
const pinDrafts = ref({})
const ledDrafts = ref({})

const busy = computed(() => props.pending || Boolean(props.status?.control?.job))
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)

const genericHeaters = computed(() => props.status?.genericHeaters ?? [])
const sensors = computed(() => props.status?.sensors ?? [])
const outputPins = computed(() => props.status?.outputPins ?? [])
const neopixels = computed(() => props.status?.neopixels ?? [])

const mountedToolId = computed(() => {
  const id = props.status?.active
  return Number.isInteger(id) && id >= 0 && id < (props.status?.tools?.length ?? 1) ? id : null
})
const mountedTool = computed(() => (mountedToolId.value != null ? props.status?.tools?.[mountedToolId.value] ?? null : null))
const minExtrudeTemp = computed(() => props.status?.capabilities?.extrusionMin?.[mountedToolId.value ?? 0] ?? 170)

const extrudeBlockReason = computed(() => {
  if (!props.online) return 'Keine aktuellen Druckerdaten.'
  if (props.status?.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (busy.value) return 'Ein Befehl läuft noch oder muss geprüft werden.'
  if (props.status?.loadWatchActive) return 'Einlegehilfe ist scharf. Zuerst mit „Fertig“ beenden.'
  if (props.status?.printState === 'printing') return 'Manuelles Extrudieren ist während eines laufenden Drucks gesperrt.'
  if (props.status?.idleState === 'Printing') return 'Der Drucker führt bereits eine Bewegung oder einen Befehl aus.'
  if (props.status?.isToolchanger && mountedToolId.value == null) {
    return 'Dieses Werkzeug ist nicht aufgenommen. Zum manuellen Extrudieren zuerst aufnehmen.'
  }
  if (mountedTool.value?.canExtrude !== true) {
    return t('Extruder zu kalt — mindestens {0} °C erforderlich.', [minExtrudeTemp.value])
  }
  return ''
})

function runManualExtrude(sign) {
  if (extrudeBlockReason.value) return
  const payload = {
    action: 'extrude',
    distance: sign * extrudeLength.value,
    speed: extrudeSpeed.value,
  }
  if (mountedToolId.value != null) payload.tool = mountedToolId.value
  emit('command', payload)
}

const number = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'

const ledColor = c =>
  c ? `rgb(${c.slice(0, 3).map(v => Math.round(Math.min(1, v + c[3]) * 255)).join(',')})` : 'transparent'

function heatPillMode(stateLabel) {
  if (!props.online) return 'idle'
  if (stateLabel === 'Heizt auf') return 'heating'
  if (stateLabel === 'Auf Solltemperatur') return 'holding'
  if (stateLabel === 'Heizung aus · heiß' || stateLabel === 'Über Solltemperatur') return 'cooling'
  return 'idle'
}

function openTempFanEditor(sensor) {
  if (!props.online || props.status?.klipperState !== 'ready' || sensor.kind !== 'temperature_fan') return
  if (tempFanEditing.value === sensor.name) {
    tempFanEditing.value = ''
    return
  }
  tempFanEditing.value = sensor.name
  tempFanDraft.value = Number.isFinite(sensor.target) ? Math.round(sensor.target) : 0
}

async function applyTempFanTarget(sensor) {
  if (!props.online || props.status?.klipperState !== 'ready') return
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
  if (!props.online || props.status?.klipperState !== 'ready') return
  const prior = pinDrafts.value[pin.name]
  const ok = await props.send({ action: 'output_pin', pin: pin.name, value })
  if (ok && pinDrafts.value[pin.name] === prior) {
    delete pinDrafts.value[pin.name]
  }
}

function toggleOutputPin(pin) {
  if (!props.online || props.status?.klipperState !== 'ready') return
  const isOn = (pin.value ?? 0) > 0
  setOutputPin(pin, isOn ? 0 : (pin.scale > 0 ? pin.scale : 1))
}

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

function applyLed(neo) {
  if (!props.online || props.status?.klipperState !== 'ready') return
  const st = ledStateFor(neo)
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
  if (!props.online || props.status?.klipperState !== 'ready') return
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
</script>

<template>
  <div class="aux-devices-deck">
    <section v-if="showExtrude" class="control-panel aux-extrude-card" :aria-label="t('Extruder & Filament')">
      <div class="single-extrude-head">
        <h3>
          <Disc :size="15" />
          {{ t('Extruder & Filament') }}
          <small v-if="status?.isToolchanger && mountedToolId != null" class="tuning-tool-tag">T{{ mountedToolId }}</small>
        </h3>
        <span
          class="single-heat-pill"
          :class="online && mountedTool?.canExtrude === true ? 'holding' : 'heating'"
        >
          {{
            !online
              ? t('Offline')
              : status?.isToolchanger && mountedToolId == null
                ? t('Kein Tool')
                : mountedTool?.canExtrude === true
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
    </section>

    <section v-if="genericHeaters.length" class="control-panel aux-generic-heaters" :aria-label="t('Zusatzheizer')">
      <div class="fan-heading">
        <h2><Flame :size="17" />{{ t('Zusatzheizer') }}</h2>
      </div>
      <div class="aux-heater-list">
        <div v-for="gh in genericHeaters" :key="gh.id" class="aux-heater-item">
          <div class="single-thermal-head">
            <strong>{{ t(gh.label) }}</strong>
            <span class="single-heat-pill" :class="heatPillMode(heatState(gh))">{{ t(heatState(gh)) }}</span>
          </div>
          <div class="single-thermal-readout">
            <span class="aux-heater-temp">{{ number(gh.temperature, 1) }} °C</span>
            <span v-if="online && gh.power != null" class="single-power-pill">{{ number(gh.power * 100, 0) }} %</span>
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
          />
        </div>
      </div>
    </section>

    <section v-if="sensors.length" class="control-panel aux-sensors-card" :aria-label="t('Sensoren & Temperaturlüfter')">
      <div class="fan-heading">
        <h2><Thermometer :size="17" />{{ t('Sensoren & Temperaturlüfter') }}</h2>
      </div>
      <div class="aux-sensors-grid">
        <div v-for="sensor in sensors" :key="sensor.id" class="aux-sensor-cell">
          <span class="single-metric-label">
            {{ t(sensor.label) }}
            <button
              v-if="sensor.kind === 'temperature_fan'"
              type="button"
              class="temp-fan-edit-trigger"
              :disabled="!online || status?.klipperState !== 'ready'"
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
            <button
              type="submit"
              class="apply-temperature"
              :disabled="!online || status?.klipperState !== 'ready'"
              :aria-label="t('Übernehmen')"
            >
              <Check :size="12" />
            </button>
          </form>
          <strong v-else class="single-metric-value single-tabular">
            {{ number(sensor.temperature, 1) }} °C
            <small v-if="sensor.target != null && sensor.target > 0">/ {{ Math.round(sensor.target) }}°</small>
          </strong>
        </div>
      </div>
    </section>

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
                  :disabled="!online || status?.klipperState !== 'ready'"
                  :aria-label="t('Ausgangsleistung für {0}', [t(pin.label)])"
                  @input="pinDrafts[pin.name] = Number($event.target.value)"
                />
                <output>{{ pinPercent(pin, pinValueFor(pin)) }} %</output>
              </div>
              <div class="fan-actions">
                <button type="button" class="subtle-button" :disabled="!online || status?.klipperState !== 'ready'" @click="setOutputPin(pin, 0)">
                  <Power :size="13" />{{ t('Aus') }}
                </button>
                <button
                  class="subtle-button"
                  type="submit"
                  :disabled="!online || status?.klipperState !== 'ready' || Math.abs(pinValueFor(pin) - (pin.value ?? 0)) < 1e-4"
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
              :disabled="!online || status?.klipperState !== 'ready'"
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
              <span class="led-swatch" :style="{ background: ledColor(neo.color) }" aria-hidden="true" />
              <strong>{{ t(neo.label) }}</strong>
            </span>
            <div class="rgb-quick-btns">
              <button type="button" class="subtle-button" :disabled="!online || status?.klipperState !== 'ready'" @click="quickLed(neo, 'white')">
                {{ t('Weiß') }}
              </button>
              <button type="button" class="subtle-button" :disabled="!online || status?.klipperState !== 'ready'" @click="quickLed(neo, 'warm')">
                {{ t('Warm') }}
              </button>
              <button type="button" class="subtle-button" :disabled="!online || status?.klipperState !== 'ready'" @click="quickLed(neo, 'off')">
                {{ t('Aus') }}
              </button>
            </div>
          </div>
          <form class="rgb-led-controls" @submit.prevent="applyLed(neo)">
            <label class="rgb-color-field" :title="t('Farbe wählen')">
              <input
                type="color"
                :value="ledStateFor(neo).hex"
                :disabled="!online || status?.klipperState !== 'ready'"
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
                  :disabled="!online || status?.klipperState !== 'ready'"
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
                  :disabled="!online || status?.klipperState !== 'ready'"
                  @input="updateLedDraft(neo, { white: Number($event.target.value) })"
                />
                <output>{{ ledStateFor(neo).white }} %</output>
              </label>
            </div>
            <button
              type="submit"
              class="apply-temperature"
              :disabled="!online || status?.klipperState !== 'ready' || !ledDrafts[neo.name]"
              :title="t('Farbe anwenden')"
              :aria-label="t('Farbe anwenden')"
            >
              <Check :size="13" />
            </button>
          </form>
        </div>
      </div>
    </section>
  </div>
</template>
