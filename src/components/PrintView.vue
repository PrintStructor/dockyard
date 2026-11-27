<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Printer,
  RefreshCw,
  Layers,
  Clock,
  FileCode2,
  ChevronRight,
  Lock,
  Unlock,
  Expand,
  X,
  Play,
  Pause,
  Upload,
  Search,
  Trash2,
  FolderOpen,
  ListPlus,
  AlertTriangle,
  ListOrdered,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { printControlReason } from '../print-control-state.mjs'
import { computeLayerToolBands } from '../layer-ribbon.mjs'
import CockpitSelect from './CockpitSelect.vue'
import PrintScene from './PrintScene.vue'
import LivePrintTuning from './LivePrintTuning.vue'
import SpoolmanPicker from './SpoolmanPicker.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  send: Function,
  printerName: { type: String, default: '' },
  requestedFile: String,
  canWrite: { type: Boolean, default: true },
})

const emit = defineEmits(['refresh'])

const files = ref([])
const recentJobs = ref([])
const filesError = ref('')
const loadingFiles = ref(false)

const fileDrawerOpen = ref(false)
const fileSearch = ref('')
const activeFolder = ref('')
const fileSort = ref('modified') // 'modified' | 'name'

const uploadInputEl = ref(null)
const dragOver = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const fileActionFeedback = ref(null) // { ok: boolean, message: string }
const confirmDeletePath = ref('')
let deleteConfirmTimer = null

const queue = ref({ available: false, queueState: null, jobs: [] })
const queueBusy = ref(false)
const queueError = ref('')

const selectedFile = ref('')
const metadata = ref(null)
const model = ref(null)
const modelLoading = ref(false)
const modelError = ref('')

const colorMode = ref('filament')
const showSupport = ref(true)
const showGhost = ref(true)
const followLiveLayer = ref(true)
const manualLayer = ref(1)
const thumbnailDialog = ref(null)

const confirmStart = ref(false)
let startConfirmTimer = null

function resetStartConfirm() {
  confirmStart.value = false
  clearTimeout(startConfirmTimer)
  startConfirmTimer = null
}

function resetDeleteConfirm() {
  confirmDeletePath.value = ''
  clearTimeout(deleteConfirmTimer)
  deleteConfirmTimer = null
}

const printStartReason = computed(() => {
  if (!selectedFile.value) return 'Keine Druckdatei ausgewählt.'
  return printControlReason(props.status, 'print_start', props.online, props.pending)
})

async function requestOrStartPrint() {
  if (printStartReason.value || !props.send) return
  if (!confirmStart.value) {
    confirmStart.value = true
    clearTimeout(startConfirmTimer)
    startConfirmTimer = setTimeout(resetStartConfirm, 6000)
    return
  }
  resetStartConfirm()
  await props.send({ action: 'print_start', filename: selectedFile.value })
}

function openThumbnail() {
  if (thumbnailUrl.value) thumbnailDialog.value?.showModal()
}

function closeThumbnail() {
  thumbnailDialog.value?.close()
}

let fetchAbort = null

const isPrintActive = computed(() => props.online && ['printing', 'paused'].includes(props.status?.printState))
const isViewingActivePrint = computed(
  () => isPrintActive.value && !!selectedFile.value && selectedFile.value === props.status?.printFilename,
)

const maxLayer = computed(() => model.value?.header?.maxLayer ?? metadata.value?.layerCount ?? 1)

const activeClipLayer = computed(() => {
  if (isViewingActivePrint.value && followLiveLayer.value) {
    if (Number.isFinite(props.status?.printLayer) && props.status.printLayer > 0) {
      return Math.min(maxLayer.value, Math.round(props.status.printLayer))
    }
    if (Number.isFinite(props.status?.progress) && maxLayer.value > 0) {
      return Math.max(1, Math.min(maxLayer.value, Math.round(props.status.progress * maxLayer.value)))
    }
  }
  return Math.max(1, Math.min(maxLayer.value, manualLayer.value))
})

const currentLayerZ = computed(() => {
  const heights = model.value?.header?.layerHeights
  if (heights?.length) {
    return heights[Math.max(0, Math.min(heights.length - 1, activeClipLayer.value - 1))] ?? null
  }
  return null
})

const TOOL_PALETTE = ['#c5f76b', '#6ed5e7', '#bca3ff', '#f3c67b', '#ff9a83', '#ed9fc8']

const toolColors = computed(() =>
  Array.from({ length: 6 }, (_, id) => metadata.value?.tools?.[id]?.color ?? null),
)

const layerRibbon = computed(() => computeLayerToolBands(model.value?.segments, maxLayer.value))

const bandColor = toolId =>
  colorMode.value === 'tools' ? TOOL_PALETTE[toolId] : (toolColors.value[toolId] || TOOL_PALETTE[toolId])

const activeLayerPercent = computed(() =>
  maxLayer.value <= 1 ? 100 : Math.max(0, Math.min(100, ((activeClipLayer.value - 1) / (maxLayer.value - 1)) * 100)),
)

