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

function findMainsailPreset(presetsMap, material, toolCount) {
  if (!presetsMap || typeof presetsMap !== 'object') return null
  const entries = Object.values(presetsMap).filter(item => item && typeof item.name === 'string')
  const upper = material.toUpperCase()
  const exact = entries.find(item => item.name.trim().toUpperCase() === upper)
  const prefixed = exact ?? entries.find(item => item.name.trim().toUpperCase().startsWith(`${upper} `))
  if (!prefixed?.values) return null
  const bed = readMainsailValue(prefixed.values, 'heater_bed')
  const fallbackTool = readMainsailValue(prefixed.values, 'extruder')
  const tools = Array.from({ length: toolCount }, (_, id) =>
    readMainsailValue(prefixed.values, id ? `extruder${id}` : 'extruder') ?? fallbackTool,
  )
  if (bed == null && tools.every(t => t == null)) return null
  return { name: upper, bed, tools }
}

function findLegacyPreset(legacyList, material, toolCount) {
  if (!Array.isArray(legacyList)) return null
  const upper = material.toUpperCase()
  const preset = legacyList.find(entry => entry?.name?.trim?.().toUpperCase() === upper)
  if (!preset?.temps) return null
  const bed = parseTemp(preset.temps.heater_bed)
  const fallbackTool = parseTemp(preset.temps.extruder)
  const tools = Array.from({ length: toolCount }, (_, id) =>
    parseTemp(preset.temps[id ? `extruder${id}` : 'extruder']) ?? fallbackTool,
  )
  if (bed == null && tools.every(t => t == null)) return null
  return { name: upper, bed, tools }
}

export function inferToolCountFromPresets(mainsail = null, legacy = null) {
  let maxIdx = -1
  const scanKeys = obj => {
    if (!obj || typeof obj !== 'object') return
    for (const key of Object.keys(obj)) {
      if (key === 'extruder') maxIdx = Math.max(maxIdx, 0)
      else {
        const m = /^extruder([1-7])$/.exec(key)
        if (m) maxIdx = Math.max(maxIdx, Number(m[1]))
      }
    }
  }
  const mainsailMap = mainsail?.presets ?? mainsail
  if (mainsailMap && typeof mainsailMap === 'object') {
    for (const entry of Object.values(mainsailMap)) {
      scanKeys(entry?.values)
    }
  }
  if (Array.isArray(legacy)) {
    for (const entry of legacy) {
      scanKeys(entry?.temps)
    }
  }
  return maxIdx >= 0 ? Math.min(8, maxIdx + 1) : null
}

function extractMainsailPreset(entry, toolCount) {
  if (!entry || typeof entry.name !== 'string' || !entry.values) return null
  const name = entry.name.trim()
  if (!name) return null
  const bed = readMainsailValue(entry.values, 'heater_bed')
  const fallbackTool = readMainsailValue(entry.values, 'extruder')
  const tools = Array.from({ length: toolCount }, (_, id) =>
    readMainsailValue(entry.values, id ? `extruder${id}` : 'extruder') ?? fallbackTool,
  )
  if (bed == null && tools.every(t => t == null)) return null
  return { name, bed, tools }
}

function extractLegacyPreset(entry, toolCount) {
  if (!entry || typeof entry.name !== 'string' || !entry.temps) return null
  const name = entry.name.trim()
  if (!name) return null
  const bed = parseTemp(entry.temps.heater_bed)
  const fallbackTool = parseTemp(entry.temps.extruder)
  const tools = Array.from({ length: toolCount }, (_, id) =>
    parseTemp(entry.temps[id ? `extruder${id}` : 'extruder']) ?? fallbackTool,
  )
  if (bed == null && tools.every(t => t == null)) return null
  return { name, bed, tools }
}

