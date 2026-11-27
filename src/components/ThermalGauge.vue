<script setup>
import { computed } from 'vue'
import { t } from '../i18n.mjs'
import { thermalDisplay } from '../thermal.mjs'

const props = defineProps({
  id: Number,
  label: { type: String, default: '' },
  temperature: Number,
  target: Number,
  power: Number,
  maxTemperature: Number,
  online: Boolean,
  decorative: Boolean,
  hideLabel: { type: Boolean, default: false },
})
const gauge = computed(() => thermalDisplay(props))
</script>

<template>
  <span
    class="thermal-gauge"
    :class="gauge.mode"
    :role="!decorative && gauge.scale ? 'meter' : undefined"
    :aria-hidden="decorative ? 'true' : undefined"
    :aria-label="
      !decorative
        ? label
          ? `${label}: ${t(gauge.label)}${gauge.scale ? t(', {0} °C, Ziel {1} °C', [Math.round(temperature), target]) : ''}`
          : t('T{0}: {1}{2}', [
              id,
              gauge.label,
              gauge.scale ? t(', {0} °C, Ziel {1} °C', [Math.round(temperature), target]) : '',
            ])
        : undefined
    "
    :aria-valuemin="!decorative && gauge.scale ? 0 : undefined"
    :aria-valuemax="!decorative ? (gauge.scale ?? undefined) : undefined"
    :aria-valuenow="!decorative && gauge.scale ? temperature : undefined"
    :title="
      gauge.scale
        ? t('Temperatur auf einer Skala von 0–{0} °C. Strich: Ziel {1} °C.', [gauge.scale, target])
        : t('Keine aktuellen Temperaturwerte')
    "
  >
    <span class="thermal-track">
      <span class="thermal-fill" :style="{ width: `${gauge.fraction * 100}%` }" />
      <span v-for="tick in [25, 50, 75]" :key="tick" class="thermal-tick" :style="{ left: `${tick}%` }" />
      <span v-if="gauge.marker != null" class="thermal-target" :style="{ left: `${gauge.marker * 100}%` }" />
    </span>
    <span v-if="!hideLabel" class="thermal-label">{{ t(gauge.label) }}</span>
  </span>
</template>
