const list = value => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // Fall through to delimiter / single-value parsing.
  }
  if (trimmed.includes(';')) {
    return trimmed
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
  }
  return [trimmed]
}

const normalizeHexColor = value => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return `#${trimmed}`
  return null
}

export function materialsFromMetadata(metadata, filename, toolCount = 6) {
  const slots = Number.isInteger(toolCount) && toolCount >= 1 ? toolCount : 6
  if (!metadata || typeof metadata !== 'object') return Array(slots).fill(null)

  const types = list(metadata.filament_type)
  const names = list(metadata.filament_name)
  const colors = list(metadata.filament_colors)

  if (slots === 1) {
    const rawType = typeof types[0] === 'string' ? types[0].trim() : ''
    const rawColor = normalizeHexColor(colors[0])
    const rawName = typeof names[0] === 'string' && names[0].trim() ? names[0].trim().slice(0, 160) : null
    if (!rawType && !rawColor) return [null]
    return [
      {
        type: (rawType || 'Filament').slice(0, 80),
        name: rawName,
        color: rawColor,
        source: typeof metadata.slicer === 'string' && metadata.slicer.trim() ? metadata.slicer.trim().slice(0, 60) : 'Slicer',
        filename,
      },
    ]
  }

  if (metadata.slicer !== 'OrcaSlicer') return Array(slots).fill(null)

  // This printer's Orca profile exports six slots indexed T0–T5. A one-material
  // file does not establish which of six physical tools it belongs to.
  if (types.length !== slots || colors.length !== slots) return Array(slots).fill(null)

  return types.map((type, id) => ({
    type: String(type).slice(0, 80),
    name: typeof names[id] === 'string' ? names[id].slice(0, 160) : null,
    color: /^#[0-9a-f]{6}$/i.test(colors[id]) ? colors[id] : null,
    source: 'OrcaSlicer',
    filename,
  }))
}

export function createMaterialsReader(printerOrGetter, fetchImpl = fetch, onUpdate = null) {
  const resolvePrinter = () => (typeof printerOrGetter === 'function' ? printerOrGetter() : printerOrGetter)
  let key = ''
  let materials = Array(6).fill(null)
  let signature = ''
  let requestedAt = 0
  let pending = false
  let version = 0

  function apply(next) {
    const nextSignature = JSON.stringify(next)
    materials = next
    if (nextSignature !== signature) {
      signature = nextSignature
      onUpdate?.()
    }
  }

  function reset() {
    key = ''
    materials = Array(6).fill(null)
    signature = JSON.stringify(materials)
    requestedAt = 0
    pending = false
    version++
  }

  const read = (raw, toolCount = 6) => {
    const slots = Number.isInteger(toolCount) && toolCount >= 1 ? toolCount : 6
    const filename = ['printing', 'paused'].includes(raw.print_stats?.state) ? raw.print_stats.filename : ''
    const nextKey = filename ? `${slots}:${filename}` : ''
    if (nextKey !== key) {
      key = nextKey
      materials = Array(slots).fill(null)
      signature = JSON.stringify(materials)
      requestedAt = 0
      pending = false
      version++
    }
    if (filename && !pending && Date.now() - requestedAt > 15_000) {
      pending = true
      requestedAt = Date.now()
      const requestVersion = version
      fetchImpl(`${resolvePrinter()}/server/files/metadata?filename=${encodeURIComponent(filename)}`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      })
        .then(async response => {
          if (!response.ok) throw new Error('metadata')
          const data = await response.json()
          if (requestVersion === version) apply(materialsFromMetadata(data.result ?? {}, filename, slots))
        })
        .catch(() => {
          if (requestVersion === version) apply(Array(slots).fill(null))
        })
        .finally(() => {
          if (requestVersion === version) pending = false
        })
    }
    return materials
  }
  read.reset = reset
  return read
}
