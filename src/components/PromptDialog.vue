<script setup>
import { ref, watch } from 'vue'
import { MessageSquare, X } from '@lucide/vue'
import { t } from '../i18n.mjs'

const props = defineProps({
  prompt: { type: Object, default: null },
  busy: Boolean,
})

const emit = defineEmits(['action', 'dismiss'])

const dialogEl = ref(null)

watch(
  () => props.prompt?.open,
  isOpen => {
    if (isOpen) {
      if (!dialogEl.value?.open) dialogEl.value?.showModal()
    } else if (dialogEl.value?.open) {
      dialogEl.value.close()
    }
  },
  { flush: 'post', immediate: true },
)

function buttonClass(style) {
  if (style === 'primary') return 'primary-control'
  if (style === 'error') return 'danger-button'
  if (style === 'warning') return 'confirm-button'
  return 'subtle-button'
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="klipper-prompt-dialog"
    :aria-label="prompt?.title || t('Klipper-Dialog')"
    @cancel.prevent="emit('dismiss')"
  >
    <template v-if="prompt?.open">
      <header class="klipper-prompt-head">
        <div class="klipper-prompt-title">
          <MessageSquare :size="16" />
          <h2>{{ prompt.title || 'Klipper' }}</h2>
        </div>
        <button
          type="button"
          class="icon-button"
          :disabled="busy"
          :aria-label="t('Schließen')"
          @click="emit('dismiss')"
        >
          <X :size="16" />
        </button>
      </header>

      <div class="klipper-prompt-body">
        <template v-for="(item, idx) in prompt.items" :key="idx">
          <p v-if="item.kind === 'text'" class="klipper-prompt-text">{{ item.text }}</p>
          <div v-else-if="item.kind === 'group'" class="klipper-prompt-group">
            <button
              v-for="(btn, bIdx) in item.buttons"
              :key="`${idx}-${bIdx}`"
              type="button"
              :class="buttonClass(btn.style)"
              :disabled="busy"
              @click="emit('action', btn.gcode)"
            >
              {{ btn.label }}
            </button>
          </div>
          <button
            v-else-if="item.kind === 'button'"
            type="button"
            class="klipper-prompt-full-btn"
            :class="buttonClass(item.style)"
            :disabled="busy"
            @click="emit('action', item.gcode)"
          >
            {{ item.label }}
          </button>
        </template>
      </div>

      <footer v-if="prompt.footerButtons?.length" class="klipper-prompt-foot">
        <button
          v-for="(btn, fIdx) in prompt.footerButtons"
          :key="fIdx"
          type="button"
          :class="buttonClass(btn.style)"
          :disabled="busy"
          @click="emit('action', btn.gcode)"
        >
          {{ btn.label }}
        </button>
      </footer>
    </template>
  </dialog>
</template>