const usedToolsList = computed(() => {
  const metaTools = metadata.value?.tools ?? []
  const parsedIds = new Set(model.value?.header?.usedTools ?? [])
  const combined = metaTools.filter(tool => tool.used || parsedIds.has(tool.id))
  if (combined.length) return combined
  return [...parsedIds].map(id => ({ id, type: null, name: null, color: null, temp: null, weight: null, used: true }))
})

const isToolchanger = computed(() => Boolean(props.status?.isToolchanger))
const showMultiToolUi = computed(() => isToolchanger.value || usedToolsList.value.length > 1)

// Pre-print Spoolman sanity warnings (1-tool)
const activeSpool = computed(() => props.status?.spoolman?.activeSpool ?? null)
const showInlineSpoolman = computed(
  () => !showMultiToolUi.value && Boolean(props.status?.spoolman?.available && props.status?.spoolman?.connected),
)

function normalizeMaterialToken(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

const prePrintWarnings = computed(() => {
  if (!showInlineSpoolman.value || !activeSpool.value || !metadata.value || isViewingActivePrint.value) return []
  const warnings = []
  const spool = activeSpool.value
  const neededWeight = metadata.value.filamentWeightTotal ?? metadata.value.tools?.[0]?.weight ?? null
  if (
    Number.isFinite(spool.remainingWeight) &&
    Number.isFinite(neededWeight) &&
    neededWeight > 0 &&
    spool.remainingWeight < neededWeight
  ) {
    const deficit = Math.max(0.1, neededWeight - spool.remainingWeight)
    warnings.push({
      id: 'weight',
      message: t('Spule reicht evtl. nicht: {0} g übrig, Druck benötigt {1} g (ca. {2} g fehlen).', [
        formatNumber(spool.remainingWeight, 0),
        formatNumber(neededWeight, 1),
        formatNumber(deficit, 1),
      ]),
    })
  }
  const slicedMat = metadata.value.tools?.[0]?.type
  const spoolMat = spool.material
  if (slicedMat && spoolMat) {
    const a = normalizeMaterialToken(spoolMat)
    const b = normalizeMaterialToken(slicedMat)
    if (a && b && a !== b && !a.startsWith(b) && !b.startsWith(a)) {
      warnings.push({
        id: 'material',
        message: t('Material-Abweichung: Geladene Spule ist {0}, Datei ist für {1} gesliced.', [spoolMat, slicedMat]),
      })
    }
  }
  return warnings
})

// Subfolder & search filtering for G-Code browser
const folders = computed(() => {
  const set = new Set()
  for (const file of files.value) {
    if (file.dir) set.add(file.dir)
  }
  return [...set].sort((a, b) => a.localeCompare(b))
})

const filteredFiles = computed(() => {
  const q = fileSearch.value.trim().toLowerCase()
  const dir = activeFolder.value
  let list = files.value.filter(file => {
    if (dir && file.dir !== dir) return false
    if (!q) return true
    return file.path.toLowerCase().includes(q)
  })
  if (fileSort.value === 'name') {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name, locale.value))
  }
  return list
})

const fileOptions = computed(() =>
  files.value.map(file => ({
    value: file.path,
    label: file.dir ? `${file.name} (${file.dir})` : file.name,
    sublabel: formatFileSize(file.size),
  })),
)

const thumbnailUrl = computed(() =>
  metadata.value?.thumbnail ? `/api/print/thumbnail?path=${encodeURIComponent(metadata.value.thumbnail)}` : '',
)

const progressPercent = computed(() =>
  isViewingActivePrint.value && Number.isFinite(props.status?.progress)
    ? Math.round(Math.max(0, Math.min(1, props.status.progress)) * 100)
    : null,
)

const remainingSeconds = computed(() => {
  if (!isViewingActivePrint.value) return null
  const elapsed = props.status?.printDuration
  const est = metadata.value?.estimatedTime
  const prog = props.status?.progress
  if (Number.isFinite(est) && Number.isFinite(elapsed) && est > elapsed) return est - elapsed
  if (Number.isFinite(elapsed) && Number.isFinite(prog) && prog > 0.02) return (elapsed / prog) * (1 - prog)
  return null
})

