<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Search,
  RefreshCw,
  Box,
  FileCode2,
  Check,
  AlertTriangle,
  Clock,
  ChevronDown,
  X,
  Expand,
  Play,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { printControlReason } from '../print-control-state.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
})

const emit = defineEmits(['open-print', 'print-started'])

const PAGE_SIZE = 40

const totals = ref(null)
const jobs = ref([])
const hasMore = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')

const search = ref('')
const statusFilter = ref('all') // 'all' | 'completed' | 'cancelled' | 'error'
const toolFilter = ref('all') // 'all' | 'multi' | '0'..'5'
const selectedId = ref(null)
const thumbnailDialog = ref(null)
const confirmReprint = ref(false)
let reprintTimer = null

function resetReprintConfirm() {
  confirmReprint.value = false
  clearTimeout(reprintTimer)
  reprintTimer = null
}

const reprintReason = computed(() => {
  if (!selectedJob.value?.fileExists) return 'Datei nicht mehr auf dem Drucker vorhanden.'
  return printControlReason(props.status, 'print_start', props.online, props.pending)
})

async function requestOrReprint() {
  if (reprintReason.value || !props.send || !selectedJob.value?.filename) return
  if (!confirmReprint.value) {
    confirmReprint.value = true
    clearTimeout(reprintTimer)
    reprintTimer = setTimeout(resetReprintConfirm, 6000)
    return
  }
  const filename = selectedJob.value.filename
  resetReprintConfirm()
  if (await props.send({ action: 'print_start', filename })) {
    emit('print-started', filename)
  }
}

function openThumbnail() {
  if (selectedJob.value?.thumbnail) thumbnailDialog.value?.showModal()
}

function closeThumbnail() {
  thumbnailDialog.value?.close()
}

let activeController = null

const isToolchanger = computed(() => Boolean(props.status?.isToolchanger))
const toolCount = computed(() => props.status?.toolCount ?? 6)

watch(
  isToolchanger,
  tc => {
    if (!tc) toolFilter.value = 'all'
  },
  { immediate: true },
)

const toolFilterOptions = computed(() => [
  { value: 'all', label: t('Alle Werkzeuge') },
  { value: 'multi', label: t('Multi-Tool (2+)') },
  ...Array.from({ length: toolCount.value }, (_, id) => ({ value: String(id), label: `T${id}` })),
])

const filteredJobs = computed(() => {
  const query = search.value.trim().toLowerCase()
  return jobs.value.filter(job => {
    if (query && !(job.name || job.filename || '').toLowerCase().includes(query)) return false
    if (statusFilter.value === 'completed' && job.status !== 'completed') return false
    if (statusFilter.value === 'cancelled' && job.status !== 'cancelled' && job.status !== 'interrupted') return false
    if (statusFilter.value === 'error' && job.status !== 'error') return false
    if (isToolchanger.value) {
      if (toolFilter.value === 'multi' && job.tools.length < 2) return false
      if (/^[0-7]$/.test(toolFilter.value) && !job.tools.some(tool => tool.id === Number(toolFilter.value))) return false
    }
    return true
  })
})

const selectedJob = computed(
  () => filteredJobs.value.find(job => job.jobId === selectedId.value) ?? filteredJobs.value[0] ?? null,
)

watch(filteredJobs, list => {
  if (!list.length) {
    selectedId.value = null
    return
  }
  if (!list.some(job => job.jobId === selectedId.value)) {
    selectedId.value = list[0].jobId
  }
})

watch(selectedId, () => {
  closeThumbnail()
  resetReprintConfirm()
})

const totalCount = computed(() => {
  const fromTotals = totals.value?.totalJobs
  return Number.isFinite(fromTotals) ? Math.max(Math.round(fromTotals), jobs.value.length) : jobs.value.length
})

