<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Send, RefreshCw, ArrowDown, ChevronUp, ChevronDown } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { useConsole } from '../useConsole.js'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  compact: Boolean,
})

const emit = defineEmits(['open'])

const { entries, loaded, loading, error, history, refresh, abort, recordCommand } = useConsole()

const collapsed = ref(false)
const input = ref('')
const log = ref(null)
const field = ref(null)
const following = ref(true)
const historyIndex = ref(history.value.length)

let draft = ''
let fallbackTimer = null

const enabled = computed(
  () => props.online && props.status?.klipperState === 'ready' && !props.pending && !props.status?.control?.job,
)
const visibleEntries = computed(() => (props.compact ? entries.value.slice(-50) : entries.value))
const time = value => new Date(value * 1000).toLocaleTimeString(locale.value)

async function scrollToLatest() {
  await nextTick()
  if (following.value && log.value) {
    log.value.scrollTop = log.value.scrollHeight
  }
}

watch(() => entries.value.length, scrollToLatest)
watch(history, list => {
  historyIndex.value = list.length
})

async function submit() {
  const script = input.value.trim()
  if (!enabled.value || !script) return
  recordCommand(script)
  historyIndex.value = history.value.length
  draft = ''
  input.value = ''
  following.value = true
  await props.send({ action: 'console', script })
  if (props.status?.transport !== 'live') await refresh()
  field.value?.focus()
}

function recall(direction) {
  const list = history.value
  if (!list.length) return
  if (historyIndex.value === list.length) draft = input.value
  historyIndex.value = Math.max(0, Math.min(list.length, historyIndex.value + direction))
  input.value = historyIndex.value === list.length ? draft : list[historyIndex.value]
}

function fill(command) {
  input.value = command
  field.value?.focus()
}

function onScroll() {
  if (log.value) {
    following.value = log.value.scrollHeight - log.value.scrollTop - log.value.clientHeight < 45
  }
}

function latest() {
  following.value = true
  if (log.value) log.value.scrollTop = log.value.scrollHeight
}

function onVisibility() {
  if (document.hidden) abort()
  else if (!loaded.value || props.status?.transport !== 'live') refresh()
}

onMounted(() => {
  if (!loaded.value) refresh()
  else scrollToLatest()

  // Live SSE delivers notify_gcode_response immediately; only poll as fallback when not live.
  fallbackTimer = setInterval(() => {
    if (!document.hidden && props.online && props.status?.transport !== 'live') refresh()
  }, 5000)

  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  clearInterval(fallbackTimer)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <section
    class="console-panel"
    :class="{ compact, collapsed: compact && collapsed }"
    :aria-label="t('Klipper-Konsole')"
  >
    <div class="console-toolbar">
      <h2>{{ compact ? t('Letzte Meldungen') : t('Ausgabe') }}</h2>
      <span>{{ compact ? t('Letzte 50 Einträge') : t('Letzte 200 Einträge') }}</span>
      <button v-if="compact" class="subtle-button console-open" type="button" @click="emit('open')">
        {{ t('Konsole öffnen') }}
      </button>
      <button
        class="icon-button"
        type="button"
        :disabled="loading"
        :aria-label="t('Konsolenausgabe aktualisieren')"
        @click="refresh"
      >
        <RefreshCw :size="17" />
      </button>
      <button
        v-if="compact"
        class="icon-button console-toggle"
        type="button"
        :aria-expanded="!collapsed"
        aria-controls="compact-console-log"
        :aria-label="collapsed ? t('Konsole ausklappen') : t('Konsole einklappen')"
        :title="collapsed ? t('Konsole ausklappen') : t('Konsole einklappen')"
        @click="collapsed = !collapsed"
      >
        <ChevronDown v-if="collapsed" :size="17" />
        <ChevronUp v-else :size="17" />
      </button>
    </div>

    <p v-if="error && (!compact || !collapsed)" class="console-problem" role="status">
      {{ t(error) }}
    </p>

    <div
      v-show="!compact || !collapsed"
      :id="compact ? 'compact-console-log' : undefined"
      ref="log"
      class="console-log"
      :aria-label="t('Befehle und Antworten')"
      tabindex="0"
      @scroll="onScroll"
    >
      <p v-if="!entries.length" class="console-empty">
        {{ !loaded && !error ? t('Konsolenausgabe wird geladen …') : t('Noch keine Konsoleneinträge vorhanden.') }}
      </p>
      <div
        v-for="(entry, index) in visibleEntries"
        :key="`${entry.time}-${index}`"
        :class="['console-line', { command: entry.type === 'command', 'console-error': /^(!!|error:)/i.test(entry.message) }]"
      >
        <time>{{ time(entry.time) }}</time>
        <pre>{{ entry.type === 'command' ? '> ' : '' }}{{ entry.message }}</pre>
      </div>
    </div>

    <button
      v-if="compact && !collapsed"
      class="console-handle"
      type="button"
      :aria-label="t('Konsole einklappen')"
      aria-controls="compact-console-log"
      aria-expanded="true"
      :title="t('Konsole einklappen')"
      @click="collapsed = true"
    >
      <ChevronUp :size="16" />
    </button>

    <form v-show="!compact || !collapsed" class="console-form" @submit.prevent="submit">
      <label :for="compact ? 'compact-console-command' : 'console-command'">{{ t('G-Code oder Makro') }}</label>
      <div class="console-entry">
        <input
          :id="compact ? 'compact-console-command' : 'console-command'"
          ref="field"
          v-model="input"
          maxlength="500"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :placeholder="t('z. B. DEBUG_TOOL_DETECTION')"
          @keydown.up.prevent="recall(-1)"
          @keydown.down.prevent="recall(1)"
        />
        <button class="primary-control" :disabled="!enabled || !input.trim()">
          <Send :size="16" />{{ pending ? t('Läuft …') : t('Senden') }}
        </button>
      </div>
      <p class="console-hint">
        {{ t('Befehle gehen direkt an Klipper und können den Drucker bewegen. ↑ / ↓ ruft deine letzten Eingaben auf.') }}
        {{
          !online
            ? t('Senden gesperrt: keine aktuellen Druckerdaten.')
            : status?.klipperState !== 'ready'
              ? t('Senden gesperrt: Klipper ist nicht bereit.')
              : status?.control?.job
                ? t('Ein Befehl läuft oder sein Ergebnis muss geprüft werden.')
                : ''
        }}
      </p>
    </form>

    <div v-if="!compact" class="console-quick">
      <span>{{ t('Einfügen:') }}</span>
      <button class="subtle-button" type="button" @click="fill('DEBUG_TOOL_DETECTION')">
        {{ t('Tool-Erkennung') }}
      </button>
      <button class="subtle-button" type="button" @click="fill('STATUS')">Status</button>
      <button v-if="!following" class="subtle-button" type="button" @click="latest">
        <ArrowDown :size="14" />{{ t('Neueste Ausgabe') }}
      </button>
    </div>
  </section>
</template>
