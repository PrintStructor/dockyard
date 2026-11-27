const MAX_TOOLS = 8
const SINGLE_TOOL_NEOPIXEL_PRIORITY = [
  'neopixel sb_leds',
  'neopixel sb-leds',
  'neopixel stealthburner_leds',
  'neopixel stealthburner-leds',
  'neopixel head_leds',
  'neopixel toolhead_leds',
  'neopixel nozzle_leds',
  'neopixel rgb',
]
const SENSOR_LABELS = {
  chamber: 'Bauraum',
  raspberry_pi: 'Raspberry Pi',
  host: 'Host',
  octopus: 'Octopus',
  rp2350: 'RP2350',
  beacon_coil: 'Beacon-Spule',
  mcu: 'MCU',
  mcu_temp: 'MCU',
  skr_pico: 'SKR Pico',
}

const INTERNAL_PUBLIC_MACROS = new Set([
  'PAUSE',
  'RESUME',
  'CANCEL_PRINT',
  'SET_GCODE_OFFSET',
  'SET_PAUSE_NEXT_LAYER',
  'SET_PAUSE_AT_LAYER',
  'SET_PRINT_STATS_INFO',
  'LOAD_WATCH',
])

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const numeric = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
const flag = value => (typeof value === 'boolean' ? value : null)

const color = value =>
  Array.isArray(value) && value.length >= 3 && value.every(v => finite(v) !== null)
    ? [0, 1, 2, 3].map(i => Math.min(1, Math.max(0, value[i] ?? 0)))
    : null

export function extractMacroParams(gcode) {
  if (typeof gcode !== 'string' || !gcode.includes('params')) return []
  const found = new Map()
  const addParam = (rawName, rawDefault = '') => {
    const name = String(rawName ?? '').trim().toUpperCase()
    if (!/^[A-Za-z0-9_]{1,40}$/.test(name)) return
    let def = String(rawDefault ?? '').trim()
    // Strip matching surrounding single/double quotes for clean prefill.
    if ((def.startsWith("'") && def.endsWith("'")) || (def.startsWith('"') && def.endsWith('"'))) {
      def = def.slice(1, -1)
    }
    // Discard Jinja expressions or overly complex defaults so the input stays clean.
    if (!def || /[{}()[\]|]/.test(def) || def.length > 48) def = ''
    if (!found.has(name) || (!found.get(name) && def)) {
      found.set(name, def)
    }
  }

  // Match params.FOO | default(60) or params.FOO
  const dotRe = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)(?:\s*\|\s*default\s*\(\s*([^),]+))?/g
  for (const m of gcode.matchAll(dotRe)) {
    if (m[1].toLowerCase() === 'get') continue
    addParam(m[1], m[2] ?? '')
  }

  // Match params['FOO'] | default(...) or params["FOO"]
  const bracketRe = /\bparams\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\](?:\s*\|\s*default\s*\(\s*([^),]+))?/g
  for (const m of gcode.matchAll(bracketRe)) {
    addParam(m[1], m[2] ?? '')
  }

  // Match params.get('FOO', 60) or params.get("FOO")
  const getRe = /\bparams\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"](?:\s*,\s*([^)]+))?\)/g
  for (const m of gcode.matchAll(getRe)) {
    addParam(m[1], m[2] ?? '')
  }

  return [...found.entries()].slice(0, 12).map(([name, defaultValue]) => ({ name, defaultValue }))
}

