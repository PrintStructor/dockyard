const MAX_SEGMENTS = 220_000
const INITIAL_CAPACITY = 32_768
const MAX_CACHE_ENTRIES = 3

const SURFACE_TYPES = new Set([
  'outer wall',
  'overhang wall',
  'top surface',
  'bottom surface',
  'bridge',
  'prime tower',
  'wipe tower',
  'external perimeter',
  'overhang perimeter',
  'top solid infill',
  'bottom solid infill',
  'solid infill',
  'perimeter',
])

const SUPPORT_TYPES = new Set([
  'support',
  'support interface',
  'support material',
  'support material interface',
  'support transition',
])

export function validateGcodeFilename(filename) {
  if (typeof filename !== 'string') return null
  const trimmed = filename.trim()
  if (!trimmed || trimmed.length > 300) return null
  if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return null
  if (trimmed.startsWith('/') || trimmed.includes('..')) return null
  if (!/\.(gcode|gco|g)$/i.test(trimmed)) return null
  return trimmed
}

export function validateThumbnailPath(relPath) {
  if (typeof relPath !== 'string') return null
  const trimmed = relPath.trim()
  if (!trimmed || trimmed.length > 400) return null
  if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return null
  if (trimmed.startsWith('/') || trimmed.includes('..')) return null
  if (!/\.(png|jpg|jpeg|webp)$/i.test(trimmed)) return null
  return trimmed
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) return [value]
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'string' || typeof parsed === 'number') return [parsed]
  } catch {
    // Plain or semicolon-delimited slicer strings (Orca/Prusa/SuperSlicer single-tool)
  }
  return trimmed
    .split(';')
    .map(part => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

export function normalizePrintMetadata(metadata = {}, filename = '') {
  const types = parseJsonList(metadata.filament_type)
  const names = parseJsonList(metadata.filament_name)
  const colors = parseJsonList(metadata.filament_colors)
  const temps = parseJsonList(metadata.filament_temps)
  const weights = parseJsonList(metadata.filament_weights)
  const num = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
    return null
  }

  const tools = Array.from({ length: 6 }, (_, id) => {
    const weight = num(weights[id])
    const rawColor = typeof colors[id] === 'string' ? colors[id].trim() : ''
    const normalizedColor = /^#[0-9a-f]{6}$/i.test(rawColor)
      ? rawColor
      : /^[0-9a-f]{6}$/i.test(rawColor)
        ? `#${rawColor}`
        : null
    return {
      id,
      type: typeof types[id] === 'string' && types[id].trim() ? types[id].trim().slice(0, 80) : null,
      name: typeof names[id] === 'string' && names[id].trim() ? names[id].trim().slice(0, 160) : null,
      color: normalizedColor,
      temp: num(temps[id]),
      weight,
      used: weight != null && weight > 0,
    }
  })

  const totalWeight = num(metadata.filament_weight_total)
  const firstExtrTemp = num(metadata.first_layer_extr_temp)
  if (!tools.some(item => item.used)) {
    const t0 = tools[0]
    const hasSingleToolMeta =
      (totalWeight != null && totalWeight > 0) || Boolean(t0.type || t0.name || t0.color)
    if (hasSingleToolMeta) {
      t0.used = true
      if (t0.weight == null && totalWeight != null && totalWeight > 0) t0.weight = totalWeight
      if (t0.temp == null && firstExtrTemp != null && firstExtrTemp > 0) t0.temp = firstExtrTemp
    }
  }

  const thumbnails = Array.isArray(metadata.thumbnails) ? metadata.thumbnails : []
  const bestThumb = [...thumbnails]
    .filter(item => item?.relative_path && validateThumbnailPath(item.relative_path))
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]

  return {
    filename: filename || metadata.filename || null,
    name: (filename || metadata.filename || '').split('/').pop() || null,
    slicer: typeof metadata.slicer === 'string' ? metadata.slicer : null,
    slicerVersion: typeof metadata.slicer_version === 'string' ? metadata.slicer_version : null,
    size: num(metadata.size),
    modified: num(metadata.modified),
    layerCount: num(metadata.layer_count),
    objectHeight: num(metadata.object_height),
    estimatedTime: num(metadata.estimated_time),
    nozzleDiameter: num(metadata.nozzle_diameter),
    layerHeight: num(metadata.layer_height),
    firstLayerHeight: num(metadata.first_layer_height),
    firstLayerExtrTemp: num(metadata.first_layer_extr_temp),
    firstLayerBedTemp: num(metadata.first_layer_bed_temp),
    chamberTemp: num(metadata.chamber_temp),
    filamentTotal: num(metadata.filament_total),
    filamentWeightTotal: num(metadata.filament_weight_total),
    printerModel: typeof metadata.printer_model === 'string' ? metadata.printer_model : null,
    thumbnail: bestThumb?.relative_path ?? null,
    tools,
  }
}

