import { computed, ref } from 'vue'

const MAX_PRINTERS = 20
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

const settings = ref(null)
const loaded = ref(false)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const printers = computed(() => settings.value?.printers ?? [])
const activePrinter = computed(
  () =>
    settings.value?.activePrinter ??
    printers.value.find(p => p.id === settings.value?.activePrinterId) ??
    printers.value[0] ??
    null,
)
const network = computed(
  () =>
    settings.value?.network ?? {
      allowedOrigins: [],
      envAllowedOrigins: [],
      allowLanOrigins: false,
      envAllowLanOrigins: false,
    },
)
const runtime = computed(
  () =>
    settings.value?.runtime ?? {
      host: '127.0.0.1',
      port: 4173,
      requestOrigin: '',
      canWrite: true,
    },
)

function slugifyProfileId(raw, fallback = 'printer') {
  const cleaned = String(raw ?? '').trim().toLowerCase()
  if (ID_PATTERN.test(cleaned)) return cleaned
  const slug = cleaned
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .replace(/[-_]+$/, '')
    .slice(0, 32)
  return slug && ID_PATTERN.test(slug) ? slug : fallback
}

function cloneCamera(cam, idx) {
  const id = slugifyProfileId(cam?.id || cam?.name, `cam_${idx + 1}`)
  const service = cam?.service === 'mjpeg' ? 'mjpeg' : 'camera-streamer'
  const out = {
    id,
    name: String(cam?.name ?? '').trim().slice(0, 40) || id,
    description: String(cam?.description ?? '').trim().slice(0, 80),
    service,
    url: String(cam?.url ?? '').trim(),
    preferredMode: service === 'mjpeg' ? 'mjpeg' : cam?.preferredMode === 'mjpeg' ? 'mjpeg' : 'webrtc',
    enabled: cam?.enabled !== false,
  }
  if (service === 'mjpeg' && typeof cam?.snapshotUrl === 'string' && cam.snapshotUrl.trim()) {
    out.snapshotUrl = cam.snapshotUrl.trim()
  }
  return out
}

function clonePrinterProfile(profile, idx = 0) {
  const name = String(profile?.name ?? '').trim().slice(0, 40)
  const url = String(profile?.url ?? '').trim()
  return {
    id: slugifyProfileId(profile?.id || name, `printer-${idx + 1}`),
    name,
    subtitle: String(profile?.subtitle ?? '').trim().slice(0, 64),
    url,
    mainsailUrl: String(profile?.mainsailUrl ?? 'auto').trim() || 'auto',
    cameras: Array.isArray(profile?.cameras) ? profile.cameras.map(cloneCamera) : [],
  }
}

export function buildPrintersExport(currentSettings) {
  const list = Array.isArray(currentSettings?.printers) ? currentSettings.printers : []
  const cloned = list.map((p, i) => clonePrinterProfile(p, i))
  const activeId = cloned.some(p => p.id === currentSettings?.activePrinterId)
    ? currentSettings.activePrinterId
    : cloned[0]?.id ?? ''
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    activePrinterId: activeId,
    printers: cloned,
  }
}

