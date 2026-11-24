<script setup>
import { computed, reactive, watch } from 'vue'
import { Fan, Check, Power } from '@lucide/vue'
import { t } from '../i18n.mjs'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
})

const drafts = reactive({})
const fans = computed(() => props.status?.capabilities?.fans ?? [])

watch(
  fans,
  list => {
    const names = new Set(list.map(item => item.name))
    for (const key of Object.keys(drafts)) {
      if (!names.has(key)) delete drafts[key]
    }
  },
  { immediate: true },
)

const actualFor = name => props.status?.fans?.find(item => item.name === name)?.percent ?? null
const valueFor = name => (drafts[name] != null ? drafts[name] : actualFor(name))
const validFor = name => {
  const val = valueFor(name)
  return Number.isInteger(val) && val >= 0 && val <= 100
}

const enabled = computed(
  () =>
    props.online &&
    props.status?.klipperState === 'ready' &&
    !props.pending &&
    !props.status?.control?.job,
)

async function apply(name, percent) {
  if (!enabled.value || !Number.isInteger(percent)) return
  const prior = drafts[name]
  if ((await props.send({ action: 'fan', fan: name, percent })) && drafts[name] === prior) {
    delete drafts[name]
  }
}
</script>

<template>
  <article class="control-panel fan-panel">
    <div class="fan-heading">
      <h2><Fan :size="18" />{{ t('Lüfter') }}</h2>
    </div>
    <div v-if="fans.length" class="fan-list">
      <form
        v-for="item in fans"
        :key="item.name"
        class="fan-item"
        @submit.prevent="apply(item.name, valueFor(item.name))"
      >
        <div class="fan-item-head">
          <strong>{{ t(item.label) }}</strong>
          <span>{{ online && actualFor(item.name) != null ? `${actualFor(item.name)} %` : '—' }}</span>
        </div>
        <div class="fan-setting">
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            :value="valueFor(item.name) ?? 0"
            :disabled="!enabled"
            :aria-label="t('Gewünschte Lüfterleistung für {0}', [t(item.label)])"
            @input="drafts[item.name] = Number($event.target.value)"
          />
          <output>{{ valueFor(item.name) == null ? '—' : `${valueFor(item.name)} %` }}</output>
        </div>
        <div class="fan-actions">
          <button type="button" class="subtle-button" :disabled="!enabled" @click="apply(item.name, 0)">
            <Power :size="14" />{{ t('Aus') }}
          </button>
          <button
            class="subtle-button"
            :disabled="!enabled || !validFor(item.name) || valueFor(item.name) === actualFor(item.name)"
          >
            <Check :size="14" />{{ t('Setzen') }}
          </button>
        </div>
        <p v-if="item.name.toLowerCase() === 'bedfans'" class="fan-empty">
          {{ t('Die Bettregelung kann den Wert automatisch ändern.') }}
        </p>
      </form>
    </div>
    <p v-else class="fan-empty">{{ t('Keine manuell regelbaren Lüfter verfügbar.') }}</p>
  </article>
</template>
