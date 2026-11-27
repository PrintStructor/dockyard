import { auxCapabilities, auxCommand, auxActions } from './aux-controls.mjs'
import { toolCapabilities, toolActionCommand, toolActions } from './tool-actions.mjs'
import {
  printControlActions,
  printControlActionKeys,
  printControlCapabilities,
  printControlCommand,
} from './print-controls.mjs'
import {
  calibrationActions,
  calibrationActionKeys,
  calibrationCapabilities,
  calibrationCommand,
} from './calibration.mjs'
import { canHomeBeforeInitialization, detectToolCount, extractBedSize } from './status.mjs'
import { getEffectiveAllowedOrigins, isLanOriginAllowed, isPrivateLanHostname } from './settings.mjs'

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
  const isToolchanger = Boolean(raw.toolchanger || config.toolchanger)
  const toolCount = detectToolCount(raw, config)
  const limit = name =>
    Number.isFinite(Number(config[name]?.max_temp)) ? Math.max(0, Number(config[name].max_temp) - 5) : null
  const qgl = !!config['quad_gantry_level']
  const zTilt = !!config['z_tilt']

  return {
    isToolchanger,
    toolCount,
    bedMax: limit('heater_bed'),
    toolMax: Array.from({ length: toolCount }, (_, i) => limit(i ? `extruder${i}` : 'extruder')),
    qgl,
    zTilt,
    leveling: qgl ? 'qgl' : zTilt ? 'z_tilt' : null,
    bedSize: extractBedSize(raw, config),
    mesh: !!config['bed_mesh'],
    ...toolCapabilities(config, raw),
    ...auxCapabilities(config),
    ...printControlCapabilities(config, raw),
    ...calibrationCapabilities(config),
  }
}

