<script setup>
import { computed, ref, watch } from 'vue'
import { Lightbulb, RotateCw } from '@lucide/vue'
import { t } from '../i18n.mjs'
import { ledProfiles, auxActionReason } from '../aux-action-state.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
})

const emit = defineEmits(['command'])

const extra = ref('')
const reason = action => auxActionReason(props.status, action, props.online, props.pending)
const available = id => props.status?.capabilities?.ledProfiles?.includes(id)
const main = computed(() => ledProfiles.slice(0, 5).filter(profile => available(profile.id)))
const others = computed(() => ledProfiles.slice(5).filter(profile => available(profile.id)))
const otherOptions = computed(() => others.value.map(profile => ({ value: profile.id, label: profile.label })))

watch(
  others,
  list => {
    if (!list.some(profile => profile.id === extra.value)) {
      extra.value = list[0]?.id ?? ''
    }
  },
  { immediate: true },
)

function led(profile) {
  if (!reason('led') && available(profile)) emit('command', { action: 'led', profile })
}

function initialize() {
  if (!reason('initialize')) emit('command', { action: 'initialize' })
}
</script>

<template>
  <section class="led-controls" :aria-label="t('LED-Befehle')">
    <h3><Lightbulb :size="16" />LED Control</h3>
    <div class="led-actions">
      <button
        v-for="profile in main"
        :key="profile.id"
        class="subtle-button"
        type="button"
        :disabled="!!reason('led')"
        :title="reason('led') ? t(reason('led')) : profile.macro"
        @click="led(profile.id)"
      >
        {{ profile.label }}
      </button>
    </div>
    <form v-if="others.length" class="led-more" @submit.prevent="led(extra)">
      <CockpitSelect
        v-model="extra"
        :options="otherOptions"
        :aria-label="t('Weiterer LED-Status')"
        size="compact"
      />
      <button class="subtle-button" :disabled="!!reason('led') || !available(extra)">
        {{ t('Setzen') }}
      </button>
    </form>
    <p>{{ t('LED-Status für Tools und Drucker.') }}</p>
  </section>

  <section class="initialize-control" :aria-label="t('Toolchanger initialisieren')">
    <button
      class="subtle-button"
      type="button"
      :disabled="!!reason('initialize')"
      :title="
        reason('initialize')
          ? t(reason('initialize'))
          : t('Homet bei Bedarf X/Y und fährt zur Bettmitte')
      "
      @click="initialize"
    >
      <RotateCw :size="15" />{{ t('Toolchanger initialisieren') }}
    </button>
    <p>{{ t('Homet bei Bedarf X/Y und fährt zur Bettmitte.') }}</p>
  </section>
</template>
