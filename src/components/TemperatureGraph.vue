<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { ChartNoAxesCombined } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'

const props = defineProps({
  online: Boolean,
  status: Object,
})

const history = ref(null)
const error = ref('')
const hidden = ref(new Set())
const showTargets = ref(false)
const plot = ref(null)
const plotWidth = ref(366)
const plotHeight = ref(230)
const hoverSeconds = ref(null)

let resizeObserver = null
let timer = null
let request = null
let disposed = false
let lastSampleMs = 0

watch(plot, element => {
  resizeObserver?.disconnect()
  if (!element) return
  const bounds = element.getBoundingClientRect()
  plotWidth.value = bounds.width || 366
  plotHeight.value = bounds.height || 230
  resizeObserver = new ResizeObserver(entries => {
    const rect = entries[0].contentRect
    if (rect.width > 0) plotWidth.value = rect.width
    if (rect.height > 0) plotHeight.value = rect.height
  })
  resizeObserver.observe(element)
})

const timeTicks = computed(() => (plotWidth.value >= 600 ? [-600, -480, -360, -240, -120, 0] : [-600, -300, 0]))
const colors = ['#c5f76b', '#6ed5e7', '#bca3ff', '#f3c67b', '#ff9a83', '#ed9fc8', '#edf1ed']

async function refresh() {
  if (disposed || document.hidden || request) return
  request = new AbortController()
  try {
    const response = await fetch('/api/temperature-history', {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(7000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    history.value = data
    lastSampleMs = data.sampledAt ? new Date(data.sampledAt).getTime() : Date.now()
    error.value = ''
  } catch {
    if (!disposed) error.value = 'Temperaturverlauf nicht erreichbar. Neuer Versuch automatisch.'
  } finally {
    request = null
  }
}

// Smoothly append live SSE temperature points every >= 5 s between authoritative 10 s polls.
watch(
  () => props.status?.at,
  at => {
    if (!props.online || !at || !history.value?.series?.length) return
    const nowMs = new Date(at).getTime()
    if (!Number.isFinite(nowMs) || nowMs - lastSampleMs < 5000) return
    const dt = Math.round((nowMs - lastSampleMs) / 1000)
    if (dt < 5 || dt > 60) return
    lastSampleMs = nowMs

    const liveById = {
      heater_bed: props.status.bed,
      ...Object.fromEntries(
        (props.status.tools ?? []).map((tool, id) => [id ? `extruder${id}` : 'extruder', tool]),
      ),
    }

    history.value = {
      ...history.value,
      sampledAt: at,
      series: history.value.series.map(item => {
        const current = liveById[item.id]
        const shifted = item.points
          .map(point => ({ ...point, seconds: point.seconds - dt }))
          .filter(point => point.seconds >= -600)
        shifted.push({
          seconds: 0,
          temperature: Number.isFinite(current?.temperature) ? current.temperature : null,
          target: Number.isFinite(current?.target) ? current.target : null,
        })
        return { ...item, points: shifted }
      }),
    }
  },
)

function visibilityChanged() {
  if (!document.hidden) refresh()
}

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 10_000)
  document.addEventListener('visibilitychange', visibilityChanged)
})

onBeforeUnmount(() => {
  disposed = true
  resizeObserver?.disconnect()
  clearInterval(timer)
  request?.abort()
  document.removeEventListener('visibilitychange', visibilityChanged)
})

const series = computed(() => (history.value?.series ?? []).map((item, i) => ({ ...item, color: colors[i] })))
const visible = computed(() => series.value.filter(item => !hidden.value.has(item.id)))
const hasData = computed(() => series.value.some(item => item.points.some(point => point.temperature != null)))

const maximum = computed(() => {
  const values = visible.value
    .flatMap(item =>
      item.points.flatMap(point => (showTargets.value ? [point.temperature, point.target] : [point.temperature])),
    )
    .filter(Number.isFinite)
  return Math.max(50, Math.ceil((Math.max(0, ...values) + 5) / 50) * 50)
})

