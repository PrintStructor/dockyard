<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Crosshair,
  Flame,
  Grid2x2,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Terminal,
  Trash2,
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
const meshProfileDraft = ref('')
const pidExtruderTarget = ref(220)
const pidBedTarget = ref(60)

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

const liveBedScrews = computed(() => props.status?.bedScrews ?? data.value?.bedScrews ?? null)
const bedScrewsActive = computed(() => liveBedScrews.value?.isActive === true)
const hasBedScrewsSection = computed(() =>
  Boolean(data.value?.bedScrews?.configured || data.value?.screwsTilt?.configured || props.status?.bedScrews?.configured),
)
const hasPidOrProbeSection = computed(() =>
  Boolean(
    data.value?.capabilities?.pidExtruder ||
      data.value?.capabilities?.pidBed ||
      data.value?.capabilities?.probeAccuracy,
  ),
)
const pidExtruderMax = computed(() => data.value?.pidLimits?.extruderMax ?? props.status?.capabilities?.toolMax?.[0] ?? 295)
const pidBedMax = computed(() => data.value?.pidLimits?.bedMax ?? props.status?.capabilities?.bedMax ?? 120)
const validPidExtruder = computed(
  () => Number.isInteger(pidExtruderTarget.value) && pidExtruderTarget.value >= 40 && pidExtruderTarget.value <= pidExtruderMax.value,
)
const validPidBed = computed(
  () => Number.isInteger(pidBedTarget.value) && pidBedTarget.value >= 40 && pidBedTarget.value <= pidBedMax.value,
)
const validMeshProfileName = computed(() => /^[A-Za-z0-9._-]{1,48}$/.test(meshProfileDraft.value.trim()))

const hasShaperFoc = computed(() => Boolean(data.value?.capabilities?.shaperFoc))
const hasStandardShaper = computed(() => Boolean(data.value?.capabilities?.resonanceTester))
const hasShakeTuneMacros = computed(() =>
  Boolean(
    data.value?.capabilities?.shaketuneShaper ||
      data.value?.capabilities?.shaketuneBelts ||
      data.value?.capabilities?.shaketuneVibrations,
  ),
)
const shaperSubtitle = computed(() =>
  hasShaperFoc.value
    ? 'Aktive Resonanzdämpfung (FOC) und gespeicherte ShakeTune-Messdiagramme.'
    : 'Aktive Resonanzdämpfung, Input-Shaper-Messung und gespeicherte ShakeTune-Diagramme.',
)

const screwsTiltRows = computed(() => {
  const res = data.value?.screwsTilt?.results
  if (!res || typeof res !== 'object') return []
  return Object.entries(res).map(([key, item]) => ({
    key,
    name: item?.name || key,
    z: typeof item?.z === 'number' ? item.z : null,
    sign: item?.sign || '',
    adjust: item?.adjust || '00:00',
    isBase: item?.is_base === true,
  }))
})

