const DEFAULT_PRESETS = {
  ABS: { bed: 110, tool: 255 },
  PLA: { bed: 60, tool: 210 },
  PETG: { bed: 80, tool: 240 },
}

const PRESET_NAMES = ['ABS', 'PLA', 'PETG']

function parseTemp(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : null
}

function readMainsailValue(values, key) {
  const entry = values?.[key]
  if (!entry || entry.bool === false) return null
  return parseTemp(entry.value)
}

function findMainsailPreset(presetsMap, material) {
  if (!presetsMap || typeof presetsMap !== 'object') return null
  const entries = Object.values(presetsMap).filter(item => item && typeof item.name === 'string')
  const upper = material.toUpperCase()
  const exact = entries.find(item => item.name.trim().toUpperCase() === upper)
  const prefixed = exact ?? entries.find(item => item.name.trim().toUpperCase().startsWith(`${upper} `))
  if (!prefixed?.values) return null
  const bed = readMainsailValue(prefixed.values, 'heater_bed')
  const fallbackTool = readMainsailValue(prefixed.values, 'extruder')
  const tools = Array.from({ length: 6 }, (_, id) =>
    readMainsailValue(prefixed.values, id ? `extruder${id}` : 'extruder') ?? fallbackTool,
  )
  if (bed == null && tools.every(t => t == null)) return null
  return { name: upper, bed, tools }
}

function findLegacyPreset(legacyList, material) {
  if (!Array.isArray(legacyList)) return null
  const upper = material.toUpperCase()
  const preset = legacyList.find(entry => entry?.name?.trim?.().toUpperCase() === upper)
  if (!preset?.temps) return null
  const bed = parseTemp(preset.temps.heater_bed)
  const fallbackTool = parseTemp(preset.temps.extruder)
  const tools = Array.from({ length: 6 }, (_, id) =>
    parseTemp(preset.temps[id ? `extruder${id}` : 'extruder']) ?? fallbackTool,
  )
  if (bed == null && tools.every(t => t == null)) return null
  return { name: upper, bed, tools }
}

export function normalizePresets({ mainsail = null, legacy = null } = {}) {
  const mainsailMap = mainsail?.presets ?? mainsail
  return PRESET_NAMES.map(name => {
    const fromMainsail = findMainsailPreset(mainsailMap, name)
    if (fromMainsail) return fromMainsail
    const fromLegacy = findLegacyPreset(legacy, name)
    if (fromLegacy) return fromLegacy
    const fallback = DEFAULT_PRESETS[name]
    return {
      name,
      bed: fallback.bed,
      tools: Array.from({ length: 6 }, () => fallback.tool),
    }
  })
}
