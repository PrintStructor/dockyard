const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const flag = value => (typeof value === 'boolean' ? value : null)

const color = value =>
  Array.isArray(value) && value.length >= 3 && value.every(v => finite(v) !== null)
    ? [0, 1, 2, 3].map(i => Math.min(1, Math.max(0, value[i] ?? 0)))
    : null

export function canHomeBeforeInitialization(status) {
  const tc = status.toolchanger
  const present = Array.from({ length: 6 }, (_, id) => id).filter(id => status[`tool T${id}`]?.detect_state === 1)
  return (
    tc?.status === 'uninitialized' &&
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
  const tc = status.toolchanger ?? {}
  const active = Number.isInteger(tc.tool_number) && tc.tool_number >= 0 ? tc.tool_number : null
  const initial =
    Number.isInteger(tc.initial_tool_number) && tc.initial_tool_number >= 0 && tc.initial_tool_number < 6
      ? tc.initial_tool_number
      : null
  const referenceOffsets = initial == null ? null : status[`tool T${initial}`]?.z_offsets
  const detected =
    tc.has_detection && Number.isInteger(tc.detected_tool_number) && tc.detected_tool_number >= 0
      ? tc.detected_tool_number
      : null
  const detectionConflict =
    Array.from({ length: 6 }, (_, id) => status[`tool T${id}`]?.detect_state === 1).filter(Boolean).length > 1

  const sensor = name => finite(status[`temperature_sensor ${name}`]?.temperature)
  const config = status.configfile?.settings ?? status.configfile?.config ?? {}
  const effects = Object.entries(status)
    .filter(([name, data]) => name.startsWith('led_effect ') && data.enabled === true)
    .map(([name]) => ({ name: name.slice(11), leds: config[name]?.leds ?? '' }))

  const tools = Array.from({ length: 6 }, (_, id) => {
    const extruder = status[id ? `extruder${id}` : 'extruder'] ?? {}
    const tool = status[`tool T${id}`] ?? {}
    const filament = status[`filament_switch_sensor T${id}_filament_sensor`] ?? {}
    const led = status[`neopixel et${id}_leds`]?.color_data

    return {
      id,
      relativeZ: initial == null ? null : id === initial ? 0 : finite(referenceOffsets?.[id]),
      leds: {
        number: color(led?.[0]),
        left: color(led?.[1]),
        right: color(led?.[2]),
      },
      effects: effects
        .filter(effect => new RegExp(`neopixel:et${id}_leds(?:\\s|$)`).test(effect.leds))
        .map(effect => effect.name),
      temperature: finite(extruder.temperature),
      target: finite(extruder.target),
      power: finite(extruder.power),
      sensorTemperature: sensor(`T${id}`),
      active: active === id,
      detected: detected === id,
      detectState: finite(tool.detect_state),
      filamentDetected: flag(filament.filament_detected),
      filamentEnabled: flag(filament.enabled),
      offsets: {
        x: finite(tool.gcode_x_offset),
        y: finite(tool.gcode_y_offset),
        z: finite(tool.gcode_z_offset),
      },
      pressureAdvance: finite(extruder.pressure_advance),
      canExtrude: flag(extruder.can_extrude),
    }
  })

  const fans = Object.keys(status)
    .filter(name => /^fan_generic [A-Za-z0-9_]+$/.test(name))
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

  return {
    at,
    active,
    detected,
    initialTool: initial,
    initialToolAvailable: Object.hasOwn(tc, 'initial_tool_number'),
    hasDetection: tc.has_detection === true,
    toolchangerState: tc.status ?? null,
    detectionConflict,
    homingCanInitialize: canHomeBeforeInitialization(status),
    detectionMismatch: tc.has_detection === true && (active !== detected || detectionConflict),
    klipperState: status.webhooks?.state ?? null,
    klipperMessage: status.webhooks?.state_message ?? '',
    printState: status.print_stats?.state ?? null,
    filename: status.print_stats?.filename?.split('/').pop() || null,
    progress: finite(status.display_status?.progress),
    printDuration: finite(status.print_stats?.print_duration),
    bed: {
      temperature: finite(status.heater_bed?.temperature),
      target: finite(status.heater_bed?.target),
    },
    chamber: sensor('Chamber'),
    raspberryPi: sensor('raspberry_pi'),
    octopus: sensor('Octopus'),
    rp2350: sensor('rp2350'),
    beacon: sensor('beacon_coil'),
    homedAxes: status.toolhead?.homed_axes ?? null,
    position: status.toolhead?.position ?? null,
    axisMinimum: status.toolhead?.axis_minimum ?? null,
    axisMaximum: status.toolhead?.axis_maximum ?? null,
    qglApplied: status.quad_gantry_level?.applied === true,
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
