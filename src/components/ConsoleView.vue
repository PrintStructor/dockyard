<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Send, RefreshCw, ArrowDown, ChevronUp, ChevronDown, Filter, Trash2 } from '@lucide/vue'
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

const collapsed = ref(props.compact)
const input = ref('')
const log = ref(null)
const field = ref(null)
const following = ref(true)
const historyIndex = ref(history.value.length)
const helpCommands = ref([])
const acIndex = ref(0)
const acDismissed = ref(false)
const hideTempNoise = ref(false)
const clearedAfter = ref(0)

try {
  hideTempNoise.value = localStorage.getItem('dockyard.console.hideTemp') === '1'
} catch {
  // Ignore storage errors
}

function toggleTempNoise() {
  hideTempNoise.value = !hideTempNoise.value
  try {
    localStorage.setItem('dockyard.console.hideTemp', hideTempNoise.value ? '1' : '0')
  } catch {
    // Ignore
  }
}

function clearDisplay() {
  const latestTime = entries.value.at(-1)?.time ?? Date.now() / 1000
  clearedAfter.value = latestTime + 0.0001
}

const TEMP_NOISE_RE = /^(?:ok\s+)?(?:B|T\d*):-?\d+(?:\.\d+)?\s*\/-?\d+(?:\.\d+)?/i

let draft = ''
let fallbackTimer = null

const enabled = computed(
  () => props.online && props.status?.klipperState === 'ready' && !props.pending && !props.status?.control?.job,
)
const visibleEntries = computed(() => {
  const base = entries.value.filter(entry => {
    if (clearedAfter.value && Number.isFinite(entry.time) && entry.time < clearedAfter.value) return false
    if (hideTempNoise.value && entry.type !== 'command' && TEMP_NOISE_RE.test(String(entry.message ?? '').trim())) {
      return false
    }
    return true
  })
  return props.compact ? base.slice(-50) : base
})
const time = value => new Date(value * 1000).toLocaleTimeString(locale.value)

const allSuggestions = computed(() => {
  const byName = new Map()
  for (const item of helpCommands.value) {
    byName.set(item.name.toUpperCase(), item)
  }
  for (const m of props.status?.publicMacros ?? []) {
    const key = m.name.toUpperCase()
    if (!byName.has(key)) {
      byName.set(key, { name: key, help: m.description || '' })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
})

const suggestions = computed(() => {
  if (acDismissed.value) return []
  const raw = input.value.trim()
  if (!raw || raw.includes(' ')) return []
  const q = raw.toUpperCase()
  const prefix = []
  const contains = []
  for (const cmd of allSuggestions.value) {
    const u = cmd.name.toUpperCase()
    if (u === q) continue
    if (u.startsWith(q)) prefix.push(cmd)
    else if (u.includes(q)) contains.push(cmd)
  }
  return [...prefix, ...contains].slice(0, 8)
})

watch(input, () => {
  acDismissed.value = false
  acIndex.value = 0
})

async function fetchHelp() {
  try {
    const res = await fetch('/api/console/help', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    if (Array.isArray(data?.commands)) helpCommands.value = data.commands
  } catch {
    // Optional autocomplete
  }
}

function acceptSuggestion(item) {
  if (!item) return
  input.value = `${item.name} `
  acDismissed.value = true
  field.value?.focus()
}

function onInputKeydown(event) {
  if (suggestions.value.length) {
    if (event.key === 'Tab') {
      event.preventDefault()
      acceptSuggestion(suggestions.value[acIndex.value])
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      acIndex.value = (acIndex.value + 1) % suggestions.value.length
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      acIndex.value = (acIndex.value - 1 + suggestions.value.length) % suggestions.value.length
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      acDismissed.value = true
      return
    }
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    recall(-1)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    recall(1)
  }
}

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

watch(
  () => [props.online, loaded.value],
  ([isOnline, isLoaded]) => {
    if (isOnline && !isLoaded && !document.hidden) refresh()
  },
)

onMounted(() => {
  if (!loaded.value) refresh()
  else scrollToLatest()
  fetchHelp()

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
      <button
        type="button"
        class="subtle-button console-filter-btn"
        :class="{ active: hideTempNoise }"
        :aria-pressed="hideTempNoise"
        :title="t('Temperatur-Antworten (ok T0/B) ausblenden')"
        @click="toggleTempNoise"
      >
        <Filter :size="13" />{{ t('Temp-Filter') }}
      </button>
      <button
        v-if="!compact"
        type="button"
        class="icon-button"
        :title="t('Ansicht leeren')"
        :aria-label="t('Ansicht leeren')"
        @click="clearDisplay"
      >
        <Trash2 :size="16" />
      </button>
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
      role="log"
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
        :title="entry.type === 'command' ? t('Klicken zum Übernehmen') : undefined"
        @click="entry.type === 'command' && fill(entry.message)"
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
      <div class="console-entry-wrap">
        <div v-if="suggestions.length" class="console-autocomplete" role="listbox" :aria-label="t('Befehlsvorschläge')">
          <button
            v-for="(item, idx) in suggestions"
            :key="item.name"
            type="button"
            role="option"
            class="console-ac-row"
            :class="{ active: idx === acIndex }"
            :aria-selected="idx === acIndex"
            @mousedown.prevent="acceptSuggestion(item)"
          >
            <strong>{{ item.name }}</strong>
            <small v-if="item.help">{{ item.help }}</small>
          </button>
        </div>
        <div class="console-entry">
          <input
            :id="compact ? 'compact-console-command' : 'console-command'"
            ref="field"
            v-model="input"
            maxlength="500"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :placeholder="status?.isToolchanger ? t('z. B. DEBUG_TOOL_DETECTION') : t('z. B. QUERY_ENDSTOPS')"
            @keydown="onInputKeydown"
          />
          <button class="primary-control" :disabled="!enabled || !input.trim()">
            <Send :size="16" />{{ pending ? t('Läuft …') : t('Senden') }}
          </button>
        </div>
      </div>
      <p class="console-hint">
        {{ t('Befehle gehen direkt an Klipper. Tab vervollständigt, ↑ / ↓ ruft letzte Eingaben auf.') }}
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
      <button
        v-if="status?.isToolchanger"
        class="subtle-button"
        type="button"
        @click="fill('DEBUG_TOOL_DETECTION')"
      >
        {{ t('Tool-Erkennung') }}
      </button>
      <template v-else>
        <button class="subtle-button" type="button" @click="fill('QUERY_ENDSTOPS')">
          {{ t('Endschalter') }}
        </button>
        <button class="subtle-button" type="button" @click="fill('GET_POSITION')">
          {{ t('Position') }}
        </button>
      </template>
      <button class="subtle-button" type="button" @click="fill('STATUS')">Status</button>
      <button v-if="!following" class="subtle-button" type="button" @click="latest">
        <ArrowDown :size="14" />{{ t('Neueste Ausgabe') }}
      </button>
    </div>
  </section>
</template>
