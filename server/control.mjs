import { auxCapabilities, auxCommand, auxActions } from './aux-controls.mjs'
import { toolCapabilities, toolActionCommand, toolActions } from './tool-actions.mjs'
import {
  calibrationActions,
  calibrationActionKeys,
  calibrationCapabilities,
  calibrationCommand,
} from './calibration.mjs'
import { canHomeBeforeInitialization } from './status.mjs'
import { allowedOrigins } from './config.mjs'

export class ControlError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const fail = (message, status = 400) => {
  throw new ControlError(message, status)
}

const finite = value => typeof value === 'number' && Number.isFinite(value)

export function capabilities(raw) {
  const config = raw.configfile?.settings ?? raw.configfile?.config ?? {}
  const limit = name =>
    Number.isFinite(Number(config[name]?.max_temp)) ? Math.max(0, Number(config[name].max_temp) - 5) : null

  return {
    bedMax: limit('heater_bed'),
    toolMax: Array.from({ length: 6 }, (_, i) => limit(i ? `extruder${i}` : 'extruder')),
    qgl: !!config['quad_gantry_level'],
    mesh: !!config['bed_mesh'],
    ...toolCapabilities(config, raw),
    ...auxCapabilities(config),
    ...calibrationCapabilities(config),
  }
}

export function commandFor(input, raw) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Ungültiger Befehl.')
  const { action } = input
  const permitted = [
    'home',
    'jog',
    'temperature',
    'temperature_all',
    'heaters_off',
    'qgl',
    'mesh',
    'motors_off',
    'emergency_stop',
    'console',
    'fan',
    ...toolActions,
    ...auxActions,
    ...calibrationActions,
  ]
  if (!permitted.includes(action)) fail('Diese Aktion ist nicht verfügbar.')

  const toolKeys = ['action', ...(action.endsWith('_all') ? [] : ['tool'])]
  const keys = toolActions.includes(action)
    ? toolKeys
    : ({
        home: ['action', 'axis'],
        jog: ['action', 'axis', 'distance'],
        temperature: ['action', 'heater', 'target'],
        temperature_all: ['action', 'target'],
        led: ['action', 'profile'],
        fan: ['action', 'fan', 'percent'],
        console: ['action', 'script'],
        ...calibrationActionKeys,
      }[action] ?? ['action'])
  if (Object.keys(input).some(key => !keys.includes(key))) fail('Unbekannte Befehlsparameter.')

  if (action === 'emergency_stop') {
    return { endpoint: '/printer/emergency_stop', body: {}, label: 'Not-Aus' }
  }
  if (raw?.webhooks?.state !== 'ready') fail('Klipper ist nicht bereit.', 409)

  if (action === 'console') {
    if (
      typeof input.script !== 'string' ||
      !input.script.trim() ||
      input.script.length > 500 ||
      /[\r\n\x00-\x1f\x7f]/.test(input.script)
    ) {
      fail('Bitte einen einzelnen Befehl mit höchstens 500 Zeichen eingeben.')
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: input.script.trim() },
      label: 'Konsolenbefehl',
    }
  }

  if (auxActions.includes(action)) return auxCommand(input, raw, capabilities(raw))

  const printState = raw.print_stats?.state
  if (!['standby', 'printing', 'paused', 'complete', 'cancelled', 'error'].includes(printState)) {
    fail('Druckstatus ist unbekannt.', 409)
  }

  if (toolActions.includes(action)) return toolActionCommand(input, raw, capabilities(raw))
  if (calibrationActions.includes(action)) return calibrationCommand(input, raw, capabilities(raw))

  if (action === 'fan') {
    const fans = capabilities(raw).fans
    if (
      !fans.some(fan => fan.name === input.fan) ||
      !Number.isInteger(input.percent) ||
      input.percent < 0 ||
      input.percent > 100
    ) {
      fail('Ungültiger Lüfter oder Prozentwert.')
    }
    const targetFan = fans.find(fan => fan.name === input.fan)
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_FAN_SPEED FAN=${input.fan} SPEED=${input.percent / 100}` },
      label: `${targetFan.label} auf ${input.percent} %`,
    }
  }

  if (action === 'temperature_all') {
    if (['printing', 'paused'].includes(printState) || raw.idle_timeout?.state === 'Printing') {
      fail('Gemeinsames Heizen ist während eines Drucks, einer Pause oder laufender Befehle gesperrt.', 409)
    }
    const limits = capabilities(raw)
    if (!Number.isInteger(input.target) || input.target < 0 || limits.toolMax.some(max => max == null || input.target > max)) {
      fail('Temperaturgrenzen der Werkzeuge prüfen.')
    }
    const script = Array.from(
      { length: 6 },
      (_, id) => `SET_HEATER_TEMPERATURE HEATER=${id ? `extruder${id}` : 'extruder'} TARGET=${input.target}`,
    ).join('\n')
    return {
      endpoint: '/printer/gcode/script',
      body: { script },
      label: `Alle Tools auf ${input.target} °C`,
    }
  }

  const motion = ['home', 'jog', 'qgl', 'mesh', 'motors_off'].includes(action)
  if (motion && raw['gcode_macro LOAD_WATCH']?.active === 1) {
    fail('Einlegehilfe ist scharf. Zuerst mit Fertig beenden.', 409)
  }
  if (motion && ['printing', 'paused'].includes(printState)) {
    fail('Bewegungen sind während eines Drucks oder einer Druckpause gesperrt.', 409)
  }
  if (motion && raw.idle_timeout?.state === 'Printing') {
    fail('Der Drucker führt bereits eine Bewegung oder einen Befehl aus.', 409)
  }

  const homed = raw.toolhead?.homed_axes ?? ''
  const requireAxes = axes => {
    if (![...axes].every(axis => homed.includes(axis))) fail(`Zuerst ${axes.toUpperCase()} homen.`, 409)
  }

  const tc = raw.toolchanger
  if (
    motion &&
    Array.from({ length: 6 }, (_, id) => raw[`tool T${id}`]?.detect_state === 1).filter(Boolean).length > 1
  ) {
    fail('Mehrere Werkzeuge melden eine Verbindung. Erkennung prüfen.', 409)
  }
  if (
    motion &&
    tc?.has_detection &&
    tc.tool_number !== tc.detected_tool_number &&
    !(action === 'home' && canHomeBeforeInitialization(raw))
  ) {
    fail('Werkzeugerkennung stimmt nicht mit dem aktiven Werkzeug überein.', 409)
  }

  let script
  let label
  let asyncJob = false

  if (action === 'home') {
    if (!['all', 'x', 'y', 'z'].includes(input.axis)) fail('Ungültige Homing-Achse.')
    if (input.axis === 'z') requireAxes('xy')
    script = input.axis === 'all' ? 'G28' : `G28 ${input.axis.toUpperCase()}`
    label = input.axis === 'all' ? 'Alle Achsen homen' : `${input.axis.toUpperCase()} homen`
    asyncJob = true
  } else if (action === 'jog') {
    if (!['x', 'y', 'z'].includes(input.axis) || !finite(input.distance) || ![0.1, 1, 10, 25, 50, 100].includes(Math.abs(input.distance))) {
      fail('Ungültiger Bewegungsschritt.')
    }
    requireAxes(input.axis)
    const i = ['x', 'y', 'z'].indexOf(input.axis)
    const position = raw.toolhead?.position?.[i]
    const min = raw.toolhead?.axis_minimum?.[i]
    const max = raw.toolhead?.axis_maximum?.[i]
    if (![position, min, max].every(finite)) fail('Achsenposition oder Verfahrgrenzen unbekannt.', 409)
    if (position + input.distance < min || position + input.distance > max) {
      fail('Dieser Schritt überschreitet den Verfahrbereich.', 409)
    }
    const axis = input.axis.toUpperCase()
    const feed = input.axis === 'z' ? 300 : 1800
    script = `SAVE_GCODE_STATE NAME=STORMTROOPER_UI_JOG\nG91\nG1 ${axis}${input.distance} F${feed}\nM400\nRESTORE_GCODE_STATE NAME=STORMTROOPER_UI_JOG MOVE=0`
    label = `${axis} ${input.distance > 0 ? '+' : ''}${input.distance} mm`
  } else if (action === 'temperature') {
    if (
      !['heater_bed', 'extruder', 'extruder1', 'extruder2', 'extruder3', 'extruder4', 'extruder5'].includes(input.heater) ||
      !finite(input.target) ||
      !Number.isInteger(input.target)
    ) {
      fail('Ungültige Temperaturangabe.')
    }
    const limits = capabilities(raw)
    const i = input.heater === 'extruder' ? 0 : Number(input.heater.replace('extruder', ''))
    const max = input.heater === 'heater_bed' ? limits.bedMax : limits.toolMax[i]
    if (max == null) fail('Temperaturgrenze ist unbekannt.', 409)
    if (input.target < 0 || input.target > max) fail(`Zieltemperatur muss zwischen 0 und ${max} °C liegen.`)
    script = `SET_HEATER_TEMPERATURE HEATER=${input.heater} TARGET=${input.target}`
    label = `${input.heater === 'heater_bed' ? 'Druckbett' : `T${i}`} auf ${input.target} °C`
  } else if (action === 'heaters_off') {
    if (printState === 'printing') {
      fail('Cooldown ist während eines laufenden Drucks gesperrt. Bei einer Druckpause ist Cooldown verfügbar.', 409)
    }
    script = 'TURN_OFF_HEATERS'
    label = 'Alle Heizungen ausschalten'
  } else if (action === 'motors_off') {
    script = 'DISABLE_MOTORS'
    label = 'Motoren lösen'
  } else {
    requireAxes('xyz')
    if (!capabilities(raw)[action]) fail('Diese Kalibrierung ist nicht konfiguriert.', 409)
    script = action === 'qgl' ? 'QUAD_GANTRY_LEVEL' : 'BED_MESH_CALIBRATE'
    label = action === 'qgl' ? 'Gantry ausrichten' : 'Bett vermessen'
    asyncJob = true
  }

  return {
    endpoint: '/printer/gcode/script',
    body: { script },
    label,
    ...(asyncJob ? { async: true } : {}),
  }
}

export function sameOriginRequest(req, extraAllowedOrigins = allowedOrigins) {
  try {
    const origin = new URL(req.headers.origin)
    const isLoopback =
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol === 'http:'
    const isExplicitlyAllowed = Array.isArray(extraAllowedOrigins) && extraAllowedOrigins.includes(origin.origin)
    const originAllowed = isLoopback || isExplicitlyAllowed
    return (
      originAllowed &&
      origin.host === req.headers.host &&
      req.headers['x-cockpit-request'] === '1' &&
      req.headers['content-type']?.split(';')[0] === 'application/json'
    )
  } catch {
    return false
  }
}
