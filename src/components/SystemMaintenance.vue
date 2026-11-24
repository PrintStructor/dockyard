<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  printLocked: Boolean,
  moonrakerOnline: Boolean,
})

const emit = defineEmits(['moonraker-status'])

const updates = ref(null)
const loadingUpdates = ref(false)
const refreshingUpdates = ref(false)
const updatesError = ref('')

const logs = ref([])
const loadingLogs = ref(false)
const logsError = ref('')
const selectedLog = ref('')
const logTail = ref(null)
const loadingTail = ref(false)
const tailError = ref('')
const logFilter = ref('')
const errorsOnly = ref(false)
const logViewerEl = ref(null)

let activeController = null

onBeforeUnmount(() => {
  activeController?.abort()
})

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

async function fetchUpdates() {
  loadingUpdates.value = true
  updatesError.value = ''
  try {
    const response = await fetch('/api/system/updates', { signal: AbortSignal.timeout(9000) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Update-Status nicht erreichbar.')
    updates.value = data
    emit('moonraker-status', true)
  } catch (cause) {
    updatesError.value = cause.message || 'Update-Status nicht erreichbar.'
    emit('moonraker-status', false)
  } finally {
    loadingUpdates.value = false
  }
}

async function refreshUpdates() {
  if (refreshingUpdates.value || props.printLocked || !props.moonrakerOnline) return
  refreshingUpdates.value = true
  updatesError.value = ''
  try {
    const response = await fetch('/api/system/updates/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: '{}',
      signal: AbortSignal.timeout(35_000),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Update-Prüfung fehlgeschlagen.')
    updates.value = data
  } catch (cause) {
    updatesError.value = cause.message || 'Update-Prüfung fehlgeschlagen.'
  } finally {
    refreshingUpdates.value = false
  }
}

async function fetchLogsList() {
  loadingLogs.value = true
  logsError.value = ''
  try {
    const response = await fetch('/api/system/logs/list', { signal: AbortSignal.timeout(8000) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Logdateien nicht erreichbar.')
    logs.value = Array.isArray(data.logs) ? data.logs : []
    emit('moonraker-status', true)
    if (!selectedLog.value && logs.value.length) {
      const preferred = logs.value.find(item => item.path === 'klippy.log') ?? logs.value[0]
      await selectLog(preferred.path)
    }
  } catch (cause) {
    logsError.value = cause.message || 'Logdateien nicht erreichbar.'
  } finally {
    loadingLogs.value = false
  }
}

async function selectLog(path) {
  if (!path) return
  selectedLog.value = path
  await loadLogTail()
}

async function loadLogTail() {
  if (!selectedLog.value) return
  activeController?.abort()
  activeController = new AbortController()
  loadingTail.value = true
  tailError.value = ''
  try {
    const response = await fetch(`/api/system/logs/tail?path=${encodeURIComponent(selectedLog.value)}`, {
      signal: AbortSignal.any([activeController.signal, AbortSignal.timeout(10_000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Logdatei konnte nicht geladen werden.')
    logTail.value = data
    await nextTick()
    scrollToBottom()
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      tailError.value = cause.message || 'Logdatei konnte nicht geladen werden.'
    }
  } finally {
    loadingTail.value = false
  }
}

function scrollToBottom() {
  if (logViewerEl.value) {
    logViewerEl.value.scrollTop = logViewerEl.value.scrollHeight
  }
}

const primaryLogs = computed(() => logs.value.filter(item => item.primary))
const allLogOptions = computed(() =>
  logs.value.map(item => ({
    value: item.path,
    label: `${item.name} (${formatBytes(item.size)})`,
  })),
)

const downloadHref = computed(() =>
  selectedLog.value ? `/api/system/logs/download?path=${encodeURIComponent(selectedLog.value)}` : '',
)

function lineSeverity(line) {
  if (/\b(ERROR|CRITICAL|FATAL|Shutdown|Traceback|Exception|MCU .* shutdown)\b/i.test(line)) return 'is-error'
  if (/\b(WARN|WARNING)\b/i.test(line)) return 'is-warn'
  return ''
}

const filteredLogLines = computed(() => {
  const lines = logTail.value?.lines ?? []
  const q = logFilter.value.trim().toLowerCase()
  const result = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const severity = lineSeverity(text)
    if (errorsOnly.value && !severity) continue
    if (q && !text.toLowerCase().includes(q)) continue
    result.push({ index: i + 1, text, severity })
  }
  return result
})

function updateStatusLabel(status) {
  return (
    {
      dirty: 'Lokal geändert',
      invalid: 'Abweichend',
      outdated: 'Update verfügbar',
      up_to_date: 'Aktuell',
    }[status] ?? status
  )
}

function updateBadgeClass(status) {
  if (status === 'dirty' || status === 'invalid') return 'amber'
  if (status === 'outdated') return 'lime'
  return 'muted'
}

onMounted(() => {
  fetchUpdates()
  fetchLogsList()
})
</script>

<template>
  <div class="maint-stack">
    <section class="system-panel" :aria-label="t('Software & Updates')">
      <div class="system-panel-head">
        <div>
          <h2>{{ t('Software & Updates') }}</h2>
          <p v-if="updates">
            {{
              t('{0} Komponenten · {1} Updates verfügbar · {2} lokal geändert', [
                updates.summary.total,
                updates.summary.outdated,
                updates.summary.dirty,
              ])
            }}
          </p>
          <p v-else>{{ t('Moonraker Update-Manager · reine Übersicht ohne automatische Überschreibung.') }}</p>
        </div>
        <button
          type="button"
          class="subtle-button"
          :disabled="refreshingUpdates || loadingUpdates || updates?.busy || printLocked || !moonrakerOnline"
          :title="printLocked ? t('Während eines Drucks gesperrt.') : t('Update-Status bei Moonraker neu prüfen')"
          @click="refreshUpdates"
        >
          <RefreshCw :size="14" :class="{ spinning: refreshingUpdates || loadingUpdates || updates?.busy }" />
          {{ refreshingUpdates ? t('Prüfe …') : t('Status prüfen') }}
        </button>
      </div>

      <div v-if="updates?.summary?.dirty > 0" class="system-banner amber" style="margin-bottom: 14px" role="status">
        <ShieldAlert :size="16" />
        <span>
          {{
            t(
              'Mindestens ein Repository enthält lokale Anpassungen (Lokal geändert). Bitte nicht blind über Mainsail aktualisieren, sonst werden eigene Patches überschrieben.',
            )
          }}
        </span>
      </div>

      <div v-if="updatesError" class="system-banner amber" style="margin-bottom: 14px" role="alert">
        <AlertTriangle :size="15" />
        <span>{{ t(updatesError) }}</span>
      </div>

      <div v-if="loadingUpdates && !updates" class="skeleton-block">
        <span class="skeleton-bar" />
        <span class="skeleton-bar" />
        <span class="skeleton-bar sm" />
        <span class="skeleton-bar" />
      </div>

      <div v-else-if="updates?.items?.length" class="update-table-wrap">
        <table class="update-table">
          <thead>
            <tr>
              <th>{{ t('Komponente') }}</th>
              <th>{{ t('Installiert') }}</th>
              <th>{{ t('Verfügbar') }}</th>
              <th>{{ t('Status') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in updates.items" :key="item.name" :class="{ 'is-dirty': item.isDirty }">
              <td>
                <div class="update-name">
                  <strong>{{ item.name }}</strong>
                  <small>{{ item.type }}<template v-if="item.branch"> · {{ item.branch }}</template></small>
                </div>
                <p v-if="item.isDirty && item.warnings.length" class="update-notes">
                  {{ item.warnings[0] }}
                </p>
                <p v-else-if="item.status === 'invalid' && (item.warnings.length || item.anomalies.length)" class="update-notes">
                  {{ item.warnings[0] || item.anomalies[0] }}
                </p>
                <details
                  v-else-if="item.anomalies.length || item.warnings.length"
                  class="update-anomalies"
                >
                  <summary>
                    <ChevronRight :size="12" />{{ t('Hinweise ({0})', [item.warnings.length + item.anomalies.length]) }}
                  </summary>
                  <ul>
                    <li v-for="(note, idx) in [...item.warnings, ...item.anomalies]" :key="idx">{{ note }}</li>
                  </ul>
                </details>
              </td>
              <td class="update-version">
                <template v-if="item.type === 'system'">
                  {{ t('Systempakete') }}
                </template>
                <template v-else>{{ item.version ?? '—' }}</template>
              </td>
              <td class="update-version" :class="{ 'update-version-diff': item.status === 'outdated' }">
                <template v-if="item.type === 'system'">
                  {{ item.packageCount > 0 ? t('{0} Pakete', [item.packageCount]) : t('Aktuell') }}
                </template>
                <template v-else>{{ item.remoteVersion ?? '—' }}</template>
              </td>
              <td>
                <span class="status-pill" :class="updateBadgeClass(item.status)">
                  <AlertTriangle v-if="item.status === 'dirty' || item.status === 'invalid'" :size="11" />
                  <Check v-else-if="item.status === 'up_to_date'" :size="11" />
                  {{ t(updateStatusLabel(item.status)) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="system-panel" :aria-label="t('Log-Viewer')">
      <div class="system-panel-head">
        <div>
          <h2>{{ t('Log-Viewer') }}</h2>
          <p>{{ t('Schnelle Tail-Ansicht der letzten 400 Zeilen — vollständige Logs direkt als Download.') }}</p>
        </div>
        <div class="confirm-inline">
          <button
            type="button"
            class="subtle-button"
            :disabled="loadingTail || !selectedLog"
            @click="loadLogTail"
          >
            <RefreshCw :size="14" :class="{ spinning: loadingTail }" />{{ t('Aktualisieren') }}
          </button>
          <button type="button" class="subtle-button" :disabled="!filteredLogLines.length" @click="scrollToBottom">
            <ArrowDown :size="14" />{{ t('Nach unten') }}
          </button>
          <a
            v-if="downloadHref"
            class="subtle-button"
            :href="downloadHref"
            :download="selectedLog"
          >
            <Download :size="14" />{{ t('Vollständig laden') }}
          </a>
        </div>
      </div>

      <div class="log-controls" style="margin-bottom: 12px">
        <div v-if="primaryLogs.length" class="segmented" role="group" :aria-label="t('Haupt-Logs')">
          <button
            v-for="item in primaryLogs"
            :key="item.path"
            type="button"
            :aria-pressed="selectedLog === item.path"
            @click="selectLog(item.path)"
          >
            {{ item.name }}
          </button>
        </div>

        <div v-if="allLogOptions.length" class="log-rotated-select">
          <CockpitSelect
            :model-value="selectedLog"
            :options="allLogOptions"
            :aria-label="t('Alle Logdateien')"
            size="compact"
            @update:model-value="selectLog"
          />
        </div>

        <div class="log-filter-input">
          <Search :size="14" />
          <input
            v-model="logFilter"
            type="search"
            :placeholder="t('Im Auszug suchen …')"
            :aria-label="t('Im Log-Auszug suchen')"
          />
          <button
            v-if="logFilter"
            type="button"
            class="history-search-clear"
            :aria-label="t('Filter leeren')"
            @click="logFilter = ''"
          >
            <X :size="13" />
          </button>
        </div>

        <label class="config-tree-toggle" style="cursor: pointer">
          <input v-model="errorsOnly" type="checkbox" />
          <span>{{ t('Nur Fehler/Warnungen') }}</span>
        </label>
      </div>

      <div v-if="logsError || tailError" class="system-banner amber" style="margin-bottom: 12px" role="alert">
        <AlertTriangle :size="15" />
        <span>{{ t(logsError || tailError) }}</span>
      </div>

      <div v-if="logTail && selectedLog" class="log-meta-bar" style="margin-bottom: 8px">
        <span>
          <template v-if="logTail.empty">{{ selectedLog }} · {{ t('Logdatei ist leer.') }}</template>
          <template v-else-if="logTail.truncated">
            {{
              t('{0} · Letzte {1} Zeilen ({2} von {3})', [
                selectedLog,
                logTail.lineCount.toLocaleString(locale),
                formatBytes(logTail.fetchedBytes),
                formatBytes(logTail.totalBytes),
              ])
            }}
          </template>
          <template v-else>
            {{
              t('{0} · {1} Zeilen ({2})', [
                selectedLog,
                logTail.lineCount.toLocaleString(locale),
                formatBytes(logTail.totalBytes),
              ])
            }}
          </template>
        </span>
        <span v-if="logFilter || errorsOnly">
          {{ t('{0} Treffer sichtbar', [filteredLogLines.length]) }}
        </span>
      </div>

      <div v-if="(loadingLogs || loadingTail) && !logTail" class="log-viewer">
        <div class="skeleton-block">
          <span class="skeleton-bar" />
          <span class="skeleton-bar sm" />
          <span class="skeleton-bar" />
          <span class="skeleton-bar" />
          <span class="skeleton-bar sm" />
        </div>
      </div>

      <div v-else ref="logViewerEl" class="log-viewer">
        <div v-if="!logTail || logTail.empty" class="log-empty">{{ t('Logdatei ist leer.') }}</div>
        <div v-else-if="!filteredLogLines.length" class="log-empty">
          {{ t('Keine Zeilen passen zum aktuellen Filter.') }}
        </div>
        <template v-else>
          <div v-for="row in filteredLogLines" :key="row.index" class="log-line" :class="row.severity">
            <span class="log-line-num">{{ row.index }}</span>
            <pre class="log-line-text">{{ row.text }}</pre>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
