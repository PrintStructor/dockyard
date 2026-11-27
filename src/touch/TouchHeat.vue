<script setup>
import { computed, ref } from 'vue'
import { Flame, Thermometer, Snowflake, Fan } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { heatState } from '../../server/status.mjs'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  presets: { type: Array, default: () => [] },
})

const emit = defineEmits(['open-numpad'])

const allTools = ref(false)
const isToolchanger = computed(() => Boolean(props.status?.isToolchanger))
const tools = computed(() => props.status?.tools ?? [])
const bed = computed(() => props.status?.bed ?? {})
const genericHeaters = computed(() => props.status?.genericHeaters ?? [])
const tempFans = computed(() => (props.status?.sensors ?? []).filter(s => s.kind === 'temperature_fan'))

const busy = computed(() => props.pending || Boolean(props.status?.control?.job))
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)
const isPrinting = computed(() => props.status?.printState === 'printing')
const moving = computed(
  () => ['printing', 'paused'].includes(props.status?.printState) || props.status?.idleState === 'Printing' || props.status?.loadWatchActive,
)

const number = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'

function heatClass(heater) {
  const s = heatState(heater)
  if (!props.online) return 'idle'
  if (s === 'Heizt auf') return 'heating'
  if (s === 'Auf Solltemperatur') return 'holding'
  if (s === 'Heizung aus · heiß' || s === 'Über Solltemperatur') return 'cooling'
  return 'idle'
}

function editTool(toolId) {
  if (!enabled.value) return
  if (allTools.value && isToolchanger.value) {
    if (moving.value) return
    const limits = props.status?.capabilities?.toolMax ?? []
    const max = limits.length && limits.every(Number.isFinite) ? Math.min(...limits) : 300
    emit('open-numpad', {
      title: t('Alle Tools T0–T{0}', [tools.value.length - 1]),
      unit: '°C',
      initialValue: tools.value[0]?.target ?? 0,
      min: 0,
      max,
      presets: [
        { label: t('Aus'), value: 0 },
        { label: '140°', value: 140 },
        { label: '210°', value: 210 },
        { label: '240°', value: 240 },
      ],
      onConfirm: target => props.send({ action: 'temperature_all', target }),
    })
    return
  }
  const toolObj = tools.value[toolId] ?? {}
  const max = props.status?.capabilities?.toolMax?.[toolId] ?? 300
  emit('open-numpad', {
    title: isToolchanger.value ? t('Werkzeug T{0}', [toolId]) : t('Extruder'),
    unit: '°C',
    initialValue: toolObj.target ?? 0,
    min: 0,
    max,
    presets: [
      { label: t('Aus'), value: 0 },
      { label: '140°', value: 140 },
      { label: '210°', value: 210 },
      { label: '240°', value: 240 },
      { label: '260°', value: 260 },
    ],
    onConfirm: target =>
      props.send({ action: 'temperature', heater: toolId ? `extruder${toolId}` : 'extruder', target }),
  })
}

function editBed() {
  if (!enabled.value) return
  emit('open-numpad', {
    title: t('Druckbett'),
    unit: '°C',
    initialValue: bed.value.target ?? 0,
    min: 0,
    max: props.status?.capabilities?.bedMax ?? 120,
    presets: [
      { label: t('Aus'), value: 0 },
      { label: '60°', value: 60 },
      { label: '80°', value: 80 },
      { label: '105°', value: 105 },
      { label: '110°', value: 110 },
    ],
    onConfirm: target => props.send({ action: 'temperature', heater: 'heater_bed', target }),
  })
}

function editGenericHeater(gh) {
  if (!enabled.value) return
  emit('open-numpad', {
    title: t(gh.label),
    unit: '°C',
    initialValue: gh.target ?? 0,
    min: 0,
    max: gh.maxTemp ?? 120,
    presets: [
      { label: t('Aus'), value: 0 },
      { label: '45°', value: 45 },
      { label: '55°', value: 55 },
      { label: '65°', value: 65 },
    ],
    onConfirm: target => props.send({ action: 'temperature', heater: gh.id, target }),
  })
}

function editTempFan(sensor) {
  if (!props.online || props.status?.klipperState !== 'ready') return
  emit('open-numpad', {
    title: t(sensor.label),
    unit: '°C',
    initialValue: sensor.target ?? 0,
    min: 0,
    max: sensor.maxTemp ?? 100,
    presets: [
      { label: t('Aus'), value: 0 },
      { label: '35°', value: 35 },
      { label: '45°', value: 45 },
      { label: '55°', value: 55 },
    ],
    onConfirm: target => props.send({ action: 'temperature_fan', fan: sensor.name, target }),
  })
}

