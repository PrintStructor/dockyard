import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rmdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { modelsDir as defaultModelsDir } from './config.mjs'

export const MAX_MODEL_BYTES = 25 * 1024 * 1024
export const MODEL_SLOTS = ['toolhead', 'printer']

const PRINTER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const GLB_MAGIC = 0x46546c67 // 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a // 'JSON'

function assertPrinterId(printerId) {
  const clean = String(printerId ?? '').trim()
  if (!PRINTER_ID_PATTERN.test(clean)) {
    throw new Error('Ungültige Drucker-ID für das 3D-Modell.')
  }
  return clean
}

function assertSlot(slot) {
  const clean = String(slot ?? '').trim()
  if (!MODEL_SLOTS.includes(clean)) {
    throw new Error('Ungültiger Modell-Slot (nur toolhead oder printer erlaubt).')
  }
  return clean
}

export function sanitizeModelFilename(raw, fallbackSlot = 'printer') {
  const fallback = `${MODEL_SLOTS.includes(fallbackSlot) ? fallbackSlot : 'printer'}.glb`
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  const normalized = raw.replace(/\\/g, '/')
  const base = normalized.split('/').pop() ?? ''
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 120)
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('..')) return fallback
  return cleaned
}

export function validateGlbBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new Error('Ungültige GLB-Daten.')
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (buf.byteLength === 0) {
    throw new Error('Die hochgeladene GLB-Datei ist leer.')
  }
  if (buf.byteLength > MAX_MODEL_BYTES) {
    throw new Error('Die GLB-Datei überschreitet das Limit von 25 MB. Bitte zuerst mit scripts/optimize-dockyard-glb.sh komprimieren.')
  }
  if (buf.byteLength < 28) {
    throw new Error('Ungültige GLB-Datei (Header zu kurz).')
  }
  const magic = buf.readUInt32LE(0)
  if (magic !== GLB_MAGIC) {
    throw new Error('Ungültiges Dateiformat: Es werden nur binäre glTF-2.0-Dateien (.glb) unterstützt.')
  }
  const version = buf.readUInt32LE(4)
  if (version !== 2) {
    throw new Error(`Nicht unterstützte GLB-Version (${version}). Erforderlich ist glTF Version 2.`)
  }
  const declaredLength = buf.readUInt32LE(8)
  if (declaredLength !== buf.byteLength) {
    throw new Error('Die GLB-Datei ist beschädigt oder unvollständig (Längenangabe weicht ab).')
  }
  const jsonChunkLength = buf.readUInt32LE(12)
  const jsonChunkType = buf.readUInt32LE(16)
  if (jsonChunkType !== GLB_CHUNK_JSON) {
    throw new Error('Ungültige GLB-Struktur: Erster Block muss JSON sein.')
  }
  if (jsonChunkLength < 2 || 20 + jsonChunkLength > buf.byteLength) {
    throw new Error('Ungültige GLB-Struktur: JSON-Block überschreitet Dateigröße.')
  }
  let parsed
  try {
    parsed = JSON.parse(buf.subarray(20, 20 + jsonChunkLength).toString('utf8'))
  } catch {
    throw new Error('Ungültige GLB-Datei: JSON-Header ist beschädigt.')
  }
  const assetVersion = typeof parsed?.asset?.version === 'string' ? parsed.asset.version.trim() : ''
  if (!assetVersion || !assetVersion.startsWith('2')) {
    throw new Error('Ungültige GLB-Datei: glTF 2.x asset.version fehlt.')
  }
  return {
    byteLength: buf.byteLength,
    jsonChunkLength,
    assetVersion,
  }
}