export function parsePrintersImport(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('Die Import-Datei ist leer.')
  }
  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new Error('Ungültiges JSON-Format in der Backup-Datei.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Ungültige Backup-Struktur (JSON-Objekt erwartet).')
  }
  if (!Array.isArray(parsed.printers) || parsed.printers.length === 0) {
    throw new Error('Backup enthält keine Druckerprofile.')
  }
  if (parsed.printers.length > MAX_PRINTERS) {
    throw new Error(`Backup enthält mehr als ${MAX_PRINTERS} Druckerprofile.`)
  }
  const printersList = parsed.printers.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Ungültiges Druckerprofil an Position ${idx + 1}.`)
    }
    const profile = clonePrinterProfile(entry, idx)
    if (!profile.url) {
      throw new Error(`Druckerprofil "${profile.name || profile.id}" hat keine Moonraker-Adresse.`)
    }
    return profile
  })
  const activePrinterId = typeof parsed.activePrinterId === 'string' ? slugifyProfileId(parsed.activePrinterId, '') : ''
  return {
    version: Number.isFinite(parsed.version) ? parsed.version : 1,
    activePrinterId: printersList.some(p => p.id === activePrinterId) ? activePrinterId : printersList[0].id,
    printers: printersList,
  }
}

export function mergePrinterProfiles(
  existingPrinters,
  importedPrinters,
  mode = 'merge',
  currentActiveId = '',
  importedActiveId = '',
) {
  if (!Array.isArray(importedPrinters) || importedPrinters.length === 0) {
    throw new Error('Keine Druckerprofile zum Importieren vorhanden.')
  }
  if (mode === 'replace') {
    const seen = new Set()
    const list = []
    for (let i = 0; i < importedPrinters.length; i++) {
      const cloned = clonePrinterProfile(importedPrinters[i], i)
      let uniqueId = cloned.id
      let suffix = 2
      while (seen.has(uniqueId)) {
        uniqueId = `${cloned.id.slice(0, 28)}-${suffix++}`
      }
      cloned.id = uniqueId
      seen.add(uniqueId)
      list.push(cloned)
    }
    if (list.length > MAX_PRINTERS) {
      throw new Error(`Maximal ${MAX_PRINTERS} Druckerprofile erlaubt.`)
    }
    const activePrinterId = list.some(p => p.id === importedActiveId)
      ? importedActiveId
      : list.some(p => p.id === currentActiveId)
        ? currentActiveId
        : list[0].id
    return { printers: list, activePrinterId }
  }

  const base = (Array.isArray(existingPrinters) ? existingPrinters : []).map((p, i) => clonePrinterProfile(p, i))
  const indexById = new Map(base.map((p, idx) => [p.id, idx]))

  for (let i = 0; i < importedPrinters.length; i++) {
    const incoming = clonePrinterProfile(importedPrinters[i], i)
    if (indexById.has(incoming.id)) {
      base[indexById.get(incoming.id)] = incoming
    } else {
      indexById.set(incoming.id, base.length)
      base.push(incoming)
    }
  }
  if (base.length > MAX_PRINTERS) {
    throw new Error(`Zusammenführen überschreitet das Limit von ${MAX_PRINTERS} Druckerprofilen.`)
  }
  const activePrinterId = base.some(p => p.id === currentActiveId)
    ? currentActiveId
    : base.some(p => p.id === importedActiveId)
      ? importedActiveId
      : base[0].id
  return { printers: base, activePrinterId }
}

function applyRemoteSettings(payload) {
  if (!payload || typeof payload !== 'object') return
  const prevRuntime = settings.value?.runtime ?? null
  settings.value = {
    ...payload,
    runtime: payload.runtime ?? prevRuntime,
  }
  loaded.value = true
  error.value = ''
}

async function loadSettings() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/api/settings', {
      cache: 'no-store',
      signal: AbortSignal.timeout(7000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Einstellungen konnten nicht geladen werden.')
    settings.value = data
    loaded.value = true
    return { ok: true, data }
  } catch (cause) {
    error.value = cause.message || 'Einstellungen konnten nicht geladen werden.'
    return { ok: false, error: error.value }
  } finally {
    loading.value = false
  }
}

async function saveSettings(payload) {
  if (saving.value) return { ok: false, error: 'Speichervorgang läuft bereits.' }
  saving.value = true
  error.value = ''
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: data.code || null,
        error: data.error || 'Einstellungen konnten nicht gespeichert werden.',
      }
    }
    settings.value = data
    loaded.value = true
    return { ok: true, data }
  } catch (cause) {
    return { ok: false, status: 0, code: null, error: cause.message || 'Verbindungsfehler beim Speichern.' }
  } finally {
    saving.value = false
  }
}

async function switchPrinter(printerId) {
  if (saving.value) return { ok: false, error: 'Vorgang läuft bereits.' }
  saving.value = true
  error.value = ''
  try {
    const response = await fetch('/api/settings/switch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({ printerId }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: data.code || null,
        error: data.error || 'Druckerwechsel fehlgeschlagen.',
      }
    }
    settings.value = data
    loaded.value = true
    return { ok: true, data }
  } catch (cause) {
    return { ok: false, status: 0, code: null, error: cause.message || 'Verbindungsfehler beim Druckerwechsel.' }
  } finally {
    saving.value = false
  }
}

async function testConnection(url) {
  try {
    const response = await fetch('/api/settings/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(7000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      return { ok: false, error: data.error || `HTTP ${response.status}` }
    }
    return data
  } catch (cause) {
    return { ok: false, error: cause.message || 'Verbindungstest fehlgeschlagen.' }
  }
}

export function useSettings() {
  return {
    settings,
    activePrinter,
    printers,
    network,
    runtime,
    loaded,
    loading,
    saving,
    error,
    loadSettings,
    saveSettings,
    switchPrinter,
    testConnection,
    applyRemoteSettings,
  }
}
