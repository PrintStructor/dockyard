const GLB_MAGIC = 0x46546c67 // 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a // 'JSON'

export const MAX_UPLOAD_MODEL_BYTES = 25 * 1024 * 1024
export const MAX_RAW_MODEL_BYTES = 150 * 1024 * 1024
export const OPTIMIZE_THRESHOLD_BYTES = Math.round(1.5 * 1024 * 1024)

const PRESETS = {
  toolhead: { ratio: 0.35, error: 0.001 },
  printer: { ratio: 0.25, error: 0.0005 },
  aggressive: { ratio: 0.12, error: 0.002 },
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return null
}

export function inspectGlbHeader(input) {
  const bytes = toUint8Array(input)
  if (!bytes || bytes.byteLength < 20) {
    return { valid: false, bytes: bytes?.byteLength ?? 0, hasMeshopt: false, hasDraco: false }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0, true)
  const version = view.getUint32(4, true)
  const totalLen = view.getUint32(8, true)
  const jsonLen = view.getUint32(12, true)
  const jsonType = view.getUint32(16, true)

  if (magic !== GLB_MAGIC || version !== 2 || totalLen !== bytes.byteLength || jsonType !== GLB_CHUNK_JSON) {
    return { valid: false, bytes: bytes.byteLength, hasMeshopt: false, hasDraco: false }
  }
  if (20 + jsonLen > bytes.byteLength) {
    return { valid: false, bytes: bytes.byteLength, hasMeshopt: false, hasDraco: false }
  }

  let gltf
  try {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(20, 20 + jsonLen))
    gltf = JSON.parse(text)
  } catch {
    return { valid: false, bytes: bytes.byteLength, hasMeshopt: false, hasDraco: false }
  }

  const exts = new Set([...(gltf?.extensionsUsed ?? []), ...(gltf?.extensionsRequired ?? [])])
  return {
    valid: typeof gltf?.asset?.version === 'string' && gltf.asset.version.startsWith('2.'),
    bytes: bytes.byteLength,
    hasMeshopt: exts.has('EXT_meshopt_compression'),
    hasDraco: exts.has('KHR_draco_mesh_compression'),
  }
}

export function shouldOptimizeGlb(info) {
  if (!info || !info.valid) return false
  if (info.hasDraco) return false
  if (info.bytes > MAX_UPLOAD_MODEL_BYTES) return true
  if (info.hasMeshopt) return false
  return info.bytes > OPTIMIZE_THRESHOLD_BYTES
}

async function runOptimizationPass(rawBytes, { ratio, error }) {
  const [{ Logger, WebIO }, { ALL_EXTENSIONS }, { dedup, weld, simplify, meshopt }, { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier }] =
    await Promise.all([
      import('@gltf-transform/core'),
      import('@gltf-transform/extensions'),
      import('@gltf-transform/functions'),
      import('meshoptimizer'),
    ])

  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready])

  const quietLogger = new Logger(Logger.Verbosity.WARN)
  const io = new WebIO()
    .setLogger(quietLogger)
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    })

  const document = await io.readBinary(rawBytes)
  document.setLogger(quietLogger)
  // Deliberately omit flatten, join, palette, and prune so live node/material tags
  // (VORON_ACCENT, LED_LOGO, LED_NOZZLE_L, LED_NOZZLE_R, NOZZLE_TIP, FILAMENT_INLET)
  // and distinct solid material colors remain intact.
  await document.transform(
    dedup(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  )

  return io.writeBinary(document)
}

export async function optimizeGlbBuffer(input, { slot = 'printer', force = false } = {}) {
  const rawBytes = toUint8Array(input)
  if (!rawBytes || rawBytes.byteLength === 0) {
    throw new Error('Die hochgeladene GLB-Datei ist leer.')
  }

  const info = inspectGlbHeader(rawBytes)
  if (!info.valid) {
    return {
      bytes: rawBytes,
      originalBytes: rawBytes.byteLength,
      optimizedBytes: rawBytes.byteLength,
      optimized: false,
    }
  }

  if (!force && !shouldOptimizeGlb(info)) {
    return {
      bytes: rawBytes,
      originalBytes: rawBytes.byteLength,
      optimizedBytes: rawBytes.byteLength,
      optimized: false,
    }
  }

  const preset = PRESETS[slot === 'toolhead' ? 'toolhead' : 'printer']
  let out = await runOptimizationPass(rawBytes, preset)

  if (out.byteLength > MAX_UPLOAD_MODEL_BYTES) {
    const second = await runOptimizationPass(rawBytes, PRESETS.aggressive)
    if (second.byteLength < out.byteLength) out = second
  }

  if (out.byteLength >= rawBytes.byteLength && rawBytes.byteLength <= MAX_UPLOAD_MODEL_BYTES) {
    return {
      bytes: rawBytes,
      originalBytes: rawBytes.byteLength,
      optimizedBytes: rawBytes.byteLength,
      optimized: false,
    }
  }

  return {
    bytes: out,
    originalBytes: rawBytes.byteLength,
    optimizedBytes: out.byteLength,
    optimized: true,
  }
}
