const number = value => (Number.isFinite(value) ? value : null)
const ALLOWED_DURATIONS = [600, 1800, 3600]
const SENSOR_LABELS = {
  chamber: 'Bauraum',
  raspberry_pi: 'Raspberry Pi',
  host: 'Host',
  octopus: 'Octopus',
  rp2350: 'RP2350',
  beacon_coil: 'Beacon-Spule',
  mcu: 'MCU',
  mcu_temp: 'MCU',
  skr_pico: 'SKR Pico',
}

function formatSeriesLabel(rawName) {
  const lower = String(rawName ?? '').trim().toLowerCase()
  if (Object.hasOwn(SENSOR_LABELS, lower)) return SENSOR_LABELS[lower]
  return String(rawName ?? '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
}

export function inferExtruderCountFromStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return 1
  let maxIdx = -1
  for (const key of Object.keys(store)) {
    if (key === 'extruder') maxIdx = Math.max(maxIdx, 0)
    else {
      const m = /^extruder([1-7])$/.exec(key)
      if (m) maxIdx = Math.max(maxIdx, Number(m[1]))
    }
  }
  return maxIdx >= 0 ? Math.min(8, maxIdx + 1) : 1
}

function heatersForCount(count) {
  const n = Number.isInteger(count) && count >= 1 && count <= 8 ? count : 6
  return [
    ...Array.from({ length: n }, (_, id) => ({
      id: id ? `extruder${id}` : 'extruder',
      label: n === 1 ? 'Extruder' : `T${id}`,
      kind: 'heater',
      defaultVisible: true,
    })),
    { id: 'heater_bed', label: 'Bett', kind: 'heater', defaultVisible: true },
  ]
}

function extraSeriesFromStore(store) {
  const extras = []
  for (const key of Object.keys(store)) {
    if (/^heater_generic [A-Za-z0-9_-]+$/.test(key)) {
      const name = key.slice(15)
      extras.push({
        id: key,
        label: formatSeriesLabel(name),
        kind: 'heater',
        defaultVisible: true,
      })
    } else if (/^temperature_fan .+$/.test(key)) {
      const name = key.slice(16)
      const isChamber = /chamber|bauraum|enclosure|nevermore/i.test(name)
      extras.push({
        id: key,
        label: formatSeriesLabel(name),
        kind: isChamber ? 'chamber' : 'sensor',
        defaultVisible: isChamber,
      })
    } else if (/^temperature_sensor .+$/.test(key) && !/^temperature_sensor T[0-7]$/.test(key)) {
      const name = key.slice(19)
      const isChamber = /chamber|bauraum|enclosure/i.test(name)
      extras.push({
        id: key,
        label: formatSeriesLabel(name),
        kind: isChamber ? 'chamber' : 'sensor',
        defaultVisible: isChamber,
      })
    }
  }
  const order = { heater: 0, chamber: 1, sensor: 2 }
  return extras.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.label.localeCompare(b.label))
}

// Moonraker's temperature store records one sample per second, oldest first.
// Keep gaps unknown and align series by their most recent sample.
export function temperatureHistory(
  store,
  sampledAt = new Date().toISOString(),
  { toolCount = null, duration = 600 } = {},
) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('Kein Temperaturverlauf erhalten.')
  }
  const safeDuration = ALLOWED_DURATIONS.includes(Number(duration)) ? Number(duration) : 600
  const step = safeDuration <= 600 ? 5 : safeDuration <= 1800 ? 15 : 30
  const seriesSpecs = [...heatersForCount(toolCount), ...extraSeriesFromStore(store)]

  return {
    sampledAt,
    duration: safeDuration,
    series: seriesSpecs.map(heater => {
      const values = store[heater.id]?.temperatures
      const targets = store[heater.id]?.targets
      if (!Array.isArray(values)) return { ...heater, points: [] }
      const start = Math.max(0, values.length - (safeDuration + 1))
      const points = []
      for (let i = start; i < values.length; i++) {
        const seconds = i - values.length + 1
        if (seconds % step !== 0) continue
        points.push({
          seconds,
          temperature: number(values[i]),
          target: number(targets?.[targets.length + seconds - 1]),
        })
      }
      return { ...heater, points }
    }),
  }
}
