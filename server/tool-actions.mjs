import { normalizeStatus, detectToolCount } from './status.mjs'
import { toolActionReason, filamentToolIds, defaultActionTemperature } from '../src/tool-action-state.mjs'
import { ControlError } from './control.mjs'

const hiddenDummyFans = new Set(['fan3'])
const fanOrder = name => ({ fan0: 0, bedfans: 1 }[name.toLowerCase()] ?? 2)
const fanLabel = name => {
  const lower = name.toLowerCase()
  if (lower === 'bedfans') return 'Bettlüfter'
  if (lower === 'fan0') return 'CPAP Part Fan'
  return name
}

export const toolActions = ['park', 'pickup', 'select', 'load', 'unload', 'clean', 'purge', 'load_all', 'unload_all']

export function toolCapabilities(config, raw) {
  const has = name => !!config[`gcode_macro ${name}`]
  const common = ['_goto_purge_pos', '_purge_pos']
  const available = names => names.every(has)
  const isToolchanger = Boolean(raw.toolchanger || config.toolchanger)
  const toolCount = detectToolCount(raw, config)
  const toolSelect = Array.from({ length: toolCount }, (_, id) => has(`t${id}`) && !!config[`tool t${id}`])
  const limits = Array.from({ length: toolCount }, (_, id) =>
    Number(config[id ? `extruder${id}` : 'extruder']?.min_extrude_temp ?? 170),
  )

  const genericFans = Object.keys(raw)
    .filter(
      name =>
        /^fan_generic [A-Za-z0-9_]+$/.test(name) &&
        config[name.toLowerCase()] &&
        !hiddenDummyFans.has(name.slice(12).toLowerCase()),
    )
    .map(name => ({
      name: name.slice(12),
      label: fanLabel(name.slice(12)),
    }))
    .sort((a, b) => fanOrder(a.name) - fanOrder(b.name) || a.name.localeCompare(b.name))

  const fans = [
    ...(config.fan || raw.fan ? [{ name: '__part_fan__', label: 'Bauteillüfter', kind: 'part_fan' }] : []),
    ...genericFans,
  ]

  return {
    toolActions: isToolchanger
      ? {
          park: has('park_toolhead'),
          pickup: has('pickup_tool'),
          select: toolSelect.some(Boolean),
          clean: has('clean_nozzle'),
          purge: available(['purge_nozzle', '_load_settings', 'clean_nozzle', ...common]),
          load: available(['load_filament', '_load_settings', 'clean_nozzle', ...common]),
          unload: available(['unload_filament', '_unload_settings', ...common]),
          unload_all: available(['unload_filament', '_unload_settings', 'park_toolhead', ...common]),
          load_all: available(['load_filament', '_load_settings', 'clean_nozzle', ...common]),
        }
      : {
          park: false,
          pickup: false,
          select: false,
          clean: has('clean_nozzle'),
          purge: has('purge_nozzle'),
          load: has('load_filament'),
          unload: has('unload_filament'),
          unload_all: false,
          load_all: false,
        },
    toolSelect,
    extrusionMin: limits,
    filamentDefaults: {
      load: Number.isFinite(raw['gcode_macro _LOAD_SETTINGS']?.temp_default)
        ? raw['gcode_macro _LOAD_SETTINGS'].temp_default
        : null,
      unload: Number.isFinite(raw['gcode_macro _UNLOAD_SETTINGS']?.temp_default)
        ? raw['gcode_macro _UNLOAD_SETTINGS'].temp_default
        : null,
    },
    fans,
  }
}

export function toolActionCommand(input, raw, capabilities) {
  const status = { ...normalizeStatus(raw), capabilities }
  const { action, tool } = input
  const temperature = defaultActionTemperature(status, action)
  const reason = toolActionReason(status, action, tool)
  if (reason) throw new ControlError(reason, 409)

  if (!status.isToolchanger) {
    let script
    let label
    if (action === 'clean') {
      script = 'CLEAN_NOZZLE'
      label = 'Nozzle Clean'
    } else if (action === 'purge') {
      script = 'PURGE_NOZZLE'
      label = 'Purge'
    } else if (action === 'load') {
      script = 'LOAD_FILAMENT'
      label = 'Filament laden'
    } else if (action === 'unload') {
      script = 'UNLOAD_FILAMENT'
      label = 'Filament entladen'
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: `${script}\nM400` },
      label,
      async: true,
    }
  }

  const ids = action.endsWith('_all') ? filamentToolIds(status) : [tool]
  const first = ids[0]
  const pick = status.active == null ? `PICKUP_TOOL T=${first}\nM400\n` : ''
  const select = status.active === tool ? '' : status.active == null ? pick : `T${tool}\nM400\n`

  let script
  let label
  let steps = null

  if (action === 'park') {
    script = 'PARK_TOOLHEAD'
    label = `T${tool} parken`
  } else if (action === 'pickup') {
    script = `PICKUP_TOOL T=${tool}`
    label = `T${tool} aufnehmen`
  } else if (action === 'select') {
    script = `T${tool}`
    label = `Auf T${tool} wechseln`
  } else if (action === 'clean') {
    script = `${select}CLEAN_NOZZLE`
    label = `T${tool} Nozzle Clean`
  } else if (action === 'purge') {
    script = `${select}PURGE_NOZZLE`
    label = `T${tool} Purge bei ${temperature} °C`
  } else if (action === 'load' || action === 'unload') {
    script = `${pick}${action === 'load' ? 'LOAD' : 'UNLOAD'}_FILAMENT T=${tool}`
    label = `T${tool} Filament ${action === 'load' ? 'laden' : 'entladen'} bei ${temperature} °C`
  } else if (action === 'load_all') {
    script = pick + ids.map(id => `LOAD_FILAMENT T=${id}`).join('\n')
    label = `Filament laden: ${ids.map(id => `T${id}`).join(', ')} bei ${temperature} °C`
    steps = [
      ...(status.active == null ? [{ script: `PICKUP_TOOL T=${first}\nM400`, label: `T${first} aufnehmen`, tool: first }] : []),
      ...ids.map(id => ({ script: `LOAD_FILAMENT T=${id}\nM400`, label: `T${id} laden`, tool: id })),
    ]
  } else if (action === 'unload_all') {
    script = pick + ids.map(id => `UNLOAD_FILAMENT T=${id}`).join('\n') + '\nPARK_TOOLHEAD'
    label = `Filament entladen: ${ids.map(id => `T${id}`).join(', ')} · danach parken`
    steps = [
      ...(status.active == null ? [{ script: `PICKUP_TOOL T=${first}\nM400`, label: `T${first} aufnehmen`, tool: first }] : []),
      ...ids.map(id => ({ script: `UNLOAD_FILAMENT T=${id}\nM400`, label: `T${id} entladen`, tool: id })),
      { script: 'PARK_TOOLHEAD\nM400', label: 'Werkzeug parken', tool: null },
    ]
  }

  return {
    endpoint: '/printer/gcode/script',
    body: { script: `${script}\nM400` },
    label,
    async: true,
    ...(steps ? { steps } : {}),
  }
}
