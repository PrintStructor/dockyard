<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Printer, RefreshCw, Layers, Clock, FileCode2, ChevronRight, Lock, Unlock, Expand, X } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import CockpitSelect from './CockpitSelect.vue'
import PrintScene from './PrintScene.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  requestedFile: String,
})

const files = ref([])
const recentJobs = ref([])
const filesError = ref('')
const loadingFiles = ref(false)

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

const toolColors = computed(() =>
  Array.from({ length: 6 }, (_, id) => metadata.value?.tools?.[id]?.color ?? null),
)

const usedToolsList = computed(() => {
  const metaTools = metadata.value?.tools ?? []
  const parsedIds = new Set(model.value?.header?.usedTools ?? [])
  const combined = metaTools.filter(tool => tool.used || parsedIds.has(tool.id))
  if (combined.length) return combined
  return [...parsedIds].map(id => ({ id, type: null, name: null, color: null, temp: null, weight: null, used: true }))
})

const fileOptions = computed(() =>
  files.value.map(file => ({
    value: file.path,
    label: file.name,
    sublabel: file.size != null ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : '',
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

    if (props.requestedFile) {
      selectRecentJob(props.requestedFile)
    } else if (!selectedFile.value) {
      const activePath = isPrintActive.value ? props.status?.printFilename : ''
      if (activePath) {
        selectedFile.value = activePath
      } else if (recentJobs.value[0]?.filename && files.value.some(f => f.path === recentJobs.value[0].filename)) {
        selectedFile.value = recentJobs.value[0].filename
      } else if (files.value[0]?.path) {
        selectedFile.value = files.value[0].path
      }
    }
  } catch (error) {
    filesError.value = error.message || 'Druckdateien nicht erreichbar.'
  } finally {
    loadingFiles.value = false
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
    files.value = [{ path: filename, name: filename.split('/').pop(), size: null, modified: null }, ...files.value]
  }
  selectedFile.value = filename
}

watch(selectedFile, filename => {
  closeThumbnail()
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
    if (['printing', 'paused'].includes(printState) && filename && filename !== selectedFile.value) {
      selectRecentJob(filename)
      followLiveLayer.value = true
    }
  },
)

onMounted(() => {
  loadFiles()
})

onBeforeUnmount(() => {
  fetchAbort?.abort()
})
</script>

<template>
  <section class="print-layout" :aria-label="t('Druckansicht')">
    <div class="print-scene-column">
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
          class="icon-button"
          type="button"
          :disabled="loadingFiles"
          :title="t('Dateiliste aktualisieren')"
          :aria-label="t('Dateiliste aktualisieren')"
          @click="loadFiles"
        >
          <RefreshCw :size="16" :class="{ spinning: loadingFiles }" />
        </button>
      </div>

      <p v-if="filesError" class="print-inline-error" role="status">{{ t(filesError) }}</p>

      <PrintScene
        :model="model"
        :loading="modelLoading"
        :error="modelError"
        :tool-colors="toolColors"
        :color-mode="colorMode"
        :clip-layer="activeClipLayer"
        :show-ghost="showGhost"
        :show-support="showSupport"
        :is-live-job="isViewingActivePrint"
        :live-position="status?.position"
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

      <section v-if="usedToolsList.length" class="print-tools-section" :aria-label="t('Verwendete Werkzeuge')">
        <h3>{{ t('Verwendete Werkzeuge') }}</h3>
        <ul class="print-tool-list">
          <li
            v-for="tool in usedToolsList"
            :key="tool.id"
            class="print-tool-item"
            :class="{ active: online && status?.detected === tool.id }"
          >
            <span
              class="print-tool-swatch"
              :style="{ background: tool.color ?? '#8b9ba2' }"
              :title="tool.color ?? ''"
            />
            <div class="print-tool-info">
              <strong>
                T{{ tool.id }}
                <span v-if="tool.type" class="print-tool-type">{{ tool.type }}</span>
                <span v-if="online && status?.detected === tool.id" class="connected-tool-label">
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
              @click="selectRecentJob(job.filename)"
            >
              <span class="print-history-name">{{ job.name }}</span>
              <span class="print-history-meta">
                {{ t(jobStatusLabel(job.status)) }} · {{ formatDuration(job.printDuration) }}
              </span>
            </button>
          </li>
        </ul>
      </details>
    </aside>

    <dialog
      ref="thumbnailDialog"
      class="camera-dialog thumbnail-dialog"
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
