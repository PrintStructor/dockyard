export function thermalDisplay({ temperature, target, power, maxTemperature, online }) {
  if (!online || !Number.isFinite(temperature) || !Number.isFinite(target)) {
    return { mode: 'unknown', label: 'Keine aktuellen Daten', fraction: 0, marker: null, scale: null }
  }

  const scale = Math.max(1, temperature, target, Number.isFinite(maxTemperature) ? maxTemperature : 0)
  let mode = 'idle'
  let label = 'Heizung aus'

  if (!Number.isFinite(power)) {
    mode = 'unknown'
    label = 'Heizstatus unbekannt'
  } else if (target > 0 && Math.abs(temperature - target) <= 2) {
    mode = 'holding'
    label = 'Am Ziel'
  } else if (target > 0 && temperature < target - 2) {
    if (power > 0) {
      mode = 'heating'
      label = 'Aufheizen'
    } else {
      mode = 'waiting'
      label = 'Wartet auf Wärme'
    }
  } else if (power === 0 && temperature > target + 2 && (target > 0 || temperature > 50)) {
    mode = 'cooling'
    label = 'Abkühlen'
  } else if (power > 0) {
    mode = 'heating'
    label = 'Heizt'
  }

  return {
    mode,
    label,
    scale,
    fraction: Math.max(0, Math.min(1, temperature / scale)),
    marker: target > 0 ? target / scale : null,
  }
}
