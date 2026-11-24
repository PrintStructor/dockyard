import http from 'node:http'
import { createMaterialsReader } from './materials.mjs'
import { createLiveFeed } from './live.mjs'
import { normalizeStatus } from './status.mjs'
import { temperatureHistory } from './temperature.mjs'
import { capabilities, commandFor, ControlError, sameOriginRequest } from './control.mjs'
import { executeGcodeScript, AbortedCommandError } from './ws-rpc.mjs'
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
  evaluateMachineWriteGuard,
  normalizeSystemOverview,
  normalizeUpdateStatus,
  validateLogPath,
  normalizeLogList,
  parseLogTail,
  encodeMoonrakerPath,
} from './machine.mjs'
import { validateShakeTuneImagePath, normalizeCalibrationData } from './calibration.mjs'
import { printerUrl as printer } from './config.mjs'

const objects = [
  'toolchanger',
  'print_stats',
  'display_status',
  'webhooks',
  'heater_bed',
  'toolhead',
  'gcode_move',
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

const cameras = { tophat: '/webcam', heatbed: '/webcam2' }

let configCache = null
let effectObjects = []
let fanObjects = []
let capabilityCache = null
let capabilityAt = 0
let gcodeFileSetCache = null
let gcodeFileSetAt = 0
let liveCapabilityRef = { config: null, load: null, unload: null, fans: '', value: null }
let currentJob = null
let activeJobAbort = null
let lastResult = null
let jobSequence = 0

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

export function getControlState() {
  return {
    job: serializeJob(currentJob),
    lastResult,
  }
}

function cachedCapabilities(raw) {
  const fanSignature = Object.keys(raw)
    .filter(name => /^fan_generic [A-Za-z0-9_]+$/.test(name))
    .sort()
    .join(',')
  const load = raw['gcode_macro _LOAD_SETTINGS']?.temp_default ?? null
  const unload = raw['gcode_macro _UNLOAD_SETTINGS']?.temp_default ?? null
  if (
    liveCapabilityRef.value &&
    liveCapabilityRef.config === raw.configfile &&
    liveCapabilityRef.load === load &&
    liveCapabilityRef.unload === unload &&
    liveCapabilityRef.fans === fanSignature
  ) {
    return liveCapabilityRef.value
  }
  const computed = capabilities(raw)
  liveCapabilityRef = { config: raw.configfile, load, unload, fans: fanSignature, value: computed }
  return computed
}

let live = null
const readMaterials = createMaterialsReader(printer, fetch, () => live?.notify())

function normalized(raw) {
  const data = normalizeStatus(raw)
  const materials = readMaterials(raw)
  data.tools.forEach((tool, id) => {
    tool.material = materials[id]
  })
  return data
}

live = createLiveFeed({
  printer,
  baseObjects: objects,
  snapshot: raw => ({
    ...normalized(raw),
    capabilities: cachedCapabilities(raw),
    control: getControlState(),
    transport: 'live',
  }),
})

export const closeLiveFeed = () => live.close()

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

async function query(withConfig = false) {
  if (withConfig) {
    const response = await fetch(`${printer}/printer/objects/list`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Druckerobjekte nicht erreichbar.')
    const data = await response.json()
    fanObjects = (data.result?.objects ?? []).filter(name => /^fan_generic [A-Za-z0-9_]+$/.test(name))
  }
  const queryNames = [...objects, ...effectObjects, ...fanObjects].map(encodeURIComponent).join('&')
  const response = await fetch(
    `${printer}/printer/objects/query?${queryNames}${withConfig ? '&configfile=settings' : ''}`,
    { signal: AbortSignal.timeout(5000) },
  )
  if (!response.ok) throw new Error(`Moonraker HTTP ${response.status}`)
  const data = await response.json()
  if (!data.result?.status) throw new Error('Keine Statusdaten von Moonraker')
  if (withConfig) {
    capabilityCache = capabilities(data.result.status)
    capabilityAt = Date.now()
    configCache = data.result.status.configfile ?? null
    effectObjects = Object.keys(configCache?.settings ?? {}).filter(name => name.startsWith('led_effect '))
  }
  return { ...data.result.status, configfile: configCache }
}

function successMessageFor(action, label) {
  if (action === 'watch_start') {
    return 'Einlegehilfe ist scharf. Dein Makro übernimmt Aufheizen, Laden und Abkühlen.'
  }
  if (action === 'watch_stop') return 'Einlegehilfe beendet.'
  return `${label}: abgeschlossen.`
}

export async function control(input, options = {}) {
  const { async: allowAsync = false, WebSocketImpl = WebSocket } = options

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ControlError('Ungültiger Befehl.')
  }

  if (input.action === 'acknowledge') {
    if (Object.keys(input).some(key => key !== 'action') || !currentJob?.uncertain) {
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
    currentJob = null
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
  if (isBatchAbort && !currentJob?.uncertain) {
    const raw = await query(true)
    const abortCmd = commandFor(input, raw)
    await executeGcodeScript({
      printer,
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

  if (currentJob && !isStop) {
    throw new ControlError('Ein Befehl läuft noch oder sein Ergebnis ist ungeklärt.', 409)
  }

  if (isStop) {
    activeJobAbort?.abort()
    const response = await fetch(`${printer}/printer/emergency_stop`, {
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
            printer,
            script: currentStep.script,
            timeoutMs: stepTimeoutMs,
            signal: abortController.signal,
            WebSocketImpl,
          })
        }
      } else {
        live.notify()
        issued = true
        await executeGcodeScript({
          printer,
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
        if (issued) {
          job.uncertain = true
          job.label = `${command.label} · Ergebnis prüfen`
        } else {
          currentJob = null
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
  const upstream = http.get(`${printer}${cameras[id]}/stream`, response => {
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

function streamLogDownload(relPath, res) {
  const upstream = http.get(`${printer}/server/files/logs/${encodeMoonrakerPath(relPath)}`, response => {
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
  let queryStatus = 503
  let queryData = null
  try {
    const qRes = await fetch(
      `${printer}/printer/objects/query?print_stats&webhooks&idle_timeout`,
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
      const infoRes = await fetch(`${printer}/server/info`, { signal: AbortSignal.timeout(5000) })
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
  if (spec.kind === 'klipper') {
    const response = await fetch(`${printer}/printer/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new ControlError(`Klipper-Neustart fehlgeschlagen (HTTP ${response.status}).`, 502)
    return
  }
  if (spec.kind === 'firmware') {
    const response = await fetch(`${printer}/printer/firmware_restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new ControlError(`Firmware-Neustart fehlgeschlagen (HTTP ${response.status}).`, 502)
    return
  }
  const response = await fetch(
    `${printer}/machine/services/restart?service=${encodeURIComponent(spec.service)}`,
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

export function printerMiddleware(req, res, next) {
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

  const camera = path.match(/^\/api\/camera\/(tophat|heatbed)(?:\/(stream|webrtc))?$/)
  const printRoute = path.match(/^\/api\/print\/(files|metadata|thumbnail|model)$/)
  const systemRoute = path.match(
    /^\/api\/system\/(overview|calibration|calibration\/shaketune-image|config\/list|config\/file|config\/save|service\/restart|updates|updates\/refresh|logs\/list|logs\/tail|logs\/download)$/,
  )
  if (
    path !== '/api/status' &&
    path !== '/api/control' &&
    path !== '/api/events' &&
    path !== '/api/console' &&
    path !== '/api/presets' &&
    path !== '/api/temperature-history' &&
    path !== '/api/history' &&
    !camera &&
    !printRoute &&
    !systemRoute
  ) {
    return json(404, { error: 'Unbekannter Endpunkt' })
  }

  const systemSub = systemRoute?.[1]
  const write =
    path === '/api/control' ||
    camera?.[2] === 'webrtc' ||
    systemSub === 'config/save' ||
    systemSub === 'service/restart' ||
    systemSub === 'updates/refresh'
  if (req.method !== (write ? 'POST' : 'GET')) return json(405, { error: 'Methode nicht erlaubt.' })
  if (write && !sameOriginRequest(req)) {
    return json(403, { error: 'Befehle sind nur aus dieser lokalen Oberfläche erlaubt.' })
  }
  if (path === '/api/events') return live.handle(req, res)
  if (camera?.[2] === 'stream') return streamCamera(camera[1], res)
  if (systemSub === 'logs/download') {
    const logPath = validateLogPath(parsedUrl.searchParams.get('path'))
    if (!logPath) return json(400, { error: 'Ungültiger Logpfad.' })
    return streamLogDownload(logPath, res)
  }

  ;(async () => {
    try {
      if (systemRoute) {
        if (systemSub === 'overview') {
          const [procRes, sysRes, infoRes] = await Promise.all([
            fetch(`${printer}/machine/proc_stats`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetch(`${printer}/machine/system_info`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetch(`${printer}/server/info`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
          ])
          if (!procRes?.ok && !sysRes?.ok && !infoRes?.ok) {
            throw new Error('Moonraker-Systemdaten nicht erreichbar.')
          }
          const procJson = procRes?.ok ? await procRes.json().catch(() => null) : null
          const sysJson = sysRes?.ok ? await sysRes.json().catch(() => null) : null
          const infoJson = infoRes?.ok ? await infoRes.json().catch(() => null) : null
          return json(
            200,
            normalizeSystemOverview({
              procStats: procJson?.result ?? null,
              systemInfo: sysJson?.result?.system_info ?? null,
              serverInfo: infoJson?.result ?? null,
            }),
          )
        }

        if (systemSub === 'calibration') {
          const [listRes, filesRes] = await Promise.all([
            fetch(`${printer}/printer/objects/list`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
            fetch(`${printer}/server/files/list?root=config`, { signal: AbortSignal.timeout(6000) }).catch(() => null),
          ])
          const availableObjects = listRes?.ok
            ? (await listRes.json().catch(() => null))?.result?.objects ?? []
            : []
          const availSet = new Set(availableObjects)
          const wanted = [
            'bed_mesh',
            'quad_gantry_level',
            'beacon',
            'tools_calibrate',
            'save_variables',
            'gcode_macro _BEACON_BATCH_STATE',
            'toolchanger',
            'temperature_sensor beacon_coil',
            ...Array.from({ length: 6 }, (_, i) => [i ? `extruder${i}` : 'extruder', `tool T${i}`]).flat(),
          ].filter(name => availSet.size === 0 || availSet.has(name))

          const queryStr = [...wanted.map(encodeURIComponent), 'configfile=settings'].join('&')
          const qRes = await fetch(`${printer}/printer/objects/query?${queryStr}`, {
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
          const response = await fetch(`${printer}/server/files/config/${encodeMoonrakerPath(imgPath)}`, {
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

        if (systemSub === 'config/list') {
          const response = await fetch(`${printer}/server/files/list?root=config`, {
            signal: AbortSignal.timeout(7000),
          })
          if (!response.ok) throw new Error('Konfigurationsdateien nicht erreichbar.')
          const data = await response.json()
          return json(200, { files: normalizeConfigList(data?.result ?? []) })
        }

        if (systemSub === 'config/file') {
          const relPath = validateConfigPath(parsedUrl.searchParams.get('path'))
          if (!relPath) throw new ControlError('Ungültiger Konfigurationspfad.', 400)
          const [listRes, fileRes] = await Promise.all([
            fetch(`${printer}/server/files/list?root=config`, { signal: AbortSignal.timeout(6000) }),
            fetch(`${printer}/server/files/config/${encodeMoonrakerPath(relPath)}`, {
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
            content: bytes.toString('utf8'),
            size: bytes.length,
            modified: meta?.modified ?? null,
            readonly: meta ? meta.readonly : true,
            isBackup: meta?.isBackup ?? false,
            isScript: meta?.isScript ?? false,
          })
        }

        if (systemSub === 'config/save') {
          const payload = await readJson(req, MAX_CONFIG_BYTES + 80_000)
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new ControlError('Ungültige Speicheranfrage.', 400)
          }
          await probeMachineWriteGuard(true)
          const listRes = await fetch(`${printer}/server/files/list?root=config`, {
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
            const sysRes = await fetch(`${printer}/machine/system_info`, { signal: AbortSignal.timeout(5000) }).catch(
              () => null,
            )
            const sysJson = sysRes?.ok ? await sysRes.json().catch(() => null) : null
            const avail = sysJson?.result?.system_info?.available_services ?? ['klipper', 'moonraker', 'crowsnest']
            restartSpec = validateRestartTarget(restartOption, avail)
          }

          const uploadRes = await fetch(`${printer}/server/files/upload`, {
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
            const refreshRes = await fetch(`${printer}/server/files/list?root=config`, {
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
          const sysRes = await fetch(`${printer}/machine/system_info`, { signal: AbortSignal.timeout(5000) }).catch(
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

        if (systemSub === 'updates') {
          const response = await fetch(`${printer}/machine/update/status`, {
            signal: AbortSignal.timeout(8000),
          })
          if (!response.ok) throw new Error('Update-Status nicht erreichbar.')
          const data = await response.json()
          return json(200, normalizeUpdateStatus(data?.result ?? {}))
        }

        if (systemSub === 'updates/refresh') {
          await readJson(req, 4000).catch(() => ({}))
          await probeMachineWriteGuard(false)
          const response = await fetch(`${printer}/machine/update/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(30_000),
          })
          if (!response.ok) throw new Error(`Update-Prüfung fehlgeschlagen (HTTP ${response.status}).`)
          const data = await response.json()
          return json(200, normalizeUpdateStatus(data?.result ?? {}))
        }

        if (systemSub === 'logs/list') {
          const response = await fetch(`${printer}/server/files/list?root=logs`, {
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
          const response = await fetch(url, {
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
        const rawLimit = Number(parsedUrl.searchParams.get('limit') ?? 40)
        const rawStart = Number(parsedUrl.searchParams.get('start') ?? 0)
        const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 40
        const start = Number.isInteger(rawStart) && rawStart >= 0 ? rawStart : 0

        const needFiles = !gcodeFileSetCache || Date.now() - gcodeFileSetAt > 30_000
        const [listRes, totalsRes, filesRes] = await Promise.all([
          fetch(`${printer}/server/history/list?limit=${limit}&start=${start}&order=desc`, {
            signal: AbortSignal.timeout(7000),
          }),
          start === 0
            ? fetch(`${printer}/server/history/totals`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
            : Promise.resolve(null),
          needFiles
            ? fetch(`${printer}/server/files/list?root=gcodes`, { signal: AbortSignal.timeout(6000) }).catch(() => null)
            : Promise.resolve(null),
        ])

        if (!listRes.ok) throw new Error('Druckverlauf nicht erreichbar.')
        const listJson = await listRes.json()
        const result = listJson.result ?? {}

        if (filesRes?.ok) {
          const filesJson = await filesRes.json().catch(() => null)
          if (Array.isArray(filesJson?.result)) {
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
          const [filesRes, historyRes] = await Promise.all([
            fetch(`${printer}/server/files/list?root=gcodes`, { signal: AbortSignal.timeout(7000) }),
            fetch(`${printer}/server/history/list?limit=10`, { signal: AbortSignal.timeout(5000) }).catch(() => null),
          ])
          if (!filesRes.ok) throw new Error('Druckdateien nicht erreichbar.')
          const filesJson = await filesRes.json()
          const files = (Array.isArray(filesJson.result) ? filesJson.result : [])
            .filter(item => validateGcodeFilename(item?.path))
            .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
            .slice(0, 60)
            .map(item => ({
              path: item.path,
              name: item.path.split('/').pop(),
              size: Number.isFinite(item.size) ? item.size : null,
              modified: Number.isFinite(item.modified) ? item.modified : null,
            }))

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
              }))
          }
          return json(200, { files, recentJobs })
        }

        if (sub === 'metadata') {
          const filename = validateGcodeFilename(parsedUrl.searchParams.get('filename'))
          if (!filename) throw new ControlError('Ungültiger Dateiname.', 400)
          const response = await fetch(
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
          const response = await fetch(`${printer}/server/files/gcodes/${encoded}`, {
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
        const response = await fetch(`${printer}/server/temperature_store`, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('Temperaturverlauf nicht erreichbar.')
        const data = await response.json()
        return json(200, temperatureHistory(data.result))
      }

      if (path === '/api/presets') {
        const response = await fetch(`${printer}/server/database/item?namespace=voyager-ui&key=settings.presets`, {
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error('Voyager-Presets nicht erreichbar.')
        const data = await response.json()
        const presets = data.result?.value
        if (!Array.isArray(presets)) throw new Error('Keine Voyager-Presets vorhanden.')
        const temperature = value => (Number.isFinite(value) && value >= 0 ? value : null)
        return json(200, {
          presets: ['ABS', 'PLA', 'PETG'].flatMap(name => {
            const preset = presets.find(entry => entry.name?.toUpperCase() === name)
            return preset
              ? [
                  {
                    name,
                    bed: temperature(preset.temps?.heater_bed),
                    tools: Array.from({ length: 6 }, (_, id) =>
                      temperature(preset.temps?.[id ? `extruder${id}` : 'extruder'] ?? preset.temps?.extruder),
                    ),
                  },
                ]
              : []
          }),
        })
      }

      if (path === '/api/console') {
        const response = await fetch(`${printer}/server/gcode_store?count=200`, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('Konsolenausgabe nicht erreichbar.')
        const data = await response.json()
        if (!Array.isArray(data.result?.gcode_store)) throw new Error('Keine Konsolenausgabe erhalten.')
        return json(200, { entries: data.result.gcode_store })
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
        const result = await control(await readJson(req, 1000), { async: true })
        const code = result.statusCode ?? 200
        return json(code, result)
      }

      const id = camera[1]
      if (camera[2] === 'webrtc') {
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
        const response = await fetch(`${printer}${cameras[id]}/webrtc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(6000),
        })
        if (!response.ok) throw new Error('WebRTC nicht verfügbar')
        return json(200, await response.json())
      }

      const response = await fetch(`${printer}${cameras[id]}/snapshot`, { signal: AbortSignal.timeout(5000) })
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