function statusLabel(status) {
  return (
    {
      completed: 'Abgeschlossen',
      cancelled: 'Abgebrochen',
      interrupted: 'Unterbrochen',
      error: 'Fehler',
      in_progress: 'Druckt',
      unknown: 'Unbekannt',
    }[status] ?? 'Unbekannt'
  )
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs.toLocaleString(locale.value)} h ${String(mins).padStart(2, '0')} min`
  if (mins > 0) return `${mins} min ${String(secs).padStart(2, '0')} s`
  return `${secs} s`
}

function formatTimestamp(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '—'
  return new Date(unixSeconds * 1000).toLocaleString(locale.value, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatFilamentMeters(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return '—'
  const meters = mm / 1000
  return `${formatNumber(meters, meters >= 100 ? 0 : 1)} m`
}

function thumbnailUrl(path) {
  return path ? `/api/print/thumbnail?path=${encodeURIComponent(path)}` : ''
}

async function fetchPage(start = 0, append = false) {
  if (append && loadingMore.value) return
  if (!append) {
    activeController?.abort()
    loading.value = true
  } else {
    loadingMore.value = true
  }

  const controller = new AbortController()
  if (!append) activeController = controller
  error.value = ''

  try {
    const response = await fetch(`/api/history?limit=${PAGE_SIZE}&start=${start}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(9000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)

    if (start === 0 && data.totals) totals.value = data.totals
    hasMore.value = !!data.hasMore

    if (append) {
      const seen = new Set(jobs.value.map(item => item.jobId))
      const incoming = (data.jobs ?? []).filter(item => !seen.has(item.jobId))
      jobs.value = [...jobs.value, ...incoming]
      if (!incoming.length) hasMore.value = false
    } else {
      jobs.value = data.jobs ?? []
      if (jobs.value.length && !jobs.value.some(item => item.jobId === selectedId.value)) {
        selectedId.value = jobs.value[0].jobId
      }
    }
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      error.value = cause.message || 'Druckverlauf nicht erreichbar.'
    }
  } finally {
    if (!append) loading.value = false
    else loadingMore.value = false
  }
}

function refresh() {
  fetchPage(0, false)
}

function loadMore() {
  if (hasMore.value && !loadingMore.value) fetchPage(jobs.value.length, true)
}

function clearFilters() {
  search.value = ''
  statusFilter.value = 'all'
  toolFilter.value = 'all'
}

const filtersActive = computed(
  () => search.value.trim() !== '' || statusFilter.value !== 'all' || toolFilter.value !== 'all',
)

onMounted(() => {
  refresh()
})

onBeforeUnmount(() => {
  activeController?.abort()
  resetReprintConfirm()
})
</script>

