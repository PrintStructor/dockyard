<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUpCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { isConnectivityFailure } from '../system-state.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  printLocked: Boolean,
  moonrakerOnline: Boolean,
  updateEvent: { type: Object, default: null },
})

const emit = defineEmits(['moonraker-status'])

const updates = ref(null)
const loadingUpdates = ref(false)
const refreshingUpdates = ref(false)
const updatesError = ref('')

// Active update / recovery job log & inline confirmation state
const activeJob = ref(null)
const updateLogEl = ref(null)
const expandedRecovery = ref('')
const confirmKey = ref('')
const submittingAction = ref(false)
let confirmTimer = null

// Release notes / changelog dialog
const notesDialog = ref(null)
const notesTarget = ref('')
const notesData = ref(null)
const loadingNotes = ref(false)
const notesError = ref('')

// Logs state
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
  if (confirmTimer) clearTimeout(confirmTimer)
})

const isUpdateBusy = computed(
  () => Boolean(activeJob.value?.running || updates.value?.busy || submittingAction.value),
)

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(iso) {
  if (!iso) return ''
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return ''
  return dt.toLocaleDateString(locale.value, { dateStyle: 'medium' })
}

function requestConfirm(key) {
  confirmKey.value = key
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => {
    confirmKey.value = ''
  }, 7000)
}

