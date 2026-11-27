import { normalizeStatus } from './status.mjs'
import { ControlError } from './control.mjs'
import { validateGcodeFilename } from './gcode-mesh.mjs'
import {
  printControlReason,
  Z_BABYSTEP_DELTAS,
  SPEED_MIN,
  SPEED_MAX,
  FLOW_MIN,
  FLOW_MAX,
} from '../src/print-control-state.mjs'

export const printControlActions = [
  'print_start',
  'print_cancel',
  'tune_speed',
  'tune_flow',
  'tune_z_offset',
  'tune_pressure_advance',
  'tune_velocity_limits',
  'tune_retraction',
  'save_z_offset',
  'exclude_object',
  'pause_next_layer',
  'pause_at_layer',
]

export const printControlActionKeys = {
  print_start: ['action', 'filename'],
  print_cancel: ['action'],
  tune_speed: ['action', 'percent'],
  tune_flow: ['action', 'percent'],
  tune_z_offset: ['action', 'delta', 'reset'],
  tune_pressure_advance: ['action', 'advance', 'smoothTime', 'tool'],
  tune_velocity_limits: ['action', 'velocity', 'accel', 'minCruiseRatio', 'squareCornerVelocity'],
  tune_retraction: ['action', 'retractLength', 'retractSpeed', 'unretractExtraLength', 'unretractSpeed'],
  save_z_offset: ['action'],
  exclude_object: ['action', 'name'],
  pause_next_layer: ['action', 'enable'],
  pause_at_layer: ['action', 'enable', 'layer'],
}

export function printControlCapabilities(config, raw) {
  const has = name => !!config[`gcode_macro ${name.toLowerCase()}`]
  const isToolchanger = Boolean(raw?.toolchanger || config.toolchanger)
  const endstopPin = String(config.stepper_z?.endstop_pin ?? '').toLowerCase()
  const isVirtualZEndstop = endstopPin.includes('probe:z_virtual_endstop') || endstopPin.includes('beacon')
  const hasExplicitPhysicalZEndstop = Boolean(config.stepper_z && endstopPin && !isVirtualZEndstop)
  const hasBeacon = Boolean(config.beacon)
  const hasTraditionalProbe = Boolean(
    config.probe ||
      config.bltouch ||
      config.scanner ||
      config.cartographer ||
      Object.keys(config).some(k => k.toLowerCase().startsWith('probe_eddy_current')),
  )
  let zOffsetSaveTarget = null
  if (!isToolchanger) {
    if (hasBeacon) zOffsetSaveTarget = 'beacon'
    else if (hasExplicitPhysicalZEndstop) zOffsetSaveTarget = 'endstop'
    else if (hasTraditionalProbe) zOffsetSaveTarget = 'probe'
    else if (config.stepper_z) zOffsetSaveTarget = 'endstop'
  }
  return {
    printStart: !!config.virtual_sdcard,
    printCancel: has('CANCEL_PRINT') || !!config.pause_resume,
    perToolZAdjust: isToolchanger && has('SET_GCODE_OFFSET'),
    zAdjustReset: has('Z_ADJUST_RESET'),
    zOffsetSaveTarget,
    firmwareRetraction: Boolean(config.firmware_retraction || raw?.firmware_retraction),
    excludeObject: raw?.exclude_object != null || !!config.exclude_object,
    pauseNextLayer: has('SET_PAUSE_NEXT_LAYER'),
    pauseAtLayer: has('SET_PAUSE_AT_LAYER'),
  }
}

