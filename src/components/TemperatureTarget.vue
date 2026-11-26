<script setup>
import { computed, ref, watch } from 'vue'
import { Check } from '@lucide/vue'
import { t } from '../i18n.mjs'

const props = defineProps({
  tool: Number,
  heater: { type: String, default: '' },
  label: { type: String, default: '' },
  target: Number,
  max: Number,
  online: Boolean,
  ready: Boolean,
  pending: Boolean,
  send: Function,
})

const draft = ref(null)
const submitted = ref(null)

const resolvedHeater = computed(() => props.heater || (props.tool ? `extruder${props.tool}` : 'extruder'))
const inputId = computed(() => `inspector-target-${props.heater || props.tool}`)
const targetDisplayName = computed(() => props.label || `T${props.tool}`)

const value = computed(() => draft.value ?? (Number.isFinite(props.target) ? String(Math.round(props.target)) : ''))
const enabled = computed(() => props.online && props.ready && !props.pending && Number.isFinite(props.max))
const valid = computed(
  () => value.value !== '' && Number.isInteger(Number(value.value)) && Number(value.value) >= 0 && Number(value.value) <= props.max,
)
const dirty = computed(() => draft.value !== null && Number(value.value) !== props.target)

function acknowledge() {
  if (submitted.value !== null && props.target === submitted.value) {
    if (draft.value !== '' && Number(draft.value) === submitted.value) draft.value = null
    submitted.value = null
  }
}

watch(() => props.target, acknowledge)

async function apply() {
  if (!enabled.value || !valid.value || !dirty.value) return
  const target = Number(value.value)
  if (await props.send({ action: 'temperature', heater: resolvedHeater.value, target })) {
    submitted.value = target
    acknowledge()
  }
}
</script>

<template>
  <form class="inspector-target" @submit.prevent="apply">
    <label :for="inputId">{{ t('Ziel') }}</label>
    <input
      :id="inputId"
      :value="value"
      type="number"
      min="0"
      :max="max"
      step="1"
      required
      inputmode="numeric"
      :disabled="!enabled"
      :class="{ dirty }"
      :aria-label="
        label
          ? t('Zieltemperatur für {0} in Grad Celsius', [targetDisplayName])
          : t('Zieltemperatur für T{0} in Grad Celsius', [tool])
      "
      :title="t('Enter übernimmt · Escape verwirft')"
      placeholder="—"
      @input="draft = $event.target.value"
      @keydown.esc="draft = null"
    />
    <span>°C</span>
    <button
      class="apply-temperature"
      :disabled="!enabled || !valid || !dirty"
      :aria-label="
        label
          ? t('Zieltemperatur für {0} übernehmen', [targetDisplayName])
          : t('Zieltemperatur für T{0} übernehmen', [tool])
      "
      :title="t('Zieltemperatur übernehmen')"
    >
      <Check :size="14" />
    </button>
  </form>
</template>
