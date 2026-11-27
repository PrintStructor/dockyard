import http from 'node:http'
import https from 'node:https'
import { createMaterialsReader } from './materials.mjs'
import { createLiveFeed } from './live.mjs'
import { normalizeStatus } from './status.mjs'
import { temperatureHistory, inferExtruderCountFromStore } from './temperature.mjs'
import { capabilities, commandFor, ControlError, isOriginWriteAllowed, sameOriginRequest } from './control.mjs'
import { executeGcodeScript, executeMoonrakerRpc, AbortedCommandError } from './ws-rpc.mjs'
import {
  validateGcodeFilename,
  validateThumbnailPath,
  normalizePrintMetadata,
  fetchGcodeMeshBinary,
} from './gcode-mesh.mjs'
import { normalizeHistoryTotals, normalizeHistoryJob } from './history.mjs'
import {
  MAX_CONFIG_BYTES,
  LOG_TAIL_BYTES,
  LOG_TAIL_MAX_LINES,
  validateConfigPath,
  classifyConfigFile,
  normalizeConfigList,
  validateWritableConfigPath,
  validateConfigContent,
  checkExpectedModified,
  buildConfigUploadFormData,
  validateRestartTarget,
  validateHostAction,
  normalizePowerDevices,
  validatePowerAction,
  evaluateMachineWriteGuard,
  normalizeSystemOverview,
  normalizeUpdateStatus,
  validateUpdateName,
  validateUpdateTarget,
  filterRelevantReleases,
  validateLogPath,
  normalizeLogList,
  parseLogTail,
  encodeMoonrakerPath,
} from './machine.mjs'
import { validateShakeTuneImagePath, normalizeCalibrationData } from './calibration.mjs'
import { normalizePresets, inferToolCountFromPresets, applyMainsailPresetMutation } from './presets.mjs'
import { serverHost, serverPort } from './config.mjs'
import {
  settingsStore as defaultSettingsStore,
  normalizePrinterOrigin,
  validateSettingsPayload,
} from './settings.mjs'
import { defaultModelStore, MAX_MODEL_BYTES } from './models.mjs'
import {
  createSpoolmanReader,
  spoolToToolMaterial,
  fetchSpoolmanList,
  setActiveSpoolmanSpool,
} from './spoolman.mjs'

const objects = [
  'toolchanger',
  'print_stats',
  'display_status',
  'webhooks',
  'heater_bed',
  'toolhead',
  'gcode_move',
  'exclude_object',
  'quad_gantry_level',
  'idle_timeout',
  'gcode_macro _KNOMI_STATUS',
  'gcode_macro LOAD_WATCH',
  'gcode_macro _LOAD_SETTINGS',
  'gcode_macro _UNLOAD_SETTINGS',
  'gcode_macro _BEACON_BATCH_STATE',
  ...Array.from({ length: 6 }, (_, i) => `neopixel et${i}_leds`),
  ...['Chamber', 'raspberry_pi', 'Octopus', 'rp2350', 'beacon_coil'].map(sensor => `temperature_sensor ${sensor}`),
  ...Array.from({ length: 6 }, (_, i) => [
    i ? `extruder${i}` : 'extruder',
    `tool T${i}`,
    `temperature_sensor T${i}`,
    `filament_switch_sensor T${i}_filament_sensor`,
  ]).flat(),
]

