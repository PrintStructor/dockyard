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

export function nozzleThermalGlow(temperature, online = true) {
  if (!online || !Number.isFinite(temperature) || temperature < 50) {
    return { active: false, bucket: 0, intensity: 0, tipHex: '#000000', poolHex: '#000000' }
  }
  const bucket = Math.min(300, Math.floor(temperature / 5) * 5)
  const norm = Math.min(1, Math.max(0, (bucket - 50) / 230))
  if (bucket < 110) {
    return {
      active: true,
      bucket,
      intensity: +(0.18 + norm * 0.85).toFixed(3),
      tipHex: '#c46c3b',
      poolHex: '#944a24',
    }
  }
  if (bucket < 200) {
    return {
      active: true,
      bucket,
      intensity: +(0.32 + norm * 0.65).toFixed(3),
      tipHex: '#e39b52',
      poolHex: '#c87c35',
    }
  }
  return {
    active: true,
    bucket,
    intensity: +(0.52 + norm * 0.42).toFixed(3),
    tipHex: '#f8d594',
    poolHex: '#f3c67b',
  }
}
