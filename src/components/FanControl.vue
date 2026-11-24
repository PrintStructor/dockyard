<script setup>
import { computed, ref, watch } from 'vue'
import { Fan, Check, Power } from '@lucide/vue'
import { t } from '../i18n.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
})

const fan = ref('')
const draft = ref(null)

const fans = computed(() => props.status?.capabilities?.fans ?? [])
const fanOptions = computed(() => fans.value.map(item => ({ value: item.name, label: t(item.label) })))

watch(
  fans,
  list => {
    if (!list.some(item => item.name === fan.value)) fan.value = list[0]?.name ?? ''
  },
  { immediate: true },
)
watch(fan, () => {
  draft.value = null
})

const actual = computed(() => props.status?.fans?.find(item => item.name === fan.value)?.percent ?? null)
const value = computed(() => draft.value ?? actual.value)
const enabled = computed(
  () =>
    props.online &&
    props.status?.klipperState === 'ready' &&
    !props.pending &&
    !props.status?.control?.job &&
    !!fan.value,
)
const valid = computed(() => Number.isInteger(value.value) && value.value >= 0 && value.value <= 100)

async function apply(percent) {
  if (!enabled.value || !Number.isInteger(percent)) return
  const name = fan.value
  const prior = draft.value
  if ((await props.send({ action: 'fan', fan: name, percent })) && fan.value === name && draft.value === prior) {
    draft.value = null
  }
}
</script>

<template>
  <article class="control-panel fan-panel">
    <div class="fan-heading">
      <h2><Fan :size="18" />{{ t('Lüfter') }}</h2>
      <span>{{ online && actual != null ? `${actual} %` : '—' }}</span>
    </div>
    <template v-if="fans.length">
      <CockpitSelect
        v-model="fan"
        :options="fanOptions"
        :aria-label="t('Lüfter auswählen')"
        size="compact"
      />
      <form @submit.prevent="apply(value)">
        <div class="fan-setting">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            :value="value ?? 0"
            :disabled="!enabled"
            :aria-label="t('Gewünschte Lüfterleistung')"
            @input="draft = Number($event.target.value)"
          />
          <output>{{ value == null ? '—' : `${value} %` }}</output>
        </div>
        <div class="fan-actions">
          <button type="button" class="subtle-button" :disabled="!enabled" @click="apply(0)">
            <Power :size="14" />{{ t('Aus') }}
          </button>
          <button class="subtle-button" :disabled="!enabled || !valid || value === actual">
            <Check :size="14" />{{ t('Setzen') }}
          </button>
        </div>
      </form>
      <p v-if="fan.toLowerCase() === 'bedfans'" class="fan-empty">
        {{ t('Die Bettregelung kann den Wert automatisch ändern.') }}
      </p>
    </template>
    <p v-else class="fan-empty">{{ t('Keine manuell regelbaren Lüfter verfügbar.') }}</p>
  </article>
</template>