<template>
  <section class="history-view" :aria-label="t('Druckverlauf')">
    <div v-if="totals" class="history-totals-strip" :aria-label="t('Gesamtstatistik')">
      <div class="history-total-cell">
        <span>{{ t('Druckjobs gesamt') }}</span>
        <strong>{{ totals.totalJobs != null ? Math.round(totals.totalJobs).toLocaleString(locale) : '—' }}</strong>
      </div>
      <div class="history-total-cell">
        <span>{{ t('Druckzeit gesamt') }}</span>
        <strong>{{ formatDuration(totals.totalPrintTime) }}</strong>
      </div>
      <div class="history-total-cell">
        <span>{{ t('Filament gesamt') }}</span>
        <strong>{{ formatFilamentMeters(totals.totalFilamentMm) }}</strong>
      </div>
      <div class="history-total-cell">
        <span>{{ t('Längster Druck') }}</span>
        <strong>{{ formatDuration(totals.longestPrint) }}</strong>
      </div>
    </div>

    <div class="history-toolbar">
      <label class="history-search">
        <Search :size="15" />
        <input
          v-model="search"
          type="search"
          :placeholder="t('Dateiname filtern …')"
          :aria-label="t('Dateiname filtern')"
          autocomplete="off"
          spellcheck="false"
        />
        <button
          v-if="search"
          type="button"
          class="history-search-clear"
          :aria-label="t('Suche leeren')"
          @click="search = ''"
        >
          <X :size="13" />
        </button>
      </label>

      <div class="segmented history-status-filter" :aria-label="t('Nach Status filtern')">
        <button type="button" :aria-pressed="statusFilter === 'all'" @click="statusFilter = 'all'">
          {{ t('Alle') }}
        </button>
        <button type="button" :aria-pressed="statusFilter === 'completed'" @click="statusFilter = 'completed'">
          {{ t('Abgeschlossen') }}
        </button>
        <button type="button" :aria-pressed="statusFilter === 'cancelled'" @click="statusFilter = 'cancelled'">
          {{ t('Abgebrochen') }}
        </button>
        <button type="button" :aria-pressed="statusFilter === 'error'" @click="statusFilter = 'error'">
          {{ t('Fehler') }}
        </button>
      </div>

      <div v-if="isToolchanger" class="history-tool-filter">
        <CockpitSelect
          v-model="toolFilter"
          :options="toolFilterOptions"
          :aria-label="t('Nach Werkzeug filtern')"
          size="compact"
          align="right"
        />
      </div>

      <button
        class="icon-button"
        type="button"
        :disabled="loading"
        :title="t('Verlauf aktualisieren')"
        :aria-label="t('Verlauf aktualisieren')"
        @click="refresh"
      >
        <RefreshCw :size="16" :class="{ spinning: loading }" />
      </button>
    </div>

    <p v-if="error" class="history-error" role="status">
      <AlertTriangle :size="15" />
      <span>{{ t(error) }}</span>
      <button type="button" class="subtle-button" @click="refresh">{{ t('Erneut versuchen') }}</button>
    </p>

    <div class="history-layout">
      <div class="history-list-panel">
        <div v-if="loading && !jobs.length" class="history-empty" role="status">
          <Clock :size="20" />
          <span>{{ t('Druckverlauf wird geladen …') }}</span>
        </div>

        <div v-else-if="!filteredJobs.length" class="history-empty">
          <FileCode2 :size="20" />
          <span>
            {{
              jobs.length
                ? t('Keine Druckjobs entsprechen dem aktuellen Filter.')
                : t('Noch keine Druckjobs im Verlauf vorhanden.')
            }}
          </span>
          <button v-if="filtersActive" type="button" class="subtle-button" @click="clearFilters">
            {{ t('Filter zurücksetzen') }}
          </button>
        </div>

        <ul v-else class="history-rows" :aria-label="t('Liste der Druckjobs')">
          <li v-for="job in filteredJobs" :key="job.jobId || `${job.filename}-${job.startTime}`">
            <button
              type="button"
              class="history-row"
              :class="{ selected: selectedJob?.jobId === job.jobId }"
              :aria-pressed="selectedJob?.jobId === job.jobId"
              @click="selectedId = job.jobId"
            >
              <img
                v-if="job.thumbnail"
                :src="thumbnailUrl(job.thumbnail)"
                class="history-thumb"
                width="40"
                height="40"
                loading="lazy"
                alt=""
              />
              <span v-else class="history-thumb history-thumb-fallback" aria-hidden="true">
                <FileCode2 :size="18" />
              </span>

              <span class="history-row-main">
                <strong class="history-row-name">{{ job.name || t('Unbekannte Datei') }}</strong>
                <span class="history-row-sub">
                  <span>{{ formatTimestamp(job.startTime) }}</span>
                  <span v-if="job.tools.length && (isToolchanger || job.tools.length > 1)" class="history-row-tools">
                    <span v-for="tool in job.tools" :key="tool.id" class="history-tool-chip">
                      <span class="history-tool-dot" :style="{ background: tool.color ?? '#8b9ba2' }" />
                      T{{ tool.id }}
                    </span>
                  </span>
                </span>
              </span>

              <span class="history-row-status" :class="job.status">
                <Check v-if="job.status === 'completed'" :size="12" />
                <AlertTriangle v-else-if="job.status === 'error' || job.status === 'interrupted'" :size="12" />
                {{ t(statusLabel(job.status)) }}
              </span>

              <span class="history-row-metrics">
                <strong>{{ formatDuration(job.printDuration) }}</strong>
                <small>{{ formatFilamentMeters(job.filamentUsedMm) }}</small>
              </span>
            </button>
          </li>
        </ul>

        <div v-if="jobs.length" class="history-footer">
          <span>
            {{
              filtersActive
                ? t('{0} Treffer in {1} geladenen Jobs ({2} gesamt)', [
                    filteredJobs.length,
                    jobs.length,
                    totalCount.toLocaleString(locale),
                  ])
                : t('Zeige {0} von {1} Jobs', [jobs.length, totalCount.toLocaleString(locale)])
            }}
          </span>
          <button
            v-if="hasMore"
            type="button"
            class="subtle-button"
            :disabled="loadingMore"
            @click="loadMore"
          >
            <ChevronDown :size="14" />{{ loadingMore ? t('Lade …') : t('Weitere laden') }}
          </button>
        </div>
      </div>

      <aside class="inspector history-inspector" :aria-label="t('Details zum Druckjob')">
        <template v-if="selectedJob">
          <div class="print-inspector-header">
            <div class="print-status-row">
              <span class="history-row-status" :class="selectedJob.status">
                <Check v-if="selectedJob.status === 'completed'" :size="12" />
                <AlertTriangle
                  v-else-if="selectedJob.status === 'error' || selectedJob.status === 'interrupted'"
                  :size="12"
                />
                {{ t(statusLabel(selectedJob.status)) }}
              </span>
              <span v-if="selectedJob.jobId" class="print-slicer-tag">#{{ selectedJob.jobId }}</span>
            </div>

            <div class="print-title-block">
              <button
                v-if="selectedJob.thumbnail"
                type="button"
                class="print-thumbnail-button"
                :title="t('Vorschaubild vergrößern')"
                :aria-label="t('Vorschaubild vergrößern')"
                @click="openThumbnail"
              >
                <img
                  :src="thumbnailUrl(selectedJob.thumbnail)"
                  class="print-thumbnail"
                  width="64"
                  height="64"
                  :alt="selectedJob.name || ''"
                />
                <span class="print-thumbnail-zoom" aria-hidden="true"><Expand :size="12" /></span>
              </button>
              <div class="print-title-copy">
                <h2>{{ selectedJob.name || t('Unbekannte Datei') }}</h2>
                <p v-if="selectedJob.slicer" class="print-preview-note">
                  {{ selectedJob.slicer }}{{ selectedJob.slicerVersion ? ` ${selectedJob.slicerVersion}` : '' }}
                </p>
              </div>
            </div>
          </div>

          <div class="history-actions-row">
            <button
              type="button"
              class="focus-action history-3d-button"
              :disabled="!selectedJob.fileExists"
              :title="
                selectedJob.fileExists
                  ? t('Datei in der 3D-Druckansicht öffnen')
                  : t('Datei nicht mehr auf dem Drucker vorhanden')
              "
              @click="selectedJob.fileExists && emit('open-print', selectedJob.filename)"
            >
              <span>{{ t('In 3D öffnen') }}</span>
              <Box :size="16" />
            </button>

            <div v-if="selectedJob.fileExists" class="history-reprint-wrap">
              <div v-if="confirmReprint" class="print-confirm-row">
                <button
                  type="button"
                  class="subtle-button history-reprint-confirm"
                  :disabled="!!reprintReason"
                  @click="requestOrReprint"
                  @keydown.esc="resetReprintConfirm"
                >
                  <Play :size="14" />{{ t('Erneut drucken?') }}
                </button>
                <button
                  type="button"
                  class="subtle-button print-confirm-cancel"
                  :title="t('Abbrechen')"
                  :aria-label="t('Abbrechen')"
                  @click="resetReprintConfirm"
                >
                  <X :size="14" />
                </button>
              </div>
              <button
                v-else
                type="button"
                class="subtle-button history-reprint-btn"
                :disabled="!!reprintReason"
                :title="reprintReason ? t(reprintReason) : t('Diese Datei direkt erneut drucken')"
                @click="requestOrReprint"
              >
                <Play :size="14" />{{ t('Erneut drucken') }}
              </button>
            </div>
          </div>
          <p v-if="!selectedJob.fileExists" class="history-file-missing">
            {{ t('Datei nicht mehr auf dem Drucker vorhanden.') }}
          </p>

          <dl class="measurements print-measurements">
            <div>
              <dt>{{ t('Gestartet') }}</dt>
              <dd>{{ formatTimestamp(selectedJob.startTime) }}</dd>
            </div>
            <div>
              <dt>{{ t('Beendet') }}</dt>
              <dd>{{ formatTimestamp(selectedJob.endTime) }}</dd>
            </div>
            <div>
              <dt>{{ t('Druckzeit') }}</dt>
              <dd>{{ formatDuration(selectedJob.printDuration) }}</dd>
            </div>
            <div>
              <dt>{{ t('Gesamtzeit') }}</dt>
              <dd>{{ formatDuration(selectedJob.totalDuration) }}</dd>
            </div>
            <div v-if="selectedJob.estimatedTime != null">
              <dt>{{ t('Geschätzte Zeit') }}</dt>
              <dd>{{ formatDuration(selectedJob.estimatedTime) }}</dd>
            </div>
            <div>
              <dt>{{ t('Filament verbraucht') }}</dt>
              <dd>
                {{ formatFilamentMeters(selectedJob.filamentUsedMm) }}
                <span v-if="selectedJob.filamentWeightTotal != null">
                  · {{ formatNumber(selectedJob.filamentWeightTotal, 1) }} g
                </span>
              </dd>
            </div>
            <div v-if="selectedJob.layerCount != null">
              <dt>{{ t('Layer') }}</dt>
              <dd>{{ selectedJob.layerCount }}</dd>
            </div>
            <div v-if="selectedJob.objectHeight != null || selectedJob.layerHeight != null">
              <dt>{{ t('Modellhöhe / Schicht') }}</dt>
              <dd>
                {{ formatNumber(selectedJob.objectHeight, 1) }} mm · {{ formatNumber(selectedJob.layerHeight, 2) }} mm
              </dd>
            </div>
            <div v-if="selectedJob.firstLayerBedTemp != null || selectedJob.firstLayerExtrTemp != null">
              <dt>{{ t('Starttemperaturen') }}</dt>
              <dd>
                {{ selectedJob.firstLayerExtrTemp != null ? `${Math.round(selectedJob.firstLayerExtrTemp)} °C` : '—' }}
                / {{ selectedJob.firstLayerBedTemp != null ? `${Math.round(selectedJob.firstLayerBedTemp)} °C` : '—' }}
                <span v-if="selectedJob.chamberTemp"> · {{ Math.round(selectedJob.chamberTemp) }} °C</span>
              </dd>
            </div>
          </dl>

          <section
            v-if="selectedJob.tools.length"
            class="print-tools-section"
            :aria-label="isToolchanger || selectedJob.tools.length > 1 ? t('Verwendete Werkzeuge') : t('Filament')"
          >
            <h3>{{ isToolchanger || selectedJob.tools.length > 1 ? t('Verwendete Werkzeuge') : t('Filament') }}</h3>
            <ul class="print-tool-list">
              <li v-for="tool in selectedJob.tools" :key="tool.id" class="print-tool-item">
                <span
                  class="print-tool-swatch"
                  :style="{ background: tool.color ?? '#8b9ba2' }"
                  :title="tool.color ?? ''"
                />
                <div class="print-tool-info">
                  <strong>
                    {{ isToolchanger || selectedJob.tools.length > 1 ? `T${tool.id}` : t('Extruder') }}
                    <span v-if="tool.type" class="print-tool-type">{{ tool.type }}</span>
                  </strong>
                  <small v-if="tool.name">{{ tool.name }}</small>
                </div>
                <div class="print-tool-metrics">
                  <span v-if="tool.weight != null && tool.weight > 0">{{ formatNumber(tool.weight, 1) }} g</span>
                  <small v-if="tool.temp != null">{{ Math.round(tool.temp) }} °C</small>
                </div>
              </li>
            </ul>
          </section>
        </template>

        <div v-else class="history-empty">
          <FileCode2 :size="20" />
          <span>{{ t('Druckjob aus der Liste wählen.') }}</span>
        </div>
      </aside>
    </div>

    <dialog
      ref="thumbnailDialog"
      class="camera-dialog thumbnail-dialog"
      @click="event => event.target === thumbnailDialog && closeThumbnail()"
    >
      <header>
        <h2>{{ selectedJob?.name || '' }}</h2>
        <button class="icon-button" type="button" :aria-label="t('Vorschaubild schließen')" @click="closeThumbnail">
          <X :size="20" />
        </button>
      </header>
      <div class="thumbnail-expanded-frame">
        <img v-if="selectedJob?.thumbnail" :src="thumbnailUrl(selectedJob.thumbnail)" :alt="selectedJob?.name || ''" />
      </div>
      <p v-if="selectedJob?.slicer || selectedJob?.layerCount">
        {{ selectedJob?.slicer || '' }}{{ selectedJob?.slicerVersion ? ` ${selectedJob.slicerVersion}` : '' }}
        <template v-if="selectedJob?.layerCount">
          {{ selectedJob?.slicer ? ' · ' : '' }}{{ t('{0} Layer', [selectedJob.layerCount]) }}
        </template>
      </p>
    </dialog>
  </section>
</template>
