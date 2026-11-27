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
  'exclude_object',
]

export const printControlActionKeys = {
  print_start: ['action', 'filename'],
  print_cancel: ['action'],
  tune_speed: ['action', 'percent'],
  tune_flow: ['action', 'percent'],
  tune_z_offset: ['action', 'delta', 'reset'],
  exclude_object: ['action', 'name'],
}

export function printControlCapabilities(config, raw) {
  const has = name => !!config[`gcode_macro ${name.toLowerCase()}`]
  const isToolchanger = Boolean(raw?.toolchanger || config.toolchanger)
  return {
    printStart: !!config.virtual_sdcard,
    printCancel: has('CANCEL_PRINT') || !!config.pause_resume,
    perToolZAdjust: isToolchanger && has('SET_GCODE_OFFSET'),
    zAdjustReset: has('Z_ADJUST_RESET'),
    excludeObject: raw?.exclude_object != null || !!config.exclude_object,
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

  throw new ControlError('Unbekannte Druckaktion.', 400)
}
