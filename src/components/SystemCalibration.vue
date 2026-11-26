<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Crosshair,
  Grid2x2,
  RefreshCw,
  Terminal,
  X,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  status: { type: Object, default: null },
  online: Boolean,
  pending: Boolean,
  send: { type: Function, required: true },
})

const emit = defineEmits(['open-console'])

const data = ref(null)
const loading = ref(false)
const error = ref('')

const matrixMode = ref('xy') // 'xy' | 'z'
const selectedTool = ref('0')
const shaperAxis = ref('ALL')
const shakeFilter = ref('all') // 'all' | 'input_shaper' | 'belts' | 'vibrations'
const hoveredMeshCell = ref(null)

const lightboxChart = ref(null)
const lightboxDialog = ref(null)

const confirmKey = ref('')
let confirmTimer = null

onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
})

const isToolchanger = computed(() =>
  data.value ? Boolean(data.value.isToolchanger) : Boolean(props.status?.isToolchanger),
)

const hasBeaconSection = computed(() =>
  Boolean(
    isToolchanger.value ||
      data.value?.beacon?.model ||
      data.value?.beacon?.coilTemp != null ||
      data.value?.beacon?.lastFreq != null ||
      data.value?.capabilities?.gantryTwist ||
      data.value?.capabilities?.beaconPoke,
  ),
)

const geometrySubtitle = computed(() => {
  if (data.value?.qgl?.configured) return 'Quad Gantry Level und aktives Höhenprofil des Druckbetts.'
  if (data.value?.zTilt?.configured) return 'Z-Tilt-Ausrichtung und aktives Höhenprofil des Druckbetts.'
  return 'Geometrie und aktives Höhenprofil des Druckbetts.'
})

const toolCount = computed(() => data.value?.toolCount ?? 6)
const toolOptions = computed(() =>
  Array.from({ length: toolCount.value }, (_, id) => ({
    value: String(id),
    label: `T${id}`,
  })),
)

const shaperAxisOptions = computed(() => [
  { value: 'ALL', label: t('X + Y') },
  { value: 'X', label: t('Nur X') },
  { value: 'Y', label: t('Nur Y') },
])

async function fetchCalibration() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/api/system/calibration', { signal: AbortSignal.timeout(9000) })
    const json = await response.json()
    if (!response.ok) throw new Error(json.error || 'Kalibrierungsdaten nicht erreichbar.')
    data.value = json
  } catch (cause) {
    error.value = cause.message || 'Kalibrierungsdaten nicht erreichbar.'
  } finally {
    loading.value = false
  }
}

watch(
  () => props.status?.control?.lastResult?.id,
  () => {
    if (data.value) fetchCalibration()
  },
)

const isHomedXyz = computed(() => {
  const axes = props.status?.homedAxes ?? ''
  return ['x', 'y', 'z'].every(axis => axes.includes(axis))
})

const isPrintBlocked = computed(() => ['printing', 'paused'].includes(props.status?.printState))
const hasActiveJob = computed(() => Boolean(props.status?.control?.job))

function blockReason({ capKey = null, requireHomed = false, allowWhenBatch = false } = {}) {
  if (!props.online) return 'Nicht verbunden.'
  if (props.status?.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (isPrintBlocked.value) return 'Kalibrierung ist während eines aktiven oder pausierten Drucks gesperrt.'
  if (props.pending || (!allowWhenBatch && hasActiveJob.value)) return 'Ein anderer Befehl läuft noch.'
  if (capKey && !data.value?.capabilities?.[capKey]) return 'Makro auf diesem Drucker nicht konfiguriert.'
  if (requireHomed && !isHomedXyz.value) return 'Zuerst alle Achsen homen.'
  return ''
}

function requestConfirm(key, opts) {
  if (blockReason(opts)) return
  confirmKey.value = key
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => {
    confirmKey.value = ''
  }, 6000)
}