function isLoopbackOrigin(req) {
  try {
    const rawOrigin = req?.headers?.origin
    if (rawOrigin) {
      const origin = new URL(rawOrigin)
      return ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol === 'http:'
    }
    const rawHost = String(req?.headers?.host || '').trim()
    if (!rawHost) return false
    const parsed = new URL(`http://${rawHost}`)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function requestOriginFor(req) {
  if (req?.headers?.origin) return String(req.headers.origin)
  const host = req?.headers?.host
  if (!host) return ''
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  const protocol = forwardedProto === 'https' ? 'https:' : 'http:'
  return `${protocol}//${host}`
}

function requestStream(url, onResponse) {
  const parsed = new URL(url)
  const client = parsed.protocol === 'https:' ? https : http
  return client.get(parsed, onResponse)
}

function defaultFetchUpstream(url, init = {}) {
  return fetch(url, { redirect: 'error', ...init })
}

export function createPrinterRuntime({
  store = defaultSettingsStore,
  modelStore = defaultModelStore,
  fetchImpl = defaultFetchUpstream,
  pinnedPrinterId = null,
} = {}) {
  const fetchUpstream = fetchImpl
  const getActive = () => {
    if (pinnedPrinterId) {
      const found = store.getSettings().printers.find(p => p.id === pinnedPrinterId)
      if (found) return found
    }
    return store.getActivePrinter()
  }
  const activeUrl = () => getActive().url
  const scopedRuntimes = pinnedPrinterId ? null : new Map()

  function getScopedRuntime(printerId) {
    if (!scopedRuntimes) return null
    const id = String(printerId ?? '').trim().toLowerCase()
    if (!id) return null
    const profile = store.getSettings().printers.find(p => p.id === id)
    if (!profile) return null
    let entry = scopedRuntimes.get(id)
    if (entry && entry.url !== profile.url) {
      entry.runtime.closeLiveFeed()
      scopedRuntimes.delete(id)
      entry = null
    }
    if (!entry) {
      entry = {
        url: profile.url,
        runtime: createPrinterRuntime({ store, modelStore, fetchImpl, pinnedPrinterId: id }),
      }
      scopedRuntimes.set(id, entry)
    }
    return entry.runtime
  }

  function enrichPublicSettings(publicSettings) {
    if (!publicSettings || typeof publicSettings !== 'object') return publicSettings
    const printers = (publicSettings.printers ?? []).map(p => ({
      ...p,
      customModels: modelStore.describePrinter(p.id),
    }))
    const activePrinter = publicSettings.activePrinter
      ? {
          ...publicSettings.activePrinter,
          customModels: modelStore.describePrinter(publicSettings.activePrinter.id),
        }
      : null
    return { ...publicSettings, printers, activePrinter }
  }

  let configCache = null
  let effectObjects = []
  let fanObjects = []
  let discoveredObjects = []
  let capabilityCache = null
  let capabilityAt = 0
  let gcodeFileSetCache = null
  let gcodeFileSetAt = 0
  let liveCapabilityRef = { config: null, load: null, unload: null, fans: '', hasExclude: false, value: null }
  let currentJob = null
  let activeJobAbort = null
  const uncertainJobsByPrinter = new Map()
  let lastResult = null
  let jobSequence = 0
  let activeUpdateJob = null
  let runtimeEpoch = 0
  const releaseNotesCache = new Map()

  function resolveCameraTarget(id) {
    const active = getActive()
    const cam = (active.cameras ?? []).find(entry => entry.id === id && entry.enabled !== false)
    if (!cam) return null
    const base = cam.url.startsWith('/') ? `${active.url}${cam.url}` : cam.url
    if (cam.service === 'mjpeg') {
      const snapshotUrl = cam.snapshotUrl
        ? cam.snapshotUrl.startsWith('/')
          ? `${active.url}${cam.snapshotUrl}`
          : cam.snapshotUrl
        : null
      return { cam, webrtcUrl: null, streamUrl: base, snapshotUrl }
    }
    const cleanBase = base.replace(/\/+$/, '')
    return {
      cam,
      webrtcUrl: `${cleanBase}/webrtc`,
      streamUrl: `${cleanBase}/stream`,
      snapshotUrl: `${cleanBase}/snapshot`,
    }
  }

  function buildRuntimeMeta(req) {
    const reqOrigin = requestOriginFor(req)
    const syntheticReq = {
      headers: {
        origin: reqOrigin,
        host: req?.headers?.host,
      },
    }
    const canWrite = isOriginWriteAllowed(syntheticReq, store.getEffectiveAllowedOrigins(), {
      allowLanOrigins: store.isLanOriginAllowed(),
    })
    return {
      host: serverHost,
      port: serverPort,
      requestOrigin: reqOrigin,
      canWrite,
    }
  }

  function assertNoActiveJobForSwitch() {
    if (currentJob && !currentJob.uncertain) {
      throw new ControlError(
        'Drucker oder Verbindung kann nicht gewechselt werden, solange ein Cockpit-Befehl läuft.',
        409,
      )
    }
    if (activeUpdateJob?.running) {
      throw new ControlError(
        'Drucker oder Verbindung kann nicht gewechselt werden, solange ein System-Update läuft.',
        409,
      )
    }
  }

  function applyRuntimeSettingsChange({ activePrinterChanged, printerUrlChanged }) {
    const publicSettings = enrichPublicSettings(store.getPublicSettings())
    if (activePrinterChanged || printerUrlChanged) {
      runtimeEpoch += 1
      configCache = null
      effectObjects = []
      fanObjects = []
      discoveredObjects = []
      capabilityCache = null
      capabilityAt = 0
      gcodeFileSetCache = null
      gcodeFileSetAt = 0
      liveCapabilityRef = { config: null, load: null, unload: null, fans: '', hasExclude: false, value: null }
      lastResult = null
      if (activeUpdateJob && !activeUpdateJob.running) activeUpdateJob = null
      readMaterials.reset()
      readSpoolman.reset()
      live.emitSettings({ ...publicSettings, activePrinterChanged, printerUrlChanged })
      live.reconnect()
    } else {
      live.emitSettings({ ...publicSettings, activePrinterChanged: false, printerUrlChanged: false })
      live.notify()
    }
    if (scopedRuntimes) {
      const currentPrinters = new Map(store.getSettings().printers.map(p => [p.id, p]))
      for (const [id, entry] of [...scopedRuntimes.entries()]) {
        const profile = currentPrinters.get(id)
        if (!profile) {
          entry.runtime.closeLiveFeed()
          scopedRuntimes.delete(id)
        } else if (entry.url !== profile.url) {
          entry.url = profile.url
          entry.runtime.notifySettingsChange({
            activePrinterChanged: false,
            printerUrlChanged: true,
          })
        } else {
          entry.runtime.notifySettingsChange({
            activePrinterChanged: false,
            printerUrlChanged: false,
          })
        }
      }
    }
  }

  async function probeMoonrakerConnection(rawUrl) {
    let url
    try {
      url = normalizePrinterOrigin(rawUrl)
    } catch (err) {
      throw new ControlError(err.message, 400)
    }
    const started = Date.now()
    try {
      const infoRes = await fetchUpstream(`${url}/server/info`, { signal: AbortSignal.timeout(3500) })
      const latencyMs = Date.now() - started
      if (!infoRes.ok) {
        return { ok: false, url, latencyMs, error: `Moonraker antwortete mit HTTP ${infoRes.status}.` }
      }
      const infoJson = await infoRes.json().catch(() => null)
      const serverInfo = infoJson?.result ?? null
      if (!serverInfo || typeof serverInfo !== 'object') {
        return { ok: false, url, latencyMs, error: 'Unerwartete Antwort (kein Moonraker-Endpunkt).' }
      }
      let printerInfo = null
      try {
        const pRes = await fetchUpstream(`${url}/printer/info`, { signal: AbortSignal.timeout(2500) })
        if (pRes.ok) printerInfo = (await pRes.json().catch(() => null))?.result ?? null
      } catch {
        printerInfo = null
      }
      return {
        ok: true,
        url,
        latencyMs,
        moonrakerVersion: typeof serverInfo.moonraker_version === 'string' ? serverInfo.moonraker_version : null,
        klippyState: typeof serverInfo.klippy_state === 'string' ? serverInfo.klippy_state : null,
        hostname: typeof printerInfo?.hostname === 'string' ? printerInfo.hostname : null,
        softwareVersion: typeof printerInfo?.software_version === 'string' ? printerInfo.software_version : null,
      }
    } catch (err) {
      const latencyMs = Date.now() - started
      const message =
        err?.name === 'TimeoutError'
          ? 'Zeitüberschreitung (3,5 s) — Adresse oder Port nicht erreichbar.'
          : err?.cause?.code === 'ECONNREFUSED'
            ? 'Verbindung abgelehnt — läuft Moonraker/Nginx auf dieser Adresse?'
            : err?.message || 'Verbindung fehlgeschlagen.'
      return { ok: false, url, latencyMs, error: message }
    }
  }

function serializeUpdateJob(job) {
  if (!job) return null
  return {
    name: job.name,
    mode: job.mode,
    hard: Boolean(job.hard),
    running: Boolean(job.running),
    ok: job.ok ?? null,
    error: job.error ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    log: job.log.slice(-120),
  }
}

async function fetchGithubReleases(owner, repoName) {
  const key = `${owner}/${repoName}`
  const cached = releaseNotesCache.get(key)
  if (cached && Date.now() - cached.at < 15 * 60_000) return cached.data
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/releases?per_page=15`,
    {
      headers: {
        'User-Agent': 'dockyard-toolchanger-cockpit',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(6000),
    },
  )
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
  const data = await response.json()
  if (releaseNotesCache.size > 32) releaseNotesCache.clear()
  releaseNotesCache.set(key, { at: Date.now(), data })
  return data
}

function startUpdateJob({ name, mode, hard = false, printer = activeUrl() }) {
  if (activeUpdateJob?.running) {
    throw new ControlError('Ein Update- oder Recovery-Vorgang läuft bereits.', 409)
  }
  const job = {
    name,
    mode,
    hard: Boolean(hard),
    running: true,
    ok: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: [],
  }
  activeUpdateJob = job

  const pushLog = (message, complete = false) => {
    if (message) {
      job.log.push({ time: Date.now() / 1000, message })
      if (job.log.length > 200) job.log.shift()
    }
    live.emitUpdate({
      application: name,
      mode,
      message,
      complete,
      running: job.running,
      ok: job.ok,
      time: Date.now() / 1000,
    })
  }

  const method = mode === 'recover' ? 'machine.update.recover' : 'machine.update.upgrade'
  const params = mode === 'recover' ? { name, hard: Boolean(hard) } : { name }

  pushLog(
    mode === 'recover'
      ? `${name}: ${hard ? 'Hard-Reset' : 'Soft-Reset'} gestartet …`
      : `${name}: Update gestartet …`,
  )

  executeMoonrakerRpc({
    printer,
    method,
    params,
    timeoutMs: 900_000,
    onNotify(data) {
      if (data.method === 'notify_update_response') {
        const info = data.params?.[0]
        if (info?.message) pushLog(String(info.message), Boolean(info.complete))
      }
    },
  })
    .then(() => {
      job.running = false
      job.ok = true
      job.finishedAt = new Date().toISOString()
      pushLog(`${name}: abgeschlossen.`, true)
    })
    .catch(err => {
      const restartedSelf =
        name === 'moonraker' && /(disconnect|unterbrochen|beendet|geschlossen)/i.test(err?.message || '')
      job.running = false
      job.ok = restartedSelf
      job.error = restartedSelf ? null : err?.message || 'Update fehlgeschlagen.'
      job.finishedAt = new Date().toISOString()
      pushLog(
        restartedSelf
          ? 'Moonraker startet nach dem Update neu — Verbindung wird wiederhergestellt.'
          : `Fehler: ${job.error}`,
        true,
      )
    })

  return serializeUpdateJob(job)
}

function serializeJob(job) {
  if (!job) return null
  return {
    id: job.id,
    action: job.action,
    label: job.label,
    startedAt: job.startedAt,
    step: job.step ?? null,
    stepIndex: job.stepIndex ?? 0,
    stepTotal: job.stepTotal ?? 0,
    uncertain: !!job.uncertain,
  }
}

function getControlState() {
  const activeJobOrLock = currentJob ?? uncertainJobsByPrinter.get(getActive().id) ?? null
  return {
    job: serializeJob(activeJobOrLock),
    lastResult,
  }
}

function cachedCapabilities(raw) {
  const fanSignature = Object.keys(raw)
    .filter(name => name === 'fan' || /^fan_generic [A-Za-z0-9_-]+$/.test(name))
    .sort()
    .join(',')
  const load = raw['gcode_macro _LOAD_SETTINGS']?.temp_default ?? null
  const unload = raw['gcode_macro _UNLOAD_SETTINGS']?.temp_default ?? null
  const hasExclude = raw.exclude_object != null
  if (
    liveCapabilityRef.value &&
    liveCapabilityRef.config === raw.configfile &&
    liveCapabilityRef.load === load &&
    liveCapabilityRef.unload === unload &&
    liveCapabilityRef.fans === fanSignature &&
    liveCapabilityRef.hasExclude === hasExclude
  ) {
    return liveCapabilityRef.value
  }
  const computed = capabilities(raw)
  liveCapabilityRef = { config: raw.configfile, load, unload, fans: fanSignature, hasExclude, value: computed }
  return computed
}

let live = null
const readMaterials = createMaterialsReader(activeUrl, fetchUpstream, () => live?.notify())
const readSpoolman = createSpoolmanReader(activeUrl, fetchUpstream, () => live?.notify())

function normalized(raw) {
  const active = getActive()
  const data = normalizeStatus(raw)
  data.printerName = active.name
  data.printerSubtitle = active.subtitle
  data.activePrinterId = active.id
  const materials = readMaterials(raw, data.toolCount)
  const spoolman = readSpoolman.read()
  data.spoolman = spoolman
  const spoolMaterial = data.toolCount === 1 ? spoolToToolMaterial(spoolman.activeSpool) : null
  data.tools.forEach((tool, id) => {
    tool.material = id === 0 && spoolMaterial ? spoolMaterial : (materials[id] ?? null)
  })
  return data
}

live = createLiveFeed({
  getPrinter: activeUrl,
  baseObjects: objects,
  snapshot: raw => ({
    ...normalized(raw),
    capabilities: cachedCapabilities(raw),
    control: getControlState(),
    transport: 'live',
  }),
})

const closeLiveFeed = () => {
  live.close()
  if (scopedRuntimes) {
    for (const entry of scopedRuntimes.values()) {
      entry.runtime.closeLiveFeed()
    }
    scopedRuntimes.clear()
  }
}

const MAX_GCODE_UPLOAD_BYTES = 100 * 1024 * 1024

async function readRawBody(
  req,
  max = MAX_MODEL_BYTES,
  tooLargeMessage = 'Die GLB-Datei überschreitet das Limit von 25 MB. Bitte zuerst mit scripts/optimize-dockyard-glb.sh komprimieren.',
) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) {
    req.resume()
    throw new ControlError(tooLargeMessage, 413)
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > max) {
      throw new ControlError(tooLargeMessage, 413)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, max = 64_000) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > max) throw new ControlError('Anfrage zu groß.', 413)
    chunks.push(buf)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ControlError('Ungültiges JSON.')
  }
}

function isDynamicPrinterObject(name) {
  return (
    objects.includes(name) ||
    /^extruder([1-7])?$/.test(name) ||
    /^tool T[0-7]$/.test(name) ||
    name === 'z_tilt' ||
    name === 'quad_gantry_level' ||
    name === 'bed_screws' ||
    name === 'screws_tilt_adjust' ||
    name === 'manual_probe' ||
    name === 'firmware_retraction' ||
    name === 'gcode_macro SET_PAUSE_NEXT_LAYER' ||
    name === 'gcode_macro SET_PAUSE_AT_LAYER' ||
    name === 'fan' ||
    /^fan_generic [A-Za-z0-9_-]+$/.test(name) ||
    /^heater_fan [A-Za-z0-9_-]+$/.test(name) ||
    /^controller_fan [A-Za-z0-9_-]+$/.test(name) ||
    /^heater_generic [A-Za-z0-9_-]+$/.test(name) ||
    /^output_pin [A-Za-z0-9_-]+$/.test(name) ||
    /^temperature_sensor .+$/.test(name) ||
    /^temperature_fan .+$/.test(name) ||
    /^filament_(?:switch|motion)_sensor .+$/.test(name) ||
    /^neopixel [A-Za-z0-9_-]+$/.test(name) ||
    /^led [A-Za-z0-9_-]+$/.test(name) ||
    /^led_effect .+$/.test(name)
  )
}

function validateGcodeDir(raw) {
  if (raw == null || raw === '') return ''
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  if (trimmed.length > 200 || /[\x00-\x1f\x7f\\]/.test(trimmed) || /%2e|%2f|%5c|%00/i.test(trimmed)) {
    return null
  }
  const segments = trimmed.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.startsWith('.')) return null
    if (!/^[A-Za-z0-9 _.-]+$/.test(seg)) return null
  }
  return segments.join('/')
}

const PROTECTED_CONFIG_FILES = new Set([
  'printer.cfg',
  'moonraker.conf',
  'mainsail.cfg',
  'fluidd.cfg',
  'crowsnest.conf',
])

async function query(withConfig = false) {
  const epoch = runtimeEpoch
  const base = activeUrl()
  let nextFanObjects = fanObjects
  let nextDiscovered = discoveredObjects
  if (withConfig) {
    const response = await fetchUpstream(`${base}/printer/objects/list`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Druckerobjekte nicht erreichbar.')
    const data = await response.json()
    if (epoch !== runtimeEpoch) {
      throw new ControlError('Der aktive Drucker wurde während der Abfrage gewechselt.', 409)
    }
    const available = Array.isArray(data.result?.objects) ? data.result.objects : []
    nextFanObjects = available.filter(name => /^fan_generic [A-Za-z0-9_-]+$/.test(name))
    nextDiscovered = available.filter(isDynamicPrinterObject)
    fanObjects = nextFanObjects
    discoveredObjects = nextDiscovered
  }
  const queryList =
    nextDiscovered.length > 0
      ? Array.from(new Set([...nextDiscovered, ...effectObjects]))
      : [...objects, ...effectObjects, ...nextFanObjects]
  const queryNames = queryList.map(encodeURIComponent).join('&')
  const configParam = withConfig
    ? '&configfile=settings,save_config_pending,warnings'
    : '&configfile=save_config_pending,warnings'
  const response = await fetchUpstream(
    `${base}/printer/objects/query?${queryNames}${configParam}`,
    { signal: AbortSignal.timeout(5000) },
  )
  if (!response.ok) throw new Error(`Moonraker HTTP ${response.status}`)
  const data = await response.json()
  if (!data.result?.status) throw new Error('Keine Statusdaten von Moonraker')
  if (epoch !== runtimeEpoch) {
    throw new ControlError('Der aktive Drucker wurde während der Abfrage gewechselt.', 409)
  }
  if (withConfig) {
    capabilityCache = capabilities(data.result.status)
    capabilityAt = Date.now()
    configCache = data.result.status.configfile ?? null
    effectObjects = Object.keys(configCache?.settings ?? {}).filter(name => name.startsWith('led_effect '))
  }
  const mergedConfigfile = configCache
    ? {
        ...configCache,
        ...(data.result.status.configfile?.save_config_pending !== undefined
          ? { save_config_pending: data.result.status.configfile.save_config_pending }
          : {}),
        ...(Array.isArray(data.result.status.configfile?.warnings)
          ? { warnings: data.result.status.configfile.warnings }
          : {}),
      }
    : (data.result.status.configfile ?? null)
  return { ...data.result.status, configfile: mergedConfigfile }
}

function successMessageFor(action, label) {
  if (action === 'watch_start') {
    return 'Einlegehilfe ist scharf. Dein Makro übernimmt Aufheizen, Laden und Abkühlen.'
  }
  if (action === 'watch_stop') return 'Einlegehilfe beendet.'
  return `${label}: abgeschlossen.`
}

async function control(input, options = {}) {
  const { async: allowAsync = false, WebSocketImpl = WebSocket } = options
  const activePrinter = getActive()
  const activePrinterId = activePrinter.id
  const targetPrinterUrl = activePrinter.url

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ControlError('Ungültiger Befehl.')
  }

  const uncertainForActive = uncertainJobsByPrinter.get(activePrinterId) ?? null

  if (input.action === 'acknowledge') {
    if (Object.keys(input).some(key => key !== 'action') || !uncertainForActive) {
      throw new ControlError('Keine ungeklärte Aktion vorhanden.', 409)
    }
    const raw = await query()
    if (
      raw.webhooks?.state !== 'ready' ||
      !['standby', 'complete', 'cancelled', 'error'].includes(raw.print_stats?.state) ||
      raw.idle_timeout?.state === 'Printing'
    ) {
      throw new ControlError('Drucker ist noch nicht bereit.', 409)
    }
    uncertainJobsByPrinter.delete(activePrinterId)
    activeJobAbort = null
    lastResult = {
      id: ++jobSequence,
      ok: true,
      label: 'Bediensperre aufgehoben',
      message: 'Bediensperre nach deiner Prüfung aufgehoben.',
      at: new Date().toISOString(),
    }
    live.notify()
    return { message: lastResult.message }
  }

  const isStop = input.action === 'emergency_stop'
  const isBatchAbort = input.action === 'calibrate_beacon_abort'
  const isPromptAction = input.action === 'prompt_action'
  const NON_BLOCKING_ACTIONS = new Set([
    'fan',
    'set_led',
    'led',
    'output_pin',
    'temperature_fan',
    'filament_sensor',
    'heaters_off',
    'console',
  ])

  if (isPromptAction && !uncertainForActive) {
    if (input.dismiss === true) {
      await executeGcodeScript({
        printer: targetPrinterUrl,
        script: 'RESPOND TYPE=command MSG="action:prompt_end"',
        timeoutMs: 15_000,
        WebSocketImpl,
      }).catch(() => {})
      live.clearPrompt()
      return { message: 'Dialog geschlossen.' }
    }
    const activePrompt = live.getActivePrompt()
    if (!activePrompt?.open) {
      throw new ControlError('Aktuell ist kein Klipper-Dialog geöffnet.', 409)
    }
    const gcode = typeof input.gcode === 'string' ? input.gcode.trim() : ''
    const allowedButtons = [
      ...(activePrompt.footerButtons ?? []),
      ...(activePrompt.items ?? []).flatMap(item =>
        item.kind === 'group' ? item.buttons : item.kind === 'button' ? [item] : [],
      ),
    ]
    const matched = allowedButtons.find(btn => btn.gcode === gcode)
    if (!matched || !gcode || gcode.length > 500 || /[\r\n\x00-\x1f\x7f]/.test(gcode)) {
      throw new ControlError('Ungültige Dialog-Aktion.', 400)
    }
    live.emitConsole({ time: Date.now() / 1000, type: 'command', message: gcode })
    await executeGcodeScript({
      printer: targetPrinterUrl,
      script: gcode,
      timeoutMs: 60_000,
      WebSocketImpl,
    })
    const message = `${matched.label}: ausgeführt.`
    lastResult = { id: ++jobSequence, ok: true, label: matched.label, message, at: new Date().toISOString() }
    live.notify()
    return { message }
  }

  if (isBatchAbort && !uncertainForActive) {
    const raw = await query(true)
    const abortCmd = commandFor(input, raw)
    await executeGcodeScript({
      printer: targetPrinterUrl,
      script: abortCmd.body.script,
      timeoutMs: abortCmd.timeoutMs ?? 60_000,
      WebSocketImpl,
    })
    const message = successMessageFor(input.action, abortCmd.label)
    lastResult = {
      id: ++jobSequence,
      ok: true,
      label: abortCmd.label,
      message,
      at: new Date().toISOString(),
    }
    live.notify()
    return { message }
  }

  if (currentJob && !uncertainForActive && NON_BLOCKING_ACTIONS.has(input.action)) {
    const raw = await query(true)
    const sideCmd = commandFor(input, raw)
    if (input.action === 'console') {
      live.emitConsole({ time: Date.now() / 1000, type: 'command', message: sideCmd.body.script })
    }
    await executeGcodeScript({
      printer: targetPrinterUrl,
      script: sideCmd.body.script,
      timeoutMs: sideCmd.timeoutMs ?? 60_000,
      WebSocketImpl,
    })
    const message = successMessageFor(input.action, sideCmd.label)
    lastResult = { id: ++jobSequence, ok: true, label: sideCmd.label, message, at: new Date().toISOString() }
    live.notify()
    return { message }
  }

  if ((currentJob || uncertainForActive) && !isStop) {
    throw new ControlError('Ein Befehl läuft noch oder sein Ergebnis ist ungeklärt.', 409)
  }

  if (isStop) {
    activeJobAbort?.abort()
    const response = await fetchUpstream(`${targetPrinterUrl}/printer/emergency_stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    const data = await response.json()
    if (!response.ok || data.error) {
      throw new ControlError(data.error?.message ?? `Moonraker HTTP ${response.status}`, 409)
    }
    if (data.result !== 'ok') throw new Error('Keine eindeutige Bestätigung von Moonraker')
    lastResult = {
      id: ++jobSequence,
      ok: true,
      label: 'Not-Aus',
      message: 'Not-Aus: abgeschlossen.',
      at: new Date().toISOString(),
    }
    live.notify()
    return { message: lastResult.message }
  }

  // Reserve the slot before awaiting state, preventing concurrent requests from both passing.
  const job = {
    id: ++jobSequence,
    printerId: activePrinterId,
    action: input.action,
    label: 'Druckerzustand prüfen',
    startedAt: new Date().toISOString(),
    step: null,
    stepIndex: 0,
    stepTotal: 0,
    uncertain: false,
  }
  currentJob = job

  let command
  try {
    const raw = await query(true)
    command = commandFor(input, raw)
  } catch (error) {
    if (currentJob === job) currentJob = null
    lastResult = {
      id: job.id,
      ok: false,
      label: job.label,
      message: error.message,
      at: new Date().toISOString(),
    }
    live.notify()
    throw error
  }

  job.label = command.label
  job.stepTotal = command.steps?.length ?? 0
  const abortController = new AbortController()
  activeJobAbort = abortController

  if (input.action === 'console') {
    live.emitConsole({ time: Date.now() / 1000, type: 'command', message: command.body.script })
  }

  const runJob = async () => {
    let issued = false
    try {
      const stepTimeoutMs = command.timeoutMs ?? 600_000
      if (Array.isArray(command.steps) && command.steps.length > 0) {
        for (let index = 0; index < command.steps.length; index++) {
          if (abortController.signal.aborted) throw new AbortedCommandError()
          const currentStep = command.steps[index]
          job.stepIndex = index + 1
          job.step = currentStep.label
          live.notify()
          issued = true
          await executeGcodeScript({
            printer: targetPrinterUrl,
            script: currentStep.script,
            timeoutMs: stepTimeoutMs,
            signal: abortController.signal,
            WebSocketImpl,
          })
        }
      } else if (command.rpcMethod) {
        live.notify()
        issued = true
        await executeMoonrakerRpc({
          printer: targetPrinterUrl,
          method: command.rpcMethod,
          params: command.rpcParams ?? {},
          timeoutMs: stepTimeoutMs,
          signal: abortController.signal,
          WebSocketImpl,
          requireOkResult: command.requireOkResult !== false,
        })
      } else {
        live.notify()
        issued = true
        await executeGcodeScript({
          printer: targetPrinterUrl,
          script: command.body.script,
          timeoutMs: stepTimeoutMs,
          signal: abortController.signal,
          WebSocketImpl,
        })
      }

      if (currentJob === job) currentJob = null
      if (activeJobAbort === abortController) activeJobAbort = null
      const message = successMessageFor(input.action, command.label)
      lastResult = { id: job.id, ok: true, label: command.label, message, at: new Date().toISOString() }
      live.notify()
      return { message }
    } catch (error) {
      if (activeJobAbort === abortController) activeJobAbort = null
      if (error instanceof AbortedCommandError) {
        if (currentJob === job) currentJob = null
        lastResult = {
          id: job.id,
          ok: false,
          label: command.label,
          message: `${command.label}: durch Not-Aus abgebrochen.`,
          at: new Date().toISOString(),
        }
        live.notify()
        throw error
      }
      if (
        command.restartsKlipper &&
        issued &&
        /(disconnect|restart|unterbrochen|geschlossen|beendet)/i.test(error?.message || '')
      ) {
        if (currentJob === job) currentJob = null
        const message = `${command.label}: abgeschlossen — Klipper startet neu.`
        lastResult = { id: job.id, ok: true, label: command.label, message, at: new Date().toISOString() }
        live.notify()
        return { message }
      }
      if (currentJob === job) {
        currentJob = null
        if (issued) {
          job.uncertain = true
          job.label = `${command.label} · Ergebnis prüfen`
          uncertainJobsByPrinter.set(job.printerId, job)
        }
      }
      const message = issued
        ? `${error.message}. Druckerzustand prüfen; der Befehl wird nicht automatisch wiederholt.`
        : error.message
      lastResult = { id: job.id, ok: false, label: command.label, message, at: new Date().toISOString() }
      live.notify()
      if (issued) throw new ControlError(message, 502)
      throw error
    }
  }

  if (allowAsync && command.async) {
    live.notify()
    runJob().catch(() => {})
    return {
      statusCode: 202,
      accepted: true,
      async: true,
      job: serializeJob(job),
      message: `${command.label} gestartet …`,
    }
  }

  return runJob()
}

function streamCamera(id, res) {
  const target = resolveCameraTarget(id)
  if (!target?.streamUrl) {
    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Kamera nicht konfiguriert oder deaktiviert.' }))
    return
  }
  const upstream = requestStream(target.streamUrl, response => {
    if (
      response.statusCode !== 200 ||
      !response.headers['content-type']?.startsWith('multipart/x-mixed-replace')
    ) {
      response.destroy()
      res.statusCode = 502
      res.end()
      return
    }
    res.setHeader('Content-Type', response.headers['content-type'])
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    response.pipe(res)
    // Abort response abruptly on upstream drop so browser fetch/img detects a real failure.
    response.on('error', () => res.destroy())
    response.on('aborted', () => res.destroy())
  })
  upstream.setTimeout(15_000, () => upstream.destroy(new Error('Kamerastream unterbrochen')))
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.end()
    } else {
      res.destroy()
    }
  })
  res.on('close', () => upstream.destroy())
}

