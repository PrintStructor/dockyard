import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  allowedOrigins as defaultEnvAllowedOrigins,
  allowLanOriginsEnv as defaultEnvAllowLanOrigins,
  mainsailUrlEnv as defaultMainsailUrlEnv,
  parseAllowedOrigins,
  printerName as defaultPrinterName,
  printerUrl as defaultPrinterUrl,
  resolveAllowLanOrigins,
  resolvePrinterName,
  settingsFilePath as defaultSettingsFilePath,
} from './config.mjs'

const SETTINGS_VERSION = 1
const MAX_PRINTERS = 20
const MAX_CAMERAS = 6
const MAX_ALLOWED_ORIGINS = 24
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const MODEL_PRESETS = ['auto', 'stormtrooper-6tc', 'stealthburner', 'mini-stealthburner', 'custom', 'none']
export const DEFAULT_ACCENT_COLOR = '#c5f76b'
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

const DEFAULT_SUBTITLE = 'VORON 2.4 / 6-Toolchanger'
const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  'metadata.google.internal',
  'metadata',
  'fd00:ec2::254',
])

export function createDefaultCameras() {
  return [
    {
      id: 'tophat',
      name: 'Tophat',
      description: 'Blick auf den Bauraum',
      service: 'camera-streamer',
      url: '/webcam',
      snapshotUrl: '',
      enabled: true,
      preferredMode: 'webrtc',
    },
    {
      id: 'heatbed',
      name: 'Druckbett',
      description: 'Blick auf die Druckfläche',
      service: 'camera-streamer',
      url: '/webcam2',
      snapshotUrl: '',
      enabled: true,
      preferredMode: 'webrtc',
    },
  ]
}

function stripBrackets(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '')
}

