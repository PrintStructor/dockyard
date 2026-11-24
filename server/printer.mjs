import http from 'node:http'
import { createMaterialsReader } from './materials.mjs'
import { createLiveFeed } from './live.mjs'
import { normalizeStatus } from './status.mjs'
import { temperatureHistory } from './temperature.mjs'
import { capabilities, commandFor, ControlError, sameOriginRequest } from './control.mjs'
import { executeGcodeScript, AbortedCommandError } from './ws-rpc.mjs'
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
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > max) throw new ControlError('Anfrage zu groß.', 413)
  }
  try {
    return JSON.parse(text)
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
    configCache = data.result.status.configfile
    effectObjects = Object.keys(configCache.settings ?? {}).filter(name => name.startsWith('led_effect '))
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
      const stepTimeoutMs = 600_000
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

export function printerMiddleware(req, res, next) {
  const path = new URL(req.url, 'http://localhost').pathname
  if (!path.startsWith('/api/')) return next()
  res.setHeader('Cache-Control', 'no-store')

  const json = (code, value) => {
    if (res.destroyed) return
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(value))
  }

  const camera = path.match(/^\/api\/camera\/(tophat|heatbed)(?:\/(stream|webrtc))?$/)
  if (
    path !== '/api/status' &&
    path !== '/api/control' &&
    path !== '/api/events' &&
    path !== '/api/console' &&
    path !== '/api/presets' &&
    path !== '/api/temperature-history' &&
    !camera
  ) {
    return json(404, { error: 'Unbekannter Endpunkt' })
  }

  const write = path === '/api/control' || camera?.[2] === 'webrtc'
  if (req.method !== (write ? 'POST' : 'GET')) return json(405, { error: 'Methode nicht erlaubt.' })
  if (write && !sameOriginRequest(req)) {
    return json(403, { error: 'Befehle sind nur aus dieser lokalen Oberfläche erlaubt.' })
  }
  if (path === '/api/events') return live.handle(req, res)
  if (camera?.[2] === 'stream') return streamCamera(camera[1], res)

  ;(async () => {
    try {
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
      json(error.status ?? 502, { error: error.message || 'Verbindung zum Drucker fehlgeschlagen.' })
    }
  })()
}
