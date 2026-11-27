<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Flame, Thermometer } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'

const props = defineProps({
  active: Boolean,
  printerName: { type: String, default: 'DOCKYARD' },
  status: { type: Object, default: null },
  online: Boolean,
})

const emit = defineEmits(['wake'])

const now = ref(new Date())
const driftIndex = ref(0)
let clockTimer = null

const DRIFT_POSITIONS = [
  { x: 0, y: 0 },
  { x: 24, y: -12 },
  { x: -20, y: 14 },
  { x: 18, y: 16 },
  { x: -24, y: -10 },
]

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = new Date()
    if (props.active && now.value.getSeconds() === 0) {
      driftIndex.value = (driftIndex.value + 1) % DRIFT_POSITIONS.length
    }
  }, 1000)
})

onBeforeUnmount(() => {
  clearInterval(clockTimer)
})

const timeLabel = computed(() =>
  now.value.toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' }),
)

const dateLabel = computed(() =>
  now.value.toLocaleDateString(locale.value, { weekday: 'short', day: '2-digit', month: 'short' }),
)

const activeTool = computed(() => {
  const idx = Number.isInteger(props.status?.active) && props.status.active >= 0 ? props.status.active : 0
  return props.status?.tools?.[idx] ?? props.status?.tools?.[0] ?? null
})

const driftTransform = computed(() => {
  const pos = DRIFT_POSITIONS[driftIndex.value]
  return { transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }
})

// First-Tap-Wake-Guard: consume pointerdown/click strictly so waking NEVER presses a button underneath.
function handleWake(event) {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  emit('wake')
}
</script>

<template>
  <div
    v-if="active"
    class="touch-screensaver"
    role="button"
    tabindex="0"
    :aria-label="t('Tippen zum Aufwecken')"
    @pointerdown.prevent.stop="handleWake"
    @click.prevent.stop="handleWake"
    @keydown.enter.prevent="handleWake"
    @keydown.space.prevent="handleWake"
  >
    <div class="touch-screensaver-inner" :style="driftTransform">
      <div class="touch-screensaver-brand">
        <span class="touch-accent-dot" aria-hidden="true" />
        <span>{{ printerName }}</span>
      </div>
      <div class="touch-screensaver-clock">{{ timeLabel }}</div>
      <div class="touch-screensaver-date">{{ dateLabel }}</div>

      <div v-if="online && status" class="touch-screensaver-temps">
        <span v-if="activeTool">
          <Flame :size="16" />
          {{ activeTool.temperature != null ? `${Math.round(activeTool.temperature)}°C` : '—' }}
        </span>
        <span v-if="status.bed">
          <Thermometer :size="16" />
          {{ status.bed.temperature != null ? `${Math.round(status.bed.temperature)}°C` : '—' }}
        </span>
      </div>

      <p class="touch-screensaver-hint">{{ t('Tippen zum Aufwecken') }}</p>
    </div>
  </div>
</template>
