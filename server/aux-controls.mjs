import { normalizeStatus } from './status.mjs'
import { ControlError } from './control.mjs'
import { ledProfiles, auxActionReason } from '../src/aux-action-state.mjs'

export const auxActions = ['led', 'pause', 'resume', 'initialize', 'watch_start', 'watch_stop']

export function auxCapabilities(config) {
  const has = name => !!config[`gcode_macro ${name.toLowerCase()}`]
  return {
    ledProfiles: ledProfiles.filter(profile => has(profile.macro)).map(profile => profile.id),
    pause: has('PAUSE') || !!config.pause_resume,
    resume: has('RESUME') || !!config.pause_resume,
    initialize: !!config.toolchanger,
    watchAutoHome: config.toolchanger?.on_axis_not_homed === 'home',
    loadWatch:
      has('LOAD_WATCH') &&
      has('LOAD_WATCH_STOP') &&
      has('LOAD_FILAMENT') &&
      !!config['delayed_gcode _load_watch_tick'],
  }
}

export function auxCommand(input, raw, capabilities) {
  const status = { ...normalizeStatus(raw), capabilities }
  const reason = auxActionReason(status, input.action)
  if (reason) throw new ControlError(reason, 409)

  if (input.action === 'led') {
    const profile = ledProfiles.find(item => item.id === input.profile)
    if (!profile || !capabilities.ledProfiles.includes(input.profile)) {
      throw new ControlError('LED-Modus ist nicht konfiguriert.')
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: profile.macro },
      label: `LEDs · ${profile.label}`,
    }
  }

  if (input.action === 'watch_start' || input.action === 'watch_stop') {
    return {
      endpoint: '/printer/gcode/script',
      body: { script: input.action === 'watch_start' ? 'LOAD_WATCH' : 'LOAD_WATCH_STOP' },
      label:
        input.action === 'watch_start'
          ? `Einlegehilfe scharf bei ${capabilities.filamentDefaults.load} °C`
          : 'Einlegehilfe beendet',
    }
  }

  if (input.action === 'initialize') {
    return {
      endpoint: '/printer/gcode/script',
      body: { script: 'INITIALIZE_TOOLCHANGER\nM400' },
      label: 'Toolchanger initialisieren',
      async: true,
    }
  }

  const [script, label] =
    input.action === 'pause' ? ['PAUSE', 'Druck pausieren'] : ['RESUME', 'Druck fortsetzen']
  return {
    endpoint: '/printer/gcode/script',
    body: { script },
    label,
  }
}
