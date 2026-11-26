<script setup>
import { computed, defineAsyncComponent } from 'vue'
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
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { heatState } from '../../server/status.mjs'
import { ledProfiles } from '../aux-action-state.mjs'
import { toolActionReason } from '../tool-action-state.mjs'
import ThermalGauge from './ThermalGauge.vue'
import TemperatureTarget from './TemperatureTarget.vue'
import FanControl from './FanControl.vue'
import LedControls from './LedControls.vue'
import SpoolmanPicker from './SpoolmanPicker.vue'

const PrinterScene = defineAsyncComponent(() => import('./PrinterScene.vue'))

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  time: String,
  printerSubtitle: String,
  printerName: { type: String, default: '' },
  sceneConfig: { type: Object, default: () => ({ kind: 'none' }) },
  canWrite: { type: Boolean, default: true },
})

const emit = defineEmits(['command', 'open-settings', 'refresh'])

const extruder = computed(() => props.status?.tools?.[0] ?? {})
const bed = computed(() => props.status?.bed ?? {})

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

const hasFilamentSensor = computed(
  () => Boolean(extruder.value?.filamentSensorName) || extruder.value?.filamentEnabled != null,
)

const filamentState = computed(() => {
  const tool = extruder.value
  if (!props.online || tool.filamentEnabled == null) return { kind: 'unknown', label: 'Filament ?' }
  if (tool.filamentEnabled === false) return { kind: 'unknown', label: 'Überwachung aus' }
  if (tool.filamentDetected === true) return { kind: 'present', label: 'Filament erkannt' }
  if (tool.filamentDetected === false) return { kind: 'empty', label: 'Kein Filament' }
  return { kind: 'unknown', label: 'Filament ?' }
})

const bedHeat = computed(() => heatState(bed.value))
const extruderHeat = computed(() => heatState(extruder.value))

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

const homedAxis = axis => props.status?.homedAxes?.includes(axis) === true
const axisDisplay = (axis, idx) => {
  if (!props.online || !homedAxis(axis)) return '—'
  const val = props.status?.position?.[idx]
  return Number.isFinite(val) ? number(val, axis === 'z' ? 2 : 1) : '—'
}

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
  return null
})

const sensors = computed(() => props.status?.sensors ?? [])

const hasLedDeck = computed(() => {
  const installed = props.status?.capabilities?.ledProfiles ?? []
  return ledProfiles.some(p => installed.includes(p.id))
})

const QUICK_ACTIONS = [
  { id: 'load', label: 'Laden', icon: ArrowDownToLine },
  { id: 'unload', label: 'Entladen', icon: ArrowUpFromLine },
  { id: 'clean', label: 'Clean', icon: Sparkles },
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
</script>

<template>
  <div class="single-tool-main">
    <PrinterScene
      v-if="sceneConfig?.kind === 'printer-scene'"
      :scene-config="sceneConfig"
      :tool="extruder"
      :online="online"
      :printer-name="printerName"
      :bed-size="status?.bedSize ?? null"
      :can-write="canWrite"
      @open-settings="emit('open-settings')"
    />

    <div class="single-thermal-grid" :aria-label="t('Temperaturen')">
      <!-- Extruder Card -->
      <article class="single-thermal-card" :class="{ stale: !online }">
        <div class="single-thermal-head">
          <div class="single-thermal-title">
            <Flame :size="16" class="single-icon-accent" />
            <h2>Extruder</h2>
            <div v-if="hasExtruderLeds && online" class="single-led-dots" :aria-label="t('Toolhead-LEDs')">
              <span
                v-for="[role, lbl] in [['number', 'Logo'], ['left', 'Düse 1'], ['right', 'Düse 2']]"
                :key="role"
                class="led-swatch"
                :style="{ background: ledColor(extruder.leds?.[role]) }"
                :title="t(lbl)"
              />
            </div>
          </div>
          <span class="single-heat-pill" :class="{ heating: extruderHeat === 'Heizt auf' && online }">
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
          :max-temperature="status?.capabilities?.toolMax?.[0]"
          :online="online"
        />

        <TemperatureTarget
          heater="extruder"
          :label="t('Extruder')"
          :target="extruder.target"
          :max="status?.capabilities?.toolMax?.[0]"
          :online="online"
          :ready="status?.klipperState === 'ready'"
          :pending="pending || !!status?.control?.job"
          :send="send"
        />

        <div
          v-if="hasFilamentSensor || Number.isFinite(extruder.pressureAdvance) || (status?.spoolman?.available && status?.spoolman?.connected)"
          class="single-thermal-meta"
        >
          <SpoolmanPicker
            v-if="status?.spoolman?.available && status?.spoolman?.connected"
            :spoolman="status.spoolman"
            :online="online"
            :can-write="canWrite"
            @changed="emit('refresh')"
          />
          <span v-if="hasFilamentSensor" class="single-meta-pill" :class="filamentState.kind">
            <span class="single-meta-dot" />
            {{ t(filamentState.label) }}
          </span>
          <span v-if="Number.isFinite(extruder.pressureAdvance)" class="single-meta-pill neutral">
            PA {{ number(extruder.pressureAdvance, 3) }}
          </span>
        </div>
      </article>

      <!-- Bed Card -->
      <article class="single-thermal-card" :class="{ stale: !online }">
        <div class="single-thermal-head">
          <div class="single-thermal-title">
            <Thermometer :size="16" class="single-icon-accent" />
            <h2>{{ t('Druckbett') }}</h2>
          </div>
          <span class="single-heat-pill" :class="{ heating: bedHeat === 'Heizt auf' && online }">
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
          :max-temperature="status?.capabilities?.bedMax"
          :online="online"
        />

        <TemperatureTarget
          heater="heater_bed"
          :label="t('Druckbett')"
          :target="bed.target"
          :max="status?.capabilities?.bedMax"
          :online="online"
          :ready="status?.klipperState === 'ready'"
          :pending="pending || !!status?.control?.job"
          :send="send"
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
    </div>

    <!-- Live Position, State & Dynamic Sensors Strip -->
    <section class="single-metrics-strip" :aria-label="t('Position und Sensoren')">
      <div class="single-metric-cell">
        <span class="single-metric-label"><Compass :size="12" />{{ t('Position') }}</span>
        <strong class="single-metric-value single-mono">
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

      <div v-for="sensor in sensors" :key="sensor.id" class="single-metric-cell">
        <span class="single-metric-label">{{ t(sensor.label) }}</span>
        <strong class="single-metric-value single-mono">
          {{ number(sensor.temperature, 1) }} °C
          <small v-if="sensor.target != null && sensor.target > 0">/ {{ Math.round(sensor.target) }}°</small>
        </strong>
      </div>
    </section>

    <!-- Machine Prep & Optional LED Deck -->
    <section
      class="tools-machine-panel"
      :class="{ 'single-col': !hasLedDeck }"
      :aria-label="t('Maschine & Vorbereitung')"
    >
      <LedControls :status="status" :online="online" :pending="pending" @command="emit('command', $event)" />
    </section>
  </div>

  <!-- Right Column: Optional Quick Actions + Fan Control -->
  <aside class="single-tool-inspector" :aria-label="t('Aktionen und Lüfter')">
    <section v-if="configuredQuickActions.length" class="single-actions-card">
      <h3>{{ t('Schnellaktionen') }}</h3>
      <div class="single-actions-grid">
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
  </aside>
</template>