function formatSensorLabel(rawName) {
  const lower = String(rawName ?? '').trim().toLowerCase()
  if (Object.hasOwn(SENSOR_LABELS, lower)) return SENSOR_LABELS[lower]
  return String(rawName ?? '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
}

export function detectToolCount(raw = {}, config = undefined) {
  const cfg = config ?? raw.configfile?.settings ?? raw.configfile?.config ?? {}
  const isToolchanger = Boolean(raw.toolchanger || cfg.toolchanger)
  let maxConfigIdx = -1
  let maxRawIdx = -1
  let maxToolDefIdx = -1

  if (Array.isArray(raw.toolchanger?.tool_names) && raw.toolchanger.tool_names.length > 0) {
    maxToolDefIdx = Math.max(maxToolDefIdx, raw.toolchanger.tool_names.length - 1)
  }

  for (const key of Object.keys(cfg)) {
    const lower = key.toLowerCase()
    if (lower === 'extruder') maxConfigIdx = Math.max(maxConfigIdx, 0)
    else {
      const mTool = /^tool t([0-7])$/.exec(lower)
      if (mTool) {
        const idx = Number(mTool[1])
        maxConfigIdx = Math.max(maxConfigIdx, idx)
        maxToolDefIdx = Math.max(maxToolDefIdx, idx)
      } else {
        const mExt = /^extruder([1-7])$/.exec(lower)
        if (mExt) maxConfigIdx = Math.max(maxConfigIdx, Number(mExt[1]))
      }
    }
  }

  for (const key of Object.keys(raw)) {
    if (key === 'extruder') maxRawIdx = Math.max(maxRawIdx, 0)
    else {
      const mOther = /^(?:extruder([1-7])|tool T([0-7])|neopixel et([0-7])_leds)$/.exec(key)
      if (mOther) {
        const idx = Number(mOther[1] ?? mOther[2] ?? mOther[3])
        maxRawIdx = Math.max(maxRawIdx, idx)
      }
    }
  }

  if (isToolchanger) {
    if (maxToolDefIdx >= 0) {
      return Math.min(MAX_TOOLS, Math.max(2, maxToolDefIdx + 1, maxConfigIdx + 1))
    }
    return Math.min(MAX_TOOLS, Math.max(6, maxConfigIdx + 1, maxRawIdx + 1))
  }
  const maxFound = Math.max(maxConfigIdx, maxRawIdx)
  return maxFound >= 1 ? Math.min(MAX_TOOLS, maxFound + 1) : 1
}

export function extractBedSize(raw = {}, config = undefined) {
  const cfg = config ?? raw.configfile?.settings ?? raw.configfile?.config ?? {}
  const minX = numeric(cfg.stepper_x?.position_min) ?? finite(raw.toolhead?.axis_minimum?.[0])
  const maxX = numeric(cfg.stepper_x?.position_max) ?? finite(raw.toolhead?.axis_maximum?.[0])
  const minY = numeric(cfg.stepper_y?.position_min) ?? finite(raw.toolhead?.axis_minimum?.[1])
  const maxY = numeric(cfg.stepper_y?.position_max) ?? finite(raw.toolhead?.axis_maximum?.[1])
  if (maxX == null || maxY == null) return null

  const originX = minX != null && minX > 0 ? Math.round(minX * 10) / 10 : 0
  const originY = minY != null && minY > 0 ? Math.round(minY * 10) / 10 : 0
  const width = Math.round((maxX - originX) * 10) / 10
  const depth = Math.round((maxY - originY) * 10) / 10
  if (width < 50 || width > 1000 || depth < 50 || depth > 1000) return null
  return { originX, originY, width, depth }
}

function resolveSingleToolNeopixelKey(status) {
  if (status['neopixel et0_leds']) return 'neopixel et0_leds'
  const keys = Object.keys(status).filter(key => key.startsWith('neopixel '))
  const byLower = new Map(keys.map(key => [key.toLowerCase(), key]))
  for (const preferred of SINGLE_TOOL_NEOPIXEL_PRIORITY) {
    if (byLower.has(preferred)) return byLower.get(preferred)
  }
  for (const key of keys.sort()) {
    const data = status[key]?.color_data
    if (Array.isArray(data) && data.length >= 1 && data.length <= 8) return key
  }
  return null
}

function resolveSingleToolFilamentSensor(status) {
  const tcKey = 'filament_switch_sensor T0_filament_sensor'
  if (status[tcKey]) return { name: 'T0_filament_sensor', data: status[tcKey] }
  const candidates = Object.keys(status)
    .filter(key => key.startsWith('filament_switch_sensor ') || key.startsWith('filament_motion_sensor '))
    .sort()
  if (!candidates.length) return { name: null, data: {} }
  const first = candidates[0]
  const name = first.replace(/^filament_(?:switch|motion)_sensor\s+/, '')
  return { name, data: status[first] ?? {} }
}

export function canHomeBeforeInitialization(status) {
  const tc = status.toolchanger
  if (!tc) return false
  const count = detectToolCount(status)
  const present = Array.from({ length: count }, (_, id) => id).filter(id => status[`tool T${id}`]?.detect_state === 1)
  return (
    tc.status === 'uninitialized' &&
    tc.tool_number === -1 &&
    tc.has_detection === true &&
    present.length === 1 &&
    present[0] === tc.detected_tool_number
  )
}

export function heatState(tool) {
  if (tool.temperature == null || tool.target == null) return 'Temperatur unbekannt'
  if (tool.target === 0) return tool.temperature > 50 ? 'Heizung aus · heiß' : 'Heizung aus'
  if (tool.temperature < tool.target - 2) return tool.power > 0 ? 'Heizt auf' : 'Unter Solltemperatur'
  if (tool.temperature > tool.target + 2) return 'Über Solltemperatur'
  return 'Auf Solltemperatur'
}

export function normalizeStatus(status, at = new Date().toISOString()) {
  const config = status.configfile?.settings ?? status.configfile?.config ?? {}
  const isToolchanger = Boolean(status.toolchanger || config.toolchanger)
  const toolCount = detectToolCount(status, config)
  const tc = status.toolchanger ?? {}

  const singleToolActive = !isToolchanger && toolCount === 1 && Boolean(status.extruder || config.extruder)
  const active = isToolchanger
    ? Number.isInteger(tc.tool_number) && tc.tool_number >= 0
      ? tc.tool_number
      : null
    : singleToolActive
      ? 0
      : null
  const initial =
    isToolchanger &&
    Number.isInteger(tc.initial_tool_number) &&
    tc.initial_tool_number >= 0 &&
    tc.initial_tool_number < toolCount
      ? tc.initial_tool_number
      : null
  const referenceOffsets = initial == null ? null : status[`tool T${initial}`]?.z_offsets
  const detected = isToolchanger
    ? tc.has_detection && Number.isInteger(tc.detected_tool_number) && tc.detected_tool_number >= 0
      ? tc.detected_tool_number
      : null
    : singleToolActive
      ? 0
      : null
  const detectionConflict =
    isToolchanger &&
    Array.from({ length: toolCount }, (_, id) => status[`tool T${id}`]?.detect_state === 1).filter(Boolean).length > 1

  const sensor = name => finite(status[`temperature_sensor ${name}`]?.temperature)
  const effects = Object.entries(status)
    .filter(([name, data]) => name.startsWith('led_effect ') && data.enabled === true)
    .map(([name]) => ({ name: name.slice(11), leds: config[name.toLowerCase()]?.leds ?? config[name]?.leds ?? '' }))

  const singleToolNeoKey = !isToolchanger && toolCount === 1 ? resolveSingleToolNeopixelKey(status) : null
  const singleToolFil = !isToolchanger && toolCount === 1 ? resolveSingleToolFilamentSensor(status) : null

  const tools = Array.from({ length: toolCount }, (_, id) => {
    const extruder = status[id ? `extruder${id}` : 'extruder'] ?? {}
    const tool = status[`tool T${id}`] ?? {}
    const filamentEntry =
      !isToolchanger && toolCount === 1 && id === 0
        ? singleToolFil
        : { name: `T${id}_filament_sensor`, data: status[`filament_switch_sensor T${id}_filament_sensor`] ?? {} }
    const filament = filamentEntry.data
    const neoKey =
      !isToolchanger && toolCount === 1 && id === 0 ? singleToolNeoKey : `neopixel et${id}_leds`
    const neoShort = neoKey ? neoKey.slice(9) : null
    const led = neoKey ? status[neoKey]?.color_data : null

    return {
      id,
      relativeZ: initial == null ? null : id === initial ? 0 : finite(referenceOffsets?.[id]),
      leds: {
        number: color(led?.[0]),
        left: color(led?.[1]),
        right: color(led?.[2]),
      },
      effects: neoShort
        ? effects
            .filter(effect => new RegExp(`neopixel:${neoShort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i').test(effect.leds))
            .map(effect => effect.name)
        : [],
      temperature: finite(extruder.temperature),
      target: finite(extruder.target),
      power: finite(extruder.power),
      sensorTemperature: sensor(`T${id}`),
      active: active === id,
      detected: detected === id,
      detectState: finite(tool.detect_state),
      filamentDetected: flag(filament.filament_detected),
      filamentEnabled: flag(filament.enabled),
      filamentSensorName: filamentEntry.name,
      offsets: {
        x: finite(tool.gcode_x_offset),
        y: finite(tool.gcode_y_offset),
        z: finite(tool.gcode_z_offset),
      },
      pressureAdvance: finite(extruder.pressure_advance),
      canExtrude: flag(extruder.can_extrude),
    }
  })

  const genericFans = Object.keys(status)
    .filter(name => /^fan_generic [A-Za-z0-9_-]+$/.test(name))
    .map(object => {
      const settings = config[object.toLowerCase()] ?? {}
      const speed = finite(status[object]?.speed)
      const max = Number(settings.max_power ?? 1)
      return {
        name: object.slice(12),
        percent:
          speed == null || !Number.isFinite(max) || max <= 0
            ? null
            : Math.round(Math.max(0, Math.min(1, speed / max)) * 100),
      }
    })

  const fans = [
    ...(status.fan
      ? [
          {
            name: '__part_fan__',
            label: 'Bauteillüfter',
            kind: 'part_fan',
            percent:
              finite(status.fan.speed) == null
                ? null
                : Math.round(Math.max(0, Math.min(1, status.fan.speed)) * 100),
          },
        ]
      : []),
    ...genericFans,
  ]

  const filamentSensors = Object.entries(status)
    .filter(([key]) => key.startsWith('filament_switch_sensor ') || key.startsWith('filament_motion_sensor '))
    .map(([key, value]) => {
      const isMotion = key.startsWith('filament_motion_sensor ')
      const name = key.replace(/^filament_(?:switch|motion)_sensor\s+/, '')
      return {
        id: key,
        name,
        kind: isMotion ? 'motion' : 'switch',
        label: formatSensorLabel(name),
        enabled: flag(value?.enabled),
        detected: flag(value?.filament_detected),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind))

  const sensors = Object.entries(status)
    .filter(([key]) => (key.startsWith('temperature_sensor ') || key.startsWith('temperature_fan ')) && !/^temperature_sensor T[0-7]$/.test(key))
    .map(([key, value]) => {
      const isFan = key.startsWith('temperature_fan ')
      const name = key.slice(isFan ? 16 : 19)
      const cfg = config[key.toLowerCase()] ?? config[key] ?? {}
      return {
        id: key,
        name,
        kind: isFan ? 'temperature_fan' : 'temperature_sensor',
        label: formatSensorLabel(name),
        temperature: finite(value?.temperature),
        target: isFan ? finite(value?.target) : null,
        speed: isFan ? finite(value?.speed) : null,
        minTemp: isFan ? numeric(cfg.min_temp) : null,
        maxTemp: isFan ? numeric(cfg.max_temp) : null,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const genericHeaters = Object.entries(status)
    .filter(([key]) => /^heater_generic [A-Za-z0-9_-]+$/.test(key))
    .map(([key, value]) => {
      const name = key.slice(15)
      const cfg = config[key.toLowerCase()] ?? config[key] ?? {}
      const rawMax = numeric(cfg.max_temp)
      return {
        id: key,
        name,
        label: formatSensorLabel(name),
        temperature: finite(value?.temperature),
        target: finite(value?.target),
        power: finite(value?.power),
        maxTemp: rawMax != null ? Math.max(0, Math.round(rawMax - 5)) : null,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const outputPins = Object.entries(status)
    .filter(([key]) => /^output_pin [A-Za-z0-9_-]+$/.test(key))
    .map(([key, value]) => {
      const name = key.slice(11)
      const cfg = config[key.toLowerCase()] ?? config[key] ?? {}
      const scale = numeric(cfg.scale)
      const safeScale = scale != null && scale > 0 ? scale : 1
      const rawVal = finite(value?.value)
      return {
        id: key,
        name,
        label: formatSensorLabel(name),
        value: rawVal != null ? Math.round(rawVal * safeScale * 1000) / 1000 : null,
        pwm: cfg.pwm === true || String(cfg.pwm).toLowerCase() === 'true',
        scale: safeScale,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const auxFans = Object.entries(status)
    .filter(([key]) => /^(?:heater_fan|controller_fan) [A-Za-z0-9_-]+$/.test(key))
    .map(([key, value]) => {
      const isController = key.startsWith('controller_fan ')
      const name = key.slice(isController ? 15 : 11)
      const speed = finite(value?.speed)
      return {
        id: key,
        name,
        kind: isController ? 'controller_fan' : 'heater_fan',
        label: formatSensorLabel(name),
        percent: speed == null ? null : Math.round(Math.max(0, Math.min(1, speed)) * 100),
        rpm: finite(value?.rpm),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const publicMacros = Object.keys(config)
    .filter(key => key.toLowerCase().startsWith('gcode_macro '))
    .map(key => key.slice(12).trim())
    .filter(
      name =>
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) &&
        !/^[GMT]\d+(\.\d+)?$/i.test(name) &&
        !INTERNAL_PUBLIC_MACROS.has(name.toUpperCase()),
    )
    .map(name => {
      const macroCfg = config[`gcode_macro ${name.toLowerCase()}`] ?? {}
      return {
        name: name.toUpperCase(),
        label: formatSensorLabel(name),
        description:
          typeof macroCfg.description === 'string' && macroCfg.description.trim() !== 'G-Code macro'
            ? macroCfg.description.trim()
            : null,
        params: extractMacroParams(macroCfg.gcode),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const bedScrews =
    status.bed_screws || config.bed_screws
      ? {
          configured: Boolean(config.bed_screws || status.bed_screws),
          isActive: status.bed_screws?.is_active === true,
          state: typeof status.bed_screws?.state === 'string' ? status.bed_screws.state : null,
          currentStage: Number.isInteger(status.bed_screws?.current_stage) ? status.bed_screws.current_stage : null,
          acceptedScrews: Number.isInteger(status.bed_screws?.accepted_screws)
            ? status.bed_screws.accepted_screws
            : 0,
        }
      : null

  const saveConfigPending = status.configfile?.save_config_pending === true

  const gcodeMove = status.gcode_move ?? {}
  const speedFactor = finite(gcodeMove.speed_factor)
  const extrudeFactor = finite(gcodeMove.extrude_factor)
  const zOffset = finite(gcodeMove.homing_origin?.[2])

  const exObj = status.exclude_object
  const excludeObjects = exObj
    ? {
        available: true,
        objects: Array.isArray(exObj.objects)
          ? exObj.objects
              .filter(item => item && typeof item.name === 'string' && item.name.trim())
              .map(item => ({
                name: item.name,
                center:
                  Array.isArray(item.center) && item.center.length >= 2 && finite(item.center[0]) != null && finite(item.center[1]) != null
                    ? [item.center[0], item.center[1]]
                    : null,
              }))
          : [],
        excluded: Array.isArray(exObj.excluded_objects)
          ? exObj.excluded_objects.filter(name => typeof name === 'string')
          : [],
        current: typeof exObj.current_object === 'string' ? exObj.current_object : null,
      }
    : { available: false, objects: [], excluded: [], current: null }

  const qglApplied = status.quad_gantry_level?.applied === true
  const zTiltApplied = status.z_tilt?.applied === true

  return {
    at,
    isToolchanger,
    toolCount,
    active,
    detected,
    initialTool: initial,
    initialToolAvailable: Object.hasOwn(tc, 'initial_tool_number'),
    hasDetection: isToolchanger && tc.has_detection === true,
    toolchangerState: isToolchanger ? (tc.status ?? null) : null,
    detectionConflict,
    homingCanInitialize: isToolchanger && canHomeBeforeInitialization(status),
    detectionMismatch: isToolchanger && tc.has_detection === true && (active !== detected || detectionConflict),
    klipperState: status.webhooks?.state ?? null,
    klipperMessage: status.webhooks?.state_message ?? '',
    printState: status.print_stats?.state ?? null,
    filename: status.print_stats?.filename?.split('/').pop() || null,
    printFilename: status.print_stats?.filename || null,
    progress: finite(status.display_status?.progress),
    printDuration: finite(status.print_stats?.print_duration),
    totalDuration: finite(status.print_stats?.total_duration),
    filamentUsed: finite(status.print_stats?.filament_used),
    printLayer: finite(status.print_stats?.info?.current_layer),
    printTotalLayers: finite(status.print_stats?.info?.total_layer),
    speedPercent: speedFactor != null ? Math.round(speedFactor * 100) : null,
    flowPercent: extrudeFactor != null ? Math.round(extrudeFactor * 100) : null,
    zOffset,
    excludeObjects,
    bedSize: extractBedSize(status, config),
    bed: {
      temperature: finite(status.heater_bed?.temperature),
      target: finite(status.heater_bed?.target),
      power: finite(status.heater_bed?.power),
    },
    chamber: sensor('Chamber'),
    raspberryPi: sensor('raspberry_pi'),
    octopus: sensor('Octopus'),
    rp2350: sensor('rp2350'),
    beacon: sensor('beacon_coil'),
    sensors,
    genericHeaters,
    outputPins,
    auxFans,
    publicMacros,
    filamentSensors,
    bedScrews,
    saveConfigPending,
    homedAxes: status.toolhead?.homed_axes ?? null,
    position: status.toolhead?.position ?? null,
    axisMinimum: status.toolhead?.axis_minimum ?? null,
    axisMaximum: status.toolhead?.axis_maximum ?? null,
    qglApplied,
    zTiltApplied,
    levelingApplied: qglApplied || zTiltApplied,
    activity: Object.fromEntries(
      ['homing', 'probing', 'qgling', 'heating_nozzle', 'heating_bed', 'printing', 'paused'].map(key => [
        key,
        flag(status['gcode_macro _KNOMI_STATUS']?.[key]),
      ]),
    ),
    idleState: status.idle_timeout?.state ?? null,
    effects: effects.map(effect => effect.name),
    loadWatchTemperature: finite(status['gcode_macro LOAD_WATCH']?.temp),
    loadWatchActive: status['gcode_macro LOAD_WATCH']?.active === 1,
    fans,
    tools,
  }
}

export function toolState(tool, status) {
  if (!status) return 'Status unbekannt'
  if (status.homingCanInitialize && tool.detected) return 'Erkannt · Startbereit'
  if (status.detectionMismatch && (tool.active || tool.detected)) return 'Erkennung abweichend'
  if (tool.detected) return 'Aufgenommen'
  if (tool.active && !status.hasDetection) return 'Aktiv · unbestätigt'
  if (status.hasDetection) return 'Nicht aufgenommen'
  return 'Status unbekannt'
}
