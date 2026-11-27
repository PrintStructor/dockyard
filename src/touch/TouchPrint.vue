<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  FileCode2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Play,
  X,
  AlertTriangle,
  Clock,
  FolderOpen,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { printControlReason } from '../print-control-state.mjs'
import { withPrinterParam } from './touch-config.mjs'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  printerId: { type: String, default: '' },
})

const emit = defineEmits(['started'])

const PAGE_SIZE = 6
const files = ref([])
const dirs = ref([])
const activeFolder = ref('')
const loading = ref(false)
const error = ref('')
const page = ref(0)

const selectedFile = ref(null)
const selectedMeta = ref(null)
const loadingMeta = ref(false)

async function loadFiles(dir = activeFolder.value) {
  loading.value = true
  error.value = ''
  try {
    const base = dir ? `/api/print/files?dir=${encodeURIComponent(dir)}` : '/api/print/files'
    const res = await fetch(withPrinterParam(base, props.printerId), { signal: AbortSignal.timeout(8000) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Druckdateien nicht erreichbar.')
    files.value = Array.isArray(data.files) ? data.files : []
    if (!dir) dirs.value = Array.isArray(data.dirs) ? data.dirs : []
    page.value = 0
  } catch (err) {
    error.value = err.message || 'Druckdateien nicht erreichbar.'
  } finally {
    loading.value = false
  }
}

watch(
  [() => props.printerId, activeFolder],
  ([, dir]) => {
    selectedFile.value = null
    selectedMeta.value = null
    loadFiles(dir)
  },
)

onMounted(() => loadFiles())

const folders = computed(() => {
  const set = new Set()
  for (const d of dirs.value) if (d?.path) set.add(d.path)
  for (const f of files.value) if (f?.dir) set.add(f.dir)
  return [...set].sort((a, b) => a.localeCompare(b))
})

const filteredFiles = computed(() => {
  if (!activeFolder.value) return files.value
  return files.value.filter(f => f.dir === activeFolder.value)
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredFiles.value.length / PAGE_SIZE)))
const pageFiles = computed(() => {
  const start = page.value * PAGE_SIZE
  return filteredFiles.value.slice(start, start + PAGE_SIZE)
})

function thumbUrl(relPath) {
  if (!relPath) return ''
  return withPrinterParam(`/api/print/thumbnail?path=${encodeURIComponent(relPath)}`, props.printerId)
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  if (hrs > 0) return `${hrs}h ${String(mins).padStart(2, '0')}m`
  return `${Math.max(1, mins)}m`
}

function formatWeight(g) {
  if (!Number.isFinite(g) || g <= 0) return ''
  return `${g.toLocaleString(locale.value, { maximumFractionDigits: 0 })} g`
}

async function openConfirm(file) {
  selectedFile.value = file
  selectedMeta.value = null
  loadingMeta.value = true
  try {
    const url = withPrinterParam(`/api/print/metadata?filename=${encodeURIComponent(file.path)}`, props.printerId)
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (res.ok) selectedMeta.value = await res.json().catch(() => null)
  } catch {
    // Metadata optional
  } finally {
    loadingMeta.value = false
  }
}

const startReason = computed(() => {
  if (!selectedFile.value) return 'Keine Druckdatei ausgewählt.'
  return printControlReason(props.status, 'print_start', props.online, props.pending)
})

const preflightWarnings = computed(() => {
  if (!selectedFile.value || !props.online || !props.status) return []
  const warnings = []
  if (props.status.isToolchanger) {
    if (props.status.toolchangerState && props.status.toolchangerState !== 'ready') {
      warnings.push(t('Toolchanger ist nicht bereit ({0}).', [props.status.toolchangerState]))
    }
    if (props.status.detectionMismatch) {
      warnings.push(t('Werkzeugerkennung stimmt nicht überein — vor Druckstart prüfen.'))
    }
    const used = (selectedMeta.value?.tools ?? []).filter(item => item.used)
    for (const u of used) {
      const liveTool = props.status.tools?.[u.id]
      if (liveTool?.filamentEnabled === true && liveTool?.filamentDetected === false) {
        warnings.push(t('Kein Filament an T{0} erkannt (für diesen Druck benötigt).', [u.id]))
      }
    }
  } else {
    const spool = props.status.spoolman?.activeSpool
    const needed = selectedMeta.value?.filamentWeightTotal ?? selectedFile.value?.filamentWeight ?? null
    if (spool && Number.isFinite(spool.remainingWeight) && Number.isFinite(needed) && spool.remainingWeight < needed) {
      warnings.push(
        t('Spule reicht evtl. nicht ({0} g übrig, {1} g nötig).', [Math.round(spool.remainingWeight), Math.round(needed)]),
      )
    }
  }
  return warnings
})

async function startSelectedPrint() {
  if (!selectedFile.value || startReason.value) return
  const filename = selectedFile.value.path
  const ok = await props.send({ action: 'print_start', filename })
  if (ok) {
    selectedFile.value = null
    emit('started')
  }
}
</script>

<template>
  <section class="touch-print-view" :aria-label="t('Druckdateien')">
    <div class="touch-print-toolbar">
      <div class="touch-folder-bar">
        <button
          type="button"
          class="touch-chip"
          :aria-pressed="activeFolder === ''"
          @click="activeFolder = ''"
        >
          <FolderOpen :size="14" />{{ t('Alle') }} ({{ files.length }})
        </button>
        <button
          v-for="dir in folders.slice(0, 4)"
          :key="dir"
          type="button"
          class="touch-chip"
          :aria-pressed="activeFolder === dir"
          @click="activeFolder = dir"
        >
          {{ dir }}
        </button>
      </div>

      <div class="touch-pager">
        <button
          type="button"
          class="touch-btn touch-btn-surface touch-btn-icon"
          :disabled="page <= 0"
          :aria-label="t('Zurück')"
          @click="page = Math.max(0, page - 1)"
        >
          <ChevronLeft :size="20" />
        </button>
        <span class="touch-page-label">{{ page + 1 }} / {{ totalPages }}</span>
        <button
          type="button"
          class="touch-btn touch-btn-surface touch-btn-icon"
          :disabled="page >= totalPages - 1"
          :aria-label="t('Weiter')"
          @click="page = Math.min(totalPages - 1, page + 1)"
        >
          <ChevronRight :size="20" />
        </button>
        <button
          type="button"
          class="touch-btn touch-btn-surface touch-btn-icon"
          :disabled="loading"
          :aria-label="t('Aktualisieren')"
          @click="loadFiles()"
        >
          <RefreshCw :size="18" :class="{ spinning: loading }" />
        </button>
      </div>
    </div>

    <div v-if="error" class="touch-empty-state">
      <AlertTriangle :size="24" />
      <p>{{ t(error) }}</p>
    </div>

    <div v-else-if="!pageFiles.length && !loading" class="touch-empty-state">
      <FileCode2 :size="28" />
      <p>{{ t('Keine G-Code-Dateien gefunden.') }}</p>
    </div>

    <div v-else class="touch-file-grid">
      <button
        v-for="file in pageFiles"
        :key="file.path"
        type="button"
        class="touch-file-card"
        @click="openConfirm(file)"
      >
        <div class="touch-file-thumb">
          <img v-if="file.thumbnail" :src="thumbUrl(file.thumbnail)" :alt="file.name" loading="lazy" />
          <FileCode2 v-else :size="26" />
        </div>
        <div class="touch-file-meta">
          <strong :title="file.name">{{ file.name }}</strong>
          <span>
            <template v-if="file.estimatedTime != null">
              <Clock :size="11" />{{ formatDuration(file.estimatedTime) }}
            </template>
            <template v-if="file.filamentWeight != null"> · {{ formatWeight(file.filamentWeight) }}</template>
            <template v-if="file.estimatedTime == null && file.filamentWeight == null && file.size != null">
              {{ Math.max(1, Math.round(file.size / 1024)) }} KB
            </template>
          </span>
        </div>
      </button>
    </div>

    <!-- PRINT START CONFIRMATION SHEET -->
    <div
      v-if="selectedFile"
      class="touch-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Druck starten')"
      @click.self="selectedFile = null"
    >
      <div class="touch-sheet touch-print-confirm-sheet">
        <div class="touch-sheet-head">
          <h2>{{ selectedMeta?.name || selectedFile.name }}</h2>
          <button type="button" class="touch-btn touch-btn-ghost touch-btn-icon" :aria-label="t('Schließen')" @click="selectedFile = null">
            <X :size="20" />
          </button>
        </div>

        <div class="touch-confirm-body">
          <div class="touch-confirm-thumb">
            <img
              v-if="selectedMeta?.thumbnail || selectedFile.thumbnail"
              :src="thumbUrl(selectedMeta?.thumbnail || selectedFile.thumbnail)"
              :alt="selectedFile.name"
            />
            <FileCode2 v-else :size="38" />
          </div>
          <div class="touch-confirm-info">
            <div class="touch-confirm-stats">
              <span v-if="(selectedMeta?.estimatedTime ?? selectedFile.estimatedTime) != null">
                {{ t('Zeit') }}: <strong>{{ formatDuration(selectedMeta?.estimatedTime ?? selectedFile.estimatedTime) }}</strong>
              </span>
              <span v-if="(selectedMeta?.filamentWeightTotal ?? selectedFile.filamentWeight) != null">
                {{ t('Filament') }}: <strong>{{ formatWeight(selectedMeta?.filamentWeightTotal ?? selectedFile.filamentWeight) }}</strong>
              </span>
              <span v-if="selectedMeta?.layerCount">
                {{ t('Layer') }}: <strong>{{ selectedMeta.layerCount }}</strong>
              </span>
              <span v-if="selectedMeta?.firstLayerExtrTemp != null || selectedMeta?.firstLayerBedTemp != null">
                {{ t('Start') }}:
                <strong>
                  {{ selectedMeta?.firstLayerExtrTemp != null ? `${Math.round(selectedMeta.firstLayerExtrTemp)}°` : '—' }}
                  / {{ selectedMeta?.firstLayerBedTemp != null ? `${Math.round(selectedMeta.firstLayerBedTemp)}°` : '—' }}
                </strong>
              </span>
            </div>

            <div v-for="(warn, idx) in preflightWarnings" :key="idx" class="touch-preflight-warn" role="alert">
              <AlertTriangle :size="15" />
              <span>{{ warn }}</span>
            </div>
            <p v-if="startReason" class="touch-confirm-blocked">{{ t(startReason) }}</p>
          </div>
        </div>

        <div class="touch-confirm-actions">
          <button type="button" class="touch-btn touch-btn-lg touch-btn-ghost" @click="selectedFile = null">
            <X :size="18" />{{ t('Abbrechen') }}
          </button>
          <button
            type="button"
            class="touch-btn touch-btn-lg touch-btn-accent"
            :disabled="!!startReason"
            @click="startSelectedPrint"
          >
            <Play :size="20" />{{ t('Druck starten') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