const ticks = computed(() => [0, maximum.value / 2, maximum.value])
const y = value => plotHeight.value - 29 - (value / maximum.value) * (plotHeight.value - 49)
const x = seconds => 38 + ((600 + seconds) / 600) * (plotWidth.value - 52)

function path(points, field) {
  let connected = false
  return points
    .map(point => {
      if (!Number.isFinite(point[field])) {
        connected = false
        return ''
      }
      const segment = `${connected ? 'L' : 'M'}${x(point.seconds).toFixed(1)},${y(point[field]).toFixed(1)}`
      connected = true
      return segment
    })
    .join(' ')
}

function toggle(id) {
  const next = new Set(hidden.value)
  next.has(id) ? next.delete(id) : next.add(id)
  hidden.value = next
}

function onPointerMove(event) {
  if (!plot.value || !visible.value.length) return
  const rect = plot.value.getBoundingClientRect()
  if (!rect.width) return
  const svgX = ((event.clientX - rect.left) / rect.width) * plotWidth.value
  const clamped = Math.max(38, Math.min(plotWidth.value - 14, svgX))
  const approxSeconds = ((clamped - 38) / Math.max(1, plotWidth.value - 52)) * 600 - 600

  let bestSeconds = null
  let bestDelta = Infinity
  for (const item of visible.value) {
    for (const point of item.points) {
      const delta = Math.abs(point.seconds - approxSeconds)
      if (delta < bestDelta) {
        bestDelta = delta
        bestSeconds = point.seconds
      }
    }
  }
  hoverSeconds.value = bestSeconds
}

function onPointerLeave() {
  hoverSeconds.value = null
}

function formatOffset(seconds) {
  if (seconds === 0) return t('Datenstand')
  const abs = Math.abs(Math.round(seconds))
  const mins = Math.floor(abs / 60)
  const secs = abs % 60
  if (mins === 0) return `−${secs} s`
  return secs === 0 ? `−${mins} min` : `−${mins}:${String(secs).padStart(2, '0')} min`
}

const formatTemp = value =>
  Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : '—'

const hoverData = computed(() => {
  if (hoverSeconds.value == null || !visible.value.length) return null
  const seconds = hoverSeconds.value
  const xPos = x(seconds)
  const items = visible.value
    .map(item => {
      let best = null
      let bestDelta = 3
      for (const point of item.points) {
        const delta = Math.abs(point.seconds - seconds)
        if (delta <= bestDelta) {
          bestDelta = delta
          best = point
        }
      }
      if (!best) return null
      return {
        id: item.id,
        label: item.label,
        color: item.color,
        temperature: best.temperature,
        target: best.target,
        yPos: Number.isFinite(best.temperature) ? y(best.temperature) : null,
      }
    })
    .filter(Boolean)

  if (!items.length) return null
  return {
    seconds,
    timeLabel: formatOffset(seconds),
    xPos,
    alignRight: xPos > plotWidth.value * 0.58,
    items,
  }
})