async function saveMeshProfile() {
  const name = meshProfileDraft.value.trim()
  if (!validMeshProfileName.value || !data.value?.bedMesh?.active) return
  if (blockReason({ capKey: 'mesh' })) return
  const ok = await props.send({ action: 'mesh_profile_save', profile: name })
  if (ok) meshProfileDraft.value = ''
}

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
              {{ t('Nudge Voll XY') }}
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

            <button
              v-if="data?.bedMesh?.active"
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'mesh' })"
              :title="t('Aktives Bed Mesh entladen (BED_MESH_CLEAR)')"
              @click="runAction({ action: 'mesh_clear' }, { capKey: 'mesh' })"
            >
              <X :size="13" />{{ t('Mesh entladen') }}
            </button>
          </template>
        </div>

        <div
          v-if="data?.capabilities?.mesh && (data?.bedMesh?.profiles?.length || data?.bedMesh?.active)"
          class="mesh-profiles-bar"
          :aria-label="t('Bed-Mesh-Profile')"
        >
          <div v-if="data?.bedMesh?.profiles?.length" class="mesh-profile-chips">
            <span class="mesh-profiles-label">{{ t('Gespeicherte Profile') }}</span>
            <div v-for="prof in data.bedMesh.profiles" :key="prof" class="mesh-profile-chip-group">
              <button
                type="button"
                class="subtle-button mesh-profile-btn"
                :class="{ active: data.bedMesh.profileName === prof }"
                :disabled="!!blockReason({ capKey: 'mesh' })"
                :title="t('Profil „{0}“ laden', [prof])"
                @click="runAction({ action: 'mesh_profile_load', profile: prof }, { capKey: 'mesh' })"
              >
                <Check v-if="data.bedMesh.profileName === prof" :size="12" />{{ prof }}
              </button>
              <template v-if="confirmKey === `mesh_rm_${prof}`">
                <button
                  type="button"
                  class="danger-button mesh-profile-rm-confirm"
                  @click="runAction({ action: 'mesh_profile_remove', profile: prof }, { capKey: 'mesh' })"
                >
                  {{ t('Löschen?') }}
                </button>
                <button type="button" class="subtle-button mesh-profile-rm-btn" @click="cancelConfirm">
                  <X :size="12" />
                </button>
              </template>
              <button
                v-else
                type="button"
                class="subtle-button mesh-profile-rm-btn"
                :disabled="!!blockReason({ capKey: 'mesh' })"
                :aria-label="t('Profil „{0}“ entfernen', [prof])"
                :title="t('Profil „{0}“ entfernen', [prof])"
                @click="requestConfirm(`mesh_rm_${prof}`, { capKey: 'mesh' })"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </div>

          <form
            v-if="data?.bedMesh?.active"
            class="mesh-profile-save-form"
            @submit.prevent="saveMeshProfile"
          >
            <input
              v-model="meshProfileDraft"
              type="text"
              maxlength="48"
              :placeholder="t('Profilname (z. B. abs_110)')"
              :aria-label="t('Neuer Bed-Mesh-Profilname')"
              :disabled="!!blockReason({ capKey: 'mesh' })"
            />
            <button
              type="submit"
              class="subtle-button"
              :disabled="!validMeshProfileName || !!blockReason({ capKey: 'mesh' })"
              :title="t('Aktives Bed Mesh als Profil speichern')"
            >
              <Save :size="13" />{{ t('Profil speichern') }}
            </button>
          </form>
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

    <div
      v-if="hasBedScrewsSection || hasPidOrProbeSection"
      class="cal-two-col"
      :class="{ 'cal-single-col': !(hasBedScrewsSection && hasPidOrProbeSection) }"
    >
      <section v-if="hasBedScrewsSection" class="cal-section" :aria-label="t('Manuelles Bett-Leveling')">
        <div class="system-panel-head" style="margin-bottom: 0">
          <div>
            <h2>{{ t('Bett-Schrauben & Neigung') }}</h2>
            <p>{{ t('Geführtes 3-/4-Punkt-Bettleveling (BED_SCREWS_ADJUST) und Sonden-Schraubenprüfung.') }}</p>
          </div>
          <span
            v-if="bedScrewsActive"
            class="status-pill lime"
          >
            <Activity :size="12" />{{ t('Aktiv · {0} akzeptiert', [liveBedScrews?.acceptedScrews ?? 0]) }}
          </span>
        </div>

        <div v-if="data?.bedScrews?.screws?.length" class="screw-list-chips">
          <span v-for="screw in data.bedScrews.screws" :key="screw.index" class="status-pill muted">
            {{ screw.index }}. {{ screw.name }}
          </span>
        </div>

        <div v-if="bedScrewsActive" class="bed-screws-live-box" role="status">
          <p class="bed-screws-prompt">
            {{
              liveBedScrews?.state === 'fine'
                ? t('Feinabgleich aktiv: Papier-Test an der aktuellen Schraube prüfen.')
                : t('Grobabgleich aktiv: Schraube einstellen, dann „Nachgestellt“ oder „Akzeptieren“ wählen.')
            }}
          </p>
          <div class="cal-action-row">
            <button
              type="button"
              class="confirm-button"
              :disabled="!!blockReason()"
              @click="runAction({ action: 'bed_screws_accept' })"
            >
              <Check :size="14" />{{ t('Akzeptieren') }} (ACCEPT)
            </button>
            <button
              type="button"
              class="subtle-button"
              :disabled="!!blockReason()"
              @click="runAction({ action: 'bed_screws_adjusted' })"
            >
              <SlidersHorizontal :size="14" />{{ t('Nachgestellt') }} (ADJUSTED)
            </button>
            <button
              type="button"
              class="danger-button"
              :disabled="!!blockReason()"
              @click="runAction({ action: 'bed_screws_abort' })"
            >
              <X :size="14" />{{ t('Abbrechen') }} (ABORT)
            </button>
          </div>
        </div>

        <div v-else class="cal-action-row">
          <template v-if="data?.capabilities?.bedScrews">
            <template v-if="confirmKey === 'bed_screws_start'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'bed_screws_start' }, { capKey: 'bedScrews', requireHomed: true })"
              >
                {{ t('BED_SCREWS_ADJUST starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'bedScrews', requireHomed: true })"
              :title="t(blockReason({ capKey: 'bedScrews', requireHomed: true }) || 'Geführtes manuelles Bett-Leveling starten')"
              @click="requestConfirm('bed_screws_start', { capKey: 'bedScrews', requireHomed: true })"
            >
              <SlidersHorizontal :size="13" />{{ t('Bett-Schrauben ausrichten') }}
            </button>
          </template>

          <template v-if="data?.capabilities?.screwsTilt">
            <template v-if="confirmKey === 'screws_tilt'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'screws_tilt_calculate' }, { capKey: 'screwsTilt', requireHomed: true })"
              >
                {{ t('SCREWS_TILT_CALCULATE starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'screwsTilt', requireHomed: true })"
              :title="t(blockReason({ capKey: 'screwsTilt', requireHomed: true }) || 'Schrauben-Neigung per Sonde berechnen')"
              @click="requestConfirm('screws_tilt', { capKey: 'screwsTilt', requireHomed: true })"
            >
              <Crosshair :size="13" />{{ t('Schrauben-Neigung prüfen') }}
            </button>
          </template>
        </div>

        <div v-if="screwsTiltRows.length" class="cal-table-wrap">
          <table class="cal-table">
            <thead>
              <tr>
                <th>{{ t('Schraube') }}</th>
                <th>Z (mm)</th>
                <th>{{ t('Drehung') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in screwsTiltRows" :key="row.key">
                <td>{{ row.name }}</td>
                <td>{{ number(row.z, 4) }}</td>
                <td>{{ row.isBase ? t('Basis') : `${row.sign} ${row.adjust}` }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="hasPidOrProbeSection" class="cal-section" :aria-label="t('PID-Tuning & Sonde')">
        <div class="system-panel-head" style="margin-bottom: 0">
          <div>
            <h2>{{ t('PID-Tuning & Sonde') }}</h2>
            <p>{{ t('Heizregler für Extruder und Druckbett abstimmen oder Sonden-Wiederholgenauigkeit prüfen.') }}</p>
          </div>
        </div>

        <div class="pid-grid">
          <div v-if="data?.capabilities?.pidExtruder" class="pid-row">
            <div class="pid-row-label">
              <Flame :size="14" />
              <strong>{{ t('Extruder PID') }}</strong>
            </div>
            <label class="pid-input-wrap">
              <input
                v-model.number="pidExtruderTarget"
                type="number"
                min="40"
                :max="pidExtruderMax"
                step="5"
                inputmode="numeric"
                :aria-label="t('PID-Zieltemperatur Extruder in Grad Celsius')"
                :disabled="!!blockReason({ capKey: 'pidExtruder' })"
              />
              <span>°C</span>
            </label>
            <div class="confirm-inline">
              <template v-if="confirmKey === 'pid_extruder'">
                <button
                  type="button"
                  class="confirm-button"
                  @click="
                    runAction(
                      { action: 'calibrate_pid', heater: 'extruder', target: Math.round(pidExtruderTarget) },
                      { capKey: 'pidExtruder' },
                    )
                  "
                >
                  {{ t('PID bei {0} °C starten?', [Math.round(pidExtruderTarget)]) }}
                </button>
                <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
              </template>
              <button
                v-else
                type="button"
                class="subtle-button"
                :disabled="!validPidExtruder || !!blockReason({ capKey: 'pidExtruder' })"
                :title="t(blockReason({ capKey: 'pidExtruder' }) || 'PID_CALIBRATE für Extruder starten')"
                @click="requestConfirm('pid_extruder', { capKey: 'pidExtruder' })"
              >
                {{ t('PID starten') }}
              </button>
            </div>
          </div>

          <div v-if="data?.capabilities?.pidBed" class="pid-row">
            <div class="pid-row-label">
              <Flame :size="14" />
              <strong>{{ t('Druckbett PID') }}</strong>
            </div>
            <label class="pid-input-wrap">
              <input
                v-model.number="pidBedTarget"
                type="number"
                min="40"
                :max="pidBedMax"
                step="5"
                inputmode="numeric"
                :aria-label="t('PID-Zieltemperatur Druckbett in Grad Celsius')"
                :disabled="!!blockReason({ capKey: 'pidBed' })"
              />
              <span>°C</span>
            </label>
            <div class="confirm-inline">
              <template v-if="confirmKey === 'pid_bed'">
                <button
                  type="button"
                  class="confirm-button"
                  @click="
                    runAction(
                      { action: 'calibrate_pid', heater: 'heater_bed', target: Math.round(pidBedTarget) },
                      { capKey: 'pidBed' },
                    )
                  "
                >
                  {{ t('PID bei {0} °C starten?', [Math.round(pidBedTarget)]) }}
                </button>
                <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
              </template>
              <button
                v-else
                type="button"
                class="subtle-button"
                :disabled="!validPidBed || !!blockReason({ capKey: 'pidBed' })"
                :title="t(blockReason({ capKey: 'pidBed' }) || 'PID_CALIBRATE für Druckbett starten')"
                @click="requestConfirm('pid_bed', { capKey: 'pidBed' })"
              >
                {{ t('PID starten') }}
              </button>
            </div>
          </div>
        </div>

        <div class="cal-action-row">
          <template v-if="data?.capabilities?.probeAccuracy">
            <template v-if="confirmKey === 'probe_accuracy'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'probe_accuracy' }, { capKey: 'probeAccuracy', requireHomed: true })"
              >
                {{ t('PROBE_ACCURACY starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'probeAccuracy', requireHomed: true })"
              :title="t(blockReason({ capKey: 'probeAccuracy', requireHomed: true }) || 'Wiederholgenauigkeit der Z-Sonde prüfen (10 Proben)')"
              @click="requestConfirm('probe_accuracy', { capKey: 'probeAccuracy', requireHomed: true })"
            >
              <Crosshair :size="13" />{{ t('Probe-Genauigkeit') }}
            </button>
          </template>

          <button type="button" class="subtle-button" @click="emit('open-console')">
            <Terminal :size="13" />{{ t('Ergebnisse in der Konsole ansehen') }}
          </button>
        </div>
        <p class="muted" style="margin: 0">
          {{ t('Nach PID- oder Shaper-Läufen erscheint oben automatisch das SAVE_CONFIG-Banner.') }}
        </p>
      </section>
    </div>

    <section class="cal-section" :aria-label="t('Input Shaper & ShakeTune')">
      <div class="system-panel-head" style="margin-bottom: 0">
        <div>
          <h2>{{ t('Input Shaper & ShakeTune') }}</h2>
          <p>{{ t(shaperSubtitle) }}</p>
        </div>
        <div v-if="hasStandardShaper || hasShaperFoc || isToolchanger" class="cal-action-row">
          <div style="width: 112px">
            <CockpitSelect
              v-model="shaperAxis"
              :options="shaperAxisOptions"
              :aria-label="t('Shaper-Achse')"
              size="compact"
            />
          </div>

          <template v-if="hasStandardShaper">
            <template v-if="confirmKey === 'shaper_std'">
              <button
                type="button"
                class="confirm-button"
                @click="runAction({ action: 'calibrate_shaper', axis: shaperAxis }, { capKey: 'resonanceTester', requireHomed: true })"
              >
                {{ t('SHAPER_CALIBRATE starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="!!blockReason({ capKey: 'resonanceTester', requireHomed: true })"
              :title="t(blockReason({ capKey: 'resonanceTester', requireHomed: true }) || 'Standard-Resonanzmessung (SHAPER_CALIBRATE) starten')"
              @click="requestConfirm('shaper_std', { capKey: 'resonanceTester', requireHomed: true })"
            >
              <Activity :size="13" />{{ t('Shaper kalibrieren') }}
            </button>
          </template>

          <template v-if="hasShaperFoc || isToolchanger">
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
          </template>
        </div>
      </div>

      <div v-if="hasShakeTuneMacros" class="cal-action-row">
        <template v-if="data?.capabilities?.shaketuneShaper">
          <template v-if="confirmKey === 'st_shaper'">
            <button
              type="button"
              class="confirm-button"
              @click="runAction({ action: 'shaketune_shaper' }, { capKey: 'shaketuneShaper', requireHomed: true })"
            >
              {{ t('ShakeTune Achsen-Shaper starten?') }}
            </button>
            <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button"
            :disabled="!!blockReason({ capKey: 'shaketuneShaper', requireHomed: true })"
            :title="t(blockReason({ capKey: 'shaketuneShaper', requireHomed: true }) || 'AXES_SHAPER_CALIBRATION ausführen')"
            @click="requestConfirm('st_shaper', { capKey: 'shaketuneShaper', requireHomed: true })"
          >
            {{ t('ShakeTune · Achsen-Shaper') }}
          </button>
        </template>

        <template v-if="data?.capabilities?.shaketuneBelts">
          <template v-if="confirmKey === 'st_belts'">
            <button
              type="button"
              class="confirm-button"
              @click="runAction({ action: 'shaketune_belts' }, { capKey: 'shaketuneBelts', requireHomed: true })"
            >
              {{ t('ShakeTune Riemen-Vergleich starten?') }}
            </button>
            <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button"
            :disabled="!!blockReason({ capKey: 'shaketuneBelts', requireHomed: true })"
            :title="t(blockReason({ capKey: 'shaketuneBelts', requireHomed: true }) || 'COMPARE_BELTS_RESPONSES ausführen')"
            @click="requestConfirm('st_belts', { capKey: 'shaketuneBelts', requireHomed: true })"
          >
            {{ t('ShakeTune · Riemen-Vergleich') }}
          </button>
        </template>

        <template v-if="data?.capabilities?.shaketuneVibrations">
          <template v-if="confirmKey === 'st_vib'">
            <button
              type="button"
              class="confirm-button"
              @click="runAction({ action: 'shaketune_vibrations' }, { capKey: 'shaketuneVibrations', requireHomed: true })"
            >
              {{ t('ShakeTune Vibrationsprofil starten?') }}
            </button>
            <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button"
            :disabled="!!blockReason({ capKey: 'shaketuneVibrations', requireHomed: true })"
            :title="t(blockReason({ capKey: 'shaketuneVibrations', requireHomed: true }) || 'CREATE_VIBRATIONS_PROFILE ausführen')"
            @click="requestConfirm('st_vib', { capKey: 'shaketuneVibrations', requireHomed: true })"
          >
            {{ t('ShakeTune · Vibrationen') }}
          </button>
        </template>
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

    <dialog
      ref="lightboxDialog"
      class="camera-dialog shaketune-dialog"
      :aria-label="t('ShakeTune-Diagramm')"
      @click.self="closeChart"
    >
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
