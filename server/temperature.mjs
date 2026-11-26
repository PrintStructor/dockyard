const number = value => (Number.isFinite(value) ? value : null)

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
    })),
    { id: 'heater_bed', label: 'Bett' },
  ]
}

// Moonraker's temperature store records one sample per second, oldest first.
// Keep gaps unknown and align series by their most recent sample.
export function temperatureHistory(store, sampledAt = new Date().toISOString(), { toolCount = null } = {}) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('Kein Temperaturverlauf erhalten.')
  }
  const heaters = heatersForCount(toolCount)
  return {
    sampledAt,
    duration: 600,
    series: heaters.map(heater => {
      const values = store[heater.id]?.temperatures
      const targets = store[heater.id]?.targets
      if (!Array.isArray(values)) return { ...heater, points: [] }
      const start = Math.max(0, values.length - 601)
      const points = []
      for (let i = start; i < values.length; i++) {
        const seconds = i - values.length + 1
        if (seconds % 5 !== 0) continue
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
