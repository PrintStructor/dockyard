<script setup>
import { computed } from 'vue'
import { t } from '../i18n.mjs'
import { toolActionReason, defaultActionTemperature } from '../tool-action-state.mjs'

const props = defineProps({
  tool: Number,
  status: Object,
  online: Boolean,
  pending: Boolean,
  mode: { type: String, default: 'all' },
})

const emit = defineEmits(['command'])

const mountAction = computed(() => {
  if (props.status?.active === props.tool) return { id: 'park', label: 'Parken' }
  if (props.status?.active != null) return { id: 'select', label: 'Wechseln' }
  return { id: 'pickup', label: 'Pickup' }
})

const maintenanceActions = [
  { id: 'load', label: 'Laden' },
  { id: 'unload', label: 'Entladen' },
  { id: 'clean', label: 'Clean' },
  { id: 'purge', label: 'Purge' },
]

const actions = computed(() => {
  if (props.mode === 'mount') return [mountAction.value]
  if (props.mode === 'maintenance') return maintenanceActions
  return [mountAction.value, ...maintenanceActions]
})

const reason = action => toolActionReason(props.status, action, props.tool, props.online, props.pending)

function description(action) {
  const blocked = reason(action)
  if (blocked) return blocked
  const temp = defaultActionTemperature(props.status, action)
  const hasTemp = Number.isFinite(temp)
  const base = {
    park: 'Am Dock ablegen',
    pickup: 'Mit leerem Schlitten aufnehmen',
    select: `T${props.status?.active} parken und T${props.tool} aufnehmen`,
    load: hasTemp
      ? `Einziehen und purgen bei ${temp} °C, wischen, Heizung aus`
      : 'Filament laden',
    unload: hasTemp
      ? `Entladen bei ${temp} °C, Heizung aus`
      : 'Filament entladen',
    clean: 'Nozzle Clean am Silikonwiper',
    purge: hasTemp
      ? `Bei ${temp} °C purgen, wischen, Heizung aus`
      : 'Purge',
  }[action]
  const switchesTool =
    Boolean(props.status?.isToolchanger) &&
    ['load', 'unload', 'clean', 'purge'].includes(action) &&
    props.status?.active !== props.tool
  return switchesTool ? `${base} · wechselt zu diesem Tool` : base
}

function run(action) {
  if (reason(action)) return
  emit('command', { action, tool: props.tool })
}
</script>

<template>
  <div
    class="tool-actions"
    :class="`tool-actions--${mode}`"
    :aria-label="t('Aktionen für T{0}', [tool])"
  >
    <button
      v-for="action in actions"
      :key="action.id"
      type="button"
      :class="{ 'tool-mount-action': ['park', 'pickup', 'select'].includes(action.id) }"
      :disabled="!!reason(action.id)"
      :title="t(description(action.id))"
      :aria-label="t('T{0}: {1}. {2}', [tool, action.label, description(action.id)])"
      @click="run(action.id)"
    >
      {{ t(action.label) }}
    </button>
  </div>
</template>