const printStatusBadge = computed(() => {
  if (isViewingActivePrint.value) {
    return props.status?.printState === 'paused' ? 'Pausiert' : 'Druckt'
  }
  return 'Dateivorschau'
})

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatShortDate(epochSec) {
  if (!Number.isFinite(epochSec)) return ''
  return new Date(epochSec * 1000).toLocaleDateString(locale.value, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs} h ${String(mins).padStart(2, '0')} min`
  if (mins > 0) return `${mins} min ${String(secs).padStart(2, '0')} s`
  return `${secs} s`
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'
}

function jobStatusLabel(value) {
  return (
    {
      completed: 'Abgeschlossen',
      cancelled: 'Abgebrochen',
      error: 'Fehler',
      klippy_shutdown: 'Abgebrochen',
      in_progress: 'Druckt',
    }[value] ?? value ?? 'Unbekannt'
  )
}

function decodeModelBinary(buffer) {
  const view = new DataView(buffer)
  const headerLength = view.getUint32(0, true)
  const headerText = new TextDecoder('utf-8').decode(new Uint8Array(buffer, 4, headerLength))
  const header = JSON.parse(headerText)
  const segments = new Float32Array(buffer, 4 + headerLength)
  return { header, segments }
}

async function loadFiles() {
  loadingFiles.value = true
  filesError.value = ''
  try {
    const response = await fetch('/api/print/files', { signal: AbortSignal.timeout(8000) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    files.value = data.files ?? []
    recentJobs.value = data.recentJobs ?? []

    if (activeFolder.value && !folders.value.includes(activeFolder.value)) {
      activeFolder.value = ''
    }

    if (props.requestedFile) {
      selectRecentJob(props.requestedFile)
    } else if (!selectedFile.value || !files.value.some(f => f.path === selectedFile.value)) {
      const activePath = isPrintActive.value ? props.status?.printFilename : ''
      if (activePath) {
        selectedFile.value = activePath
      } else if (recentJobs.value[0]?.filename && files.value.some(f => f.path === recentJobs.value[0].filename)) {
        selectedFile.value = recentJobs.value[0].filename
      } else if (files.value[0]?.path) {
        selectedFile.value = files.value[0].path
      } else {
        selectedFile.value = ''
      }
    }
  } catch (error) {
    filesError.value = error.message || 'Druckdateien nicht erreichbar.'
  } finally {
    loadingFiles.value = false
  }
}

async function loadQueue() {
  try {
    const res = await fetch('/api/print/queue', { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    if (data) queue.value = data
  } catch {
    // Job queue optional
  }
}

async function runQueueAction(payload) {
  if (!props.canWrite || queueBusy.value) return
  queueBusy.value = true
  queueError.value = ''
  try {
    const res = await fetch('/api/print/queue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Warteschlangen-Aktion fehlgeschlagen.')
    queue.value = data
    if (payload.action === 'add') {
      fileActionFeedback.value = {
        ok: true,
        message: t('{0} zur Warteschlange hinzugefügt.', [payload.filename.split('/').pop()]),
      }
    }
  } catch (err) {
    queueError.value = err.message || 'Warteschlangen-Aktion fehlgeschlagen.'
  } finally {
    queueBusy.value = false
  }
}

async function uploadGcodeFile(file) {
  if (!file || !props.canWrite || uploading.value) return
  if (!/\.(gcode|gco|g)$/i.test(file.name)) {
    fileActionFeedback.value = { ok: false, message: 'Bitte eine .gcode-, .gco- oder .g-Datei auswählen.' }
    return
  }
  if (file.size > 100 * 1024 * 1024) {
    fileActionFeedback.value = { ok: false, message: 'Die G-Code-Datei überschreitet das Limit von 100 MB.' }
    return
  }

  uploading.value = true
  uploadProgress.value = 0
  fileActionFeedback.value = { ok: true, message: t('Lade {0} hoch …', [file.name]) }

  try {
    // Buffer in memory first so macOS Safari never aborts on File-backed XHR bodies
    const arrayBuffer = await file.arrayBuffer()
    const targetDir = activeFolder.value || ''
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/print/upload')
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.setRequestHeader('X-Cockpit-Request', '1')
      xhr.setRequestHeader('X-Gcode-Filename', encodeURIComponent(file.name))
      if (targetDir) xhr.setRequestHeader('X-Gcode-Path', encodeURIComponent(targetDir))
      xhr.timeout = 120_000
      xhr.upload.onprogress = evt => {
        if (evt.lengthComputable && evt.total > 0) {
          uploadProgress.value = Math.min(99, Math.round((evt.loaded / evt.total) * 100))
        }
      }
      xhr.onload = () => {
        let parsed = {}
        try {
          parsed = JSON.parse(xhr.responseText || '{}')
        } catch {
          // Ignore malformed JSON
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          uploadProgress.value = 100
          resolve(parsed)
        } else {
          reject(new Error(parsed.error || `Upload fehlgeschlagen (HTTP ${xhr.status}).`))
        }
      }
      xhr.onerror = () => reject(new Error('Verbindungsfehler beim Hochladen.'))
      xhr.ontimeout = () => reject(new Error('Upload abgebrochen oder Zeitüberschreitung. Bitte erneut versuchen.'))
      xhr.send(arrayBuffer)
    })

    await loadFiles()
    if (data?.path) {
      selectedFile.value = data.path
    }
    fileActionFeedback.value = {
      ok: true,
      message: t('{0} hochgeladen und ausgewählt.', [data?.name || file.name]),
    }
  } catch (err) {
    fileActionFeedback.value = { ok: false, message: err.message || 'Upload fehlgeschlagen.' }
  } finally {
    uploading.value = false
    uploadProgress.value = 0
  }
}

function triggerUploadPicker() {
  uploadInputEl.value?.click()
}

function onUploadInputChange(event) {
  const file = event.target?.files?.[0]
  if (event.target) event.target.value = ''
  if (file) uploadGcodeFile(file)
}

function onDropGcode(event) {
  dragOver.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) uploadGcodeFile(file)
}

function isFileActivePrint(path) {
  return isPrintActive.value && props.status?.printFilename === path
}

async function requestOrDeleteFile(file) {
  if (!props.canWrite || isFileActivePrint(file.path)) return
  if (confirmDeletePath.value !== file.path) {
    confirmDeletePath.value = file.path
    clearTimeout(deleteConfirmTimer)
    deleteConfirmTimer = setTimeout(resetDeleteConfirm, 5000)
    return
  }
  resetDeleteConfirm()
  fileActionFeedback.value = null
  try {
    const res = await fetch(`/api/print/file?filename=${encodeURIComponent(file.path)}`, {
      method: 'DELETE',
      headers: { 'X-Cockpit-Request': '1' },
      signal: AbortSignal.timeout(8000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Datei konnte nicht gelöscht werden.')
    fileActionFeedback.value = { ok: true, message: t('{0} gelöscht.', [file.name]) }
    await loadFiles()
  } catch (err) {
    fileActionFeedback.value = { ok: false, message: err.message || 'Datei konnte nicht gelöscht werden.' }
  }
}

async function loadSelectedFile(filename) {
  fetchAbort?.abort()
  if (!filename) {
    metadata.value = null
    model.value = null
    modelError.value = ''
    return
  }

  fetchAbort = new AbortController()
  const signal = fetchAbort.signal
  modelLoading.value = true
  modelError.value = ''

  try {
    const metaRes = await fetch(`/api/print/metadata?filename=${encodeURIComponent(filename)}`, { signal })
    const metaData = await metaRes.json()
    if (!metaRes.ok) throw new Error(metaData.error)
    metadata.value = metaData

    const versionTag = `${metaData.size ?? ''}-${metaData.modified ?? ''}`
    const modelRes = await fetch(
      `/api/print/model?filename=${encodeURIComponent(filename)}&v=${encodeURIComponent(versionTag)}`,
      { signal },
    )
    if (!modelRes.ok) {
      const err = await modelRes.json().catch(() => ({}))
      throw new Error(err.error || '3D-Modell konnte nicht erstellt werden.')
    }
    const decoded = decodeModelBinary(await modelRes.arrayBuffer())
    model.value = decoded
    manualLayer.value = decoded.header.maxLayer || 1
    followLiveLayer.value = isPrintActive.value && filename === props.status?.printFilename
  } catch (error) {
    if (error.name !== 'AbortError') {
      modelError.value = error.message || '3D-Modell konnte nicht erstellt werden.'
      model.value = null
    }
  } finally {
    if (!signal.aborted) modelLoading.value = false
  }
}

function onLayerInput(event) {
  followLiveLayer.value = false
  manualLayer.value = Number(event.target.value)
}

function selectRecentJob(filename) {
  if (!files.value.some(f => f.path === filename)) {
    const idx = filename.lastIndexOf('/')
    files.value = [
      {
        path: filename,
        name: idx >= 0 ? filename.slice(idx + 1) : filename,
        dir: idx >= 0 ? filename.slice(0, idx) : '',
        size: null,
        modified: null,
      },
      ...files.value,
    ]
  }
  selectedFile.value = filename
}

watch(selectedFile, filename => {
  closeThumbnail()
  resetStartConfirm()
  loadSelectedFile(filename)
})

watch(
  () => props.requestedFile,
  filename => {
    if (filename && filename !== selectedFile.value) {
      selectRecentJob(filename)
    }
  },
)

watch(
  () => [props.status?.printState, props.status?.printFilename],
  ([printState, filename]) => {
    if (['printing', 'paused'].includes(printState)) {
      resetStartConfirm()
      if (filename && filename !== selectedFile.value) {
        selectRecentJob(filename)
        followLiveLayer.value = true
      }
    }
  },
)

onMounted(() => {
  loadFiles()
  loadQueue()
})

onBeforeUnmount(() => {
  fetchAbort?.abort()
  resetStartConfirm()
  resetDeleteConfirm()
})
</script>

<template>
  <section class="print-layout" :aria-label="t('Druckansicht')">
    <div
      class="print-scene-column"
      :class="{ 'drag-over': dragOver }"
      @dragover.prevent="canWrite && !uploading && (dragOver = true)"
      @dragleave="dragOver = false"
      @drop.prevent="onDropGcode"
    >
      <div class="print-file-bar">
        <div class="print-file-picker">
          <FileCode2 :size="16" class="print-file-icon" />
          <CockpitSelect
            v-model="selectedFile"
            :options="fileOptions"
            :aria-label="t('G-Code-Datei für 3D-Vorschau auswählen')"
            :placeholder="loadingFiles ? t('Druckdateien werden geladen …') : t('Druckdatei auswählen')"
            :disabled="loadingFiles || !fileOptions.length"
          />
        </div>
        <button
          class="subtle-button print-bar-btn"
          :class="{ active: fileDrawerOpen }"
          type="button"
          :aria-expanded="fileDrawerOpen"
          :title="t('Dateimanager ein- oder ausblenden')"
          @click="fileDrawerOpen = !fileDrawerOpen"
        >
          <FolderOpen :size="15" />
          <span>{{ t('Dateien') }} ({{ files.length }})</span>
        </button>
        <button
          v-if="canWrite"
          class="subtle-button print-bar-btn"
          type="button"
          :disabled="uploading"
          :title="t('.gcode-Datei auf den Drucker hochladen')"
          @click="triggerUploadPicker"
        >
          <Upload :size="15" />
          <span>{{ uploading ? `${uploadProgress} %` : t('Hochladen') }}</span>
        </button>
        <input
          ref="uploadInputEl"
          type="file"
          accept=".gcode,.gco,.g,text/plain"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          @change="onUploadInputChange"
        />
        <button
          class="icon-button"
          type="button"
          :disabled="loadingFiles"
          :title="t('Dateiliste aktualisieren')"
          :aria-label="t('Dateiliste aktualisieren')"
          @click="loadFiles(); loadQueue()"
        >
          <RefreshCw :size="16" :class="{ spinning: loadingFiles }" />
        </button>
      </div>

      <div v-if="uploading" class="print-upload-bar" role="status" aria-live="polite">
        <div class="print-upload-fill" :style="{ width: `${uploadProgress}%` }" />
      </div>

      <p
        v-if="fileActionFeedback"
        class="print-feedback-note"
        :class="fileActionFeedback.ok ? 'ok' : 'error'"
        :role="fileActionFeedback.ok ? 'status' : 'alert'"
      >
        {{ t(fileActionFeedback.message) }}
      </p>

      <p v-if="filesError" class="print-inline-error" role="alert">{{ t(filesError) }}</p>

      <!-- Expandable G-Code File Browser (Search, Subfolders, Upload Dropzone, Delete, Queue) -->
      <section v-if="fileDrawerOpen" class="print-browser-panel" :aria-label="t('G-Code-Dateimanager')">
        <div class="print-browser-controls">
          <label class="spoolman-search print-browser-search">
            <Search :size="14" />
            <input
              v-model="fileSearch"
              type="text"
              :placeholder="t('G-Code oder Ordner suchen …')"
              :aria-label="t('G-Code-Dateien durchsuchen')"
            />
          </label>
          <div class="segmented" role="group" :aria-label="t('Sortierung')">
            <button type="button" :aria-pressed="fileSort === 'modified'" @click="fileSort = 'modified'">
              {{ t('Neueste') }}
            </button>
            <button type="button" :aria-pressed="fileSort === 'name'" @click="fileSort = 'name'">
              {{ t('Name') }}
            </button>
          </div>
        </div>

        <div v-if="folders.length" class="print-folder-chips" role="group" :aria-label="t('Ordner filtern')">
          <button
            type="button"
            class="subtle-button"
            :class="{ active: activeFolder === '' }"
            @click="activeFolder = ''"
          >
            {{ t('Alle Ordner') }}
          </button>
          <button
            v-for="dir in folders"
            :key="dir"
            type="button"
            class="subtle-button"
            :class="{ active: activeFolder === dir }"
            @click="activeFolder = dir"
          >
            {{ dir }}
          </button>
        </div>

        <div v-if="!filteredFiles.length" class="print-browser-empty" role="status">
          {{ files.length ? t('Keine passende G-Code-Datei gefunden.') : t('Noch keine G-Code-Dateien vorhanden. Einfach per Drag & Drop ablegen.') }}
        </div>

        <ul v-else class="print-browser-list">
          <li
            v-for="file in filteredFiles"
            :key="file.path"
            class="print-browser-row"
            :class="{ selected: selectedFile === file.path }"
          >
            <button
              type="button"
              class="print-browser-select"
              @click="selectedFile = file.path"
            >
              <span class="print-browser-name">
                <strong>{{ file.name }}</strong>
                <span v-if="file.dir" class="print-dir-badge">{{ file.dir }}</span>
              </span>
              <span class="print-browser-meta">
                {{ formatFileSize(file.size) }}
                <template v-if="file.modified"> · {{ formatShortDate(file.modified) }}</template>
              </span>
            </button>

            <div class="print-browser-actions">
              <button
                v-if="queue.available && canWrite"
                type="button"
                class="icon-button"
                :disabled="queueBusy"
                :title="t('Zur Druck-Warteschlange hinzufügen')"
                :aria-label="t('{0} zur Warteschlange hinzufügen', [file.name])"
                @click="runQueueAction({ action: 'add', filename: file.path })"
              >
                <ListPlus :size="15" />
              </button>
              <button
                v-if="canWrite"
                type="button"
                :class="confirmDeletePath === file.path ? 'confirm-button print-delete-confirm' : 'icon-button'"
                :disabled="isFileActivePrint(file.path)"
                :title="
                  isFileActivePrint(file.path)
                    ? t('Aktive Druckdatei kann nicht gelöscht werden')
                    : confirmDeletePath === file.path
                      ? t('Erneut klicken, um endgültig zu löschen')
                      : t('Datei löschen')
                "
                :aria-label="
                  confirmDeletePath === file.path
                    ? t('{0} wirklich löschen?', [file.name])
                    : t('{0} löschen', [file.name])
                "
                @click="requestOrDeleteFile(file)"
                @keydown.esc="resetDeleteConfirm"
              >
                <Trash2 :size="14" />
                <span v-if="confirmDeletePath === file.path">{{ t('Löschen?') }}</span>
              </button>
            </div>
          </li>
        </ul>
      </section>

      <PrintScene
        :model="model"
        :loading="modelLoading"
        :error="modelError"
        :tool-colors="toolColors"
        :color-mode="showMultiToolUi ? colorMode : 'filament'"
        :show-color-mode-toggle="showMultiToolUi"
        :clip-layer="activeClipLayer"
        :show-ghost="showGhost"
        :show-support="showSupport"
        :is-live-job="isViewingActivePrint"
        :live-position="status?.position"
        :active-tool="status?.active"
        :exclude-objects="status?.excludeObjects"
        :bed-size="status?.bedSize"
        :printer-label="printerName"
        @update:color-mode="colorMode = $event"
        @update:show-support="showSupport = $event"
        @update:show-ghost="showGhost = $event"
        @reload="loadSelectedFile(selectedFile)"
      />

      <div v-if="model?.header?.maxLayer > 0" class="layer-scrubber">
        <div class="layer-scrubber-head">
          <span class="layer-scrubber-label">
            <Layers :size="14" />
            <strong>{{ t('Layer {0} / {1}', [activeClipLayer, maxLayer]) }}</strong>
            <span v-if="currentLayerZ != null" class="layer-scrubber-z">
              · {{ formatNumber(currentLayerZ, 2) }} mm
            </span>
            <span v-if="showMultiToolUi && layerRibbon.toolChanges > 0" class="layer-tool-changes">
              · {{ t('{0} Werkzeugwechsel', [layerRibbon.toolChanges]) }}
            </span>
          </span>
          <button
            v-if="isViewingActivePrint"
            type="button"
            class="subtle-button layer-live-toggle"
            :class="{ active: followLiveLayer }"
            @click="followLiveLayer = !followLiveLayer"
          >
            <Lock v-if="followLiveLayer" :size="13" />
            <Unlock v-else :size="13" />
            {{ followLiveLayer ? t('Live-Layer aktiv') : t('Live-Layer folgen') }}
          </button>
          <button
            v-else-if="activeClipLayer < maxLayer"
            type="button"
            class="subtle-button layer-live-toggle"
            @click="manualLayer = maxLayer"
          >
            {{ t('Alle Layer zeigen') }}
          </button>
        </div>
        <div
          v-if="showMultiToolUi && layerRibbon.bands.length"
          class="layer-tool-ribbon"
          aria-hidden="true"
        >
          <span
            v-for="(band, idx) in layerRibbon.bands"
            :key="`${band.startLayer}-${band.tool}-${idx}`"
            class="layer-tool-band"
            :style="{
              left: `${((band.startLayer - 1) / maxLayer) * 100}%`,
              width: `${Math.max(0.4, ((band.endLayer - band.startLayer + 1) / maxLayer) * 100)}%`,
              background: bandColor(band.tool),
            }"
            :title="
              band.startLayer === band.endLayer
                ? `T${band.tool} · Layer ${band.startLayer}`
                : `T${band.tool} · Layer ${band.startLayer}–${band.endLayer}`
            "
          />
          <span class="layer-ribbon-cursor" :style="{ left: `${activeLayerPercent}%` }" />
        </div>
        <input
          type="range"
          min="1"
          :max="maxLayer"
          step="1"
          :value="activeClipLayer"
          :aria-label="t('Sichtbare Schicht im 3D-Modell')"
          @input="onLayerInput"
        />
      </div>
    </div>

    <aside class="inspector print-inspector" :aria-label="t('Druckinformationen')">
      <div class="print-inspector-header">
        <div class="print-status-row">
          <span
            class="print-status-pill"
            :class="{
              printing: isViewingActivePrint && status?.printState === 'printing',
              paused: isViewingActivePrint && status?.printState === 'paused',
            }"
          >
            <Printer :size="13" />{{ t(printStatusBadge) }}
          </span>
          <span v-if="metadata?.slicer" class="print-slicer-tag">
            {{ metadata.slicer }}{{ metadata.slicerVersion ? ` ${metadata.slicerVersion}` : '' }}
          </span>
        </div>

        <div class="print-title-block">
          <button
            v-if="thumbnailUrl"
            type="button"
            class="print-thumbnail-button"
            :title="t('Vorschaubild vergrößern')"
            :aria-label="t('Vorschaubild vergrößern')"
            @click="openThumbnail"
          >
            <img
              :src="thumbnailUrl"
              class="print-thumbnail"
              width="64"
              height="64"
              :alt="metadata?.name || ''"
            />
            <span class="print-thumbnail-zoom" aria-hidden="true"><Expand :size="12" /></span>
          </button>
          <div class="print-title-copy">
            <h2>{{ metadata?.name || (selectedFile ? selectedFile.split('/').pop() : t('Kein Druck gewählt')) }}</h2>
            <p v-if="!isViewingActivePrint" class="print-preview-note">
              {{ t('Vorschau aus G-Code · kein aktiver Druck') }}
            </p>
          </div>
        </div>
      </div>

      <!-- Inline Spoolman Picker + Pre-Print Sanity Warnings (1-Tool) -->
      <div v-if="showInlineSpoolman" class="print-spoolman-block">
        <SpoolmanPicker
          :spoolman="status.spoolman"
          :online="online"
          :can-write="canWrite"
          @changed="emit('refresh')"
        />
        <div
          v-for="warn in prePrintWarnings"
          :key="warn.id"
          class="print-sanity-alert"
          role="alert"
        >
          <AlertTriangle :size="14" />
          <span>{{ warn.message }}</span>
        </div>
      </div>

      <div v-if="!isPrintActive && selectedFile" class="print-start-bar">
        <div v-if="confirmStart" class="print-confirm-row">
          <button
            type="button"
            class="focus-action print-start-confirm"
            :disabled="!!printStartReason"
            @click="requestOrStartPrint"
            @keydown.esc="resetStartConfirm"
          >
            <span>{{ t('Jetzt drucken?') }}</span>
            <Play :size="15" />
          </button>
          <button
            type="button"
            class="subtle-button print-confirm-cancel"
            :title="t('Abbrechen')"
            :aria-label="t('Abbrechen')"
            @click="resetStartConfirm"
          >
            <X :size="15" />
          </button>
        </div>
        <div v-else class="print-start-actions">
          <button
            type="button"
            class="focus-action print-start-btn"
            :disabled="!!printStartReason"
            :title="printStartReason ? t(printStartReason) : t('Ausgewählte Datei auf dem Drucker starten')"
            @click="requestOrStartPrint"
          >
            <span>{{ t('Druck starten') }}</span>
            <Play :size="15" />
          </button>
          <button
            v-if="queue.available && canWrite"
            type="button"
            class="subtle-button print-queue-add-btn"
            :disabled="queueBusy"
            :title="t('Zur Druck-Warteschlange hinzufügen')"
            :aria-label="t('Zur Druck-Warteschlange hinzufügen')"
            @click="runQueueAction({ action: 'add', filename: selectedFile })"
          >
            <ListPlus :size="15" />
          </button>
        </div>
      </div>

      <div v-else-if="isPrintActive && !isViewingActivePrint && status?.printFilename" class="print-start-bar">
        <button
          type="button"
          class="subtle-button print-jump-active"
          @click="selectRecentJob(status.printFilename)"
        >
          <Printer :size="14" />{{ t('Zum laufenden Druck wechseln') }}
        </button>
      </div>

      <div v-if="isViewingActivePrint" class="print-progress-card">
        <div class="print-progress-numbers">
          <strong>{{ progressPercent != null ? `${progressPercent} %` : '—' }}</strong>
          <span>
            <Clock :size="13" />
            {{
              remainingSeconds != null
                ? t('Restzeit ca. {0}', [formatDuration(remainingSeconds)])
                : formatDuration(status?.printDuration)
            }}
          </span>
        </div>
        <div v-if="progressPercent != null" class="print-job-track" aria-hidden="true">
          <div
            class="print-job-fill"
            :class="{ paused: status?.printState === 'paused' }"
            :style="{ width: `${progressPercent}%` }"
          />
        </div>
      </div>

      <LivePrintTuning
        v-if="isViewingActivePrint"
        :status="status"
        :online="online"
        :pending="pending"
        :send="send"
      />

      <dl class="measurements print-measurements">
        <div>
          <dt>{{ t('Layer') }}</dt>
          <dd>
            <template v-if="isViewingActivePrint && status?.printLayer != null">
              {{ status.printLayer }} / {{ status.printTotalLayers ?? metadata?.layerCount ?? maxLayer }}
            </template>
            <template v-else>{{ metadata?.layerCount ?? model?.header?.layerCount ?? '—' }}</template>
          </dd>
        </div>
        <div>
          <dt>{{ isViewingActivePrint ? t('Druckzeit') : t('Geschätzte Zeit') }}</dt>
          <dd>{{ formatDuration(isViewingActivePrint ? status?.printDuration : metadata?.estimatedTime) }}</dd>
        </div>
        <div v-if="isViewingActivePrint && metadata?.estimatedTime">
          <dt>{{ t('Geschätzte Zeit') }}</dt>
          <dd>{{ formatDuration(metadata.estimatedTime) }}</dd>
        </div>
        <div>
          <dt>{{ t('Modellhöhe / Schicht') }}</dt>
          <dd>
            {{ formatNumber(metadata?.objectHeight ?? model?.header?.bounds?.maxZ, 1) }} mm ·
            {{ formatNumber(metadata?.layerHeight ?? model?.header?.layerHeight, 2) }} mm
          </dd>
        </div>
        <div>
          <dt>Filament</dt>
          <dd>
            <template v-if="metadata?.filamentWeightTotal != null">
              {{ formatNumber(metadata.filamentWeightTotal, 1) }} g
              <span v-if="metadata.filamentTotal != null"> · {{ formatNumber(metadata.filamentTotal / 1000, 1) }} m</span>
            </template>
            <template v-else-if="isViewingActivePrint && status?.filamentUsed != null">
              {{ formatNumber(status.filamentUsed / 1000, 2) }} m
            </template>
            <template v-else>—</template>
          </dd>
        </div>
        <div v-if="metadata?.firstLayerBedTemp != null || metadata?.firstLayerExtrTemp != null">
          <dt>{{ t('Starttemperaturen') }}</dt>
          <dd>
            {{ metadata?.firstLayerExtrTemp != null ? `${Math.round(metadata.firstLayerExtrTemp)} °C` : '—' }}
            / {{ metadata?.firstLayerBedTemp != null ? `${Math.round(metadata.firstLayerBedTemp)} °C` : '—' }}
            <span v-if="metadata?.chamberTemp"> · {{ Math.round(metadata.chamberTemp) }} °C</span>
          </dd>
        </div>
      </dl>

      <section
        v-if="usedToolsList.length"
        class="print-tools-section"
        :aria-label="showMultiToolUi ? t('Verwendete Werkzeuge') : t('Filament')"
      >
        <h3>{{ showMultiToolUi ? t('Verwendete Werkzeuge') : t('Filament') }}</h3>
        <ul class="print-tool-list">
          <li
            v-for="tool in usedToolsList"
            :key="tool.id"
            class="print-tool-item"
            :class="{ active: showMultiToolUi && online && status?.detected === tool.id }"
          >
            <span
              class="print-tool-swatch"
              :style="{ background: tool.color ?? 'var(--muted)' }"
              :title="tool.color ?? ''"
            />
            <div class="print-tool-info">
              <strong>
                {{ showMultiToolUi ? `T${tool.id}` : t('Extruder') }}
                <span v-if="tool.type" class="print-tool-type">{{ tool.type }}</span>
                <span v-if="showMultiToolUi && online && status?.detected === tool.id" class="connected-tool-label">
                  {{ t('Aufgenommen') }}
                </span>
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

      <!-- Moonraker Job Queue (shown when available & non-empty) -->
      <section v-if="queue.available && queue.jobs.length" class="print-queue-section" :aria-label="t('Warteschlange')">
        <div class="print-queue-head">
          <h3><ListOrdered :size="14" />{{ t('Warteschlange') }} ({{ queue.jobs.length }})</h3>
          <div v-if="canWrite" class="print-queue-controls">
            <button
              v-if="queue.queueState === 'paused'"
              type="button"
              class="subtle-button"
              :disabled="queueBusy"
              :title="t('Warteschlange starten')"
              @click="runQueueAction({ action: 'start' })"
            >
              <Play :size="12" />{{ t('Start') }}
            </button>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="queueBusy"
              :title="t('Warteschlange pausieren')"
              @click="runQueueAction({ action: 'pause' })"
            >
              <Pause :size="12" />{{ t('Pause') }}
            </button>
            <button
              type="button"
              class="subtle-button"
              :disabled="queueBusy"
              :title="t('Warteschlange leeren')"
              @click="runQueueAction({ action: 'clear' })"
            >
              {{ t('Leeren') }}
            </button>
          </div>
        </div>
        <p v-if="queueError" class="print-inline-error" role="alert">{{ t(queueError) }}</p>
        <ul class="print-queue-list">
          <li v-for="(job, idx) in queue.jobs" :key="job.jobId || `${job.filename}-${idx}`" class="print-queue-item">
            <span class="print-queue-index">{{ idx + 1 }}</span>
            <button type="button" class="print-queue-name" @click="selectRecentJob(job.filename)">
              {{ job.name }}
            </button>
            <button
              v-if="canWrite && job.jobId"
              type="button"
              class="icon-button print-queue-remove"
              :disabled="queueBusy"
              :aria-label="t('{0} aus Warteschlange entfernen', [job.name])"
              @click="runQueueAction({ action: 'remove', jobId: job.jobId })"
            >
              <X :size="13" />
            </button>
          </li>
        </ul>
      </section>

      <details v-if="recentJobs.length" class="print-history">
        <summary>
          <span>{{ t('Letzte Druckjobs') }}</span>
          <ChevronRight :size="15" />
        </summary>
        <ul class="print-history-list">
          <li v-for="job in recentJobs" :key="job.jobId || job.filename">
            <button
              type="button"
              class="print-history-item"
              :class="{ selected: selectedFile === job.filename }"
              :disabled="job.fileExists === false"
              :title="job.fileExists === false ? t('Datei wurde gelöscht') : job.filename"
              @click="job.fileExists !== false && selectRecentJob(job.filename)"
            >
              <span class="print-history-name">{{ job.name }}</span>
              <span class="print-history-meta">
                {{ job.fileExists === false ? t('Entfernt') : t(jobStatusLabel(job.status)) }} · {{ formatDuration(job.printDuration) }}
              </span>
            </button>
          </li>
        </ul>
      </details>
    </aside>

    <dialog
      ref="thumbnailDialog"
      class="camera-dialog thumbnail-dialog"
      :aria-label="t('Vorschaubild')"
      @click="event => event.target === thumbnailDialog && closeThumbnail()"
    >
      <header>
        <h2>{{ metadata?.name || (selectedFile ? selectedFile.split('/').pop() : '') }}</h2>
        <button class="icon-button" type="button" :aria-label="t('Vorschaubild schließen')" @click="closeThumbnail">
          <X :size="20" />
        </button>
      </header>
      <div class="thumbnail-expanded-frame">
        <img v-if="thumbnailUrl" :src="thumbnailUrl" :alt="metadata?.name || ''" />
      </div>
      <p v-if="metadata?.slicer">
        {{ metadata.slicer }}{{ metadata.slicerVersion ? ` ${metadata.slicerVersion}` : '' }}
        <template v-if="metadata?.layerCount"> · {{ t('{0} Layer', [metadata.layerCount]) }}</template>
      </p>
    </dialog>
  </section>
</template>