function streamGcodeDownload(relPath, res) {
  const baseName = relPath.split('/').pop() || 'file.gcode'
  const safeName = baseName.replace(/["\\\r\n]/g, '_')
  const upstream = requestStream(`${activeUrl()}/server/files/gcodes/${encodeMoonrakerPath(relPath)}`, response => {
    if (response.statusCode !== 200) {
      response.destroy()
      res.statusCode = response.statusCode === 404 ? 404 : 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'G-Code-Datei nicht verfügbar.' }))
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length'])
    }
    res.flushHeaders?.()
    response.pipe(res)
    response.on('error', () => res.destroy())
    response.on('aborted', () => res.destroy())
  })
  upstream.setTimeout(60_000, () => upstream.destroy(new Error('G-Code-Download unterbrochen')))
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'G-Code-Datei konnte nicht geladen werden.' }))
    } else {
      res.destroy()
    }
  })
  res.on('close', () => upstream.destroy())
}

function streamLogDownload(relPath, res) {
  const upstream = requestStream(`${activeUrl()}/server/files/logs/${encodeMoonrakerPath(relPath)}`, response => {
    if (response.statusCode !== 200) {
      response.destroy()
      res.statusCode = response.statusCode === 404 ? 404 : 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Logdatei nicht verfügbar.' }))
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${relPath}"`)
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length'])
    }
    res.flushHeaders?.()
    response.pipe(res)
    response.on('error', () => res.destroy())
    response.on('aborted', () => res.destroy())
  })
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('Log-Download unterbrochen')))
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Logdatei konnte nicht geladen werden.' }))
    } else {
      res.destroy()
    }
  })
  res.on('close', () => upstream.destroy())
}

async function probeMachineWriteGuard(allowUncertainRecovery = false) {
  const base = activeUrl()
  let queryStatus = 503
  let queryData = null
  try {
    const qRes = await fetchUpstream(
      `${base}/printer/objects/query?print_stats&webhooks&idle_timeout`,
      { signal: AbortSignal.timeout(5000) },
    )
    queryStatus = qRes.status
    if (qRes.ok) {
      const qJson = await qRes.json().catch(() => null)
      queryData = qJson?.result?.status ?? null
    }
  } catch {
    queryStatus = 503
  }

  let serverInfo = null
  if (queryStatus !== 200 || !queryData?.print_stats?.state) {
    try {
      const infoRes = await fetchUpstream(`${base}/server/info`, { signal: AbortSignal.timeout(5000) })
      if (infoRes.ok) {
        const infoJson = await infoRes.json().catch(() => null)
        serverInfo = infoJson?.result ?? null
      }
    } catch {
      serverInfo = null
    }
  }

  return evaluateMachineWriteGuard({
    queryStatus,
    queryData,
    serverInfo,
    job: getControlState().job,
    allowUncertainRecovery,
  })
}