function cancelConfirm() {
  confirmKey.value = ''
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

async function fetchUpdates() {
  loadingUpdates.value = true
  updatesError.value = ''
  try {
    const response = await fetch('/api/system/updates', { signal: AbortSignal.timeout(9000) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const err = new Error(data.error || 'Update-Status nicht erreichbar.')
      err.httpStatus = response.status
      throw err
    }
    updates.value = data
    if (data.activeJob) activeJob.value = data.activeJob
    emit('moonraker-status', true)
  } catch (cause) {
    updatesError.value = cause.message || 'Update-Status nicht erreichbar.'
    if (isConnectivityFailure(cause.httpStatus ?? 0)) emit('moonraker-status', false)
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
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Update-Prüfung fehlgeschlagen.')
    updates.value = data
    if (data.activeJob) activeJob.value = data.activeJob
  } catch (cause) {
    updatesError.value = cause.message || 'Update-Prüfung fehlgeschlagen.'
  } finally {
    refreshingUpdates.value = false
  }
}

async function triggerUpgrade(name) {
  if (isUpdateBusy.value || props.printLocked || !props.moonrakerOnline) return
  cancelConfirm()
  submittingAction.value = true
  updatesError.value = ''
  try {
    const response = await fetch('/api/system/updates/upgrade', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Update konnte nicht gestartet werden.')
    if (data.job) activeJob.value = data.job
  } catch (cause) {
    updatesError.value = cause.message || 'Update konnte nicht gestartet werden.'
  } finally {
    submittingAction.value = false
  }
}

async function triggerRecover(name, hard) {
  if (isUpdateBusy.value || props.printLocked || !props.moonrakerOnline) return
  cancelConfirm()
  expandedRecovery.value = ''
  submittingAction.value = true
  updatesError.value = ''
  try {
    const response = await fetch('/api/system/updates/recover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({ name, hard }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Wiederherstellung konnte nicht gestartet werden.')
    if (data.job) activeJob.value = data.job
  } catch (cause) {
    updatesError.value = cause.message || 'Wiederherstellung konnte nicht gestartet werden.'
  } finally {
    submittingAction.value = false
  }
}

watch(
  () => props.updateEvent,
  async evt => {
    if (!evt) return
    if (evt.refreshed) {
      fetchUpdates()
      return
    }
    if (!activeJob.value && evt.application) {
      activeJob.value = {
        name: evt.application,
        mode: evt.mode || 'upgrade',
        running: !evt.complete,
        ok: evt.ok ?? null,
        log: [],
      }
    }
    if (activeJob.value) {
      if (evt.message) {
        const last = activeJob.value.log.at(-1)
        if (!last || last.message !== evt.message) {
          activeJob.value = {
            ...activeJob.value,
            running: evt.complete ? false : (evt.running ?? true),
            ok: evt.ok ?? activeJob.value.ok,
            log: [...activeJob.value.log.slice(-149), { time: evt.time, message: evt.message }],
          }
        }
      } else if (evt.complete) {
        activeJob.value = { ...activeJob.value, running: false, ok: evt.ok ?? true }
      }
      await nextTick()
      if (updateLogEl.value) updateLogEl.value.scrollTop = updateLogEl.value.scrollHeight
      if (evt.complete) {
        setTimeout(() => fetchUpdates(), 1200)
      }
    }
  },
)

function hasNotesSource(item) {
  return Boolean(item.repoUrl || item.commitsBehindCount > 0 || item.packageCount > 0)
}

async function openNotes(item) {
  notesTarget.value = item.name
  notesData.value = null
  notesError.value = ''
  loadingNotes.value = true
  notesDialog.value?.showModal()
  try {
    const response = await fetch(`/api/system/updates/notes?name=${encodeURIComponent(item.name)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Neuigkeiten konnten nicht geladen werden.')
    notesData.value = data
  } catch (cause) {
    notesError.value = cause.message || 'Neuigkeiten konnten nicht geladen werden.'
  } finally {
    loadingNotes.value = false
  }
}

function closeNotes() {
  notesDialog.value?.close()
}

// Safely parse markdown-like GitHub release bodies into structured blocks (zero v-html).
function parseReleaseBlocks(body) {
  if (!body) return []
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let listItems = []
  const flushList = () => {
    if (listItems.length) {
      blocks.push({ kind: 'list', items: listItems })
      listItems = []
    }
  }
  const cleanInline = text =>
    text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .trim()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^---+$/.test(line)) {
      flushList()
      continue
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/)
    if (heading) {
      flushList()
      blocks.push({ kind: 'heading', text: cleanInline(heading[1]) })
      continue
    }
    const bullet = line.match(/^[-*•]\s+(.+)$/)
    if (bullet) {
      listItems.push(cleanInline(bullet[1]))
      continue
    }
    flushList()
    blocks.push({ kind: 'p', text: cleanInline(line) })
  }
  flushList()
  return blocks.slice(0, 80)
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
              updates.summary.outdated === 1
                ? t('{0} Komponenten · 1 Update verfügbar · {1} lokal geändert', [
                    updates.summary.total,
                    updates.summary.dirty,
                  ])
                : t('{0} Komponenten · {1} Updates verfügbar · {2} lokal geändert', [
                    updates.summary.total,
                    updates.summary.outdated,
                    updates.summary.dirty,
                  ])
            }}
          </p>
          <p v-else>{{ t('Moonraker Update-Manager · Changelogs, gezielte Updates und Dirty-Recovery.') }}</p>
        </div>
        <button
          type="button"
          class="subtle-button"
          :disabled="refreshingUpdates || loadingUpdates || printLocked || !moonrakerOnline"
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
              'Mindestens ein Repository enthält lokale Anpassungen (Lokal geändert). Updates sind dort gesperrt — über „Wiederherstellen“ kannst du bewusst einen Soft- oder Hard-Reset ausführen.',
            )
          }}
        </span>
      </div>

      <div v-if="activeJob" class="update-job-panel" role="status">
        <div class="update-job-head">
          <strong>
            <Loader2 v-if="activeJob.running" :size="14" class="spinning" />
            <Check v-else-if="activeJob.ok !== false" :size="14" class="text-lime" />
            <AlertTriangle v-else :size="14" class="heating" />
            <span>
              {{ activeJob.name }} ·
              {{
                activeJob.running
                  ? activeJob.mode === 'recover'
                    ? t('Wiederherstellung läuft …')
                    : t('Update läuft …')
                  : activeJob.ok !== false
                    ? t('Abgeschlossen')
                    : t('Fehlgeschlagen')
              }}
            </span>
          </strong>
          <button
            v-if="!activeJob.running"
            type="button"
            class="icon-button"
            :aria-label="t('Protokoll schließen')"
            @click="activeJob = null"
          >
            <X :size="14" />
          </button>
        </div>
        <pre ref="updateLogEl" class="update-job-log">{{
          activeJob.log.map(entry => entry.message).join('\n')
        }}</pre>
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
              <th style="text-align: right">{{ t('Aktionen') }}</th>
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
                <p
                  v-else-if="item.status === 'invalid' && (item.warnings.length || item.anomalies.length)"
                  class="update-notes"
                >
                  {{ item.warnings[0] || item.anomalies[0] }}
                </p>
                <details v-else-if="item.anomalies.length || item.warnings.length" class="update-anomalies">
                  <summary>
                    <ChevronRight :size="12" />{{ t('Hinweise ({0})', [item.warnings.length + item.anomalies.length]) }}
                  </summary>
                  <ul>
                    <li v-for="(note, idx) in [...item.warnings, ...item.anomalies]" :key="idx">{{ note }}</li>
                  </ul>
                </details>

                <div v-if="expandedRecovery === item.name && item.canRecover" class="update-recovery-box">
                  <p>
                    {{
                      item.isDirty
                        ? t(
                            'Achtung: Ein Reset verwirft lokale Dateiänderungen (z. B. eigene Patches). Soft-Reset setzt das Git-Arbeitsverzeichnis zurück; Hard-Reset löscht den Ordner und klont das Repository komplett neu.',
                          )
                        : t(
                            'Repository weicht vom erwarteten Stand ab. Soft-Reset setzt Git zurück; Hard-Reset klont das Repository sauber neu.',
                          )
                    }}
                  </p>
                  <div class="update-recovery-options">
                    <template v-if="confirmKey === `soft:${item.name}`">
                      <button
                        type="button"
                        class="confirm-button"
                        :disabled="isUpdateBusy || printLocked || !moonrakerOnline"
                        @click="triggerRecover(item.name, false)"
                      >
                        {{ t('Soft-Reset jetzt ausführen?') }}
                      </button>
                      <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
                    </template>
                    <button
                      v-else
                      type="button"
                      class="confirm-button"
                      :disabled="isUpdateBusy || printLocked || !moonrakerOnline"
                      @click="requestConfirm(`soft:${item.name}`)"
                    >
                      <RotateCcw :size="12" />{{ t('Soft-Reset') }}
                    </button>

                    <template v-if="confirmKey === `hard:${item.name}`">
                      <button
                        type="button"
                        class="danger-button"
                        :disabled="isUpdateBusy || printLocked || !moonrakerOnline"
                        @click="triggerRecover(item.name, true)"
                      >
                        {{ t('Hard-Reset (neu klonen) ausführen?') }}
                      </button>
                      <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
                    </template>
                    <button
                      v-else
                      type="button"
                      class="danger-button"
                      :disabled="isUpdateBusy || printLocked || !moonrakerOnline"
                      @click="requestConfirm(`hard:${item.name}`)"
                    >
                      <RotateCcw :size="12" />{{ t('Hard-Reset') }}
                    </button>

                    <button type="button" class="subtle-button" @click="expandedRecovery = ''; cancelConfirm()">
                      {{ t('Schließen') }}
                    </button>
                  </div>
                </div>
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
              <td class="update-actions-cell">
                <div class="update-actions-row">
                  <button
                    v-if="hasNotesSource(item)"
                    type="button"
                    class="subtle-button"
                    :title="t('Neuigkeiten und Änderungen anzeigen')"
                    @click="openNotes(item)"
                  >
                    <FileText :size="12" />{{ t('Neuigkeiten') }}
                  </button>

                  <template v-if="item.canUpgrade">
                    <template v-if="confirmKey === `upgrade:${item.name}`">
                      <button
                        type="button"
                        class="primary-control"
                        :disabled="isUpdateBusy || printLocked || !moonrakerOnline"
                        @click="triggerUpgrade(item.name)"
                      >
                        <ArrowUpCircle :size="13" />{{ t('Jetzt aktualisieren?') }}
                      </button>
                      <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
                    </template>
                    <button
                      v-else
                      type="button"
                      class="primary-control"
                      :disabled="isUpdateBusy || printLocked || !moonrakerOnline"
                      :title="printLocked ? t('Während eines Drucks gesperrt.') : t('Komponente auf neue Version aktualisieren')"
                      @click="requestConfirm(`upgrade:${item.name}`)"
                    >
                      <ArrowUpCircle :size="13" />{{ t('Aktualisieren') }}
                    </button>
                  </template>

                  <button
                    v-else-if="item.canRecover"
                    type="button"
                    class="confirm-button"
                    :disabled="isUpdateBusy || printLocked || !moonrakerOnline"
                    @click="expandedRecovery = expandedRecovery === item.name ? '' : item.name; cancelConfirm()"
                  >
                    <RotateCcw :size="12" />{{ t('Wiederherstellen') }}
                  </button>
                </div>
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

    <dialog ref="notesDialog" class="camera-dialog update-notes-dialog" @click.self="closeNotes">
      <header>
        <h2>{{ notesTarget }} · {{ t('Neuigkeiten & Änderungen') }}</h2>
        <button type="button" class="icon-button" :aria-label="t('Schließen')" @click="closeNotes">
          <X :size="18" />
        </button>
      </header>

      <div v-if="loadingNotes" class="skeleton-block">
        <span class="skeleton-bar lg" />
        <span class="skeleton-bar" />
        <span class="skeleton-bar sm" />
        <span class="skeleton-bar" />
      </div>

      <div v-else-if="notesError" class="system-banner amber" role="alert">
        <AlertTriangle :size="15" />
        <span>{{ t(notesError) }}</span>
      </div>

      <div v-else-if="notesData" class="update-notes-body">
        <div class="update-notes-meta">
          <span class="update-version">
            {{ notesData.version ?? '—' }}
            <template v-if="notesData.remoteVersion && notesData.remoteVersion !== notesData.version">
              → <span class="update-version-diff">{{ notesData.remoteVersion }}</span>
            </template>
          </span>
          <div class="confirm-inline">
            <a
              v-if="notesData.compareUrl"
              class="subtle-button"
              :href="notesData.compareUrl"
              target="_blank"
              rel="noopener"
            >
              {{ t('Diff auf GitHub') }}<ArrowUpRight :size="13" />
            </a>
            <a
              v-if="notesData.repoUrl"
              class="subtle-button"
              :href="notesData.repoUrl"
              target="_blank"
              rel="noopener"
            >
              {{ t('Auf GitHub öffnen') }}<ArrowUpRight :size="13" />
            </a>
          </div>
        </div>

        <div v-if="notesData.githubError" class="system-banner amber">
          <AlertTriangle :size="14" />
          <span>{{ t('Release-Notes von GitHub derzeit nicht abrufbar:') }} {{ notesData.githubError }}</span>
        </div>

        <template v-if="notesData.releases?.length">
          <article v-for="rel in notesData.releases" :key="rel.tag" class="release-entry">
            <div class="release-entry-head">
              <strong>{{ rel.name }}</strong>
              <span>
                {{ formatDate(rel.publishedAt) }}
                <template v-if="rel.url">
                  ·
                  <a :href="rel.url" target="_blank" rel="noopener" style="text-decoration: underline">GitHub</a>
                </template>
              </span>
            </div>
            <div v-if="rel.body" class="release-lines">
              <template v-for="(blk, idx) in parseReleaseBlocks(rel.body)" :key="idx">
                <h4 v-if="blk.kind === 'heading'">{{ blk.text }}</h4>
                <ul v-else-if="blk.kind === 'list'">
                  <li v-for="(li, j) in blk.items" :key="j">{{ li }}</li>
                </ul>
                <p v-else>{{ blk.text }}</p>
              </template>
            </div>
          </article>
        </template>

        <div v-if="notesData.commits?.length">
          <h3 style="margin-bottom: 8px">{{ t('Ausstehende Commits ({0})', [notesData.commitsCount]) }}</h3>
          <ul class="commit-list">
            <li v-for="c in notesData.commits" :key="c.sha" class="commit-item">
              <span class="commit-sha">{{ c.sha }}</span>
              <span class="commit-msg">{{ c.subject || c.message }}</span>
              <span v-if="c.author" class="commit-author">{{ c.author }}</span>
            </li>
          </ul>
        </div>

        <div v-if="notesData.packages?.length">
          <h3 style="margin-bottom: 8px">{{ t('Systempakete ({0})', [notesData.packages.length]) }}</h3>
          <div class="pkg-chips">
            <span v-for="pkg in notesData.packages" :key="pkg" class="pkg-chip">{{ pkg }}</span>
          </div>
        </div>

        <p
          v-if="!notesData.releases?.length && !notesData.commits?.length && !notesData.packages?.length && !notesData.githubError"
          class="muted"
          style="margin-top: 0"
        >
          {{ t('Keine detaillierten Release-Notes oder Commits für diese Komponente hinterlegt.') }}
        </p>
      </div>
    </dialog>
  </div>
</template>
