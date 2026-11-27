<script setup>
import { computed, ref, watch } from 'vue'
import { Check, Delete, X } from '@lucide/vue'
import { t } from '../i18n.mjs'

const props = defineProps({
  open: Boolean,
  title: { type: String, default: '' },
  unit: { type: String, default: '°C' },
  initialValue: { type: [Number, String], default: '' },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 300 },
  allowDecimal: { type: Boolean, default: false },
  presets: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'confirm'])

const draft = ref('')

watch(
  [() => props.open, () => props.initialValue],
  ([isOpen, init]) => {
    if (!isOpen) return
    if (init === '' || init == null || !Number.isFinite(Number(init))) {
      draft.value = ''
    } else {
      draft.value = props.allowDecimal ? String(Number(Number(init).toFixed(2))) : String(Math.round(Number(init)))
    }
  },
  { immediate: true },
)

const parsedValue = computed(() => {
  if (draft.value === '' || draft.value === '.' || draft.value === '-') return null
  const num = Number(draft.value)
  return Number.isFinite(num) ? num : null
})

const isValid = computed(() => {
  if (parsedValue.value === null) return false
  if (!props.allowDecimal && !Number.isInteger(parsedValue.value)) return false
  return parsedValue.value >= props.min && parsedValue.value <= props.max
})

function appendChar(ch) {
  if (ch === '.') {
    if (!props.allowDecimal || draft.value.includes('.')) return
    draft.value = draft.value === '' ? '0.' : `${draft.value}.`
    return
  }
  if (draft.value.length >= 6) return
  if (draft.value === '0') {
    draft.value = ch
    return
  }
  draft.value += ch
}

function backspace() {
  draft.value = draft.value.slice(0, -1)
}

function clearDraft() {
  draft.value = ''
}

function applyPreset(val) {
  if (!Number.isFinite(val)) return
  if (val < props.min || val > props.max) return
  emit('confirm', props.allowDecimal ? Number(val.toFixed(2)) : Math.round(val))
}

function submit() {
  if (!isValid.value) return
  emit('confirm', props.allowDecimal ? Number(parsedValue.value.toFixed(2)) : Math.round(parsedValue.value))
}
</script>

<template>
  <div
    v-if="open"
    class="touch-overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="title || t('Wert eingeben')"
    @click.self="emit('close')"
  >
    <div class="touch-numpad-sheet">
      <div class="touch-numpad-left">
        <div class="touch-numpad-head">
          <h2>{{ title }}</h2>
          <small>{{ t('Bereich: {0} – {1} {2}', [min, max, unit]) }}</small>
        </div>

        <div class="touch-numpad-display" :class="{ invalid: draft !== '' && !isValid }">
          <span>{{ draft === '' ? '—' : draft }}</span>
          <small>{{ unit }}</small>
        </div>

        <div v-if="presets.length" class="touch-numpad-presets">
          <button
            v-for="p in presets"
            :key="p.label ?? p.value"
            type="button"
            class="touch-btn touch-preset-chip"
            :disabled="p.value < min || p.value > max"
            @click="applyPreset(p.value)"
          >
            {{ p.label ?? `${p.value} ${unit}` }}
          </button>
        </div>

        <div class="touch-numpad-actions">
          <button type="button" class="touch-btn touch-btn-ghost" @click="emit('close')">
            <X :size="20" />{{ t('Abbrechen') }}
          </button>
          <button
            type="button"
            class="touch-btn touch-btn-accent"
            :disabled="!isValid"
            @click="submit"
          >
            <Check :size="20" />{{ t('Übernehmen') }}
          </button>
        </div>
      </div>

      <div class="touch-numpad-keys" role="group" :aria-label="t('Ziffernblock')">
        <button v-for="d in ['7', '8', '9', '4', '5', '6', '1', '2', '3']" :key="d" type="button" class="touch-key" @click="appendChar(d)">
          {{ d }}
        </button>
        <button v-if="allowDecimal" type="button" class="touch-key touch-key-muted" @click="appendChar('.')">.</button>
        <button v-else type="button" class="touch-key touch-key-muted" @click="clearDraft">C</button>
        <button type="button" class="touch-key" @click="appendChar('0')">0</button>
        <button type="button" class="touch-key touch-key-muted" :aria-label="t('Löschen')" @click="backspace">
          <Delete :size="22" />
        </button>
      </div>
    </div>
  </div>
</template>
