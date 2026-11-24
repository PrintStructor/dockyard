const heaters = [
  ...Array.from({ length: 6 }, (_, id) => ({ id: id ? `extruder${id}` : 'extruder', label: `T${id}` })),
  { id: 'heater_bed', label: 'Bett' },
]

const number = value => (Number.isFinite(value) ? value : null)

// Moonraker's temperature store records one sample per second, oldest first.
// Keep gaps unknown and align series by their most recent sample.
export function temperatureHistory(store, sampledAt = new Date().toISOString()) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('Kein Temperaturverlauf erhalten.')
  }
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