async function executeRestartTarget(spec) {
  const base = activeUrl()
  if (spec.kind === 'klipper') {
    const response = await fetchUpstream(`${base}/printer/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new ControlError(`Klipper-Neustart fehlgeschlagen (HTTP ${response.status}).`, 502)
    return
  }
  if (spec.kind === 'firmware') {
    const response = await fetchUpstream(`${base}/printer/firmware_restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new ControlError(`Firmware-Neustart fehlgeschlagen (HTTP ${response.status}).`, 502)
    return
  }
  const response = await fetchUpstream(
    `${base}/machine/services/restart?service=${encodeURIComponent(spec.service)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: spec.service }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  // Restarting moonraker itself can close the HTTP socket right after accepting the restart.
  if (!response.ok && spec.service !== 'moonraker') {
    throw new ControlError(`Dienst-Neustart fehlgeschlagen (HTTP ${response.status}).`, 502)
  }
}

function printerMiddleware(req, res, next) {
  const parsedUrl = new URL(req.url, 'http://localhost')
  const path = parsedUrl.pathname
  if (!path.startsWith('/api/')) return next()
  res.setHeader('Cache-Control', 'no-store')

  const json = (code, value) => {
    if (res.destroyed) return
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(value))
  }

  const camera = path.match(/^\/api\/camera\/([a-z0-9][a-z0-9_-]{0,31})(?:\/(stream|webrtc))?$/)
  const printRoute = path.match(/^\/api\/print\/(files|metadata|thumbnail|model|upload|file|queue|mkdir|move|download|dir)$/)
  const settingsRoute = path.match(/^\/api\/settings(?:\/(switch|test))?$/)
  const modelRoute = path.match(/^\/api\/models\/([a-z0-9][a-z0-9_-]{0,31})\/(toolhead|printer)$/)
  const spoolmanRoute = path.match(/^\/api\/spoolman\/(spools|active)$/)
  const systemRoute = path.match(
    /^\/api\/system\/(overview|calibration|calibration\/shaketune-image|endstops|config\/list|config\/file|config\/save|config\/create|service\/restart|host\/reboot|host\/shutdown|power|updates|updates\/refresh|updates\/notes|updates\/upgrade|updates\/recover|logs\/list|logs\/tail|logs\/download)$/,
  )
  if (
    path !== '/api/status' &&
    path !== '/api/control' &&
    path !== '/api/events' &&
    path !== '/api/console' &&
    path !== '/api/console/help' &&
    path !== '/api/presets' &&
    path !== '/api/temperature-history' &&
    path !== '/api/history' &&
    !camera &&
    !printRoute &&
    !settingsRoute &&
    !modelRoute &&
    !spoolmanRoute &&
    !systemRoute
  ) {
    return json(404, { error: 'Unbekannter Endpunkt' })
  }

  const systemSub = systemRoute?.[1]
  const settingsSub = settingsRoute?.[1]
  const spoolmanSub = spoolmanRoute?.[1]
  const printSub = printRoute?.[1]

  if (!pinnedPrinterId && !settingsRoute && !modelRoute) {
    const requestedPrinterId = String(
      parsedUrl.searchParams.get('printer') ?? req.headers?.['x-dockyard-printer'] ?? '',
    )
      .trim()
      .toLowerCase()
    if (requestedPrinterId) {
      const scoped = getScopedRuntime(requestedPrinterId)
      if (!scoped) return json(404, { error: 'Druckerprofil nicht gefunden.' })
      return scoped.printerMiddleware(req, res, next)
    }
  }
  const isSettingsGet = path === '/api/settings' && req.method === 'GET'
  const isPresetsGet = path === '/api/presets' && req.method === 'GET'
  const isPresetsWrite = path === '/api/presets' && req.method === 'POST'
  const isModelGet = Boolean(modelRoute) && req.method === 'GET'
  const isModelWrite = Boolean(modelRoute) && (req.method === 'POST' || req.method === 'DELETE')
  const isPrintUpload = printSub === 'upload' && req.method === 'POST'
  const isPrintDelete = printSub === 'file' && req.method === 'DELETE'
  const isPrintDirDelete = printSub === 'dir' && req.method === 'DELETE'
  const isPrintMkdir = printSub === 'mkdir' && req.method === 'POST'
  const isPrintMove = printSub === 'move' && req.method === 'POST'
  const isPrintQueueGet = printSub === 'queue' && req.method === 'GET'
  const isPrintQueueWrite = printSub === 'queue' && req.method === 'POST'
  const isSystemPowerGet = systemSub === 'power' && req.method === 'GET'
  const isSystemPowerWrite = systemSub === 'power' && req.method === 'POST'
  const isConfigFileGet = systemSub === 'config/file' && req.method === 'GET'
  const isConfigFileDelete = systemSub === 'config/file' && req.method === 'DELETE'
  const write =
    !isSettingsGet &&
    !isPresetsGet &&
    !isModelGet &&
    !isPrintQueueGet &&
    !isSystemPowerGet &&
    !isConfigFileGet &&
    (path === '/api/control' ||
      path === '/api/settings' ||
      isPresetsWrite ||
      settingsSub === 'switch' ||
      settingsSub === 'test' ||
      isModelWrite ||
      isPrintUpload ||
      isPrintDelete ||
      isPrintDirDelete ||
      isPrintMkdir ||
      isPrintMove ||
      isPrintQueueWrite ||
      isSystemPowerWrite ||
      spoolmanSub === 'active' ||
      camera?.[2] === 'webrtc' ||
      systemSub === 'config/save' ||
      systemSub === 'config/create' ||
      isConfigFileDelete ||
      systemSub === 'service/restart' ||
      systemSub === 'host/reboot' ||
      systemSub === 'host/shutdown' ||
      systemSub === 'updates/refresh' ||
      systemSub === 'updates/upgrade' ||
      systemSub === 'updates/recover')
  if (modelRoute) {
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      return json(405, { error: 'Methode nicht erlaubt.' })
    }
  } else if (printSub === 'file' || printSub === 'dir') {
    if (req.method !== 'DELETE') return json(405, { error: 'Methode nicht erlaubt.' })
  } else if (systemSub === 'config/file') {
    if (!['GET', 'DELETE'].includes(req.method)) return json(405, { error: 'Methode nicht erlaubt.' })
  } else if (printSub === 'queue' || systemSub === 'power' || path === '/api/presets') {
    if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Methode nicht erlaubt.' })
  } else if (!isSettingsGet && req.method !== (write ? 'POST' : 'GET')) {
    return json(405, { error: 'Methode nicht erlaubt.' })
  }
  const binaryWriteAllowed = allowedTypes => {
    if (
      !isOriginWriteAllowed(req, store.getEffectiveAllowedOrigins(), { allowLanOrigins: store.isLanOriginAllowed() }) ||
      req.headers['x-cockpit-request'] !== '1'
    ) {
      return false
    }
    if (req.method === 'DELETE') return true
    const ct = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    return !ct || allowedTypes.includes(ct)
  }
  if (
    write &&
    !(isModelWrite
      ? binaryWriteAllowed(['model/gltf-binary', 'application/octet-stream'])
      : isPrintUpload || isPrintDelete || isPrintDirDelete || isConfigFileDelete
        ? binaryWriteAllowed(['application/octet-stream', 'text/plain', 'text/x.gcode'])
        : sameOriginRequest(req, store.getEffectiveAllowedOrigins(), { allowLanOrigins: store.isLanOriginAllowed() }))
  ) {
    return json(403, { error: 'Befehle sind nur aus dieser lokalen Oberfläche erlaubt.' })
  }
  if (path === '/api/events') return live.handle(req, res)
  if (camera?.[2] === 'stream') return streamCamera(camera[1], res)
  if (printSub === 'download') {
    const filename = validateGcodeFilename(parsedUrl.searchParams.get('filename'))
    if (!filename) return json(400, { error: 'Ungültiger Dateiname.' })
    return streamGcodeDownload(filename, res)
  }
  if (systemSub === 'logs/download') {
    const logPath = validateLogPath(parsedUrl.searchParams.get('path'))
    if (!logPath) return json(400, { error: 'Ungültiger Logpfad.' })
    return streamLogDownload(logPath, res)
  }

  ;(async () => {
    try {
      if (modelRoute) {
        const [, printerId, slot] = modelRoute
        if (req.method === 'GET') {
          const item = await modelStore.readModel(printerId, slot)
          if (!item) return json(404, { error: 'Kein 3D-Modell für diesen Slot vorhanden.' })
          res.setHeader('Cache-Control', 'private, no-cache')
          res.setHeader('ETag', item.meta.etag)
          res.setHeader('X-Content-Type-Options', 'nosniff')
          if (req.headers['if-none-match'] && req.headers['if-none-match'] === item.meta.etag) {
            res.statusCode = 304
            res.end()
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'model/gltf-binary')
          res.setHeader('Content-Length', String(item.buffer.byteLength))
          res.end(item.buffer)
          return
        }
        if (req.method === 'DELETE') {
          await modelStore.deleteModel(printerId, slot)
          const enriched = enrichPublicSettings(store.getPublicSettings(buildRuntimeMeta(req)))
          live.emitSettings({ ...enrichPublicSettings(store.getPublicSettings()), activePrinterChanged: false, printerUrlChanged: false })
          return json(200, { ok: true, printerId, slot, settings: enriched })
        }
        // POST /api/models/:printerId/:slot
        const exists = store.getSettings().printers.some(p => p.id === printerId)
        if (!exists) {
          throw new ControlError('Druckerprofil nicht gefunden. Bitte Profil zuerst speichern.', 404)
        }
        const buffer = await readRawBody(req, MAX_MODEL_BYTES)
        const rawFilenameHeader = String(req.headers['x-model-filename'] ?? parsedUrl.searchParams.get('filename') ?? '')
        let decodedFilename = rawFilenameHeader
        try {
          decodedFilename = decodeURIComponent(rawFilenameHeader)
        } catch {
          // Keep raw filename when not percent-encoded.
        }
        let meta
        try {
          meta = await modelStore.saveModel(printerId, slot, buffer, decodedFilename)
        } catch (err) {
          throw new ControlError(err.message || 'Ungültige GLB-Datei.', 400)
        }
        const enriched = enrichPublicSettings(store.getPublicSettings(buildRuntimeMeta(req)))
        live.emitSettings({ ...enrichPublicSettings(store.getPublicSettings()), activePrinterChanged: false, printerUrlChanged: false })
        return json(200, { ok: true, printerId, slot, meta, settings: enriched })
      }

      if (settingsRoute) {
        if (isSettingsGet) {
          return json(200, enrichPublicSettings(store.getPublicSettings(buildRuntimeMeta(req))))
        }
        if (settingsSub === 'test') {
          const payload = await readJson(req, 4096)
          const result = await probeMoonrakerConnection(payload?.url)
          return json(200, result)
        }
        if (settingsSub === 'switch') {
          const payload = await readJson(req, 4096)
          const nextId = String(payload?.printerId ?? '').trim().toLowerCase()
          const currentActive = getActive()
          const targetProfile = store.getSettings().printers.find(p => p.id === nextId)
          if (!targetProfile) throw new ControlError('Druckerprofil wurde nicht gefunden.', 404)
          if (targetProfile.id !== currentActive.id || targetProfile.url !== currentActive.url) {
            assertNoActiveJobForSwitch()
          }
          const change = await store.switchPrinter(nextId)
          applyRuntimeSettingsChange(change)
          return json(200, {
            ...enrichPublicSettings(store.getPublicSettings(buildRuntimeMeta(req))),
            activePrinterChanged: change.activePrinterChanged,
            printerUrlChanged: change.printerUrlChanged,
          })
        }
        // POST /api/settings
        const payload = await readJson(req, 64_000)
        let validated
        try {
          validated = validateSettingsPayload(payload)
        } catch (err) {
          throw new ControlError(err.message, 400)
        }

        // Prevent accidental self-lockout from a non-loopback LAN/Meet browser
        if (!isLoopbackOrigin(req) && payload?.confirmSelfLockout !== true) {
          const publicCurrent = store.getPublicSettings()
          const nextAllowed = Array.from(
            new Set([...publicCurrent.network.envAllowedOrigins, ...validated.network.allowedOrigins]),
          )
          const nextAllowLan = publicCurrent.network.envAllowLanOrigins || validated.network.allowLanOrigins
          if (!isOriginWriteAllowed(req, nextAllowed, { allowLanOrigins: nextAllowLan })) {
            const lockoutError = new ControlError(
              'Diese Netzwerkeinstellungen würden deinem aktuellen Browser den Schreibzugriff entziehen. Bitte bestätigen, wenn das gewollt ist.',
              400,
            )
            lockoutError.code = 'SELF_LOCKOUT'
            throw lockoutError
          }
        }

        const previousIds = store.getSettings().printers.map(p => p.id)
        const nextIds = new Set(validated.printers.map(p => p.id))
        const removedIds = previousIds.filter(id => !nextIds.has(id))

        const currentActive = getActive()
        const nextActive = validated.printers.find(p => p.id === validated.activePrinterId) ?? validated.printers[0]
        if (nextActive.id !== currentActive.id || nextActive.url !== currentActive.url) {
          assertNoActiveJobForSwitch()
        }

        const change = await store.saveSettings(validated)
        for (const removedId of removedIds) {
          await modelStore.removePrinter(removedId).catch(() => {})
        }
        applyRuntimeSettingsChange(change)
        return json(200, {
          ...enrichPublicSettings(store.getPublicSettings(buildRuntimeMeta(req))),
          activePrinterChanged: change.activePrinterChanged,
          printerUrlChanged: change.printerUrlChanged,
        })
      }

      const printer = activeUrl()
      if (spoolmanRoute) {
        if (spoolmanSub === 'spools') {
          const result = await fetchSpoolmanList(printer, fetchUpstream)
          return json(200, result)
        }
        // POST /api/spoolman/active
        const payload = await readJson(req, 2048)
        const result = await setActiveSpoolmanSpool(printer, payload?.spoolId ?? null, fetchUpstream)
        readSpoolman.setActive(result)
        live.notify()
        return json(200, { ok: true, ...result })
      }
      if (systemRoute) {
        if (systemSub === 'overview') {
          const [procRes, sysRes, infoRes, dirRes, objListRes] = await Promise.all([
            fetchUpstream(`${printer}/machine/proc_stats`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetchUpstream(`${printer}/machine/system_info`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetchUpstream(`${printer}/server/info`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetchUpstream(`${printer}/server/files/directory?path=gcodes`, { signal: AbortSignal.timeout(4000) }).catch(
              () => null,
            ),
            fetchUpstream(`${printer}/printer/objects/list`, { signal: AbortSignal.timeout(4000) }).catch(() => null),
          ])
          if (!procRes?.ok && !sysRes?.ok && !infoRes?.ok) {
            throw new Error('Moonraker-Systemdaten nicht erreichbar.')
          }
          const procJson = procRes?.ok ? await procRes.json().catch(() => null) : null
          const sysJson = sysRes?.ok ? await sysRes.json().catch(() => null) : null
          const infoJson = infoRes?.ok ? await infoRes.json().catch(() => null) : null
          const dirJson = dirRes?.ok ? await dirRes.json().catch(() => null) : null
          const objListJson = objListRes?.ok ? await objListRes.json().catch(() => null) : null

          let mcuStatus = null
          const mcuObjects = (Array.isArray(objListJson?.result?.objects) ? objListJson.result.objects : []).filter(
            name => name === 'mcu' || /^mcu [A-Za-z0-9_-]+$/.test(name),
          )
          if (mcuObjects.length > 0 && infoJson?.result?.klippy_connected !== false) {
            const mcuQuery = mcuObjects.map(encodeURIComponent).join('&')
            const mcuRes = await fetchUpstream(`${printer}/printer/objects/query?${mcuQuery}`, {
              signal: AbortSignal.timeout(4000),
            }).catch(() => null)
            if (mcuRes?.ok) {
              const mcuJson = await mcuRes.json().catch(() => null)
              mcuStatus = mcuJson?.result?.status ?? null
            }
          }

          return json(
            200,
            normalizeSystemOverview({
              procStats: procJson?.result ?? null,
              systemInfo: sysJson?.result?.system_info ?? null,
              serverInfo: infoJson?.result ?? null,
              diskUsage: dirJson?.result?.disk_usage ?? null,
              mcuStatus,
            }),
          )
        }

        if (systemSub === 'calibration') {
          const [listRes, filesRes] = await Promise.all([
            fetchUpstream(`${printer}/printer/objects/list`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetchUpstream(`${printer}/server/files/list?root=config`, { signal: AbortSignal.timeout(6000) }).catch(() => null),
          ])
          const availableObjects = listRes?.ok
            ? (await listRes.json().catch(() => null))?.result?.objects ?? []
            : []
          const availSet = new Set(availableObjects)
          const wanted = [
            'bed_mesh',
            'quad_gantry_level',
            'z_tilt',
            'bed_screws',
            'screws_tilt_adjust',
            'manual_probe',
            'probe',
            'bltouch',
            'scanner',
            'cartographer',
            'beacon',
            'tools_calibrate',
            'save_variables',
            'gcode_macro _BEACON_BATCH_STATE',
            'toolchanger',
            'temperature_sensor beacon_coil',
            ...Array.from({ length: 8 }, (_, i) => [i ? `extruder${i}` : 'extruder', `tool T${i}`]).flat(),
          ].filter(name => availSet.size === 0 || availSet.has(name))

          const queryStr = [...wanted.map(encodeURIComponent), 'configfile=settings,save_config_pending'].join('&')
          const qRes = await fetchUpstream(`${printer}/printer/objects/query?${queryStr}`, {
            signal: AbortSignal.timeout(6000),
          })
          if (!qRes.ok) throw new Error('Kalibrierungsdaten nicht erreichbar.')
          const qJson = await qRes.json()
          const filesJson = filesRes?.ok ? await filesRes.json().catch(() => null) : null
          return json(
            200,
            normalizeCalibrationData({
              rawStatus: qJson?.result?.status ?? {},
              configFiles: filesJson?.result ?? [],
            }),
          )
        }

        if (systemSub === 'calibration/shaketune-image') {
          const imgPath = validateShakeTuneImagePath(parsedUrl.searchParams.get('path'))
          if (!imgPath) throw new ControlError('Ungültiger Bildpfad.', 400)
          const response = await fetchUpstream(`${printer}/server/files/config/${encodeMoonrakerPath(imgPath)}`, {
            signal: AbortSignal.timeout(8000),
          })
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
            throw new Error('ShakeTune-Diagramm nicht verfügbar.')
          }
          const bytes = Buffer.from(await response.arrayBuffer())
          if (bytes.length > 8 * 1024 * 1024) throw new Error('Diagramm zu groß.')
          res.setHeader('Content-Type', 'image/png')
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.end(bytes)
          return
        }

        if (systemSub === 'endstops') {
          const eRes = await fetchUpstream(`${printer}/printer/query_endstops/status`, {
            signal: AbortSignal.timeout(6000),
          })
          if (!eRes.ok) {
            const errJson = await eRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message || `Endschalter konnten nicht abgefragt werden (HTTP ${eRes.status}).`,
              eRes.status === 400 ? 409 : 502,
            )
          }
          const eJson = await eRes.json().catch(() => ({}))
          const rawMap = eJson?.result && typeof eJson.result === 'object' ? eJson.result : {}
          const endstops = Object.entries(rawMap)
            .filter(([name]) => typeof name === 'string' && name.trim())
            .map(([name, state]) => ({
              name,
              state: String(state ?? 'unknown').toLowerCase(),
              triggered: String(state ?? '').toUpperCase() === 'TRIGGERED',
            }))
            .sort((a, b) => a.name.localeCompare(b.name))
          return json(200, { endstops, queriedAt: new Date().toISOString() })
        }

        if (systemSub === 'config/list') {
          const response = await fetchUpstream(`${printer}/server/files/list?root=config`, {
            signal: AbortSignal.timeout(7000),
          })
          if (!response.ok) throw new Error('Konfigurationsdateien nicht erreichbar.')
          const data = await response.json()
          return json(200, { files: normalizeConfigList(data?.result ?? []) })
        }

        if (systemSub === 'config/file') {
          const relPath = validateConfigPath(parsedUrl.searchParams.get('path'))
          if (!relPath) throw new ControlError('Ungültiger Konfigurationspfad.', 400)
          if (req.method === 'DELETE') {
            if (PROTECTED_CONFIG_FILES.has(relPath.toLowerCase())) {
              throw new ControlError('Zentrale Systemkonfigurationen können nicht gelöscht werden.', 403)
            }
            await probeMachineWriteGuard(true)
            const listRes = await fetchUpstream(`${printer}/server/files/list?root=config`, {
              signal: AbortSignal.timeout(6000),
            })
            if (!listRes.ok) throw new Error('Konfigurationsliste nicht erreichbar.')
            const listJson = await listRes.json()
            const entry = (listJson?.result ?? []).find(item => item?.path === relPath) ?? null
            const { path: validPath } = validateWritableConfigPath(relPath, entry)
            const delRes = await fetchUpstream(`${printer}/server/files/config/${encodeMoonrakerPath(validPath)}`, {
              method: 'DELETE',
              signal: AbortSignal.timeout(8000),
            })
            if (!delRes.ok) {
              const errJson = await delRes.json().catch(() => null)
              throw new ControlError(
                errJson?.error?.message || 'Konfigurationsdatei konnte nicht gelöscht werden.',
                delRes.status === 404 ? 404 : 502,
              )
            }
            return json(200, { ok: true, deleted: validPath })
          }
          const [listRes, fileRes] = await Promise.all([
            fetchUpstream(`${printer}/server/files/list?root=config`, { signal: AbortSignal.timeout(6000) }),
            fetchUpstream(`${printer}/server/files/config/${encodeMoonrakerPath(relPath)}`, {
              signal: AbortSignal.timeout(8000),
            }),
          ])
          if (!fileRes.ok) {
            throw new ControlError('Konfigurationsdatei nicht gefunden.', fileRes.status === 404 ? 404 : 502)
          }
          const bytes = Buffer.from(await fileRes.arrayBuffer())
          if (bytes.length > MAX_CONFIG_BYTES) {
            throw new ControlError('Konfigurationsdatei überschreitet das Limit von 512 KB.', 413)
          }
          if (bytes.includes(0)) {
            throw new ControlError('Binärdatei kann nicht im Texteditor geöffnet werden.', 400)
          }
          const listJson = listRes.ok ? await listRes.json().catch(() => null) : null
          const rawEntry = (listJson?.result ?? []).find(item => item?.path === relPath) ?? {
            path: relPath,
            size: bytes.length,
            modified: null,
            permissions: 'r',
          }
          const meta = classifyConfigFile(rawEntry)
          return json(200, {
            path: relPath,
            printerId: getActive().id,
            content: bytes.toString('utf8'),
            size: bytes.length,
            modified: meta?.modified ?? null,
            readonly: meta ? meta.readonly : true,
            isBackup: meta?.isBackup ?? false,
            isScript: meta?.isScript ?? false,
          })
        }

        if (systemSub === 'config/create') {
          const payload = await readJson(req, MAX_CONFIG_BYTES + 80_000)
          const relPath = validateConfigPath(payload?.path)
          if (!relPath) throw new ControlError('Ungültiger Konfigurationspfad.', 400)
          const classified = classifyConfigFile({ path: relPath, permissions: 'rw' })
          if (!classified || classified.readonly) {
            throw new ControlError('Nur Textdateien (.cfg, .conf, .md, .txt, .json) außerhalb von Backups erlaubt.', 403)
          }
          await probeMachineWriteGuard(true)
          const listRes = await fetchUpstream(`${printer}/server/files/list?root=config`, {
            signal: AbortSignal.timeout(6000),
          })
          if (!listRes.ok) throw new Error('Konfigurationsliste nicht erreichbar.')
          const listJson = await listRes.json()
          const exists = (listJson?.result ?? []).some(item => item?.path === classified.path)
          if (exists) {
            throw new ControlError('Eine Konfigurationsdatei mit diesem Pfad existiert bereits.', 409)
          }
          const content = validateConfigContent(
            typeof payload?.content === 'string' ? payload.content : `# ${classified.path}\n`,
          )
          const uploadRes = await fetchUpstream(`${printer}/server/files/upload`, {
            method: 'POST',
            body: buildConfigUploadFormData(classified.path, content),
            signal: AbortSignal.timeout(10_000),
          })
          if (!uploadRes.ok) {
            const errJson = await uploadRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message ?? `Datei konnte nicht erstellt werden (HTTP ${uploadRes.status}).`,
              502,
            )
          }
          return json(200, { ok: true, created: classified.path })
        }

        if (systemSub === 'config/save') {
          const payload = await readJson(req, MAX_CONFIG_BYTES + 80_000)
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new ControlError('Ungültige Speicheranfrage.', 400)
          }
          if (payload.expectedPrinterId !== undefined && payload.expectedPrinterId !== null) {
            if (String(payload.expectedPrinterId).trim().toLowerCase() !== getActive().id) {
              const err = new ControlError(
                'Der aktive Drucker wurde geändert. Speichern abgebrochen, um ein Überschreiben auf dem falschen Drucker zu verhindern.',
                409,
              )
              err.code = 'PRINTER_CHANGED'
              throw err
            }
          }
          await probeMachineWriteGuard(true)
          const listRes = await fetchUpstream(`${printer}/server/files/list?root=config`, {
            signal: AbortSignal.timeout(6000),
          })
          if (!listRes.ok) throw new Error('Konfigurationsliste nicht erreichbar.')
          const listJson = await listRes.json()
          const entry = (listJson?.result ?? []).find(item => item?.path === payload.path) ?? null
          const { path: validPath } = validateWritableConfigPath(payload.path, entry)
          const content = validateConfigContent(payload.content)
          checkExpectedModified({
            expectedModified: payload.expectedModified,
            currentModified: entry?.modified,
            force: payload.force === true,
          })

          const restartOption = payload.restart ?? 'none'
          if (!['none', 'klipper_restart', 'moonraker', 'crowsnest'].includes(restartOption)) {
            throw new ControlError('Ungültige Neustart-Option.', 400)
          }

          let restartSpec = null
          if (restartOption !== 'none') {
            const sysRes = await fetchUpstream(`${printer}/machine/system_info`, { signal: AbortSignal.timeout(5000) }).catch(
              () => null,
            )
            const sysJson = sysRes?.ok ? await sysRes.json().catch(() => null) : null
            const avail = sysJson?.result?.system_info?.available_services ?? ['klipper', 'moonraker', 'crowsnest']
            restartSpec = validateRestartTarget(restartOption, avail)
          }

          const uploadRes = await fetchUpstream(`${printer}/server/files/upload`, {
            method: 'POST',
            body: buildConfigUploadFormData(validPath, content),
            signal: AbortSignal.timeout(10_000),
          })
          if (!uploadRes.ok) {
            const errJson = await uploadRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message ?? `Speichern fehlgeschlagen (HTTP ${uploadRes.status}).`,
              502,
            )
          }
          const uploadJson = await uploadRes.json().catch(() => null)
          let newModified =
            Number.isFinite(uploadJson?.item?.modified)
              ? uploadJson.item.modified
              : Number.isFinite(uploadJson?.result?.item?.modified)
                ? uploadJson.result.item.modified
                : null
          if (newModified == null) {
            const refreshRes = await fetchUpstream(`${printer}/server/files/list?root=config`, {
              signal: AbortSignal.timeout(5000),
            }).catch(() => null)
            const refreshJson = refreshRes?.ok ? await refreshRes.json().catch(() => null) : null
            const updatedEntry = (refreshJson?.result ?? []).find(item => item?.path === validPath)
            if (Number.isFinite(updatedEntry?.modified)) newModified = updatedEntry.modified
          }

          let restarted = null
          if (restartSpec) {
            try {
              await executeRestartTarget(restartSpec)
              restarted = restartOption
            } catch (restartErr) {
              if (restartSpec.service === 'moonraker') {
                restarted = restartOption
              } else {
                throw new ControlError(
                  `Datei gespeichert, aber Neustart fehlgeschlagen: ${restartErr.message}`,
                  502,
                )
              }
            }
          }

          return json(200, {
            saved: true,
            path: validPath,
            modified: newModified,
            restarted,
            message: restarted
              ? `${validPath} gespeichert · Neustart ausgelöst.`
              : `${validPath} gespeichert.`,
          })
        }

        if (systemSub === 'service/restart') {
          const payload = await readJson(req, 4000)
          const target = payload?.target
          const sysRes = await fetchUpstream(`${printer}/machine/system_info`, { signal: AbortSignal.timeout(5000) }).catch(
            () => null,
          )
          const sysJson = sysRes?.ok ? await sysRes.json().catch(() => null) : null
          const avail = sysJson?.result?.system_info?.available_services ?? []
          const spec = validateRestartTarget(target, avail)
          const allowUncertainRecovery = ['klipper_restart', 'firmware_restart', 'klipper'].includes(target)
          await probeMachineWriteGuard(allowUncertainRecovery)

          try {
            await executeRestartTarget(spec)
          } catch (restartErr) {
            if (spec.service !== 'moonraker') throw restartErr
          }

          return json(200, {
            ok: true,
            target,
            message: `${spec.label}: ausgelöst. Verbindung wird automatisch neu aufgebaut.`,
          })
        }

        if (systemSub === 'host/reboot' || systemSub === 'host/shutdown') {
          await readJson(req, 2048).catch(() => ({}))
          const hostAction = systemSub === 'host/reboot' ? 'reboot' : 'shutdown'
          const spec = validateHostAction(hostAction)
          await probeMachineWriteGuard(false)
          try {
            const hRes = await fetchUpstream(`${printer}${spec.endpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(8000),
            })
            if (!hRes.ok) {
              const errJson = await hRes.json().catch(() => null)
              throw new ControlError(
                errJson?.error?.message || `${spec.label} fehlgeschlagen (HTTP ${hRes.status}).`,
                hRes.status === 403 || hRes.status === 404 ? hRes.status : 502,
              )
            }
          } catch (hostErr) {
            if (hostErr instanceof ControlError) throw hostErr
            // Host reboot/shutdown may drop connection immediately after accepting the command.
          }
          return json(200, {
            ok: true,
            action: spec.action,
            message:
              spec.action === 'reboot'
                ? 'Host-Neustart ausgelöst. Der Drucker verbindet sich nach dem Booten automatisch wieder.'
                : 'Host wird heruntergefahren. Bitte warte vor dem Trennen der Stromversorgung.',
          })
        }

        if (systemSub === 'power') {
          if (req.method === 'GET') {
            const pRes = await fetchUpstream(`${printer}/machine/device_power/devices`, {
              signal: AbortSignal.timeout(5000),
            }).catch(() => null)
            if (!pRes || pRes.status === 404) {
              return json(200, { available: false, devices: [] })
            }
            if (!pRes.ok) throw new Error('Stromgeräte nicht erreichbar.')
            const pJson = await pRes.json().catch(() => ({}))
            return json(200, {
              available: true,
              devices: normalizePowerDevices(pJson?.result),
            })
          }

          const payload = await readJson(req, 4000)
          const listRes = await fetchUpstream(`${printer}/machine/device_power/devices`, {
            signal: AbortSignal.timeout(5000),
          }).catch(() => null)
          if (!listRes || listRes.status === 404) {
            throw new ControlError('Moonraker Power-Plugin ist nicht konfiguriert.', 404)
          }
          if (!listRes.ok) throw new Error('Stromgeräte nicht erreichbar.')
          const listJson = await listRes.json().catch(() => ({}))
          const devices = normalizePowerDevices(listJson?.result)
          const { device: targetDev, action } = validatePowerAction(payload?.device, payload?.action, devices)

          const mightTurnOff = action === 'off' || (action === 'toggle' && targetDev.status === 'on')
          if (mightTurnOff && targetDev.lockedWhilePrinting) {
            await probeMachineWriteGuard(false)
          }

          const postUrl = `${printer}/machine/device_power/device?device=${encodeURIComponent(targetDev.device)}&action=${encodeURIComponent(action)}`
          const setRes = await fetchUpstream(postUrl, {
            method: 'POST',
            signal: AbortSignal.timeout(8000),
          })
          if (!setRes.ok) {
            const errJson = await setRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message || `Stromgerät konnte nicht geschaltet werden (HTTP ${setRes.status}).`,
              setRes.status >= 400 && setRes.status < 500 ? setRes.status : 502,
            )
          }
          const setJson = await setRes.json().catch(() => ({}))
          const nextState = setJson?.result?.[targetDev.device] ?? (action === 'on' ? 'on' : action === 'off' ? 'off' : 'unknown')
          return json(200, {
            ok: true,
            device: targetDev.device,
            status: nextState,
          })
        }

        if (systemSub === 'updates') {
          const response = await fetchUpstream(`${printer}/machine/update/status`, {
            signal: AbortSignal.timeout(8000),
          })
          if (!response.ok) throw new Error('Update-Status nicht erreichbar.')
          const data = await response.json()
          return json(200, {
            ...normalizeUpdateStatus(data?.result ?? {}),
            activeJob: serializeUpdateJob(activeUpdateJob),
          })
        }

        if (systemSub === 'updates/notes') {
          const name = validateUpdateName(parsedUrl.searchParams.get('name'))
          if (!name) throw new ControlError('Ungültiger Komponentenname.', 400)
          const response = await fetchUpstream(`${printer}/machine/update/status`, {
            signal: AbortSignal.timeout(8000),
          })
          if (!response.ok) throw new Error('Update-Status nicht erreichbar.')
          const data = await response.json()
          const normalized = normalizeUpdateStatus(data?.result ?? {})
          const item = normalized.items.find(entry => entry.name === name)
          if (!item) throw new ControlError('Komponente im Update-Manager nicht gefunden.', 404)

          let releases = []
          let githubError = null
          if (item.owner && item.repoName) {
            try {
              const rawReleases = await fetchGithubReleases(item.owner, item.repoName)
              releases = filterRelevantReleases(rawReleases, item.version, item.remoteVersion)
            } catch (err) {
              githubError = err?.message || 'Release-Notes derzeit nicht erreichbar.'
            }
          }

          return json(200, {
            name: item.name,
            type: item.type,
            version: item.version,
            remoteVersion: item.remoteVersion,
            repoUrl: item.repoUrl,
            compareUrl: item.compareUrl,
            commits: item.commitsBehind,
            commitsCount: item.commitsBehindCount,
            packages: item.packageList,
            releases,
            githubError,
          })
        }

        if (systemSub === 'updates/refresh') {
          await readJson(req, 4000).catch(() => ({}))
          await probeMachineWriteGuard(false)
          const response = await fetchUpstream(`${printer}/machine/update/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(30_000),
          })
          if (!response.ok) throw new Error(`Update-Prüfung fehlgeschlagen (HTTP ${response.status}).`)
          const data = await response.json()
          return json(200, {
            ...normalizeUpdateStatus(data?.result ?? {}),
            activeJob: serializeUpdateJob(activeUpdateJob),
          })
        }

        if (systemSub === 'updates/upgrade') {
          const epoch = runtimeEpoch
          const payload = await readJson(req, 4000)
          await probeMachineWriteGuard(false)
          const statusRes = await fetchUpstream(`${printer}/machine/update/status`, { signal: AbortSignal.timeout(8000) })
          if (!statusRes.ok) throw new Error('Update-Status nicht erreichbar.')
          const statusJson = await statusRes.json()
          if (epoch !== runtimeEpoch) {
            throw new ControlError('Der aktive Drucker wurde geändert. Update-Start abgebrochen.', 409)
          }
          if (statusJson?.result?.busy) throw new ControlError('Moonraker führt bereits ein Update aus.', 409)
          const target = validateUpdateTarget(payload?.name, statusJson?.result?.version_info ?? {}, 'upgrade')
          const job = startUpdateJob({ name: target.name, mode: 'upgrade', printer })
          return json(202, { accepted: true, job, message: `${target.name}: Update gestartet …` })
        }

        if (systemSub === 'updates/recover') {
          const epoch = runtimeEpoch
          const payload = await readJson(req, 4000)
          await probeMachineWriteGuard(false)
          const statusRes = await fetchUpstream(`${printer}/machine/update/status`, { signal: AbortSignal.timeout(8000) })
          if (!statusRes.ok) throw new Error('Update-Status nicht erreichbar.')
          const statusJson = await statusRes.json()
          if (epoch !== runtimeEpoch) {
            throw new ControlError('Der aktive Drucker wurde geändert. Recovery-Start abgebrochen.', 409)
          }
          if (statusJson?.result?.busy) throw new ControlError('Moonraker führt bereits ein Update aus.', 409)
          const target = validateUpdateTarget(payload?.name, statusJson?.result?.version_info ?? {}, 'recover')
          const hard = payload?.hard === true
          const job = startUpdateJob({ name: target.name, mode: 'recover', hard, printer })
          return json(202, {
            accepted: true,
            job,
            message: `${target.name}: ${hard ? 'Hard-Reset' : 'Soft-Reset'} gestartet …`,
          })
        }

        if (systemSub === 'logs/list') {
          const response = await fetchUpstream(`${printer}/server/files/list?root=logs`, {
            signal: AbortSignal.timeout(7000),
          })
          if (!response.ok) throw new Error('Logdateien nicht erreichbar.')
          const data = await response.json()
          return json(200, { logs: normalizeLogList(data?.result ?? []) })
        }

        if (systemSub === 'logs/tail') {
          const logPath = validateLogPath(parsedUrl.searchParams.get('path'))
          if (!logPath) throw new ControlError('Ungültiger Logpfad.', 400)
          const url = `${printer}/server/files/logs/${encodeMoonrakerPath(logPath)}`
          const response = await fetchUpstream(url, {
            headers: { Range: `bytes=-${LOG_TAIL_BYTES}` },
            signal: AbortSignal.timeout(8000),
          })
          if (response.status === 416) {
            return json(
              200,
              parseLogTail({ text: '', totalBytes: 0, fetchedBytes: 0, statusCode: 416, maxLines: LOG_TAIL_MAX_LINES }),
            )
          }
          if (!response.ok && response.status !== 206) {
            throw new ControlError('Logdatei nicht verfügbar.', response.status === 404 ? 404 : 502)
          }
          const buf = Buffer.from(await response.arrayBuffer())
          let totalBytes = buf.length
          const contentRange = response.headers.get('content-range')
          const match = contentRange?.match(/\/(\d+)$/)
          if (match) totalBytes = Number(match[1])
          else if (response.headers.get('content-length')) totalBytes = Number(response.headers.get('content-length'))

          return json(
            200,
            parseLogTail({
              text: buf.toString('utf8'),
              totalBytes,
              fetchedBytes: buf.length,
              statusCode: response.status,
              maxLines: LOG_TAIL_MAX_LINES,
            }),
          )
        }
      }

      if (path === '/api/history') {
        const epoch = runtimeEpoch
        const rawLimit = Number(parsedUrl.searchParams.get('limit') ?? 40)
        const rawStart = Number(parsedUrl.searchParams.get('start') ?? 0)
        const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 40
        const start = Number.isInteger(rawStart) && rawStart >= 0 ? rawStart : 0

        const needFiles = !gcodeFileSetCache || Date.now() - gcodeFileSetAt > 30_000
        const [listRes, totalsRes, filesRes] = await Promise.all([
          fetchUpstream(`${printer}/server/history/list?limit=${limit}&start=${start}&order=desc`, {
            signal: AbortSignal.timeout(7000),
          }),
          start === 0
            ? fetchUpstream(`${printer}/server/history/totals`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
            : Promise.resolve(null),
          needFiles
            ? fetchUpstream(`${printer}/server/files/list?root=gcodes`, { signal: AbortSignal.timeout(6000) }).catch(() => null)
            : Promise.resolve(null),
        ])

        if (!listRes.ok) throw new Error('Druckverlauf nicht erreichbar.')
        const listJson = await listRes.json()
        if (epoch !== runtimeEpoch) {
          throw new ControlError('Der aktive Drucker wurde während der Abfrage gewechselt.', 409)
        }
        const result = listJson.result ?? {}

        if (filesRes?.ok) {
          const filesJson = await filesRes.json().catch(() => null)
          if (epoch === runtimeEpoch && Array.isArray(filesJson?.result)) {
            gcodeFileSetCache = new Set(filesJson.result.map(item => item?.path).filter(Boolean))
            gcodeFileSetAt = Date.now()
          }
        }

        let totals = null
        if (totalsRes?.ok) {
          const totalsJson = await totalsRes.json().catch(() => null)
          totals = normalizeHistoryTotals(totalsJson?.result)
        }

        const jobs = (Array.isArray(result.jobs) ? result.jobs : [])
          .map(job => normalizeHistoryJob(job, gcodeFileSetCache))
          .filter(Boolean)

        return json(200, {
          count: jobs.length,
          hasMore: jobs.length >= limit,
          start,
          limit,
          totals,
          jobs,
        })
      }

      if (printRoute) {
        const sub = printRoute[1]
        if (sub === 'files') {
          const currentDir = validateGcodeDir(parsedUrl.searchParams.get('dir') ?? '')
          if (currentDir === null) throw new ControlError('Ungültiger Ordnerpfad.', 400)
          const dirParam = currentDir ? `gcodes/${currentDir}` : 'gcodes'
          const [filesRes, dirRes, historyRes] = await Promise.all([
            fetchUpstream(`${printer}/server/files/list?root=gcodes`, { signal: AbortSignal.timeout(7000) }),
            fetchUpstream(
              `${printer}/server/files/directory?path=${encodeURIComponent(dirParam)}&extended=true`,
              { signal: AbortSignal.timeout(6000) },
            ).catch(() => null),
            fetchUpstream(`${printer}/server/history/list?limit=10`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
          ])
          if (!filesRes.ok) throw new Error('Druckdateien nicht erreichbar.')
          const filesJson = await filesRes.json()
          const validRaw = (Array.isArray(filesJson.result) ? filesJson.result : []).filter(item =>
            validateGcodeFilename(item?.path),
          )
          const existingSet = new Set(validRaw.map(item => item.path))
          gcodeFileSetCache = existingSet
          gcodeFileSetAt = Date.now()

          const metaByPath = new Map()
          const dirs = []
          if (dirRes?.ok) {
            const dirJson = await dirRes.json().catch(() => null)
            const rawDirs = Array.isArray(dirJson?.result?.dirs) ? dirJson.result.dirs : []
            for (const entry of rawDirs) {
              const dirname = typeof entry?.dirname === 'string' ? entry.dirname.trim() : ''
              if (!dirname || dirname.startsWith('.')) continue
              const relDir = currentDir ? `${currentDir}/${dirname}` : dirname
              if (validateGcodeDir(relDir) === null) continue
              dirs.push({
                name: dirname,
                path: relDir,
                modified: Number.isFinite(entry.modified) ? entry.modified : null,
              })
            }
            const rawDirFiles = Array.isArray(dirJson?.result?.files) ? dirJson.result.files : []
            for (const entry of rawDirFiles) {
              if (!entry || typeof entry.filename !== 'string') continue
              const relPath = currentDir ? `${currentDir}/${entry.filename}` : entry.filename
              let thumbPath = null
              if (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
                const sorted = [...entry.thumbnails]
                  .filter(t => typeof t?.relative_path === 'string')
                  .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
                const preferred = sorted.find(t => (t.width ?? 0) <= 400 && (t.width ?? 0) >= 96) ?? sorted[0]
                if (preferred) {
                  const candidate = currentDir
                    ? `${currentDir}/${preferred.relative_path}`
                    : preferred.relative_path
                  thumbPath = validateThumbnailPath(candidate)
                }
              }
              metaByPath.set(relPath, {
                estimatedTime: Number.isFinite(entry.estimated_time) ? entry.estimated_time : null,
                filamentWeight: Number.isFinite(entry.filament_weight_total) ? entry.filament_weight_total : null,
                layerHeight: Number.isFinite(entry.layer_height) ? entry.layer_height : null,
                thumbnail: thumbPath,
              })
            }
          }

          const files = validRaw
            .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
            .slice(0, 500)
            .map(item => {
              const idx = item.path.lastIndexOf('/')
              const ext = metaByPath.get(item.path)
              return {
                path: item.path,
                name: idx >= 0 ? item.path.slice(idx + 1) : item.path,
                dir: idx >= 0 ? item.path.slice(0, idx) : '',
                size: Number.isFinite(item.size) ? item.size : null,
                modified: Number.isFinite(item.modified) ? item.modified : null,
                estimatedTime: ext?.estimatedTime ?? null,
                filamentWeight: ext?.filamentWeight ?? null,
                layerHeight: ext?.layerHeight ?? null,
                thumbnail: ext?.thumbnail ?? null,
              }
            })

          let recentJobs = []
          if (historyRes?.ok) {
            const historyJson = await historyRes.json().catch(() => null)
            recentJobs = (Array.isArray(historyJson?.result?.jobs) ? historyJson.result.jobs : [])
              .filter(job => validateGcodeFilename(job?.filename))
              .slice(0, 6)
              .map(job => ({
                jobId: job.job_id ?? null,
                filename: job.filename,
                name: job.filename.split('/').pop(),
                status: job.status ?? null,
                printDuration: Number.isFinite(job.print_duration) ? job.print_duration : null,
                filamentUsed: Number.isFinite(job.filament_used) ? job.filament_used : null,
                startTime: Number.isFinite(job.start_time) ? job.start_time : null,
                endTime: Number.isFinite(job.end_time) ? job.end_time : null,
                fileExists: existingSet.has(job.filename),
              }))
          }
          return json(200, { files, dirs, currentDir, recentJobs })
        }

        if (sub === 'mkdir') {
          const payload = await readJson(req, 4096)
          const dirPath = validateGcodeDir(payload?.path)
          if (!dirPath) throw new ControlError('Ungültiger Ordnername.', 400)
          const mkRes = await fetchUpstream(`${printer}/server/files/directory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: `gcodes/${dirPath}` }),
            signal: AbortSignal.timeout(8000),
          })
          if (!mkRes.ok) {
            const errJson = await mkRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message || 'Ordner konnte nicht erstellt werden.',
              mkRes.status >= 400 && mkRes.status < 500 ? mkRes.status : 502,
            )
          }
          return json(200, { ok: true, path: dirPath })
        }

        if (sub === 'dir') {
          const dirPath = validateGcodeDir(parsedUrl.searchParams.get('path'))
          if (!dirPath) throw new ControlError('Ungültiger Ordnerpfad.', 400)
          const liveRaw = await query(false).catch(() => null)
          const livePrintState = liveRaw?.print_stats?.state
          const liveFilename = liveRaw?.print_stats?.filename || ''
          if (['printing', 'paused'].includes(livePrintState) && liveFilename.startsWith(`${dirPath}/`)) {
            throw new ControlError('Der Ordner enthält die aktuell gedruckte Datei und kann nicht gelöscht werden.', 409)
          }
          const delDirRes = await fetchUpstream(
            `${printer}/server/files/directory?path=${encodeURIComponent(`gcodes/${dirPath}`)}&force=false`,
            { method: 'DELETE', signal: AbortSignal.timeout(8000) },
          )
          if (!delDirRes.ok) {
            const errJson = await delDirRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message || 'Ordner konnte nicht gelöscht werden (ist er leer?).',
              delDirRes.status >= 400 && delDirRes.status < 500 ? delDirRes.status : 502,
            )
          }
          gcodeFileSetCache = null
          return json(200, { ok: true, deleted: dirPath })
        }

        if (sub === 'move') {
          const payload = await readJson(req, 4096)
          const source = validateGcodeFilename(payload?.source)
          const dest = validateGcodeFilename(payload?.dest)
          if (!source || !dest) throw new ControlError('Ungültiger Quell- oder Zielpfad.', 400)
          if (source === dest) throw new ControlError('Quell- und Zielname sind identisch.', 400)
          const liveRaw = await query(false).catch(() => null)
          const livePrintState = liveRaw?.print_stats?.state
          const liveFilename = liveRaw?.print_stats?.filename
          if (['printing', 'paused'].includes(livePrintState) && liveFilename === source) {
            throw new ControlError('Die aktuell gedruckte Datei kann nicht umbenannt werden.', 409)
          }
          const mvRes = await fetchUpstream(`${printer}/server/files/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: `gcodes/${source}`, dest: `gcodes/${dest}` }),
            signal: AbortSignal.timeout(8000),
          })
          if (!mvRes.ok) {
            const errJson = await mvRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message || 'Datei konnte nicht verschoben oder umbenannt werden.',
              mvRes.status >= 400 && mvRes.status < 500 ? mvRes.status : 502,
            )
          }
          gcodeFileSetCache = null
          return json(200, { ok: true, source, dest })
        }

        if (sub === 'upload') {
          const rawHeaderName = String(req.headers['x-gcode-filename'] ?? parsedUrl.searchParams.get('filename') ?? '')
          let decodedName = rawHeaderName
          try {
            decodedName = decodeURIComponent(rawHeaderName)
          } catch {
            // Keep raw filename if not percent-encoded
          }
          const rawHeaderDir = String(req.headers['x-gcode-path'] ?? parsedUrl.searchParams.get('path') ?? '').trim()
          let decodedDir = rawHeaderDir
          try {
            decodedDir = decodeURIComponent(rawHeaderDir)
          } catch {
            // Keep raw dir
          }
          const cleanDir = decodedDir.replace(/^\/+|\/+$/g, '')
          const baseName = decodedName.split('/').pop()?.trim() || ''
          const fullRelPath = cleanDir ? `${cleanDir}/${baseName}` : baseName
          const validRelPath = validateGcodeFilename(fullRelPath)
          if (!validRelPath) {
            throw new ControlError('Ungültiger G-Code-Dateiname (.gcode, .gco oder .g erwartet).', 400)
          }
          const buffer = await readRawBody(
            req,
            MAX_GCODE_UPLOAD_BYTES,
            'Die G-Code-Datei überschreitet das Limit von 100 MB.',
          )
          if (!buffer.byteLength) throw new ControlError('Die hochgeladene G-Code-Datei ist leer.', 400)

          const form = new FormData()
          form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), baseName)
          form.append('root', 'gcodes')
          if (cleanDir) form.append('path', cleanDir)
          const wantPrint = req.headers['x-gcode-print'] === '1' || parsedUrl.searchParams.get('print') === '1'
          if (wantPrint) {
            await probeMachineWriteGuard(false)
            form.append('print', 'true')
          }

          const upRes = await fetchUpstream(`${printer}/server/files/upload`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(90_000),
          })
          const upData = await upRes.json().catch(() => ({}))
          if (!upRes.ok) {
            throw new ControlError(
              upData?.error?.message || upData?.message || 'G-Code-Upload auf Moonraker fehlgeschlagen.',
              upRes.status >= 400 && upRes.status < 500 ? upRes.status : 502,
            )
          }
          gcodeFileSetCache = null
          const itemPath = validateGcodeFilename(upData?.item?.path) ?? validRelPath
          return json(200, {
            ok: true,
            path: itemPath,
            name: itemPath.split('/').pop(),
            size: buffer.byteLength,
          })
        }

        if (sub === 'file') {
          const filename = validateGcodeFilename(parsedUrl.searchParams.get('filename'))
          if (!filename) throw new ControlError('Ungültiger Dateiname.', 400)
          const liveRaw = await query(false).catch(() => null)
          const livePrintState = liveRaw?.print_stats?.state
          const liveFilename = liveRaw?.print_stats?.filename
          if (['printing', 'paused'].includes(livePrintState) && liveFilename === filename) {
            throw new ControlError('Die aktuell gedruckte Datei kann nicht gelöscht werden.', 409)
          }
          const delRes = await fetchUpstream(`${printer}/server/files/gcodes/${encodeMoonrakerPath(filename)}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(8000),
          })
          if (!delRes.ok) {
            const errData = await delRes.json().catch(() => ({}))
            throw new ControlError(
              errData?.error?.message || 'Datei konnte nicht gelöscht werden.',
              delRes.status === 404 ? 404 : 502,
            )
          }
          gcodeFileSetCache = null
          return json(200, { ok: true, filename })
        }

        if (sub === 'queue') {
          const normalizeQueueResult = payload => {
            const result = payload?.result ?? {}
            const jobs = (Array.isArray(result.queued_jobs) ? result.queued_jobs : [])
              .filter(item => item && typeof item.filename === 'string')
              .map(item => ({
                jobId: String(item.job_id ?? ''),
                filename: item.filename,
                name: item.filename.split('/').pop(),
                timeAdded: Number.isFinite(item.time_added) ? item.time_added : null,
                timeInQueue: Number.isFinite(item.time_in_queue) ? item.time_in_queue : null,
              }))
            return {
              available: true,
              queueState: typeof result.queue_state === 'string' ? result.queue_state : 'ready',
              jobs,
            }
          }

          if (req.method === 'GET') {
            const qRes = await fetchUpstream(`${printer}/server/job_queue/status`, {
              signal: AbortSignal.timeout(5000),
            }).catch(() => null)
            if (!qRes || qRes.status === 404) {
              return json(200, { available: false, queueState: null, jobs: [] })
            }
            if (!qRes.ok) throw new Error('Warteschlange nicht erreichbar.')
            return json(200, normalizeQueueResult(await qRes.json().catch(() => ({}))))
          }

          const payload = await readJson(req, 8192)
          const action = payload?.action
          let qRes
          if (action === 'add') {
            const filename = validateGcodeFilename(payload?.filename)
            if (!filename) throw new ControlError('Ungültiger Dateiname.', 400)
            qRes = await fetchUpstream(`${printer}/server/job_queue/job`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filenames: [filename] }),
              signal: AbortSignal.timeout(7000),
            })
          } else if (action === 'remove') {
            const jobId = String(payload?.jobId ?? '').trim()
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) throw new ControlError('Ungültige Job-ID.', 400)
            qRes = await fetchUpstream(`${printer}/server/job_queue/job?job_ids=${encodeURIComponent(jobId)}`, {
              method: 'DELETE',
              signal: AbortSignal.timeout(7000),
            })
          } else if (action === 'clear') {
            qRes = await fetchUpstream(`${printer}/server/job_queue/job?all=true`, {
              method: 'DELETE',
              signal: AbortSignal.timeout(7000),
            })
          } else if (action === 'start') {
            qRes = await fetchUpstream(`${printer}/server/job_queue/start`, {
              method: 'POST',
              signal: AbortSignal.timeout(7000),
            })
          } else if (action === 'pause') {
            qRes = await fetchUpstream(`${printer}/server/job_queue/pause`, {
              method: 'POST',
              signal: AbortSignal.timeout(7000),
            })
          } else {
            throw new ControlError('Ungültige Warteschlangen-Aktion.', 400)
          }

          if (qRes.status === 404) {
            throw new ControlError('Moonraker job_queue ist auf diesem Drucker nicht konfiguriert.', 404)
          }
          const qData = await qRes.json().catch(() => ({}))
          if (!qRes.ok) {
            throw new ControlError(qData?.error?.message || 'Warteschlangen-Aktion fehlgeschlagen.', 502)
          }
          return json(200, normalizeQueueResult(qData))
        }

        if (sub === 'metadata') {
          const filename = validateGcodeFilename(parsedUrl.searchParams.get('filename'))
          if (!filename) throw new ControlError('Ungültiger Dateiname.', 400)
          const response = await fetchUpstream(
            `${printer}/server/files/metadata?filename=${encodeURIComponent(filename)}`,
            { signal: AbortSignal.timeout(7000) },
          )
          if (!response.ok) throw new Error('Dateimetadaten nicht erreichbar.')
          const data = await response.json()
          return json(200, normalizePrintMetadata(data.result ?? {}, filename))
        }

        if (sub === 'thumbnail') {
          const relPath = validateThumbnailPath(parsedUrl.searchParams.get('path'))
          if (!relPath) throw new ControlError('Ungültiger Vorschaupfad.', 400)
          const encoded = relPath
            .split('/')
            .map(segment => encodeURIComponent(segment))
            .join('/')
          const response = await fetchUpstream(`${printer}/server/files/gcodes/${encoded}`, {
            signal: AbortSignal.timeout(6000),
          })
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
            throw new Error('Kein Vorschaubild verfügbar.')
          }
          const bytes = Buffer.from(await response.arrayBuffer())
          if (bytes.length > 4 * 1024 * 1024) throw new Error('Vorschaubild zu groß.')
          res.setHeader('Content-Type', response.headers.get('content-type'))
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.end(bytes)
          return
        }

        if (sub === 'model') {
          const filename = validateGcodeFilename(parsedUrl.searchParams.get('filename'))
          if (!filename) throw new ControlError('Ungültiger Dateiname.', 400)
          const tag = parsedUrl.searchParams.get('v') || ''
          const cacheKey = `${filename}:${tag}`
          const binary = await fetchGcodeMeshBinary({ printer, filename, cacheKey })
          if (res.destroyed) return
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Length', binary.byteLength)
          res.setHeader('Cache-Control', 'private, max-age=300')
          res.end(binary)
          return
        }
      }

      if (path === '/api/temperature-history') {
        const response = await fetchUpstream(`${printer}/server/temperature_store`, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('Temperaturverlauf nicht erreichbar.')
        const data = await response.json()
        const knownToolCount = capabilityCache?.toolCount ?? liveCapabilityRef.value?.toolCount ?? null
        const toolCount = knownToolCount ?? inferExtruderCountFromStore(data.result)
        const requestedDuration = Number(parsedUrl.searchParams.get('duration'))
        const duration = [600, 1800, 3600].includes(requestedDuration) ? requestedDuration : 600
        return json(200, temperatureHistory(data.result, undefined, { toolCount, duration }))
      }

      if (path === '/api/presets') {
        if (req.method === 'POST') {
          const payload = await readJson(req, 8192)
          const currentRes = await fetchUpstream(`${printer}/server/database/item?namespace=mainsail&key=presets`, {
            signal: AbortSignal.timeout(5000),
          }).catch(() => null)
          const currentDb = currentRes?.ok ? (await currentRes.json().catch(() => null))?.result?.value ?? {} : {}
          const knownToolCount =
            capabilityCache?.toolCount ?? liveCapabilityRef.value?.toolCount ?? inferToolCountFromPresets(currentDb, null) ?? 1
          let nextDb
          try {
            nextDb = applyMainsailPresetMutation(currentDb, { ...payload, toolCount: knownToolCount })
          } catch (err) {
            throw new ControlError(err.message || 'Ungültiges Preset.', 400)
          }
          const saveRes = await fetchUpstream(`${printer}/server/database/item`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ namespace: 'mainsail', key: 'presets', value: nextDb }),
            signal: AbortSignal.timeout(6000),
          })
          if (!saveRes.ok) {
            const errJson = await saveRes.json().catch(() => null)
            throw new ControlError(
              errJson?.error?.message || `Presets konnten nicht gespeichert werden (HTTP ${saveRes.status}).`,
              502,
            )
          }
          const toolCount =
            capabilityCache?.toolCount ??
            liveCapabilityRef.value?.toolCount ??
            inferToolCountFromPresets(nextDb, null) ??
            1
          return json(200, { ok: true, presets: normalizePresets({ mainsail: nextDb, toolCount }) })
        }
        const [mainsailRes, legacyRes] = await Promise.all([
          fetchUpstream(`${printer}/server/database/item?namespace=mainsail&key=presets`, {
            signal: AbortSignal.timeout(5000),
          }).catch(() => null),
          fetchUpstream(`${printer}/server/database/item?namespace=voyager-ui&key=settings.presets`, {
            signal: AbortSignal.timeout(5000),
          }).catch(() => null),
        ])
        const mainsail = mainsailRes?.ok ? (await mainsailRes.json().catch(() => null))?.result?.value : null
        const legacy = legacyRes?.ok ? (await legacyRes.json().catch(() => null))?.result?.value : null
        const toolCount =
          capabilityCache?.toolCount ??
          liveCapabilityRef.value?.toolCount ??
          inferToolCountFromPresets(mainsail, legacy) ??
          6
        return json(200, { presets: normalizePresets({ mainsail, legacy, toolCount }) })
      }

      if (path === '/api/console') {
        const response = await fetchUpstream(`${printer}/server/gcode_store?count=200`, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('Konsolenausgabe nicht erreichbar.')
        const data = await response.json()
        if (!Array.isArray(data.result?.gcode_store)) throw new Error('Keine Konsolenausgabe erhalten.')
        return json(200, { entries: data.result.gcode_store })
      }

      if (path === '/api/console/help') {
        const response = await fetchUpstream(`${printer}/printer/gcode/help`, { signal: AbortSignal.timeout(5000) }).catch(
          () => null,
        )
        if (!response?.ok) return json(200, { commands: [] })
        const data = await response.json().catch(() => null)
        const rawHelp = data?.result && typeof data.result === 'object' ? data.result : {}
        const commands = Object.entries(rawHelp)
          .filter(([name]) => typeof name === 'string' && name.trim() && !name.startsWith('_'))
          .map(([name, help]) => ({
            name: name.trim(),
            help: typeof help === 'string' ? help.trim() : '',
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
        return json(200, { commands })
      }

      if (path === '/api/status') {
        const raw = await query(!capabilityCache || Date.now() - capabilityAt > 60_000)
        return json(200, {
          ...normalized(raw),
          capabilities: capabilityCache,
          control: getControlState(),
          transport: 'poll',
        })
      }

      if (path === '/api/control') {
        const result = await control(await readJson(req, 2048), { async: true })
        const code = result.statusCode ?? 200
        return json(code, result)
      }

      const id = camera[1]
      const target = resolveCameraTarget(id)
      if (!target) {
        throw new ControlError('Kamera nicht konfiguriert oder deaktiviert.', 404)
      }
      if (camera[2] === 'webrtc') {
        if (!target.webrtcUrl) {
          throw new ControlError('WebRTC wird für diesen Kameratyp nicht unterstützt.', 404)
        }
        const data = await readJson(req)
        if (!data || !['request', 'answer', 'remote_candidate'].includes(data.type)) {
          throw new ControlError('Ungültige Kamera-Anfrage.')
        }
        const body =
          data.type === 'request'
            ? { type: 'request', iceServers: [], keepAlive: true }
            : data.type === 'answer'
              ? { type: 'answer', id: data.id, sdp: data.sdp }
              : { type: 'remote_candidate', id: data.id, candidates: data.candidates }
        const response = await fetchUpstream(target.webrtcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(6000),
        })
        if (!response.ok) throw new Error('WebRTC nicht verfügbar')
        return json(200, await response.json())
      }

      if (!target.snapshotUrl) {
        throw new ControlError('Kein Snapshot-Endpunkt konfiguriert.', 404)
      }
      const response = await fetchUpstream(target.snapshotUrl, { signal: AbortSignal.timeout(5000) })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        throw new Error('Kein Kamerabild verfügbar')
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > 12 * 1024 * 1024) throw new Error('Kamerabild zu groß')
      res.setHeader('Content-Type', response.headers.get('content-type'))
      res.end(bytes)
    } catch (error) {
      const payload = { error: error.message || 'Verbindung zum Drucker fehlgeschlagen.' }
      if (error.code) payload.code = error.code
      if (error.currentModified !== undefined) payload.currentModified = error.currentModified
      json(error.status ?? 502, payload)
    }
  })()
}

  return { printerMiddleware, control, getControlState, closeLiveFeed, notifySettingsChange: applyRuntimeSettingsChange }
}

const defaultRuntime = createPrinterRuntime()
export const printerMiddleware = defaultRuntime.printerMiddleware
export const control = defaultRuntime.control
export const getControlState = defaultRuntime.getControlState
export const closeLiveFeed = defaultRuntime.closeLiveFeed