const updated = computed(() =>
  history.value?.sampledAt
    ? new Date(history.value.sampledAt).toLocaleTimeString(locale.value, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '',
)
</script>

<template>
  <article class="control-panel temperature-graph">
    <div class="graph-heading">
      <h2><ChartNoAxesCombined :size="18" />{{ t('Temperaturverlauf') }}</h2>
      <p
        class="graph-caption"
        :title="online && !error ? t('Aktualisierung alle zehn Sekunden') : t('Zuletzt empfangene Werte')"
      >
        {{ t('10 Minuten ·') }} {{ online && !error ? 'Live' : t('zuletzt') }}
        <span v-if="updated">{{ updated }}</span>
      </p>
    </div>

    <template v-if="hasData">
      <div class="graph-stage" @pointerleave="onPointerLeave">
        <svg
          ref="plot"
          class="graph-plot"
          :viewBox="`0 0 ${plotWidth} ${plotHeight}`"
          role="img"
          :aria-label="
            t('Temperaturverlauf der ausgewählten Werkzeuge und des Druckbetts in Grad Celsius über zehn Minuten')
          "
          @pointermove="onPointerMove"
        >
          <text x="8" y="11">°C</text>
          <g v-for="tick in ticks" :key="tick">
            <line class="graph-grid" x1="38" :x2="plotWidth - 14" :y1="y(tick)" :y2="y(tick)" />
            <text x="29" :y="y(tick) + 4" text-anchor="end">{{ tick }}</text>
          </g>
          <g v-for="item in visible" :key="item.id">
            <path class="graph-trace" :stroke="item.color" :d="path(item.points, 'temperature')" />
            <path
              v-if="showTargets"
              class="graph-trace target"
              :stroke="item.color"
              :d="path(item.points, 'target')"
            />
          </g>
          <g v-if="hoverData" class="graph-hover-layer">
            <line
              class="graph-crosshair"
              :x1="hoverData.xPos"
              :x2="hoverData.xPos"
              y1="14"
              :y2="plotHeight - 29"
            />
            <circle
              v-for="item in hoverData.items"
              v-show="item.yPos != null"
              :key="`dot-${item.id}`"
              :cx="hoverData.xPos"
              :cy="item.yPos ?? 0"
              r="3.2"
              :fill="item.color"
              stroke="#111618"
              stroke-width="1.2"
            />
          </g>
          <text
            v-for="seconds in timeTicks"
            :key="seconds"
            :x="x(seconds)"
            :y="plotHeight - 7"
            :text-anchor="seconds === -600 ? 'start' : seconds === 0 ? 'end' : 'middle'"
          >
            {{ seconds === 0 ? t('Datenstand') : `−${-seconds / 60} min` }}
          </text>
        </svg>

        <div
          v-if="hoverData"
          class="graph-tooltip"
          :class="{ 'align-right': hoverData.alignRight }"
          :style="{ left: `${(hoverData.xPos / Math.max(1, plotWidth)) * 100}%` }"
        >
          <div class="graph-tooltip-time">{{ hoverData.timeLabel }}</div>
          <div class="graph-tooltip-grid">
            <div v-for="item in hoverData.items" :key="item.id" class="graph-tooltip-row">
              <span class="graph-tooltip-dot" :style="{ background: item.color }" />
              <span class="graph-tooltip-label">{{ t(item.label) }}</span>
              <strong class="graph-tooltip-value">
                {{ formatTemp(item.temperature) }} °C
                <small v-if="showTargets && item.target != null">/ {{ Math.round(item.target) }}</small>
              </strong>
            </div>
          </div>
        </div>
      </div>

      <div class="graph-footer">
        <div class="graph-legend" :aria-label="t('Temperaturkurven auswählen')">
          <button
            v-for="item in series"
            :key="item.id"
            type="button"
            :aria-pressed="!hidden.has(item.id)"
            :style="{ '--series-color': item.color }"
            @click="toggle(item.id)"
          >
            <span aria-hidden="true" />{{ t(item.label) }}
          </button>
        </div>
        <label class="graph-options">
          <input v-model="showTargets" type="checkbox" />{{ t('Zieltemperaturen gestrichelt') }}
        </label>
      </div>
      <p v-if="!visible.length" class="graph-caption">{{ t('Kurve über die Legende auswählen') }}</p>
    </template>

    <p v-else class="graph-empty">
      {{ error ? t(error) : history ? t('Noch keine Temperaturmesswerte vorhanden.') : t('Temperaturverlauf wird geladen …') }}
    </p>
    <p v-if="hasData && error" class="graph-caption graph-error" role="status">{{ t(error) }}</p>
  </article>
</template>