export function printControlCommand(input, raw, capabilities) {
  const status = { ...normalizeStatus(raw), capabilities }
  const { action } = input
  const reason = printControlReason(status, action)
  if (reason) throw new ControlError(reason, 409)

  if (action === 'print_start') {
    const filename = validateGcodeFilename(input.filename)
    if (!filename) throw new ControlError('Ungültiger G-Code-Dateiname.', 400)
    const basename = filename.split('/').pop()
    return {
      rpcMethod: 'printer.print.start',
      rpcParams: { filename },
      label: `Druck starten · ${basename}`,
      timeoutMs: 30_000,
    }
  }

  if (action === 'print_cancel') {
    return {
      rpcMethod: 'printer.print.cancel',
      rpcParams: {},
      label: 'Druck abbrechen',
      async: true,
      timeoutMs: 120_000,
    }
  }

  if (action === 'tune_speed') {
    if (!Number.isInteger(input.percent) || input.percent < SPEED_MIN || input.percent > SPEED_MAX) {
      throw new ControlError(`Geschwindigkeit muss zwischen ${SPEED_MIN} und ${SPEED_MAX} % liegen.`, 400)
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `M220 S${input.percent}` },
      label: `Geschwindigkeit auf ${input.percent} %`,
    }
  }

  if (action === 'tune_flow') {
    if (!Number.isInteger(input.percent) || input.percent < FLOW_MIN || input.percent > FLOW_MAX) {
      throw new ControlError(`Fluss muss zwischen ${FLOW_MIN} und ${FLOW_MAX} % liegen.`, 400)
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `M221 S${input.percent}` },
      label: `Fluss auf ${input.percent} %`,
    }
  }

  if (action === 'tune_z_offset') {
    const hasDelta = input.delta !== undefined
    const hasReset = input.reset !== undefined
    if (hasDelta === hasReset) {
      throw new ControlError('Entweder Z-Schrittweite oder Zurücksetzen angeben.', 400)
    }
    if (hasReset) {
      if (input.reset !== true) throw new ControlError('Ungültiger Reset-Parameter.', 400)
      if (capabilities.zAdjustReset) {
        return {
          endpoint: '/printer/gcode/script',
          body: { script: 'Z_ADJUST_RESET' },
          label: 'Z-Offset zurücksetzen',
        }
      }
      if (capabilities.perToolZAdjust) {
        throw new ControlError('Z_ADJUST_RESET ist nicht konfiguriert.', 409)
      }
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'SET_GCODE_OFFSET Z=0 MOVE=1' },
        label: 'Z-Offset zurücksetzen',
      }
    }
    if (typeof input.delta !== 'number' || !Number.isFinite(input.delta)) {
      throw new ControlError('Ungültige Z-Schrittweite.', 400)
    }
    const matched = Z_BABYSTEP_DELTAS.find(step => Math.abs(step - input.delta) < 1e-6)
    if (matched == null) {
      throw new ControlError('Nicht erlaubte Z-Schrittweite.', 400)
    }
    const formatted = `${matched > 0 ? '+' : ''}${matched.toFixed(3)}`
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_GCODE_OFFSET Z_ADJUST=${formatted} MOVE=1` },
      label: `Z-Offset ${formatted} mm`,
    }
  }

  if (action === 'save_z_offset') {
    const target = capabilities.zOffsetSaveTarget
    if (target === 'beacon') {
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'BEACON_OFFSET_APPLY' },
        label: 'Z-Offset für Beacon übernehmen',
      }
    }
    const isProbe = target === 'probe'
    return {
      endpoint: '/printer/gcode/script',
      body: { script: isProbe ? 'Z_OFFSET_APPLY_PROBE' : 'Z_OFFSET_APPLY_ENDSTOP' },
      label: isProbe ? 'Z-Offset für Probe übernehmen' : 'Z-Offset für Endstop übernehmen',
    }
  }

  if (action === 'tune_pressure_advance') {
    const parts = []
    if (input.tool !== undefined) {
      if (!Number.isInteger(input.tool) || input.tool < 0 || input.tool >= (status.toolCount ?? 1)) {
        throw new ControlError('Ungültiges Werkzeug.', 400)
      }
      parts.push(`EXTRUDER=${input.tool ? `extruder${input.tool}` : 'extruder'}`)
    }
    if (input.advance !== undefined) {
      if (typeof input.advance !== 'number' || !Number.isFinite(input.advance) || input.advance < 0 || input.advance > 2) {
        throw new ControlError('Pressure Advance muss zwischen 0 und 2,0 liegen.', 400)
      }
      parts.push(`ADVANCE=${Number(input.advance.toFixed(4))}`)
    }
    if (input.smoothTime !== undefined) {
      if (
        typeof input.smoothTime !== 'number' ||
        !Number.isFinite(input.smoothTime) ||
        input.smoothTime < 0.005 ||
        input.smoothTime > 0.2
      ) {
        throw new ControlError('Smooth Time muss zwischen 0,005 und 0,200 s liegen.', 400)
      }
      parts.push(`SMOOTH_TIME=${Number(input.smoothTime.toFixed(3))}`)
    }
    if (parts.length === 0 || (parts.length === 1 && parts[0].startsWith('EXTRUDER='))) {
      throw new ControlError('Mindestens Pressure Advance oder Smooth Time angeben.', 400)
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_PRESSURE_ADVANCE ${parts.join(' ')}` },
      label: 'Pressure Advance angepasst',
    }
  }

  if (action === 'tune_velocity_limits') {
    const cfgPrinter = raw?.configfile?.settings?.printer ?? {}
    const maxV = Number.isFinite(Number(cfgPrinter.max_velocity)) ? Number(cfgPrinter.max_velocity) : 1000
    const maxA = Number.isFinite(Number(cfgPrinter.max_accel)) ? Number(cfgPrinter.max_accel) : 50000
    const parts = []
    if (input.velocity !== undefined) {
      if (typeof input.velocity !== 'number' || !Number.isFinite(input.velocity) || input.velocity < 1 || input.velocity > maxV) {
        throw new ControlError(`Geschwindigkeitslimit muss zwischen 1 und ${Math.round(maxV)} mm/s liegen.`, 400)
      }
      parts.push(`VELOCITY=${Number(input.velocity.toFixed(1))}`)
    }
    if (input.accel !== undefined) {
      if (typeof input.accel !== 'number' || !Number.isFinite(input.accel) || input.accel < 50 || input.accel > maxA) {
        throw new ControlError(`Beschleunigung muss zwischen 50 und ${Math.round(maxA)} mm/s² liegen.`, 400)
      }
      parts.push(`ACCEL=${Math.round(input.accel)}`)
    }
    if (input.minCruiseRatio !== undefined) {
      if (
        typeof input.minCruiseRatio !== 'number' ||
        !Number.isFinite(input.minCruiseRatio) ||
        input.minCruiseRatio < 0 ||
        input.minCruiseRatio >= 1
      ) {
        throw new ControlError('Min. Cruise Ratio muss zwischen 0 und 0,99 liegen.', 400)
      }
      parts.push(`MINIMUM_CRUISE_RATIO=${Number(input.minCruiseRatio.toFixed(2))}`)
    }
    if (input.squareCornerVelocity !== undefined) {
      if (
        typeof input.squareCornerVelocity !== 'number' ||
        !Number.isFinite(input.squareCornerVelocity) ||
        input.squareCornerVelocity < 0.5 ||
        input.squareCornerVelocity > 50
      ) {
        throw new ControlError('Square Corner Velocity muss zwischen 0,5 und 50 mm/s liegen.', 400)
      }
      parts.push(`SQUARE_CORNER_VELOCITY=${Number(input.squareCornerVelocity.toFixed(1))}`)
    }
    if (!parts.length) throw new ControlError('Mindestens ein Bewegungslimit angeben.', 400)
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_VELOCITY_LIMIT ${parts.join(' ')}` },
      label: 'Bewegungslimits angepasst',
    }
  }

  if (action === 'tune_retraction') {
    const parts = []
    if (input.retractLength !== undefined) {
      if (typeof input.retractLength !== 'number' || !Number.isFinite(input.retractLength) || input.retractLength < 0 || input.retractLength > 15) {
        throw new ControlError('Retract-Länge muss zwischen 0 und 15 mm liegen.', 400)
      }
      parts.push(`RETRACT_LENGTH=${Number(input.retractLength.toFixed(2))}`)
    }
    if (input.retractSpeed !== undefined) {
      if (typeof input.retractSpeed !== 'number' || !Number.isFinite(input.retractSpeed) || input.retractSpeed < 1 || input.retractSpeed > 200) {
        throw new ControlError('Retract-Geschwindigkeit muss zwischen 1 und 200 mm/s liegen.', 400)
      }
      parts.push(`RETRACT_SPEED=${Math.round(input.retractSpeed)}`)
    }
    if (input.unretractExtraLength !== undefined) {
      if (
        typeof input.unretractExtraLength !== 'number' ||
        !Number.isFinite(input.unretractExtraLength) ||
        input.unretractExtraLength < 0 ||
        input.unretractExtraLength > 5
      ) {
        throw new ControlError('Extra-Länge muss zwischen 0 und 5 mm liegen.', 400)
      }
      parts.push(`UNRETRACT_EXTRA_LENGTH=${Number(input.unretractExtraLength.toFixed(2))}`)
    }
    if (input.unretractSpeed !== undefined) {
      if (typeof input.unretractSpeed !== 'number' || !Number.isFinite(input.unretractSpeed) || input.unretractSpeed < 1 || input.unretractSpeed > 200) {
        throw new ControlError('Unretract-Geschwindigkeit muss zwischen 1 und 200 mm/s liegen.', 400)
      }
      parts.push(`UNRETRACT_SPEED=${Math.round(input.unretractSpeed)}`)
    }
    if (!parts.length) throw new ControlError('Mindestens einen Retraction-Wert angeben.', 400)
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_RETRACTION ${parts.join(' ')}` },
      label: 'Firmware Retraction angepasst',
    }
  }

  if (action === 'exclude_object') {
    const name = input.name
    if (typeof name !== 'string' || !name || name.length > 200 || /[\s\r\n\x00-\x1f\x7f"']/.test(name)) {
      throw new ControlError('Ungültiger Objektname.', 400)
    }
    const known = status.excludeObjects?.objects ?? []
    const excluded = status.excludeObjects?.excluded ?? []
    if (!known.some(item => item.name === name)) {
      throw new ControlError('Objekt ist im aktuellen Druck nicht vorhanden.', 409)
    }
    if (excluded.includes(name)) {
      throw new ControlError('Objekt wurde bereits übersprungen.', 409)
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `EXCLUDE_OBJECT NAME=${name}` },
      label: `Objekt überspringen · ${name}`,
    }
  }

  if (action === 'pause_next_layer') {
    if (typeof input.enable !== 'boolean') throw new ControlError('Ungültiger Parameter für Pause beim nächsten Layer.', 400)
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_PAUSE_NEXT_LAYER ENABLE=${input.enable ? 1 : 0}` },
      label: input.enable ? 'Pause beim nächsten Layer vorgemerkt' : 'Pause beim nächsten Layer aufgehoben',
    }
  }

  if (action === 'pause_at_layer') {
    if (typeof input.enable !== 'boolean') throw new ControlError('Ungültiger Parameter für Pause bei Layer.', 400)
    if (!input.enable) {
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'SET_PAUSE_AT_LAYER ENABLE=0' },
        label: 'Layer-Pause aufgehoben',
      }
    }
    const layer = input.layer
    if (!Number.isInteger(layer) || layer < 1 || layer > 100_000) {
      throw new ControlError('Layer-Nummer muss eine ganze Zahl ≥ 1 sein.', 400)
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `SET_PAUSE_AT_LAYER ENABLE=1 LAYER=${layer}` },
      label: `Pause bei Layer ${layer} vorgemerkt`,
    }
  }

  throw new ControlError('Unbekannte Druckaktion.', 400)
}