export function createGcodeParser({ filename = '', defaultLayerHeight = 0.2, defaultWidth = 0.45 } = {}) {
  let capacity = INITIAL_CAPACITY
  let data = new Float32Array(capacity * 8)
  let count = 0
  let totalSurfaceSegments = 0

  let x = 0
  let y = 0
  let z = 0
  let e = 0
  let absolutePos = true
  let absoluteExtrude = false
  let tool = 0
  let layer = 0
  let sawLayerMarker = false
  let sawTypeComment = false
  let currentType = ''
  let layerHeight = defaultLayerHeight
  let lineWidth = defaultWidth

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  let hasSupport = false
  const usedTools = new Set()
  const layerZMap = new Map()

  // Previous emitted segment for collinear merging
  let prevLayer = -1
  let prevTool = -1
  let prevSupport = -1
  let prevDx = 0
  let prevDy = 0
  let prevLen = 0
  let prevZ = NaN

  function compactPolylines() {
    // Watertight polyline decimation: merge consecutive connected segments A->B + B->C into A->C
    // instead of dropping segments (which would leave holes in walls).
    let write = 0
    let i = 0
    while (i < count) {
      const a = i * 8
      if (i + 1 < count) {
        const b = (i + 1) * 8
        const sameMeta = data[a + 7] === data[b + 7] && data[a + 4] === data[b + 4]
        const connected =
          Math.abs(data[a + 2] - data[b]) < 0.02 && Math.abs(data[a + 3] - data[b + 1]) < 0.02
        const lenA = Math.hypot(data[a + 2] - data[a], data[a + 3] - data[a + 1])
        const lenB = Math.hypot(data[b + 2] - data[b], data[b + 3] - data[b + 1])
        if (sameMeta && connected && lenA + lenB < 6.0) {
          const dst = write * 8
          data[dst] = data[a]
          data[dst + 1] = data[a + 1]
          data[dst + 2] = data[b + 2]
          data[dst + 3] = data[b + 3]
          data[dst + 4] = data[a + 4]
          data[dst + 5] = Math.max(data[a + 5], data[b + 5])
          data[dst + 6] = Math.max(data[a + 6], data[b + 6])
          data[dst + 7] = data[a + 7]
          write++
          i += 2
          continue
        }
      }
      if (write !== i) {
        const dst = write * 8
        for (let k = 0; k < 8; k++) data[dst + k] = data[a + k]
      }
      write++
      i++
    }
    count = write
    prevLayer = -1
  }

  function ensureCapacity(extra = 1) {
    if (count + extra <= capacity) return
    const nextCap = Math.min(MAX_SEGMENTS + 32_768, Math.max(capacity * 2, count + extra))
    if (nextCap <= capacity) {
      compactPolylines()
      if (count + extra <= capacity) return
      // Second pass if still full (very large 150MB+ prints)
      compactPolylines()
      if (count + extra <= capacity) return
      // Last-resort stride only if polylines couldn't merge further
      const compacted = Math.floor(count * 0.75)
      const stride = count / compacted
      for (let i = 0; i < compacted; i++) {
        const src = Math.floor(i * stride) * 8
        const dst = i * 8
        for (let k = 0; k < 8; k++) data[dst + k] = data[src + k]
      }
      count = compacted
      prevLayer = -1
      return
    }
    const next = new Float32Array(nextCap * 8)
    next.set(data.subarray(0, count * 8))
    data = next
    capacity = nextCap
  }

  function pushSegment(x1, y1, x2, y2, segZ, w, h, segLayer, segTool, isSupport) {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy)
    if (len < 0.03) return

    totalSurfaceSegments++
    usedTools.add(segTool)
    if (isSupport) hasSupport = true

    if (x1 < minX) minX = x1
    if (x2 < minX) minX = x2
    if (x1 > maxX) maxX = x1
    if (x2 > maxX) maxX = x2
    if (y1 < minY) minY = y1
    if (y2 < minY) minY = y2
    if (y1 > maxY) maxY = y1
    if (y2 > maxY) maxY = y2
    if (segZ < minZ) minZ = segZ
    if (segZ > maxZ) maxZ = segZ
    if (!layerZMap.has(segLayer)) layerZMap.set(segLayer, segZ)

    const nx = dx / len
    const ny = dy / len
    const supportBit = isSupport ? 1 : 0

    // Merge nearly-collinear tiny consecutive moves to preserve sharpness while saving vertices
    if (
      count > 0 &&
      prevLayer === segLayer &&
      prevTool === segTool &&
      prevSupport === supportBit &&
      prevZ === segZ
    ) {
      const base = (count - 1) * 8
      if (Math.abs(data[base + 2] - x1) < 0.005 && Math.abs(data[base + 3] - y1) < 0.005) {
        const dot = prevDx * nx + prevDy * ny
        const adaptiveMin = count > 110_000 ? 0.55 : 0.28
        if (dot > 0.996 || (prevLen < adaptiveMin && len < adaptiveMin && dot > 0.94)) {
          data[base + 2] = x2
          data[base + 3] = y2
          const mergedDx = x2 - data[base]
          const mergedDy = y2 - data[base + 1]
          const mergedLen = Math.hypot(mergedDx, mergedDy)
          if (mergedLen > 0) {
            prevDx = mergedDx / mergedLen
            prevDy = mergedDy / mergedLen
            prevLen = mergedLen
          }
          return
        }
      }
    }

    ensureCapacity(1)
    const offset = count * 8
    data[offset] = x1
    data[offset + 1] = y1
    data[offset + 2] = x2
    data[offset + 3] = y2
    data[offset + 4] = segZ
    data[offset + 5] = w
    data[offset + 6] = h
    data[offset + 7] = segLayer * 16 + segTool * 2 + supportBit
    count++

    prevLayer = segLayer
    prevTool = segTool
    prevSupport = supportBit
    prevDx = nx
    prevDy = ny
    prevLen = len
    prevZ = segZ
  }

  function parseCoords(line, startIndex) {
    let nx = NaN
    let ny = NaN
    let nz = NaN
    let ne = NaN
    let ni = NaN
    let nj = NaN
    const len = line.length
    let i = startIndex
    while (i < len) {
      const ch = line.charCodeAt(i)
      if (ch === 59) break // ';' comment
      if (ch === 32 || ch === 9) {
        i++
        continue
      }
      const letter = ch >= 97 && ch <= 122 ? ch - 32 : ch
      let end = i + 1
      while (end < len) {
        const c = line.charCodeAt(end)
        if (c === 32 || c === 9 || c === 59) break
        end++
      }
      const val = parseFloat(line.slice(i + 1, end))
      if (Number.isFinite(val)) {
        if (letter === 88) nx = val // X
        else if (letter === 89) ny = val // Y
        else if (letter === 90) nz = val // Z
        else if (letter === 69) ne = val // E
        else if (letter === 73) ni = val // I
        else if (letter === 74) nj = val // J
      }
      i = end
    }
    return { nx, ny, nz, ne, ni, nj }
  }

  function feedLine(rawLine) {
    const line = rawLine.trim()
    if (!line) return
    const first = line.charCodeAt(0)

    if (first === 59) {
      // Comment
      if (line.startsWith(';TYPE:')) {
        sawTypeComment = true
        currentType = line.slice(6).trim().toLowerCase()
      } else if (line.startsWith(';LAYER_CHANGE')) {
        sawLayerMarker = true
        layer++
      } else if (line.startsWith(';HEIGHT:')) {
        const h = parseFloat(line.slice(8))
        if (Number.isFinite(h) && h > 0.02 && h < 2) layerHeight = h
      } else if (line.startsWith(';WIDTH:')) {
        const w = parseFloat(line.slice(7))
        if (Number.isFinite(w) && w > 0.1 && w < 3) lineWidth = w
      }
      return
    }

    if (first === 84 || first === 116) {
      // T0..T5 tool selection
      if (line.length >= 2) {
        const digit = line.charCodeAt(1) - 48
        const nextCh = line.length > 2 ? line.charCodeAt(2) : 32
        if (digit >= 0 && digit <= 5 && (nextCh === 32 || nextCh === 9 || nextCh === 59)) {
          tool = digit
        }
      }
      return
    }

    if (first === 83 && line.startsWith('SET_PRINT_STATS_INFO')) {
      const idx = line.indexOf('CURRENT_LAYER=')
      if (idx !== -1) {
        const parsed = parseInt(line.slice(idx + 14), 10)
        if (Number.isInteger(parsed) && parsed > 0) {
          sawLayerMarker = true
          layer = parsed
        }
      }
      return
    }

    if (first === 77 || first === 109) {
      if (line.startsWith('M82') && (line.length === 3 || line.charCodeAt(3) <= 32 || line.charCodeAt(3) === 59)) {
        absoluteExtrude = true
      } else if (line.startsWith('M83') && (line.length === 3 || line.charCodeAt(3) <= 32 || line.charCodeAt(3) === 59)) {
        absoluteExtrude = false
      }
      return
    }

    if (first !== 71 && first !== 103) return

    const c1 = line.charCodeAt(1)
    const c2 = line.length > 2 ? line.charCodeAt(2) : 32

    // G0 / G1 linear move
    if ((c1 === 48 || c1 === 49) && (c2 === 32 || c2 === 9)) {
      const { nx, ny, nz, ne } = parseCoords(line, 3)
      const prevX = x
      const prevY = y
      const prevE = e

      const targetX = Number.isFinite(nx) ? (absolutePos ? nx : x + nx) : x
      const targetY = Number.isFinite(ny) ? (absolutePos ? ny : y + ny) : y
      const targetZ = Number.isFinite(nz) ? (absolutePos ? nz : z + nz) : z
      const deltaE = Number.isFinite(ne) ? (absoluteExtrude ? ne - prevE : ne) : 0

      if (Number.isFinite(ne)) e = absoluteExtrude ? ne : prevE + ne
      if (Number.isFinite(nz) && targetZ > z + 0.01 && !sawLayerMarker && deltaE > 0) layer++

      x = targetX
      y = targetY
      z = targetZ

      if (c1 === 49 && deltaE > 0 && (targetX !== prevX || targetY !== prevY)) {
        const isSupport = sawTypeComment && SUPPORT_TYPES.has(currentType)
        const keep = !sawTypeComment || SURFACE_TYPES.has(currentType) || isSupport
        if (keep) {
          const effectiveLayer = Math.max(1, layer || 1)
          pushSegment(prevX, prevY, targetX, targetY, targetZ, lineWidth, layerHeight, effectiveLayer, tool, isSupport)
        }
      }
      return
    }

    // G2 / G3 arc move
    if ((c1 === 50 || c1 === 51) && (c2 === 32 || c2 === 9)) {
      const { nx, ny, nz, ne, ni, nj } = parseCoords(line, 3)
      const prevX = x
      const prevY = y
      const prevE = e
      const targetX = Number.isFinite(nx) ? (absolutePos ? nx : x + nx) : x
      const targetY = Number.isFinite(ny) ? (absolutePos ? ny : y + ny) : y
      const targetZ = Number.isFinite(nz) ? (absolutePos ? nz : z + nz) : z
      const deltaE = Number.isFinite(ne) ? (absoluteExtrude ? ne - prevE : ne) : 0
      if (Number.isFinite(ne)) e = absoluteExtrude ? ne : prevE + ne

      x = targetX
      y = targetY
      z = targetZ

      if (deltaE > 0 && (Number.isFinite(ni) || Number.isFinite(nj))) {
        const isSupport = sawTypeComment && SUPPORT_TYPES.has(currentType)
        const keep = !sawTypeComment || SURFACE_TYPES.has(currentType) || isSupport
        if (keep) {
          const cx = prevX + (Number.isFinite(ni) ? ni : 0)
          const cy = prevY + (Number.isFinite(nj) ? nj : 0)
          const r = Math.hypot(prevX - cx, prevY - cy)
          if (r > 0.05) {
            const startAngle = Math.atan2(prevY - cy, prevX - cx)
            let endAngle = Math.atan2(targetY - cy, targetX - cx)
            const cw = c1 === 50
            let sweep = endAngle - startAngle
            if (cw && sweep >= 0) sweep -= Math.PI * 2
            if (!cw && sweep <= 0) sweep += Math.PI * 2
            const steps = Math.max(2, Math.min(24, Math.ceil((Math.abs(sweep) * r) / 0.8)))
            const effectiveLayer = Math.max(1, layer || 1)
            let ax = prevX
            let ay = prevY
            for (let s = 1; s <= steps; s++) {
              const angle = startAngle + (sweep * s) / steps
              const bx = s === steps ? targetX : cx + Math.cos(angle) * r
              const by = s === steps ? targetY : cy + Math.sin(angle) * r
              pushSegment(ax, ay, bx, by, targetZ, lineWidth, layerHeight, effectiveLayer, tool, isSupport)
              ax = bx
              ay = by
            }
          }
        }
      }
      return
    }

    // G90 / G91 / G92
    if (c1 === 57 && c2 === 48) {
      absolutePos = true
    } else if (c1 === 57 && c2 === 49) {
      absolutePos = false
    } else if (c1 === 57 && c2 === 50) {
      const { nx, ny, nz, ne } = parseCoords(line, 4)
      if (Number.isFinite(nx)) x = nx
      if (Number.isFinite(ny)) y = ny
      if (Number.isFinite(nz)) z = nz
      if (Number.isFinite(ne)) e = ne
    }
  }

  function finalize() {
    while (count > MAX_SEGMENTS) {
      const before = count
      compactPolylines()
      if (count >= before * 0.95) break
    }
    let finalCount = count
    let finalFloat = data.subarray(0, count * 8)

    if (finalCount > MAX_SEGMENTS) {
      const stride = finalCount / MAX_SEGMENTS
      const thinned = new Float32Array(MAX_SEGMENTS * 8)
      for (let i = 0; i < MAX_SEGMENTS; i++) {
        const src = Math.floor(i * stride) * 8
        const dst = i * 8
        for (let k = 0; k < 8; k++) thinned[dst + k] = data[src + k]
      }
      finalCount = MAX_SEGMENTS
      finalFloat = thinned
    }

    const maxLayer = Math.max(layer, ...layerZMap.keys(), 0)
    const layerHeights = []
    for (let l = 1; l <= maxLayer; l++) {
      layerHeights.push(Number((layerZMap.get(l) ?? l * layerHeight).toFixed(3)))
    }

    const header = {
      filename,
      layerCount: maxLayer,
      maxLayer,
      segmentCount: finalCount,
      totalSurfaceSegments,
      bounds:
        finalCount > 0
          ? {
              minX: Number(minX.toFixed(2)),
              maxX: Number(maxX.toFixed(2)),
              minY: Number(minY.toFixed(2)),
              maxY: Number(maxY.toFixed(2)),
              minZ: Number(minZ.toFixed(2)),
              maxZ: Number(maxZ.toFixed(2)),
            }
          : null,
      usedTools: [...usedTools].sort((a, b) => a - b),
      hasSupport,
      layerHeight: Number(layerHeight.toFixed(3)),
      layerHeights,
    }

    return { header, segments: finalFloat }
  }

  return { feedLine, finalize }
}