async function applyPreset(preset) {
  if (!enabled.value) return
  const ext = Number.isFinite(preset?.tools?.[0]) ? Math.round(preset.tools[0]) : null
  const b = Number.isFinite(preset?.bed) ? Math.round(preset.bed) : null
  if (isToolchanger.value) {
    if (b != null) await props.send({ action: 'temperature', heater: 'heater_bed', target: b })
    if (ext != null) {
      if (allTools.value && !moving.value) {
        await props.send({ action: 'temperature_all', target: ext })
      } else {
        const activeId = Number.isInteger(props.status?.active) && props.status.active >= 0 ? props.status.active : 0
        await props.send({ action: 'temperature', heater: activeId ? `extruder${activeId}` : 'extruder', target: ext })
      }
    }
    return
  }
  const payload = { action: 'preheat' }
  if (ext != null) payload.extruder = ext
  if (b != null) payload.bed = b
  await props.send(payload)
}
</script>

<template>
  <section class="touch-heat-view" :aria-label="t('Heizen')">
    <div class="touch-heat-top">
      <div class="touch-heat-cards" :class="{ multi: isToolchanger }">
        <button
          v-for="tool in tools"
          :key="tool.id"
          type="button"
          class="touch-heater-tile"
          :class="[heatClass(tool), { mounted: isToolchanger && online && tool.detected }]"
          :disabled="!enabled"
          @click="editTool(tool.id)"
        >
          <span class="touch-heater-label">
            <Flame :size="14" />{{ isToolchanger ? `T${tool.id}` : t('Extruder') }}
          </span>
          <strong class="touch-heater-temp">{{ number(tool.temperature, 1) }}°</strong>
          <small class="touch-heater-target">{{ tool.target > 0 ? `→ ${Math.round(tool.target)}°C` : t('Aus') }}</small>
        </button>

        <button
          type="button"
          class="touch-heater-tile bed"
          :class="heatClass(bed)"
          :disabled="!enabled"
          @click="editBed"
        >
          <span class="touch-heater-label"><Thermometer :size="14" />{{ t('Druckbett') }}</span>
          <strong class="touch-heater-temp">{{ number(bed.temperature, 1) }}°</strong>
          <small class="touch-heater-target">{{ bed.target > 0 ? `→ ${Math.round(bed.target)}°C` : t('Aus') }}</small>
        </button>

        <button
          v-for="gh in genericHeaters"
          :key="gh.id"
          type="button"
          class="touch-heater-tile"
          :class="heatClass(gh)"
          :disabled="!enabled"
          @click="editGenericHeater(gh)"
        >
          <span class="touch-heater-label"><Flame :size="14" />{{ t(gh.label) }}</span>
          <strong class="touch-heater-temp">{{ number(gh.temperature, 1) }}°</strong>
          <small class="touch-heater-target">{{ gh.target > 0 ? `→ ${Math.round(gh.target)}°C` : t('Aus') }}</small>
        </button>

        <button
          v-for="tf in tempFans"
          :key="tf.id"
          type="button"
          class="touch-heater-tile"
          :disabled="!online || status?.klipperState !== 'ready'"
          @click="editTempFan(tf)"
        >
          <span class="touch-heater-label"><Fan :size="14" />{{ t(tf.label) }}</span>
          <strong class="touch-heater-temp">{{ number(tf.temperature, 1) }}°</strong>
          <small class="touch-heater-target">{{ tf.target > 0 ? `→ ${Math.round(tf.target)}°C` : t('Aus') }}</small>
        </button>
      </div>
    </div>

    <div class="touch-heat-bar">
      <button
        v-if="isToolchanger"
        type="button"
        class="touch-btn"
        :class="allTools ? 'touch-btn-accent' : 'touch-btn-surface'"
        :aria-pressed="allTools"
        @click="allTools = !allTools"
      >
        {{ t('Alle Tools') }}
      </button>

      <button
        v-for="preset in presets.slice(0, isToolchanger ? 3 : 4)"
        :key="preset.name"
        type="button"
        class="touch-btn touch-btn-surface"
        :disabled="!enabled"
        @click="applyPreset(preset)"
      >
        <strong>{{ preset.name }}</strong>
        <small>{{ preset.tools?.[0] ?? '—' }}/{{ preset.bed ?? '—' }}°</small>
      </button>

      <button
        type="button"
        class="touch-btn touch-btn-danger-soft"
        :disabled="!enabled || isPrinting"
        @click="send({ action: 'heaters_off' })"
      >
        <Snowflake :size="17" />{{ t('Alle aus') }}
      </button>
    </div>
  </section>
</template>