export function createModelStore({ dir = defaultModelsDir } = {}) {
  const rootDir = path.resolve(dir)
  let tmpSeq = 0

  function resolvePrinterDir(printerId) {
    const cleanId = assertPrinterId(printerId)
    const target = path.resolve(rootDir, cleanId)
    if (target !== rootDir && !target.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error('Ungültiger Modellpfad.')
    }
    return target
  }

  function resolveSlotPaths(printerId, slot) {
    const cleanSlot = assertSlot(slot)
    const printerDir = resolvePrinterDir(printerId)
    return {
      printerDir,
      glbPath: path.join(printerDir, `${cleanSlot}.glb`),
      metaPath: path.join(printerDir, `${cleanSlot}.meta.json`),
    }
  }

  function readSlotMetaSync(printerId, slot) {
    try {
      const { glbPath, metaPath } = resolveSlotPaths(printerId, slot)
      if (!existsSync(glbPath)) return null
      if (existsSync(metaPath)) {
        const parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
        if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.bytes) && typeof parsed.updatedAt === 'string') {
          return {
            filename: sanitizeModelFilename(parsed.filename, slot),
            bytes: parsed.bytes,
            updatedAt: parsed.updatedAt,
            etag: typeof parsed.etag === 'string' ? parsed.etag : `"${parsed.bytes}"`,
          }
        }
      }
      const stats = statSync(glbPath)
      return {
        filename: `${slot}.glb`,
        bytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
        etag: `"${stats.size}-${Math.floor(stats.mtimeMs)}"`,
      }
    } catch {
      return null
    }
  }

  function describePrinter(printerId) {
    if (!PRINTER_ID_PATTERN.test(String(printerId ?? '').trim())) {
      return { toolhead: null, printer: null }
    }
    return {
      toolhead: readSlotMetaSync(printerId, 'toolhead'),
      printer: readSlotMetaSync(printerId, 'printer'),
    }
  }

  async function saveModel(printerId, slot, buffer, filename = '') {
    const cleanSlot = assertSlot(slot)
    const { printerDir, glbPath, metaPath } = resolveSlotPaths(printerId, cleanSlot)
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    validateGlbBuffer(buf)

    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 32)
    const meta = {
      filename: sanitizeModelFilename(filename, cleanSlot),
      bytes: buf.byteLength,
      updatedAt: new Date().toISOString(),
      etag: `"${hash}"`,
    }

    await mkdir(printerDir, { recursive: true })
    const seq = ++tmpSeq
    const tmpGlb = `${glbPath}.${process.pid}.${seq}.tmp`
    const tmpMeta = `${metaPath}.${process.pid}.${seq}.tmp`
    try {
      await writeFile(tmpGlb, buf, { mode: 0o600 })
      await writeFile(tmpMeta, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmpGlb, glbPath)
      await rename(tmpMeta, metaPath)
      return meta
    } catch (err) {
      await unlink(tmpGlb).catch(() => {})
      await unlink(tmpMeta).catch(() => {})
      throw err
    }
  }

  async function readModel(printerId, slot) {
    const cleanSlot = assertSlot(slot)
    const { glbPath } = resolveSlotPaths(printerId, cleanSlot)
    try {
      const buffer = await readFile(glbPath)
      const meta = readSlotMetaSync(printerId, cleanSlot) ?? {
        filename: `${cleanSlot}.glb`,
        bytes: buffer.byteLength,
        updatedAt: new Date().toISOString(),
        etag: `"${createHash('sha256').update(buffer).digest('hex').slice(0, 32)}"`,
      }
      return { buffer, meta }
    } catch (err) {
      if (err?.code === 'ENOENT') return null
      throw err
    }
  }

  async function deleteModel(printerId, slot) {
    const { printerDir, glbPath, metaPath } = resolveSlotPaths(printerId, slot)
    await unlink(glbPath).catch(err => {
      if (err?.code !== 'ENOENT') throw err
    })
    await unlink(metaPath).catch(err => {
      if (err?.code !== 'ENOENT') throw err
    })
    try {
      const remaining = await readdir(printerDir)
      if (remaining.length === 0) await rmdir(printerDir)
    } catch {
      // Directory already absent or non-empty.
    }
  }

  async function removePrinter(printerId) {
    const printerDir = resolvePrinterDir(printerId)
    await rm(printerDir, { recursive: true, force: true })
  }

  return {
    dir: rootDir,
    describePrinter,
    saveModel,
    readModel,
    deleteModel,
    removePrinter,
  }
}

export const defaultModelStore = createModelStore()
