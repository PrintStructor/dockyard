const list = value => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function materialsFromMetadata(metadata, filename) {
  if (metadata.slicer !== 'OrcaSlicer') return Array(6).fill(null)
  const types = list(metadata.filament_type)
  const names = list(metadata.filament_name)
  const colors = list(metadata.filament_colors)

  // This printer's Orca profile exports six slots indexed T0–T5. A one-material
  // file does not establish which of six physical tools it belongs to.
  if (types.length !== 6 || colors.length !== 6) return Array(6).fill(null)

  return types.map((type, id) => ({
    type: String(type).slice(0, 80),
    name: typeof names[id] === 'string' ? names[id].slice(0, 160) : null,
    color: /^#[0-9a-f]{6}$/i.test(colors[id]) ? colors[id] : null,
    source: 'OrcaSlicer',
    filename,
  }))
}

export function createMaterialsReader(printer, fetchImpl = fetch, onUpdate = null) {
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

  return raw => {
    const filename = ['printing', 'paused'].includes(raw.print_stats?.state) ? raw.print_stats.filename : ''
    if (filename !== key) {
      key = filename
      materials = Array(6).fill(null)
      signature = JSON.stringify(materials)
      requestedAt = 0
      pending = false
      version++
    }
    if (filename && !pending && Date.now() - requestedAt > 15_000) {
      pending = true
      requestedAt = Date.now()
      const requestVersion = version
      fetchImpl(`${printer}/server/files/metadata?filename=${encodeURIComponent(filename)}`, {
        signal: AbortSignal.timeout(5000),
      })
        .then(async response => {
          if (!response.ok) throw new Error('metadata')
          const data = await response.json()
          if (requestVersion === version) apply(materialsFromMetadata(data.result ?? {}, filename))
        })
        .catch(() => {
          if (requestVersion === version) apply(Array(6).fill(null))
        })
        .finally(() => {
          if (requestVersion === version) pending = false
        })
    }
    return materials
  }
}