function extractMappedIpv4(clean) {
  const dotted = /^(?:::|(?:0+:){5})ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(clean)
  if (dotted && parseIpv4Octets(dotted[1])) return dotted[1]
  const hex = /^(?:::|(?:0+:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(clean)
  if (hex) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
  }
  return null
}

export function isBlockedUpstreamHost(hostname) {
  const clean = stripBrackets(hostname)
  if (!clean) return true
  if (BLOCKED_HOSTS.has(clean)) return true
  if (clean.endsWith('.metadata.google.internal')) return true
  const mapped = extractMappedIpv4(clean)
  if (mapped && BLOCKED_HOSTS.has(mapped)) return true
  return false
}

function parseIpv4Octets(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  return octets.every(n => n >= 0 && n <= 255) ? octets : null
}

export function isPrivateLanHostname(hostname) {
  const clean = stripBrackets(hostname)
  if (!clean || isBlockedUpstreamHost(clean)) return false
  if (clean === 'localhost' || clean === '::1') return true

  const ipv4Target = extractMappedIpv4(clean) ?? clean
  const ipv4 = parseIpv4Octets(ipv4Target)
  if (ipv4) {
    const [a, b] = ipv4
    if (a === 127) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }

  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  if (clean.includes(':')) {
    return /^(fc|fd)[0-9a-f]{2}:/i.test(clean) || /^fe[89ab][0-9a-f]:/i.test(clean)
  }

  // Single-label local hostnames (e.g. "voron-pi") or mDNS / local LAN suffixes
  if (!clean.includes('.') && /^[a-z0-9-]+$/.test(clean)) return true
  if (/\.(local|lan|home|internal)$/.test(clean)) return true
  return false
}

export function slugifyId(label, fallback = 'printer') {
  const slug = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .replace(/[-_]+$/, '')
    .slice(0, 32)
  return slug && ID_PATTERN.test(slug) ? slug : fallback
}

function uniqueId(base, used) {
  const clean = slugifyId(base, 'item')
  if (!used.has(clean)) {
    used.add(clean)
    return clean
  }
  for (let i = 2; i < 999; i++) {
    const suffix = `-${i}`
    const candidate = `${clean.slice(0, 32 - suffix.length)}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  throw new Error('Konnte keine eindeutige Kennung erzeugen.')
}

export function normalizePrinterOrigin(raw) {
  if (typeof raw !== 'string') throw new Error('Drucker-URL muss eine Zeichenkette sein.')
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 256) {
    throw new Error('Bitte eine gültige Drucker-URL oder IP-Adresse eingeben.')
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
  const candidate = (hasScheme ? trimmed : `http://${trimmed}`).replace(/\/+$/, '')

  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('Drucker-URL ist ungültig (z. B. http://192.168.1.50 oder voron.local).')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Drucker-URL muss mit http:// oder https:// beginnen.')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Drucker-URL darf nur Protokoll, Host/IP und optional Port enthalten (ohne Pfad oder Zugangsdaten).')
  }
  if (isBlockedUpstreamHost(url.hostname)) {
    throw new Error('Diese Zieladresse ist aus Sicherheitsgründen gesperrt.')
  }
  return url.origin
}

export function normalizeMainsailSetting(raw) {
  if (raw == null) return 'auto'
  const trimmed = String(raw).trim()
  if (!trimmed || trimmed.toLowerCase() === 'auto') return 'auto'
  if (trimmed.length > 256) throw new Error('Mainsail-URL ist zu lang.')
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
  const candidate = hasScheme ? trimmed : `http://${trimmed}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('Mainsail-URL ist ungültig.')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Mainsail-URL muss eine gültige HTTP(S)-Adresse ohne Zugangsdaten sein.')
  }
  if (isBlockedUpstreamHost(url.hostname)) {
    throw new Error('Diese Mainsail-Adresse ist aus Sicherheitsgründen gesperrt.')
  }
  return url.toString()
}

function validateCameraEndpoint(raw, { allowQuery, allowEmpty = false, label = 'Kamera-URL' }) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) {
    if (allowEmpty) return ''
    throw new Error(`${label} darf nicht leer sein.`)
  }
  if (trimmed.length > 512 || /[\x00-\x1f\x7f\\]/.test(trimmed)) {
    throw new Error(`${label} enthält ungültige Zeichen.`)
  }
  if (trimmed.includes('#')) {
    throw new Error(`${label} darf kein #-Fragment enthalten.`)
  }

  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//') || trimmed.includes('..')) {
      throw new Error(`${label} enthält einen ungültigen Pfad.`)
    }
    const qIdx = trimmed.indexOf('?')
    if (qIdx !== -1 && !allowQuery) {
      throw new Error(`${label} für camera-streamer darf keine Query-Parameter enthalten (für ustreamer bitte Dienst „MJPEG“ wählen).`)
    }
    if (qIdx === -1) {
      const stripped = trimmed.replace(/\/+$/, '')
      return stripped || '/'
    }
    return trimmed
  }

  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${label} muss mit / oder http(s):// beginnen.`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`${label} muss eine gültige HTTP(S)-Adresse ohne Zugangsdaten sein.`)
  }
  if (url.pathname.includes('..') || isBlockedUpstreamHost(url.hostname)) {
    throw new Error(`${label} ist aus Sicherheitsgründen nicht zulässig.`)
  }
  if (url.search && !allowQuery) {
    throw new Error(`${label} für camera-streamer darf keine Query-Parameter enthalten (für ustreamer bitte Dienst „MJPEG“ wählen).`)
  }
  return allowQuery ? url.toString() : `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function normalizeCamera(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Ungültige Kamera-Konfiguration.')
  }
  const name = String(raw.name ?? '').trim()
  if (!name || name.length > 40) {
    throw new Error('Kameraname muss zwischen 1 und 40 Zeichen lang sein.')
  }
  const description = String(raw.description ?? '').trim().slice(0, 80)
  const service = raw.service === 'mjpeg' ? 'mjpeg' : 'camera-streamer'
  const id = raw.id ? slugifyId(raw.id, `cam-${index + 1}`) : slugifyId(name, `cam-${index + 1}`)
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Ungültige Kamera-ID: ${id}`)
  }

  const allowQuery = service === 'mjpeg'
  const url = validateCameraEndpoint(raw.url, { allowQuery, label: `Kamera „${name}“ URL` })
  const snapshotUrl =
    service === 'mjpeg'
      ? validateCameraEndpoint(raw.snapshotUrl ?? '', {
          allowQuery: true,
          allowEmpty: true,
          label: `Kamera „${name}“ Snapshot-URL`,
        })
      : ''
  const preferredMode = service === 'mjpeg' ? 'mjpeg' : raw.preferredMode === 'mjpeg' ? 'mjpeg' : 'webrtc'
  const enabled = raw.enabled !== false

  return { id, name, description, service, url, snapshotUrl, enabled, preferredMode }
}

