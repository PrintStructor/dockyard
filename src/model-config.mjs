export const MODEL_PRESETS = ['auto', 'stormtrooper-6tc', 'stealthburner', 'mini-stealthburner', 'custom', 'none']
export const DEFAULT_ACCENT_COLOR = '#c5f76b'
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

export const ACCENT_SWATCHES = [
  { id: 'voron-red', label: 'VORON-Rot', hex: '#d62828' },
  { id: 'acid-lime', label: 'Acid-Lime', hex: '#c5f76b' },
  { id: 'arctic-white', label: 'Arctic-Weiß', hex: '#dce6e2' },
  { id: 'signal-amber', label: 'Signal-Amber', hex: '#f3c67b' },
  { id: 'cobalt-blue', label: 'Kobaltblau', hex: '#3b82f6' },
  { id: 'violet', label: 'Violett', hex: '#9b5de5' },
  { id: 'graphite', label: 'Graphit', hex: '#495860' },
]

export const TEMPLATE_URLS = {
  stealthburner: '/models/templates/stealthburner.glb',
  'mini-stealthburner': '/models/templates/mini-stealthburner.glb',
}

export function normalizeAccentColor(raw, fallback = DEFAULT_ACCENT_COLOR) {
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim().toLowerCase()
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : fallback
}

function templateSource(templateId) {
  return {
    url: TEMPLATE_URLS[templateId],
    sourceKind: 'template',
    templateId,
    label: templateId === 'mini-stealthburner' ? 'Mini-StealthBurner' : 'StealthBurner',
  }
}

function customSource(printerId, slot, meta) {
  if (!printerId || !meta || typeof meta !== 'object') return null
  const version = meta.updatedAt ? `?v=${encodeURIComponent(meta.updatedAt)}` : ''
  return {
    url: `/api/models/${encodeURIComponent(printerId)}/${slot}${version}`,
    sourceKind: 'custom',
    filename: meta.filename || `${slot}.glb`,
    bytes: Number.isFinite(meta.bytes) ? meta.bytes : 0,
    updatedAt: meta.updatedAt || '',
    etag: meta.etag || '',
    label: meta.filename || `${slot}.glb`,
  }
}

export function resolveSceneConfig(printerProfile, status, { settingsLoaded = true } = {}) {
  if (!settingsLoaded || !printerProfile) return { kind: 'none' }

  const presetRaw = String(printerProfile.model?.preset ?? 'auto').trim().toLowerCase()
  const preset = MODEL_PRESETS.includes(presetRaw) ? presetRaw : 'auto'
  const accentColor = normalizeAccentColor(printerProfile.model?.accentColor, DEFAULT_ACCENT_COLOR)
  const printerId = printerProfile.id
  const customModels = printerProfile.customModels ?? {}
  const customPrinter = customSource(printerId, 'printer', customModels.printer)
  const customToolhead = customSource(printerId, 'toolhead', customModels.toolhead)

  if (preset === 'none') return { kind: 'none' }

  if (preset === 'stormtrooper-6tc') {
    if (!status || (Boolean(status.isToolchanger) && status.toolCount === 6)) {
      return { kind: 'stormtrooper-6tc' }
    }
    return { kind: 'none' }
  }

  if (preset === 'stealthburner' || preset === 'mini-stealthburner') {
    return {
      kind: 'printer-scene',
      effectivePreset: preset,
      accentColor,
      defaultView: 'toolhead',
      emptyCustom: false,
      views: {
        toolhead: templateSource(preset),
        printer: customPrinter,
      },
    }
  }

  if (preset === 'custom') {
    const emptyCustom = !customToolhead && !customPrinter
    return {
      kind: 'printer-scene',
      effectivePreset: 'custom',
      accentColor,
      defaultView: customToolhead ? 'toolhead' : 'printer',
      emptyCustom,
      views: {
        toolhead: customToolhead,
        printer: customPrinter,
      },
    }
  }

  // preset === 'auto'
  if (!status) return { kind: 'none' }

  if (status.isToolchanger && status.toolCount === 6) {
    return { kind: 'stormtrooper-6tc' }
  }

  if (!status.isToolchanger && status.toolCount === 1) {
    const bedWidth = Number(status.bedSize?.width)
    const templateId = Number.isFinite(bedWidth) && bedWidth > 0 && bedWidth <= 165 ? 'mini-stealthburner' : 'stealthburner'
    return {
      kind: 'printer-scene',
      effectivePreset: templateId,
      accentColor,
      defaultView: 'toolhead',
      emptyCustom: false,
      views: {
        toolhead: templateSource(templateId),
        printer: customPrinter,
      },
    }
  }

  // Non-6-TC toolchangers and multi-extruder non-toolchangers (e.g. IDEX)
  if (customToolhead || customPrinter) {
    return {
      kind: 'printer-scene',
      effectivePreset: 'custom',
      accentColor,
      defaultView: customToolhead ? 'toolhead' : 'printer',
      emptyCustom: false,
      views: {
        toolhead: customToolhead,
        printer: customPrinter,
      },
    }
  }

  return { kind: 'none' }
}