export function commandFor(input, raw) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Ungültiger Befehl.')
  const { action } = input
  const permitted = [
    'home',
    'jog',
    'move_to',
    'extrude',
    'filament_sensor',
    'temperature',
    'temperature_all',
    'preheat',
    'heaters_off',
    'qgl',
    'z_tilt',
    'mesh',
    'motors_off',
    'emergency_stop',
    'console',
    'fan',
    ...toolActions,
    ...auxActions,
    ...printControlActions,
    ...calibrationActions,
  ]
  if (!permitted.includes(action)) fail('Diese Aktion ist nicht verfügbar.')

  const toolKeys = ['action', ...(action.endsWith('_all') ? [] : ['tool'])]
  const keys = toolActions.includes(action)
    ? toolKeys
    : ({
        home: ['action', 'axis'],
        jog: ['action', 'axis', 'distance'],
        move_to: ['action', 'axis', 'target'],
        extrude: ['action', 'distance', 'speed', 'tool'],
        filament_sensor: ['action', 'sensor', 'enabled'],
        temperature: ['action', 'heater', 'target'],
        temperature_all: ['action', 'target'],
        preheat: ['action', 'extruder', 'bed'],
        led: ['action', 'profile'],
        fan: ['action', 'fan', 'percent'],
        console: ['action', 'script'],
        ...printControlActionKeys,
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
  if (printControlActions.includes(action)) return printControlCommand(input, raw, capabilities(raw))
  if (calibrationActions.includes(action)) return calibrationCommand(input, raw, capabilities(raw))

  if (action === 'filament_sensor') {
    if (
      typeof input.sensor !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,80}$/.test(input.sensor) ||
      typeof input.enabled !== 'boolean'
    ) {
      fail('Ungültiger Filamentsensor oder Schaltzustand.')
    }
    const switchKey = `filament_switch_sensor ${input.sensor}`
    const motionKey = `filament_motion_sensor ${input.sensor}`
    const cfg = raw.configfile?.settings ?? raw.configfile?.config ?? {}
    const exists = Boolean(
      raw[switchKey] ||
        raw[motionKey] ||
        cfg[switchKey.toLowerCase()] ||
        cfg[motionKey.toLowerCase()],
    )
    if (!exists) fail('Filamentsensor ist auf diesem Drucker nicht konfiguriert.', 409)
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_FILAMENT_SENSOR SENSOR=${input.sensor} ENABLE=${input.enabled ? 1 : 0}` },
      label: `${input.sensor} ${input.enabled ? 'aktiviert' : 'deaktiviert'}`,
    }
  }

  if (action === 'extrude') {
    if (raw['gcode_macro LOAD_WATCH']?.active === 1) {
      fail('Einlegehilfe ist scharf. Zuerst mit Fertig beenden.', 409)
    }
    if (printState === 'printing') {
      fail('Manuelles Extrudieren ist während eines laufenden Drucks gesperrt.', 409)
    }
    if (raw.idle_timeout?.state === 'Printing') {
      fail('Der Drucker führt bereits eine Bewegung oder einen Befehl aus.', 409)
    }
    const limits = capabilities(raw)
    const toolId = input.tool === undefined ? 0 : input.tool
    if (!Number.isInteger(toolId) || toolId < 0 || toolId >= limits.toolCount) {
      fail('Ungültiges Werkzeug.')
    }
    const dist = input.distance
    if (!finite(dist) || Math.abs(dist) < 0.5 || Math.abs(dist) > 150) {
      fail('Extrusionslänge muss zwischen 0,5 und 150 mm liegen.')
    }
    const speed = input.speed === undefined ? 5 : input.speed
    if (!finite(speed) || speed < 1 || speed > 30) {
      fail('Extrusionsgeschwindigkeit muss zwischen 1 und 30 mm/s liegen.')
    }
    const extruderKey = toolId ? `extruder${toolId}` : 'extruder'
    const minTemp = limits.extrusionMin?.[toolId] ?? 170
    if (raw[extruderKey]?.can_extrude !== true) {
      fail(`Extruder zu kalt — mindestens ${minTemp} °C erforderlich.`, 409)
    }
    const distFormatted = Number(dist.toFixed(2))
    const feed = Math.round(speed * 60)
    const absLabel = Math.abs(distFormatted)
    const prefix = limits.isToolchanger && toolId > 0 ? `ACTIVATE_EXTRUDER EXTRUDER=${extruderKey}\n` : ''
    return {
      endpoint: '/printer/gcode/script',
      body: {
        script: `${prefix}SAVE_GCODE_STATE NAME=DOCKYARD_UI_EXTRUDE\nM83\nG1 E${distFormatted} F${feed}\nM400\nRESTORE_GCODE_STATE NAME=DOCKYARD_UI_EXTRUDE MOVE=0`,
      },
      label: `${distFormatted > 0 ? 'Extrudieren' : 'Einziehen'} ${absLabel} mm`,
      async: true,
    }
  }

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
    const script =
      targetFan.kind === 'part_fan' || targetFan.name === '__part_fan__'
        ? `M106 S${Math.round((input.percent / 100) * 255)}`
        : `SET_FAN_SPEED FAN=${input.fan} SPEED=${input.percent / 100}`
    return {
      endpoint: '/printer/gcode/script',
      body: { script },
      label: `${targetFan.label} auf ${input.percent} %`,
    }
  }

  if (action === 'temperature_all') {
    const limits = capabilities(raw)
    if (limits.toolCount <= 1) {
      fail('Gemeinsames Heizen ist nur bei mehreren Werkzeugen verfügbar.', 409)
    }
    if (['printing', 'paused'].includes(printState) || raw.idle_timeout?.state === 'Printing') {
      fail('Gemeinsames Heizen ist während eines Drucks, einer Pause oder laufender Befehle gesperrt.', 409)
    }
    if (!Number.isInteger(input.target) || input.target < 0 || limits.toolMax.some(max => max == null || input.target > max)) {
      fail('Temperaturgrenzen der Werkzeuge prüfen.')
    }
    const script = Array.from(
      { length: limits.toolCount },
      (_, id) => `SET_HEATER_TEMPERATURE HEATER=${id ? `extruder${id}` : 'extruder'} TARGET=${input.target}`,
    ).join('\n')
    return {
      endpoint: '/printer/gcode/script',
      body: { script },
      label: `Alle Tools auf ${input.target} °C`,
    }
  }

  const motion = ['home', 'jog', 'move_to', 'qgl', 'z_tilt', 'mesh', 'motors_off'].includes(action)
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
  const tcCount = detectToolCount(raw)
  if (
    motion &&
    tc &&
    Array.from({ length: tcCount }, (_, id) => raw[`tool T${id}`]?.detect_state === 1).filter(Boolean).length > 1
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
    script = `SAVE_GCODE_STATE NAME=DOCKYARD_UI_JOG\nG91\nG1 ${axis}${input.distance} F${feed}\nM400\nRESTORE_GCODE_STATE NAME=DOCKYARD_UI_JOG MOVE=0`
    label = `${axis} ${input.distance > 0 ? '+' : ''}${input.distance} mm`
  } else if (action === 'move_to') {
    if (!['x', 'y', 'z'].includes(input.axis) || !finite(input.target)) {
      fail('Ungültige Zielposition.')
    }
    requireAxes(input.axis)
    const i = ['x', 'y', 'z'].indexOf(input.axis)
    const min = raw.toolhead?.axis_minimum?.[i]
    const max = raw.toolhead?.axis_maximum?.[i]
    if (![min, max].every(finite)) fail('Achsenposition oder Verfahrgrenzen unbekannt.', 409)
    if (input.target < min || input.target > max) {
      fail('Dieser Schritt überschreitet den Verfahrbereich.', 409)
    }
    const target = Number(input.target.toFixed(3)) || 0
    if (target < min || target > max) {
      fail('Dieser Schritt überschreitet den Verfahrbereich.', 409)
    }
    const axis = input.axis.toUpperCase()
    const feed = input.axis === 'z' ? 600 : 3000
    script = `SAVE_GCODE_STATE NAME=DOCKYARD_UI_MOVE\nG90\nG1 ${axis}${target} F${feed}\nM400\nRESTORE_GCODE_STATE NAME=DOCKYARD_UI_MOVE MOVE=0`
    label = `${axis} auf ${target} mm`
  } else if (action === 'temperature') {
    const limits = capabilities(raw)
    const allowedHeaters = [
      'heater_bed',
      ...Array.from({ length: limits.toolCount }, (_, id) => (id ? `extruder${id}` : 'extruder')),
    ]
    if (
      !allowedHeaters.includes(input.heater) ||
      !finite(input.target) ||
      !Number.isInteger(input.target)
    ) {
      fail('Ungültige Temperaturangabe.')
    }
    const i = input.heater === 'extruder' ? 0 : Number(input.heater.replace('extruder', ''))
    const max = input.heater === 'heater_bed' ? limits.bedMax : limits.toolMax[i]
    if (max == null) fail('Temperaturgrenze ist unbekannt.', 409)
    if (input.target < 0 || input.target > max) fail(`Zieltemperatur muss zwischen 0 und ${max} °C liegen.`)
    script = `SET_HEATER_TEMPERATURE HEATER=${input.heater} TARGET=${input.target}`
    const heaterLabel = input.heater === 'heater_bed' ? 'Druckbett' : limits.toolCount === 1 ? 'Extruder' : `T${i}`
    label = `${heaterLabel} auf ${input.target} °C`
  } else if (action === 'preheat') {
    const limits = capabilities(raw)
    const hasExtruder = input.extruder !== undefined && input.extruder !== null
    const hasBed = input.bed !== undefined && input.bed !== null
    if (!hasExtruder && !hasBed) fail('Mindestens eine Zieltemperatur angeben.')
    const lines = []
    const parts = []
    if (hasExtruder) {
      if (!finite(input.extruder) || !Number.isInteger(input.extruder)) fail('Ungültige Temperaturangabe.')
      const max = limits.toolMax[0]
      if (max == null) fail('Temperaturgrenze ist unbekannt.', 409)
      if (input.extruder < 0 || input.extruder > max) fail(`Zieltemperatur muss zwischen 0 und ${max} °C liegen.`)
      lines.push(`SET_HEATER_TEMPERATURE HEATER=extruder TARGET=${input.extruder}`)
      parts.push(`Extruder ${input.extruder} °C`)
    }
    if (hasBed) {
      if (!finite(input.bed) || !Number.isInteger(input.bed)) fail('Ungültige Temperaturangabe.')
      const max = limits.bedMax
      if (max == null) fail('Temperaturgrenze ist unbekannt.', 409)
      if (input.bed < 0 || input.bed > max) fail(`Zieltemperatur muss zwischen 0 und ${max} °C liegen.`)
      lines.push(`SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${input.bed}`)
      parts.push(`Bett ${input.bed} °C`)
    }
    script = lines.join('\n')
    label = `Vorheizen · ${parts.join(' · ')}`
  } else if (action === 'heaters_off') {
    if (printState === 'printing') {
      fail('Cooldown ist während eines laufenden Drucks gesperrt. Bei einer Druckpause ist Cooldown verfügbar.', 409)
    }
    script = 'TURN_OFF_HEATERS'
    label = 'Alle Heizungen ausschalten'
  } else if (action === 'motors_off') {
    const cfg = raw.configfile?.settings ?? raw.configfile?.config ?? {}
    script = cfg['gcode_macro disable_motors'] ? 'DISABLE_MOTORS' : 'M84'
    label = 'Motoren lösen'
  } else if (action === 'z_tilt') {
    requireAxes('xyz')
    if (!capabilities(raw).zTilt) fail('Z-Tilt ist nicht konfiguriert.', 409)
    script = 'Z_TILT_ADJUST'
    label = 'Z-Tilt ausrichten'
    asyncJob = true
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

export function isOriginWriteAllowed(req, extraAllowedOrigins, options) {
  try {
    const rawOrigin = req?.headers?.origin
    const rawHost = req?.headers?.host
    if (!rawOrigin || !rawHost) return false
    const origin = new URL(rawOrigin)
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false
    if (origin.host !== rawHost) return false

    const effectiveAllowed =
      extraAllowedOrigins !== undefined ? extraAllowedOrigins : getEffectiveAllowedOrigins()
    const allowLan =
      options?.allowLanOrigins !== undefined
        ? Boolean(options.allowLanOrigins)
        : extraAllowedOrigins !== undefined
          ? false
          : isLanOriginAllowed()

    const isLoopback =
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol === 'http:'
    const isExplicitlyAllowed = Array.isArray(effectiveAllowed) && effectiveAllowed.includes(origin.origin)
    const isAllowedLan = allowLan && isPrivateLanHostname(origin.hostname)

    return isLoopback || isExplicitlyAllowed || isAllowedLan
  } catch {
    return false
  }
}

export function sameOriginRequest(req, extraAllowedOrigins, options) {
  return (
    isOriginWriteAllowed(req, extraAllowedOrigins, options) &&
    req.headers['x-cockpit-request'] === '1' &&
    req.headers['content-type']?.split(';')[0] === 'application/json'
  )
}
