import { ref } from 'vue'

export const historyStorageKey = 'stormtrooper.consoleHistory'
const MAX_ENTRIES = 200
const MAX_HISTORY = 50

function readStoredHistory() {
  try {
    const raw = globalThis.localStorage?.getItem(historyStorageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(item => typeof item === 'string' && item.trim()).slice(-MAX_HISTORY)
      : []
  } catch {
    return []
  }
}

function writeStoredHistory(items) {
  try {
    globalThis.localStorage?.setItem(historyStorageKey, JSON.stringify(items.slice(-MAX_HISTORY)))
  } catch {
    // History remains in memory when storage is unavailable.
  }
}

const entries = ref([])
const loaded = ref(false)
const loading = ref(false)
const error = ref('')
const history = ref(readStoredHistory())
let activeRequest = null

export function pushConsoleEntry(entry) {
  if (!entry || typeof entry.message !== 'string' || !entry.message) return
  const normalized = {
    time: Number.isFinite(entry.time) ? entry.time : Date.now() / 1000,
    type: entry.type === 'command' ? 'command' : 'response',
    message: entry.message,
  }
  const previous = entries.value.at(-1)
  // Avoid duplicating an optimistic command if Moonraker immediately echoes it.
  if (
    previous &&
    previous.type === normalized.type &&
    previous.message === normalized.message &&
    Math.abs(previous.time - normalized.time) < 1.5
  ) {
    return
  }
  const next = [...entries.value, normalized]
  entries.value = next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
  loaded.value = true
  error.value = ''
}

export async function refreshConsole() {
  if ((typeof document !== 'undefined' && document.hidden) || loading.value) return
  loading.value = true
  activeRequest = new AbortController()
  try {
    const response = await fetch('/api/console', {
      signal: AbortSignal.any([activeRequest.signal, AbortSignal.timeout(7000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    if (!Array.isArray(data.entries)) throw new Error('Ungültige Konsolenausgabe.')
    entries.value = data.entries.slice(-MAX_ENTRIES)
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      error.value = 'Konsolenausgabe nicht erreichbar. Letzter Verlauf bleibt sichtbar.'
    }
  } finally {
    loading.value = false
    activeRequest = null
  }
}

export function abortConsoleRefresh() {
  activeRequest?.abort()
}

export function recordConsoleCommand(script) {
  const trimmed = script.trim()
  if (!trimmed) return
  if (history.value.at(-1) !== trimmed) {
    const next = [...history.value, trimmed].slice(-MAX_HISTORY)
    history.value = next
    writeStoredHistory(next)
  }
}

export function useConsole() {
  return {
    entries,
    loaded,
    loading,
    error,
    history,
    refresh: refreshConsole,
    abort: abortConsoleRefresh,
    pushEntry: pushConsoleEntry,
    recordCommand: recordConsoleCommand,
  }
}