export function normalizeModelSetting(raw) {
  if (raw == null) return { preset: 'auto', accentColor: DEFAULT_ACCENT_COLOR }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Ungültige 3D-Modell-Konfiguration.')
  }
  const presetRaw = raw.preset == null ? 'auto' : String(raw.preset).trim().toLowerCase()
  if (!MODEL_PRESETS.includes(presetRaw)) {
    throw new Error('Ungültiges 3D-Modell-Preset.')
  }
  let accentColor = DEFAULT_ACCENT_COLOR
  if (raw.accentColor != null && String(raw.accentColor).trim() !== '') {
    const colorRaw = String(raw.accentColor).trim().toLowerCase()
    if (!HEX_COLOR_PATTERN.test(colorRaw)) {
      throw new Error('Ungültige Akzentfarbe (erwartet wird ein Hex-Farbwert wie #d62828).')
    }
    accentColor = colorRaw
  }
  return { preset: presetRaw, accentColor }
}

function normalizePrinterProfile(raw, index, usedIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Ungültiges Druckerprofil.')
  }
  const name = String(raw.name ?? '').trim()
  if (name.length > 40) throw new Error('Druckername darf höchstens 40 Zeichen lang sein.')

  const subtitleRaw = raw.subtitle === undefined ? DEFAULT_SUBTITLE : String(raw.subtitle ?? '').trim()
  if (subtitleRaw.length > 64) throw new Error('Untertitel darf höchstens 64 Zeichen lang sein.')

  const url = normalizePrinterOrigin(raw.url)
  const mainsailUrl = normalizeMainsailSetting(raw.mainsailUrl)
  const model = normalizeModelSetting(raw.model)
  const rawId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().toLowerCase() : slugifyId(name, `printer-${index + 1}`)
  const id = uniqueId(rawId, usedIds)

  const rawCameras = Array.isArray(raw.cameras) ? raw.cameras : createDefaultCameras()
  if (rawCameras.length > MAX_CAMERAS) {
    throw new Error(`Höchstens ${MAX_CAMERAS} Kameras pro Drucker zulässig.`)
  }
  const usedCamIds = new Set()
  const cameras = rawCameras.map((cam, camIdx) => {
    const normalized = normalizeCamera(cam, camIdx)
    normalized.id = uniqueId(normalized.id, usedCamIds)
    return normalized
  })

  return { id, name, subtitle: subtitleRaw, url, mainsailUrl, model, cameras }
}

function normalizeAllowedOriginList(rawList) {
  if (rawList == null) return []
  if (!Array.isArray(rawList)) throw new Error('Vertrauenswürdige Origins müssen eine Liste sein.')
  if (rawList.length > MAX_ALLOWED_ORIGINS) {
    throw new Error(`Höchstens ${MAX_ALLOWED_ORIGINS} vertrauenswürdige Origins zulässig.`)
  }
  const unique = new Set()
  for (const item of rawList) {
    const trimmed = String(item ?? '').trim()
    if (!trimmed) continue
    const parsed = parseAllowedOrigins(trimmed)
    for (const origin of parsed) unique.add(origin)
  }
  return Array.from(unique)
}

export function validateSettingsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Ungültige Einstellungsdaten.')
  }
  if (!Array.isArray(payload.printers) || payload.printers.length === 0) {
    throw new Error('Mindestens ein Druckerprofil muss vorhanden sein.')
  }
  if (payload.printers.length > MAX_PRINTERS) {
    throw new Error(`Höchstens ${MAX_PRINTERS} Druckerprofile zulässig.`)
  }

  const usedIds = new Set()
  const printers = payload.printers.map((entry, idx) => normalizePrinterProfile(entry, idx, usedIds))
  const requestedActive = typeof payload.activePrinterId === 'string' ? payload.activePrinterId.trim().toLowerCase() : ''
  const activePrinter = printers.find(p => p.id === requestedActive) ?? printers[0]

  const networkIn = payload.network && typeof payload.network === 'object' ? payload.network : {}
  const network = {
    allowedOrigins: normalizeAllowedOriginList(networkIn.allowedOrigins),
    allowLanOrigins: Boolean(networkIn.allowLanOrigins),
  }

  return {
    version: SETTINGS_VERSION,
    activePrinterId: activePrinter.id,
    printers,
    network,
  }
}