function cancelConfirm() {
  confirmKey.value = ''
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

async function runAction(command, opts = {}) {
  if (blockReason(opts)) return
  cancelConfirm()
  await props.send(command)
}

const number = (value, digits = 3) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'

const signed = (value, digits = 3) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${number(value, digits)}`
}

const formatExpansion = coeff =>
  typeof coeff === 'number' && Number.isFinite(coeff) ? `${number(coeff * 1000, 3)} µm/°C` : '—'

const formatFreq = hz =>
  typeof hz === 'number' && Number.isFinite(hz) ? `${number(hz / 1_000_000, 3)} MHz` : '—'

const formatDate = ts =>
  Number.isFinite(ts)
    ? new Date(ts * 1000).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' })
    : '—'

const meshCells = computed(() => {
  const mesh = data.value?.bedMesh
  if (!mesh?.active || !mesh.matrix?.length) return null
  const rows = mesh.matrix.length
  const cols = mesh.matrix[0]?.length ?? 0
  if (!cols) return null
  const min = mesh.min
  const span = Math.max(mesh.range || 0, 0.001)
  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = mesh.matrix[r][c]
      const norm = val == null ? 0.5 : Math.max(0, Math.min(1, (val - min) / span))
      // Flip Y so row 0 (front of bed) renders at the bottom of the SVG.
      cells.push({
        r,
        c,
        x: c,
        y: rows - 1 - r,
        value: val,
        fill: meshColor(norm),
      })
    }
  }
  return { rows, cols, cells }
})

function meshColor(norm) {
  // Restrained technical cockpit ramp: deep cool slate -> muted teal -> lime -> warm amber.
  const stops = [
    [35, 66, 82],
    [48, 92, 96],
    [102, 138, 72],
    [186, 224, 102],
    [235, 185, 108],
  ]
  const scaled = norm * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(scaled))
  const f = scaled - i
  const rgb = [0, 1, 2].map(k => Math.round(stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f))
  return `rgb(${rgb.join(',')})`
}

const filteredShakeTune = computed(() => {
  const items = data.value?.shakeTune ?? []
  return items
    .filter(item => shakeFilter.value === 'all' || item.category === shakeFilter.value)
    .slice(0, 12)
})

function shakeImageUrl(path) {
  return `/api/system/calibration/shaketune-image?path=${encodeURIComponent(path)}`
}

function categoryLabel(cat) {
  return (
    {
      input_shaper: 'Input Shaper',
      belts: 'Riemen',
      vibrations: 'Vibrationen',
    }[cat] ?? 'Sonstige'
  )
}

function openChart(item) {
  lightboxChart.value = item
  lightboxDialog.value?.showModal()
}

function closeChart() {
  lightboxDialog.value?.close()
}

onMounted(() => {
  fetchCalibration()
})
</script>

<template>
  <div class="cal-stack">
    <div v-if="error" class="system-banner amber" role="alert">
      <AlertTriangle :size="15" />
      <span>{{ t(error) }}</span>
      <div class="system-banner-actions">
        <button type="button" class="subtle-button" @click="fetchCalibration">{{ t('Erneut laden') }}</button>
      </div>
    </div>

    <div v-if="data?.beaconBatch?.running" class="system-banner amber" role="status">
      <Activity :size="16" />
      <span>
        {{
          t('Beacon-Batch läuft · {0}/{1} Messungen (Referenz T{2} → T{3})', [
            data.beaconBatch.totalMeasurements,
            data.beaconBatch.totalTarget,
            data.beaconBatch.currentInitial,
            data.beaconBatch.currentMeasure,
          ])
        }}
      </span>
      <div class="system-banner-actions">
        <template v-if="confirmKey === 'beacon_abort'">
          <button
            type="button"
            class="danger-button"
            @click="runAction({ action: 'calibrate_beacon_abort' }, { capKey: 'beaconAbort', allowWhenBatch: true })"
          >
            {{ t('Batch wirklich abbrechen?') }}
          </button>
          <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
        </template>
        <button
          v-else
          type="button"
          class="confirm-button"
          :disabled="!!blockReason({ capKey: 'beaconAbort', allowWhenBatch: true })"
          @click="requestConfirm('beacon_abort', { capKey: 'beaconAbort', allowWhenBatch: true })"
        >
          {{ t('Batch abbrechen') }}
        </button>
      </div>
    </div>

    <section v-if="isToolchanger" class="cal-section" :aria-label="t('Werkzeug-Offsets')">
      <div class="system-panel-head" style="margin-bottom: 0">
        <div>
          <h2>{{ t('Werkzeug-Offsets (T0–T{0})', [toolCount - 1]) }}</h2>
          <p>{{ t('Nudge XY, Beacon Z, thermische Düsen-Ausdehnung und Pressure Advance.') }}</p>
        </div>
        <div class="cal-header-meta">
          <span v-if="data?.nudgeRingClosure" class="status-pill lime">
            <Crosshair :size="12" />
            {{
              t('Ringschluss X {0} / Y {1} mm', [
                signed(data.nudgeRingClosure.x, 4),
                signed(data.nudgeRingClosure.y, 4),
              ])
            }}
          </span>
          <span v-if="data?.zReferenceTool != null" class="status-pill muted">
            {{ t('Z-Referenz: T{0}', [data.zReferenceTool]) }}
          </span>
          <button
            type="button"
            class="subtle-button"
            :disabled="loading"
            @click="fetchCalibration"
          >
            <RefreshCw :size="13" :class="{ spinning: loading }" />{{ t('Aktualisieren') }}
          </button>
        </div>
      </div>

      <div v-if="loading && !data" class="skeleton-block">
        <span class="skeleton-bar" />
        <span class="skeleton-bar" />
        <span class="skeleton-bar sm" />
      </div>

      <div v-else-if="data?.tools?.length" class="cal-table-wrap">
        <table class="cal-table">
          <thead>
            <tr>
              <th>{{ t('Tool') }}</th>
              <th>X (mm)</th>
              <th>Y (mm)</th>
              <th>Z (mm)</th>
              <th>ΔZ</th>
              <th>{{ t('Z-Anpassung') }}</th>
              <th>{{ t('Ausdehnung') }}</th>
              <th>PA</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tool in data.tools" :key="tool.id">
              <td>T{{ tool.id }}</td>
              <td>{{ signed(tool.offsets?.x, 3) }}</td>
              <td>{{ signed(tool.offsets?.y, 3) }}</td>
              <td>{{ signed(tool.offsets?.z, 4) }}</td>
              <td>{{ signed(tool.relativeZ, 4) }}</td>
              <td>{{ signed(tool.zAdjust, 4) }}</td>
              <td>{{ formatExpansion(tool.expansionCoeff) }}</td>
              <td>{{ number(tool.pressureAdvance, 3) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <details v-if="data" class="cal-matrix-details">
        <summary>
          <span>{{ t('{0}×{0}-Kalibrierungsmatrix (Nudge XY / Beacon Z)', [toolCount]) }}</span>
          <ChevronRight :size="15" />
        </summary>
        <div class="cal-matrix-controls">
          <div class="segmented" role="group" :aria-label="t('Matrix-Ansicht')">
            <button type="button" :aria-pressed="matrixMode === 'xy'" @click="matrixMode = 'xy'">
              Nudge XY (mm)
            </button>
            <button type="button" :aria-pressed="matrixMode === 'z'" @click="matrixMode = 'z'">
              Beacon Z (mm)
            </button>
          </div>
          <span>{{ t('Zeile = Referenz-Tool · Spalte = Ziel-Tool') }}</span>
        </div>
        <div class="cal-table-wrap">
          <table class="cal-table cal-matrix">
            <thead>
              <tr>
                <th>{{ t('Ref → Ziel') }}</th>
                <th v-for="j in toolCount" :key="j">T{{ j - 1 }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in toolCount" :key="i">
                <td>T{{ i - 1 }}</td>
                <td v-for="j in toolCount" :key="j" :class="{ diag: i === j }">
                  <template v-if="i === j">—</template>
                  <template v-else-if="matrixMode === 'xy'">
                    {{
                      data.nudgeXy?.[i - 1]?.[j - 1]
                        ? `${signed(data.nudgeXy[i - 1][j - 1][0], 3)} / ${signed(data.nudgeXy[i - 1][j - 1][1], 3)}`
                        : '—'
                    }}
                  </template>
                  <template v-else>
                    {{ signed(data.beaconZ?.[i - 1]?.[j - 1], 4) }}
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>

      <div class="cal-actions-grid">
        <div class="cal-action-card">
          <h3>{{ t('XY-Kalibrierung (Nudge)') }}</h3>
          <p>
            {{
              t(
                'Ring XY misst 12 Nachbarpaare mit Ausgleichsrechnung und beendet mit SAVE_CONFIG (Klipper-Neustart). Voll XY misst alle 30 Paare.',
              )
            }}
          </p>
          <div class="cal-action-row">
            <template v-if="confirmKey === 'nudge_ring'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_nudge_ring' }, { capKey: 'nudgeRing' })"
              >
                {{ t('Ring XY starten (inkl. SAVE_CONFIG)?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'nudgeRing' })"
              :title="t(blockReason({ capKey: 'nudgeRing' }) || '12 Paar-Messungen + SAVE_CONFIG')"
              @click="requestConfirm('nudge_ring', { capKey: 'nudgeRing' })"
            >
              Nudge Ring XY
            </button>

            <template v-if="confirmKey === 'nudge_all'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_nudge_all' }, { capKey: 'nudgeAll' })"
              >
                {{ t('Voll XY starten (30 Messungen)?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'nudgeAll' })"
              :title="t(blockReason({ capKey: 'nudgeAll' }) || 'Alle 30 Werkzeugpaare messen + SAVE_CONFIG')"
              @click="requestConfirm('nudge_all', { capKey: 'nudgeAll' })"
            >
              Nudge Voll XY
            </button>

            <template v-if="confirmKey === 'nudge_restore'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_nudge_restore' }, { capKey: 'nudgeRestore' })"
              >
                {{ t('Offsets aus variables.cfg laden?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'nudgeRestore' })"
              :title="t(blockReason({ capKey: 'nudgeRestore' }) || 'Gespeicherte Nudge-Werte wiederherstellen')"
              @click="requestConfirm('nudge_restore', { capKey: 'nudgeRestore' })"
            >
              {{ t('Offsets wiederherstellen') }}
            </button>
          </div>
        </div>

        <div class="cal-action-card">
          <h3>{{ t('Z- & Thermik-Kalibrierung (Beacon)') }}</h3>
          <p>{{ t('Misst Z-Offsets relativ zum gewählten Referenz-Tool oder die thermische Düsen-Ausdehnung.') }}</p>
          <div class="cal-action-row">
            <div class="cal-tool-select">
              <CockpitSelect
                v-model="selectedTool"
                :options="toolOptions"
                :aria-label="t('Referenz-Werkzeug')"
                size="compact"
              />
            </div>

            <template v-if="confirmKey === 'beacon_z'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_beacon_z', tool: Number(selectedTool) }, { capKey: 'beaconZ', requireHomed: true })"
              >
                {{ t('Beacon Z ab T{0} starten?', [selectedTool]) }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'beaconZ', requireHomed: true })"
              :title="t(blockReason({ capKey: 'beaconZ', requireHomed: true }) || 'Z-Offsets gegen Referenz-Tool messen')"
              @click="requestConfirm('beacon_z', { capKey: 'beaconZ', requireHomed: true })"
            >
              {{ t('Beacon Z (Referenz)') }}
            </button>

            <template v-if="confirmKey === 'beacon_all_z'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_beacon_all_z', probeTemp: 150 }, { capKey: 'beaconAllZ', requireHomed: true })"
              >
                {{ t('Beacon Z alle 30 Paare starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'beaconAllZ', requireHomed: true }) || data?.beaconBatch?.running"
              :title="t(blockReason({ capKey: 'beaconAllZ', requireHomed: true }) || 'Alle 30 Werkzeugpaare per Beacon messen')"
              @click="requestConfirm('beacon_all_z', { capKey: 'beaconAllZ', requireHomed: true })"
            >
              {{ t('Beacon Z alle Tools') }}
            </button>

            <template v-if="confirmKey === 'nozzle_exp'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_nozzle_expansion', tool: Number(selectedTool) }, { capKey: 'nozzleExpansion' })"
              >
                {{ t('Ausdehnung für T{0} messen?', [selectedTool]) }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'nozzleExpansion' })"
              :title="t(blockReason({ capKey: 'nozzleExpansion' }) || 'Thermischen Düsen-Ausdehnungskoeffizienten messen')"
              @click="requestConfirm('nozzle_exp', { capKey: 'nozzleExpansion' })"
            >
              {{ t('Düsen-Ausdehnung') }}
            </button>

            <template v-if="confirmKey === 'reset_z'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_reset_z_adjust' }, { capKey: 'resetZAdjust' })"
              >
                {{ t('Z-Anpassungen zurücksetzen?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'resetZAdjust' })"
              :title="t(blockReason({ capKey: 'resetZAdjust' }) || 'Alle Z-Feinanpassungen auf kalibrierte Werte zurücksetzen')"
              @click="requestConfirm('reset_z', { capKey: 'resetZAdjust' })"
            >
              {{ t('Z-Anpassungen zurücksetzen') }}
            </button>
          </div>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end">
        <button type="button" class="subtle-button" @click="emit('open-console')">
          <Terminal :size="14" />{{ t('Ergebnisse in der Konsole ansehen') }}
        </button>
      </div>
    </section>

    <div class="cal-two-col" :class="{ 'cal-single-col': !hasBeaconSection }">
      <section class="cal-section" :aria-label="t('Geometrie & Bett-Mesh')">
        <div class="system-panel-head" style="margin-bottom: 0">
          <div>
            <h2>{{ t('Geometrie & Bett-Mesh') }}</h2>
            <p>{{ t(geometrySubtitle) }}</p>
          </div>
          <div class="cal-header-meta">
            <span v-if="data?.qgl?.configured" class="status-pill" :class="data?.qgl?.applied ? 'lime' : 'muted'">
              <Check v-if="data?.qgl?.applied" :size="11" />
              {{ data?.qgl?.applied ? t('QGL ausgerichtet') : t('QGL offen') }}
            </span>
            <span v-else-if="data?.zTilt?.configured" class="status-pill" :class="data?.zTilt?.applied ? 'lime' : 'muted'">
              <Check v-if="data?.zTilt?.applied" :size="11" />
              {{ data?.zTilt?.applied ? t('Z-Tilt ausgerichtet') : t('Z-Tilt offen') }}
            </span>
            <button
              v-if="!isToolchanger"
              type="button"
              class="subtle-button"
              :disabled="loading"
              @click="fetchCalibration"
            >
              <RefreshCw :size="13" :class="{ spinning: loading }" />{{ t('Aktualisieren') }}
            </button>
          </div>
        </div>

        <dl v-if="data?.bedMesh?.config || data?.qgl?.configured || data?.zTilt?.configured" class="measurements" style="margin-top: 0">
          <div v-if="data?.bedMesh?.config?.probeCount">
            <dt>{{ t('Messraster') }}</dt>
            <dd>
              {{ data.bedMesh.config.probeCount[0] }} × {{ data.bedMesh.config.probeCount[1] }}
              <template v-if="data.bedMesh.config.algorithm"> · {{ data.bedMesh.config.algorithm }}</template>
            </dd>
          </div>
          <div v-if="data?.bedMesh?.config?.meshMin && data?.bedMesh?.config?.meshMax">
            <dt>{{ t('Messbereich') }}</dt>
            <dd>
              {{ number(data.bedMesh.config.meshMin[0], 0) }}/{{ number(data.bedMesh.config.meshMin[1], 0) }}
              → {{ number(data.bedMesh.config.meshMax[0], 0) }}/{{ number(data.bedMesh.config.meshMax[1], 0) }} mm
            </dd>
          </div>
          <div v-if="data?.bedMesh?.config?.zeroReference">
            <dt>{{ t('Nullreferenz') }}</dt>
            <dd>
              X {{ number(data.bedMesh.config.zeroReference[0], 1) }} / Y {{ number(data.bedMesh.config.zeroReference[1], 1) }} mm
            </dd>
          </div>
          <div v-if="data?.qgl?.retryTolerance != null">
            <dt>{{ t('QGL-Toleranz') }}</dt>
            <dd>
              {{ number(data.qgl.retryTolerance, 4) }} mm
              <template v-if="data.qgl.retries != null"> · {{ t('max. {0}×', [data.qgl.retries]) }}</template>
            </dd>
          </div>
          <div v-if="data?.zTilt?.retryTolerance != null">
            <dt>{{ t('Z-Tilt-Toleranz') }}</dt>
            <dd>
              {{ number(data.zTilt.retryTolerance, 4) }} mm
              <template v-if="data.zTilt.retries != null"> · {{ t('max. {0}×', [data.zTilt.retries]) }}</template>
            </dd>
          </div>
        </dl>

        <div v-if="data?.qgl?.configured || data?.zTilt?.configured || data?.capabilities?.fineQgl || data?.capabilities?.mesh || isToolchanger" class="cal-action-row">
          <template v-if="data?.qgl?.configured || isToolchanger">
            <template v-if="confirmKey === 'qgl'">
              <button type="button" class="confirm-button" @click="runAction({ action: 'qgl' }, { capKey: 'qgl', requireHomed: true })">
                {{ t('QGL starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'qgl', requireHomed: true })"
              :title="t(blockReason({ capKey: 'qgl', requireHomed: true }) || 'Quad Gantry Level ausführen')"
              @click="requestConfirm('qgl', { capKey: 'qgl', requireHomed: true })"
            >
              QGL
            </button>
          </template>

          <template v-if="data?.zTilt?.configured">
            <template v-if="confirmKey === 'z_tilt'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'z_tilt' }, { capKey: 'zTilt', requireHomed: true })"
              >
                {{ t('Z-Tilt starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'zTilt', requireHomed: true })"
              :title="t(blockReason({ capKey: 'zTilt', requireHomed: true }) || 'Z-Tilt ausrichten')"
              @click="requestConfirm('z_tilt', { capKey: 'zTilt', requireHomed: true })"
            >
              Z-Tilt
            </button>
          </template>

          <template v-if="data?.capabilities?.fineQgl || isToolchanger">
            <template v-if="confirmKey === 'fine_qgl'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_fine_qgl' }, { capKey: 'fineQgl', requireHomed: true })"
              >
                {{ t('Fein-QGL starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'fineQgl', requireHomed: true })"
              :title="t(blockReason({ capKey: 'fineQgl', requireHomed: true }) || 'Fein-QGL auf niedriger Z-Höhe')"
              @click="requestConfirm('fine_qgl', { capKey: 'fineQgl', requireHomed: true })"
            >
              {{ t('Fein-QGL') }}
            </button>
          </template>

          <template v-if="data?.capabilities?.mesh || isToolchanger">
            <template v-if="confirmKey === 'mesh'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'mesh' }, { capKey: 'mesh', requireHomed: true })"
              >
                {{ t('Bett vermessen starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'mesh', requireHomed: true })"
              :title="t(blockReason({ capKey: 'mesh', requireHomed: true }) || 'Bed Mesh neu vermessen')"
              @click="requestConfirm('mesh', { capKey: 'mesh', requireHomed: true })"
            >
              <Grid2x2 :size="13" />{{ t('Bett vermessen') }}
            </button>
          </template>
        </div>

        <template v-if="data?.bedMesh?.active && meshCells">
          <div class="mesh-stats-row">
            <div class="mesh-stat-box">
              <span>{{ t('Profil') }}</span>
              <strong>{{ data.bedMesh.profileName }}</strong>
            </div>
            <div class="mesh-stat-box">
              <span>Min</span>
              <strong>{{ signed(data.bedMesh.min, 3) }} mm</strong>
            </div>
            <div class="mesh-stat-box">
              <span>Max</span>
              <strong>{{ signed(data.bedMesh.max, 3) }} mm</strong>
            </div>
            <div class="mesh-stat-box">
              <span>{{ t('Spannweite') }}</span>
              <strong>{{ number(data.bedMesh.range, 3) }} mm</strong>
            </div>
          </div>

          <div class="mesh-heatmap-wrap">
            <svg
              class="mesh-heatmap"
              :viewBox="`0 0 ${meshCells.cols} ${meshCells.rows}`"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              :aria-label="t('2D-Bett-Mesh-Heatmap')"
              @mouseleave="hoveredMeshCell = null"
            >
              <rect
                v-for="cell in meshCells.cells"
                :key="`${cell.r}-${cell.c}`"
                :x="cell.x + 0.04"
                :y="cell.y + 0.04"
                width="0.92"
                height="0.92"
                rx="0.08"
                :fill="cell.fill"
                @mouseenter="hoveredMeshCell = cell"
              />
            </svg>
            <div class="mesh-heatmap-caption">
              <span v-if="hoveredMeshCell">
                {{
                  t('Punkt ({0}, {1}) · Z = {2} mm', [
                    hoveredMeshCell.c + 1,
                    hoveredMeshCell.r + 1,
                    signed(hoveredMeshCell.value, 4),
                  ])
                }}
              </span>
              <span v-else>{{ t('Maus über Messpunkte bewegen für exakten Z-Wert.') }}</span>
              <span>{{ meshCells.cols }} × {{ meshCells.rows }}</span>
            </div>
          </div>
        </template>
        <p v-else-if="data?.capabilities?.mesh || isToolchanger" class="muted" style="margin-top: 0">
          {{ t('Aktuell kein Bett-Mesh geladen. Starte „Bett vermessen“, um ein aktuelles Profil zu erzeugen.') }}
        </p>
        <p v-else-if="data?.qgl?.configured || data?.zTilt?.configured" class="muted" style="margin-top: 0">
          {{ t('Kein Bed Mesh konfiguriert.') }}
        </p>
        <p v-else class="muted" style="margin-top: 0">
          {{ t('Kein Bed Mesh oder motorisiertes Bett-Leveling konfiguriert.') }}
        </p>
      </section>

      <section v-if="hasBeaconSection" class="cal-section" :aria-label="t('Beacon-Sensor & Mechanik')">
        <div class="system-panel-head" style="margin-bottom: 0">
          <div>
            <h2>{{ t('Beacon & Mechanik') }}</h2>
            <p>{{ t('Kontakt-Sensor, Gantry-Verwindung und Wiederholgenauigkeit.') }}</p>
          </div>
        </div>

        <dl class="measurements" style="margin-top: 0">
          <div>
            <dt>{{ t('Beacon-Modell') }}</dt>
            <dd>{{ data?.beacon?.model ?? t('Unbekannt') }}</dd>
          </div>
          <div>
            <dt>{{ t('Spulentemperatur') }}</dt>
            <dd>{{ data?.beacon?.coilTemp != null ? `${number(data.beacon.coilTemp, 1)} °C` : '—' }}</dd>
          </div>
          <div>
            <dt>{{ t('Letzte Frequenz') }}</dt>
            <dd>{{ formatFreq(data?.beacon?.lastFreq) }}</dd>
          </div>
        </dl>

        <div class="cal-action-row">
          <template v-if="confirmKey === 'gantry_twist'">
            <button
              type="button"
              class="confirm-button"
              @click="runAction({ action: 'calibrate_gantry_twist' }, { capKey: 'gantryTwist' })"
            >
              {{ t('Gantry-Twist (9 Punkte) messen?') }}
            </button>
            <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button"
            :disabled="!!blockReason({ capKey: 'gantryTwist' })"
            :title="t(blockReason({ capKey: 'gantryTwist' }) || 'Gantry-Verwindung an 9 Punkten messen')"
            @click="requestConfirm('gantry_twist', { capKey: 'gantryTwist' })"
          >
            {{ t('Gantry-Twist messen') }}
          </button>

          <template v-if="confirmKey === 'beacon_poke'">
            <button
              type="button"
              class="confirm-button"
              @click="runAction({ action: 'calibrate_beacon_poke' }, { capKey: 'beaconPoke' })"
            >
              {{ t('Beacon Poke-Test starten?') }}
            </button>
            <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button"
            :disabled="!!blockReason({ capKey: 'beaconPoke' })"
            :title="t(blockReason({ capKey: 'beaconPoke' }) || 'Kontakt-Genauigkeit mit mehreren Proben testen')"
            @click="requestConfirm('beacon_poke', { capKey: 'beaconPoke' })"
          >
            {{ t('Beacon Poke-Test') }}
          </button>
        </div>
      </section>
    </div>

    <section class="cal-section" :aria-label="t('Input Shaper & ShakeTune')">
      <div class="system-panel-head" style="margin-bottom: 0">
        <div>
          <h2>{{ t('Input Shaper & ShakeTune') }}</h2>
          <p>{{ t('Aktive Resonanzdämpfung (FOC) und gespeicherte ShakeTune-Messdiagramme.') }}</p>
        </div>
        <div class="cal-action-row">
          <div style="width: 112px">
            <CockpitSelect
              v-model="shaperAxis"
              :options="shaperAxisOptions"
              :aria-label="t('Shaper-Achse')"
              size="compact"
            />
          </div>
          <template v-if="confirmKey === 'shaper_foc'">
            <button
              type="button"
              class="confirm-button"
              @click="runAction({ action: 'calibrate_shaper_foc', axis: shaperAxis }, { capKey: 'shaperFoc', requireHomed: true })"
            >
              {{ t('FOC-Shaper starten?') }}
            </button>
            <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button"
            :disabled="!!blockReason({ capKey: 'shaperFoc', requireHomed: true })"
            :title="t(blockReason({ capKey: 'shaperFoc', requireHomed: true }) || 'Resonanzmessung im FOC-Messmodus starten')"
            @click="requestConfirm('shaper_foc', { capKey: 'shaperFoc', requireHomed: true })"
          >
            <Activity :size="13" />{{ t('Shaper kalibrieren (FOC)') }}
          </button>
        </div>
      </div>

      <div class="shaper-cards">
        <div class="shaper-card">
          <span>{{ t('X-Achse') }}</span>
          <strong>
            {{ data?.inputShaper?.x?.type?.toUpperCase() || '—' }}
            <template v-if="data?.inputShaper?.x?.freq != null">
              · {{ number(data.inputShaper.x.freq, 1) }} Hz
            </template>
          </strong>
          <small>
            {{ t('Dämpfung') }}: {{ data?.inputShaper?.x?.damping != null ? number(data.inputShaper.x.damping, 3) : '—' }}
          </small>
        </div>
        <div class="shaper-card">
          <span>{{ t('Y-Achse') }}</span>
          <strong>
            {{ data?.inputShaper?.y?.type?.toUpperCase() || '—' }}
            <template v-if="data?.inputShaper?.y?.freq != null">
              · {{ number(data.inputShaper.y.freq, 1) }} Hz
            </template>
          </strong>
          <small>
            {{ t('Dämpfung') }}: {{ data?.inputShaper?.y?.damping != null ? number(data.inputShaper.y.damping, 3) : '—' }}
          </small>
        </div>
      </div>

      <div v-if="data?.shakeTune?.length" style="display: flex; flex-direction: column; gap: 12px">
        <div class="cal-matrix-controls" style="margin: 0">
          <div class="segmented" role="group" :aria-label="t('ShakeTune-Kategorie')">
            <button type="button" :aria-pressed="shakeFilter === 'all'" @click="shakeFilter = 'all'">
              {{ t('Alle') }}
            </button>
            <button
              type="button"
              :aria-pressed="shakeFilter === 'input_shaper'"
              @click="shakeFilter = 'input_shaper'"
            >
              Input Shaper
            </button>
            <button type="button" :aria-pressed="shakeFilter === 'belts'" @click="shakeFilter = 'belts'">
              {{ t('Riemen') }}
            </button>
            <button type="button" :aria-pressed="shakeFilter === 'vibrations'" @click="shakeFilter = 'vibrations'">
              {{ t('Vibrationen') }}
            </button>
          </div>
          <span>{{ t('{0} Diagramme angezeigt', [filteredShakeTune.length]) }}</span>
        </div>

        <div class="shaketune-grid">
          <button
            v-for="chart in filteredShakeTune"
            :key="chart.path"
            type="button"
            class="shaketune-card"
            @click="openChart(chart)"
          >
            <div class="shaketune-thumb">
              <img :src="shakeImageUrl(chart.path)" :alt="chart.name" loading="lazy" />
            </div>
            <div class="shaketune-meta">
              <strong :title="chart.name">{{ chart.name }}</strong>
              <small>{{ t(categoryLabel(chart.category)) }} · {{ formatDate(chart.modified) }}</small>
            </div>
          </button>
        </div>
      </div>
      <p v-else class="muted" style="margin-top: 0">{{ t('Keine ShakeTune-Diagramme vorhanden.') }}</p>
    </section>

    <dialog ref="lightboxDialog" class="camera-dialog shaketune-dialog" @click.self="closeChart">
      <header>
        <h2>{{ lightboxChart?.name }}</h2>
        <button type="button" class="icon-button" :aria-label="t('Schließen')" @click="closeChart">
          <X :size="18" />
        </button>
      </header>
      <img v-if="lightboxChart" :src="shakeImageUrl(lightboxChart.path)" :alt="lightboxChart.name" />
      <p v-if="lightboxChart">{{ t(categoryLabel(lightboxChart.category)) }} · {{ formatDate(lightboxChart.modified) }}</p>
    </dialog>
  </div>
</template>
