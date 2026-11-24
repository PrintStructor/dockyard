<script setup>
import { computed } from 'vue'
import { t } from '../i18n.mjs'
import { toolActionReason, defaultActionTemperature } from '../tool-action-state.mjs'

const props = defineProps({
  tool: Number,
  status: Object,
  online: Boolean,
  pending: Boolean,
})

const emit = defineEmits(['command'])

const actions = computed(() => [
  {
    id: props.status?.active === props.tool ? 'park' : 'pickup',
    label: props.status?.active === props.tool ? 'Parken' : 'Pickup',
  },
  { id: 'load', label: 'Laden' },
  { id: 'unload', label: 'Entladen' },
  { id: 'clean', label: 'Clean' },
  { id: 'purge', label: 'Purge' },
])

const reason = action => toolActionReason(props.status, action, props.tool, props.online, props.pending)

function description(action) {
  const blocked = reason(action)
  if (blocked) return blocked
  const base = {
    park: 'Am Dock ablegen',
    pickup: 'Mit leerem Schlitten aufnehmen',
    load: `Einziehen und purgen bei ${defaultActionTemperature(props.status, action)} °C, wischen, Heizung aus`,
    unload: `Entladen bei ${defaultActionTemperature(props.status, action)} °C, Heizung aus`,
    clean: 'Nozzle Clean am Silikonwiper',
    purge: `Bei ${defaultActionTemperature(props.status, action)} °C purgen, wischen, Heizung aus`,
  }[action]
  const switchesTool =
    ['load', 'unload', 'clean', 'purge'].includes(action) && props.status?.active !== props.tool
  return switchesTool ? `${base} · wechselt zu diesem Tool` : base
}

function run(action) {
  if (reason(action)) return
  emit('command', { action, tool: props.tool })
}
</script>

<template>
  <div class="tool-actions" :aria-label="t('Aktionen für T{0}', [tool])">
    <button
      v-for="action in actions"
      :key="action.id"
      type="button"
      :class="{ 'tool-mount-action': ['park', 'pickup'].includes(action.id) }"
      :disabled="!!reason(action.id)"
      :title="t(description(action.id))"
      :aria-label="t('T{0}: {1}. {2}', [tool, action.label, description(action.id)])"
      @click="run(action.id)"
    >
      {{ t(action.label) }}
    </button>
  </div>
</template>