function bootstrapFromEnv(env) {
  const envUrlRaw = env?.PRINTER_URL ?? defaultPrinterUrl
  let url = 'http://127.0.0.1'
  try {
    url = normalizePrinterOrigin(envUrlRaw)
  } catch {
    url = 'http://127.0.0.1'
  }
  const name = env ? resolvePrinterName(env) : defaultPrinterName
  let mainsailUrl = 'auto'
  try {
    const rawMainsail = env ? (env.MAINSAIL_URL ?? env.VITE_MAINSAIL_URL ?? 'auto') : defaultMainsailUrlEnv
    mainsailUrl = normalizeMainsailSetting(rawMainsail)
  } catch {
    mainsailUrl = 'auto'
  }
  const id = slugifyId(name || 'printer', 'printer')

  return {
    version: SETTINGS_VERSION,
    activePrinterId: id,
    printers: [
      {
        id,
        name,
        subtitle: DEFAULT_SUBTITLE,
        url,
        mainsailUrl,
        model: { preset: 'auto', accentColor: DEFAULT_ACCENT_COLOR },
        cameras: createDefaultCameras(),
      },
    ],
    network: {
      allowedOrigins: [],
      allowLanOrigins: false,
    },
  }
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data))
}

export function createSettingsStore({ filePath = defaultSettingsFilePath, env } = {}) {
  const envAllowedOrigins = env ? parseAllowedOrigins(env.ALLOWED_ORIGINS) : [...defaultEnvAllowedOrigins]
  const envAllowLanOrigins = env ? resolveAllowLanOrigins(env) : defaultEnvAllowLanOrigins
  const listeners = new Set()

  let state = bootstrapFromEnv(env)
  try {
    const diskRaw = readFileSync(filePath, 'utf8')
    state = validateSettingsPayload(JSON.parse(diskRaw))
  } catch {
    // Missing or unreadable file safely keeps env-bootstrapped defaults.
  }

  let writeQueue = Promise.resolve()
  let tmpSeq = 0

  async function persistAtomic(nextState) {
    const dir = path.dirname(filePath)
    await mkdir(dir, { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.${++tmpSeq}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmpPath, filePath)
  }

  function enqueueCommit(buildNextState) {
    const run = writeQueue.then(async () => {
      const prevActive = getActivePrinter()
      const nextState = buildNextState(state)
      await persistAtomic(nextState)
      state = nextState
      const nextActive = getActivePrinter()
      const activePrinterChanged = prevActive.id !== nextActive.id
      const printerUrlChanged = prevActive.url !== nextActive.url
      const change = {
        settings: getPublicSettings(),
        activePrinterChanged,
        printerUrlChanged,
        previousPrinter: prevActive,
        activePrinter: nextActive,
      }
      for (const listener of listeners) {
        try {
          listener(change)
        } catch {
          // Isolate change listener errors.
        }
      }
      return change
    })
    writeQueue = run.catch(() => {})
    return run
  }

  function getActivePrinter() {
    const found = state.printers.find(p => p.id === state.activePrinterId) ?? state.printers[0]
    return cloneData(found)
  }

  function getEffectiveAllowedOrigins() {
    return Array.from(new Set([...envAllowedOrigins, ...state.network.allowedOrigins]))
  }

  function isLanOriginAllowed() {
    return envAllowLanOrigins || state.network.allowLanOrigins
  }

  function hasEnvLanOriginOverride() {
    return envAllowLanOrigins
  }

  function getPublicSettings(runtime = null) {
    const active = getActivePrinter()
    return {
      version: state.version,
      activePrinterId: active.id,
      activePrinter: active,
      printers: cloneData(state.printers),
      network: {
        allowedOrigins: [...state.network.allowedOrigins],
        envAllowedOrigins: [...envAllowedOrigins],
        allowLanOrigins: state.network.allowLanOrigins,
        envAllowLanOrigins,
      },
      ...(runtime ? { runtime } : {}),
    }
  }

  return {
    filePath,
    getSettings: () => cloneData(state),
    getActivePrinter,
    getPublicSettings,
    getEffectiveAllowedOrigins,
    isLanOriginAllowed,
    hasEnvLanOriginOverride,
    async saveSettings(payload) {
      const validated = validateSettingsPayload(payload)
      return enqueueCommit(() => validated)
    },
    async switchPrinter(printerId) {
      const cleanId = String(printerId ?? '').trim().toLowerCase()
      return enqueueCommit(current => {
        if (!current.printers.some(p => p.id === cleanId)) {
          throw new Error('Druckerprofil wurde nicht gefunden.')
        }
        const nextState = cloneData(current)
        nextState.activePrinterId = cleanId
        return nextState
      })
    },
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export const settingsStore = createSettingsStore()
export const getSettings = () => settingsStore.getSettings()
export const getActivePrinter = () => settingsStore.getActivePrinter()
export const getEffectiveAllowedOrigins = () => settingsStore.getEffectiveAllowedOrigins()
export const isLanOriginAllowed = () => settingsStore.isLanOriginAllowed()
export const hasEnvLanOriginOverride = () => settingsStore.hasEnvLanOriginOverride()