export function encodeGcodeMeshBinary({ header, segments }) {
  let headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const pad = (4 - (headerBytes.byteLength % 4)) % 4
  if (pad > 0) {
    headerBytes = Buffer.concat([headerBytes, Buffer.alloc(pad, 0x20)])
  }
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(headerBytes.byteLength, 0)
  const payloadBytes = Buffer.from(segments.buffer, segments.byteOffset, segments.byteLength)
  return Buffer.concat([prefix, headerBytes, payloadBytes])
}

export function parseGcodeText(text, options = {}) {
  const parser = createGcodeParser(options)
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      parser.feedLine(text.slice(start, i))
      start = i + 1
    }
  }
  if (start < text.length) parser.feedLine(text.slice(start))
  return parser.finalize()
}

const meshCache = new Map()

export async function fetchGcodeMeshBinary({ printer, filename, cacheKey = filename, fetchImpl = fetch }) {
  const scopedCacheKey = `${printer}|${cacheKey}`
  if (meshCache.has(scopedCacheKey)) {
    const cached = meshCache.get(scopedCacheKey)
    meshCache.delete(scopedCacheKey)
    meshCache.set(scopedCacheKey, cached)
    return cached
  }

  const encoded = filename
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  const response = await fetchImpl(`${printer}/server/files/gcodes/${encoded}`, {
    signal: AbortSignal.timeout(45_000),
    redirect: 'error',
  })
  if (!response.ok || !response.body) {
    throw new Error(`G-Code-Datei konnte nicht geladen werden (HTTP ${response.status}).`)
  }

  const parser = createGcodeParser({ filename })
  const decoder = new TextDecoder('utf-8')
  const reader = response.body.getReader()
  let leftover = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const text = leftover + decoder.decode(value, { stream: true })
    let start = 0
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        parser.feedLine(text.slice(start, i))
        start = i + 1
      }
    }
    leftover = text.slice(start)
  }
  leftover += decoder.decode()
  if (leftover) parser.feedLine(leftover)

  const binary = encodeGcodeMeshBinary(parser.finalize())

  meshCache.set(scopedCacheKey, binary)
  while (meshCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = meshCache.keys().next().value
    meshCache.delete(oldestKey)
  }

  return binary
}