export function normalizePresets({ mainsail = null, legacy = null, toolCount = 6 } = {}) {
  const count = Number.isInteger(toolCount) && toolCount >= 1 && toolCount <= 8 ? toolCount : 6
  const mainsailMap = mainsail?.presets ?? mainsail
  const result = PRESET_NAMES.map(name => {
    const fromMainsail = findMainsailPreset(mainsailMap, name, count)
    if (fromMainsail) return fromMainsail
    const fromLegacy = findLegacyPreset(legacy, name, count)
    if (fromLegacy) return fromLegacy
    const fallback = DEFAULT_PRESETS[name]
    return {
      name,
      bed: fallback.bed,
      tools: Array.from({ length: count }, () => fallback.tool),
    }
  })

  const seen = new Set(result.map(item => item.name.toUpperCase()))
  const isCorePrefix = upper => PRESET_NAMES.some(core => upper === core || upper.startsWith(`${core} `))

  const extras = []
  if (mainsailMap && typeof mainsailMap === 'object') {
    for (const entry of Object.values(mainsailMap)) {
      const parsed = extractMainsailPreset(entry, count)
      if (!parsed) continue
      const upper = parsed.name.toUpperCase()
      if (seen.has(upper) || isCorePrefix(upper)) continue
      seen.add(upper)
      extras.push(parsed)
    }
  }
  if (Array.isArray(legacy)) {
    for (const entry of legacy) {
      const parsed = extractLegacyPreset(entry, count)
      if (!parsed) continue
      const upper = parsed.name.toUpperCase()
      if (seen.has(upper) || isCorePrefix(upper)) continue
      seen.add(upper)
      extras.push(parsed)
    }
  }

  return [...result, ...extras].slice(0, 12)
}

export function applyMainsailPresetMutation(currentDb, payload) {
  const action = payload?.action
  if (!['upsert', 'delete'].includes(action)) {
    throw new Error('Ungültige Preset-Aktion (erlaubt: upsert oder delete).')
  }
  const existingMap =
    currentDb?.presets && typeof currentDb.presets === 'object'
      ? { ...currentDb.presets }
      : currentDb && typeof currentDb === 'object' && !Array.isArray(currentDb)
        ? { ...currentDb }
        : {}

  const name = String(payload?.name ?? '').trim()
  if (!name || name.length > 32 || /[\r\n\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Preset-Name muss zwischen 1 und 32 Zeichen lang sein.')
  }
  const upper = name.toUpperCase()
  const existingKey = Object.keys(existingMap).find(
    k => typeof existingMap[k]?.name === 'string' && existingMap[k].name.trim().toUpperCase() === upper,
  )

  if (action === 'delete') {
    if (!existingKey) throw new Error('Preset wurde nicht gefunden.')
    delete existingMap[existingKey]
    return currentDb?.presets ? { ...currentDb, presets: existingMap } : { presets: existingMap }
  }

  const extruder = payload?.extruder != null && payload.extruder !== '' ? Number(payload.extruder) : null
  const bed = payload?.bed != null && payload.bed !== '' ? Number(payload.bed) : null
  if (extruder == null && bed == null) {
    throw new Error('Mindestens Extruder- oder Betttemperatur angeben.')
  }
  if (extruder != null && (!Number.isInteger(extruder) || extruder < 0 || extruder > 360)) {
    throw new Error('Extruder-Preset muss zwischen 0 und 360 °C liegen.')
  }
  if (bed != null && (!Number.isInteger(bed) || bed < 0 || bed > 160)) {
    throw new Error('Bett-Preset muss zwischen 0 und 160 °C liegen.')
  }

  const id = existingKey ?? `dockyard_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || Date.now()}`
  const prevValues = existingMap[id]?.values && typeof existingMap[id].values === 'object' ? existingMap[id].values : {}
  existingMap[id] = {
    ...(existingMap[id] ?? {}),
    name,
    gcode: typeof existingMap[id]?.gcode === 'string' ? existingMap[id].gcode : '',
    values: {
      ...prevValues,
      extruder: { bool: extruder != null, type: 'heater', value: extruder ?? 0 },
      heater_bed: { bool: bed != null, type: 'heater', value: bed ?? 0 },
    },
  }
  return currentDb?.presets ? { ...currentDb, presets: existingMap } : { presets: existingMap }
}
