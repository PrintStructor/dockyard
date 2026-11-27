import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeStatus, detectToolCount, extractBedSize } from '../server/status.mjs'
import { temperatureHistory, inferExtruderCountFromStore } from '../server/temperature.mjs'
import { normalizePresets } from '../server/presets.mjs'
import { normalizeCalibrationData } from '../server/calibration.mjs'
import { capabilities, commandFor } from '../server/control.mjs'
import { auxActionReason, quickMotionReason } from '../src/aux-action-state.mjs'
import { toolActionReason } from '../src/tool-action-state.mjs'
import { createSettingsStore } from '../server/settings.mjs'
import { createPrinterRuntime } from '../server/printer.mjs'

test('normalizeStatus handles single-tool VORON 2.4 with sb_leds, QGL, part fan, and 350x350 bed', () => {
  const raw = {
    webhooks: { state: 'ready' },
    print_stats: { state: 'standby' },
    extruder: { temperature: 210.5, target: 215, power: 0.4, pressure_advance: 0.04, can_extrude: true },
    heater_bed: { temperature: 105, target: 110, power: 0.62 },
    quad_gantry_level: { applied: true },
    fan: { speed: 0.75 },
    'neopixel sb_leds': {
      color_data: [
        [0.1, 0.8, 0.2, 0],
        [1, 1, 1, 0],
        [1, 1, 1, 0],
      ],
    },
    toolhead: { homed_axes: 'xyz', position: [100, 100, 20, 0], axis_minimum: [0, 0, 0, 0], axis_maximum: [350, 350, 330, 0] },
    configfile: {
      settings: {
        extruder: { max_temp: 295, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        stepper_x: { position_min: 0, position_max: 350 },
        stepper_y: { position_min: 0, position_max: 350 },
        quad_gantry_level: {},
        fan: {},
      },
    },
  }

  const data = normalizeStatus(raw)
  assert.equal(data.isToolchanger, false)
  assert.equal(data.toolCount, 1)
  assert.equal(data.tools.length, 1)
  assert.equal(data.active, 0)
  assert.equal(data.tools[0].active, true)
  assert.equal(data.tools[0].detected, true)
  assert.equal(data.detectionMismatch, false)
  assert.equal(data.qglApplied, true)
  assert.equal(data.zTiltApplied, false)
  assert.equal(data.levelingApplied, true)
  assert.deepEqual(data.tools[0].leds.number, [0.1, 0.8, 0.2, 0])
  assert.deepEqual(data.tools[0].leds.left, [1, 1, 1, 0])
  assert.deepEqual(data.tools[0].leds.right, [1, 1, 1, 0])
  assert.deepEqual(data.fans[0], {
    name: '__part_fan__',
    label: 'Bauteillüfter',
    kind: 'part_fan',
    percent: 75,
  })
  assert.deepEqual(data.bedSize, { originX: 0, originY: 0, width: 350, depth: 350 })
  assert.equal(data.bed.power, 0.62)
})

test('normalizeStatus handles Trident with Z-tilt, negative endstop min, and filament motion sensor', () => {
  const raw = {
    webhooks: { state: 'ready' },
    extruder: { temperature: 25, target: 0, power: 0 },
    heater_bed: { temperature: 24, target: 0 },
    z_tilt: { applied: true },
    'filament_motion_sensor encoder_sensor': { enabled: true, filament_detected: true },
    configfile: {
      settings: {
        extruder: { max_temp: 300 },
        stepper_x: { position_min: -5, position_max: 300 },
        stepper_y: { position_min: 0, position_max: 300 },
        z_tilt: { retries: 5, retry_tolerance: 0.0075, horizontal_move_z: 10 },
      },
    },
  }

  const data = normalizeStatus(raw)
  assert.equal(data.isToolchanger, false)
  assert.equal(data.toolCount, 1)
  assert.equal(data.zTiltApplied, true)
  assert.equal(data.qglApplied, false)
  assert.equal(data.levelingApplied, true)
  assert.deepEqual(data.bedSize, { originX: 0, originY: 0, width: 300, depth: 300 })
  assert.equal(data.tools[0].filamentEnabled, true)
  assert.equal(data.tools[0].filamentDetected, true)
  assert.equal(data.tools[0].filamentSensorName, 'encoder_sensor')
})

test('normalizeStatus handles V0.1 with 120x120 bed, no leveling, no LEDs, and dynamic sensors', () => {
  const raw = {
    webhooks: { state: 'ready' },
    extruder: { temperature: 23, target: 0, power: 0 },
    heater_bed: { temperature: 22, target: 0 },
    'temperature_sensor skr_pico': { temperature: 41.2 },
    'temperature_sensor host': { temperature: 48.9 },
    'temperature_fan chamber_fan': { temperature: 36.4, target: 45 },
    configfile: {
      settings: {
        extruder: { max_temp: 280 },
        stepper_x: { position_min: 0, position_max: 120 },
        stepper_y: { position_min: 0, position_max: 120 },
      },
    },
  }

  const data = normalizeStatus(raw)
  assert.equal(data.isToolchanger, false)
  assert.equal(data.toolCount, 1)
  assert.equal(data.qglApplied, false)
  assert.equal(data.zTiltApplied, false)
  assert.equal(data.levelingApplied, false)
  assert.equal(data.tools[0].leds.number, null)
  assert.deepEqual(data.bedSize, { originX: 0, originY: 0, width: 120, depth: 120 })
  assert.equal(data.sensors.length, 3)
  assert.ok(data.sensors.some(s => s.name === 'skr_pico' && s.temperature === 41.2))
  assert.ok(data.sensors.some(s => s.name === 'host' && s.temperature === 48.9))
  assert.ok(data.sensors.some(s => s.name === 'chamber_fan' && s.temperature === 36.4 && s.target === 45))
})

test('detectToolCount keeps IDEX / multi-extruder without toolchanger distinct from toolchanger', () => {
  const raw = {
    extruder: { temperature: 200, target: 200 },
    extruder1: { temperature: 205, target: 205 },
    configfile: { settings: { extruder: {}, extruder1: {} } },
  }
  const data = normalizeStatus(raw)
  assert.equal(detectToolCount(raw, raw.configfile.settings), 2)
  assert.equal(data.isToolchanger, false)
  assert.equal(data.toolCount, 2)
  assert.equal(data.tools.length, 2)
})

test('temperatureHistory and normalizePresets support single-tool sizing while keeping legacy defaults', () => {
  const store = {
    extruder: { temperatures: [200, 205], targets: [210, 210] },
    heater_bed: { temperatures: [60, 62], targets: [65, 65] },
  }
  assert.equal(inferExtruderCountFromStore(store), 1)
  assert.equal(inferExtruderCountFromStore({ extruder: {}, extruder1: {}, extruder2: {}, heater_bed: {} }), 3)

  const single = temperatureHistory(store, '2026-11-26T10:00:00Z', { toolCount: 1 })
  assert.equal(single.series.length, 2)
  assert.equal(single.series[0].id, 'extruder')
  assert.equal(single.series[0].label, 'Extruder')
  assert.equal(single.series[1].id, 'heater_bed')

  const legacy = temperatureHistory(store, '2026-11-26T10:00:00Z')
  assert.equal(legacy.series.length, 7)

  const presets = normalizePresets({ toolCount: 1 })
  assert.equal(presets[0].tools.length, 1)
})

test('normalizeCalibrationData exposes isToolchanger, toolCount, and zTilt', () => {
  const cal = normalizeCalibrationData({
    rawStatus: {
      extruder: { temperature: 25 },
      z_tilt: { applied: true },
      configfile: {
        settings: {
          extruder: {},
          z_tilt: { retries: 5, retry_tolerance: 0.0075, horizontal_move_z: 10 },
          bed_mesh: { mesh_min: [20, 20], mesh_max: [280, 280] },
        },
      },
    },
  })
  assert.equal(cal.isToolchanger, false)
  assert.equal(cal.toolCount, 1)
  assert.equal(cal.tools.length, 1)
  assert.equal(cal.zTilt.configured, true)
  assert.equal(cal.zTilt.applied, true)
  assert.equal(cal.zTilt.retries, 5)
  assert.equal(cal.capabilities.zTilt, true)
  assert.equal(cal.capabilities.qgl, false)
})

test('extractBedSize falls back safely to axis_minimum/axis_maximum when stepper config absent', () => {
  const bed = extractBedSize(
    { toolhead: { axis_minimum: [-2, 0, 0, 0], axis_maximum: [150, 150, 150, 0] } },
    {},
  )
  assert.deepEqual(bed, { originX: 0, originY: 0, width: 150, depth: 150 })
  assert.equal(extractBedSize({}, {}), null)
})

function singleToolTridentRaw(overrides = {}) {
  return {
    webhooks: { state: 'ready' },
    print_stats: { state: 'standby' },
    idle_timeout: { state: 'Idle' },
    extruder: { temperature: 210, target: 210, power: 0.3, can_extrude: true },
    heater_bed: { temperature: 60, target: 60 },
    z_tilt: { applied: false },
    fan: { speed: 0.5 },
    toolhead: { homed_axes: 'xyz', position: [150, 150, 20, 0], axis_minimum: [0, 0, 0, 0], axis_maximum: [300, 300, 250, 0] },
    configfile: {
      settings: {
        extruder: { max_temp: 300, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        stepper_x: { position_min: 0, position_max: 300 },
        stepper_y: { position_min: 0, position_max: 300 },
        z_tilt: { retries: 5 },
        bed_mesh: {},
        fan: {},
        'gcode_macro pause': {},
        'gcode_macro resume': {},
        'gcode_macro load_filament': {},
        'gcode_macro unload_filament': {},
        'gcode_macro clean_nozzle': {},
        'gcode_macro purge_nozzle': {},
      },
    },
    ...overrides,
  }
}

test('commandFor supports z_tilt, standard [fan] M106, single-tool temperature, and rejects temperature_all', () => {
  const raw = singleToolTridentRaw()
  const caps = capabilities(raw)
  assert.equal(caps.isToolchanger, false)
  assert.equal(caps.toolCount, 1)
  assert.equal(caps.zTilt, true)
  assert.equal(caps.qgl, false)
  assert.equal(caps.leveling, 'z_tilt')
  assert.deepEqual(caps.bedSize, { originX: 0, originY: 0, width: 300, depth: 300 })
  assert.ok(caps.fans.some(f => f.name === '__part_fan__' && f.kind === 'part_fan'))

  const zTiltCmd = commandFor({ action: 'z_tilt' }, raw)
  assert.equal(zTiltCmd.body.script, 'Z_TILT_ADJUST')
  assert.equal(zTiltCmd.async, true)

  const unhomedRaw = singleToolTridentRaw({ toolhead: { homed_axes: 'xy', position: [100, 100, 10, 0] } })
  assert.throws(() => commandFor({ action: 'z_tilt' }, unhomedRaw), /homen/i)

  const v0Raw = singleToolTridentRaw({
    z_tilt: undefined,
    configfile: { settings: { extruder: { max_temp: 280 }, heater_bed: { max_temp: 120 } } },
  })
  assert.throws(() => commandFor({ action: 'z_tilt' }, v0Raw), /konfiguriert/i)

  const statusObj = { ...normalizeStatus(raw), capabilities: caps }
  assert.equal(quickMotionReason(statusObj, 'z_tilt', true, false), '')
  assert.match(quickMotionReason({ ...normalizeStatus(v0Raw), capabilities: capabilities(v0Raw) }, 'z_tilt', true, false), /konfiguriert/i)

  // Standard Klipper [fan] M106 control
  assert.equal(commandFor({ action: 'fan', fan: '__part_fan__', percent: 50 }, raw).body.script, 'M106 S128')
  assert.equal(commandFor({ action: 'fan', fan: '__part_fan__', percent: 0 }, raw).body.script, 'M106 S0')
  assert.equal(commandFor({ action: 'fan', fan: '__part_fan__', percent: 100 }, raw).body.script, 'M106 S255')

  // Single-tool temperature label & temperature_all rejection
  const heatCmd = commandFor({ action: 'temperature', heater: 'extruder', target: 210 }, raw)
  assert.equal(heatCmd.label, 'Extruder auf 210 °C')
  assert.throws(() => commandFor({ action: 'temperature_all', target: 140 }, raw), /mehreren Werkzeugen/i)
})

test('single-tool RESUME works without toolchangerState and single-tool macros omit T=0 and PICKUP_TOOL', () => {
  const pausedRaw = singleToolTridentRaw({ print_stats: { state: 'paused' } })
  const pausedStatus = { ...normalizeStatus(pausedRaw), capabilities: capabilities(pausedRaw) }
  assert.equal(auxActionReason(pausedStatus, 'resume', true, false), '')
  assert.equal(commandFor({ action: 'resume' }, pausedRaw).body.script, 'RESUME')

  // Toolchanger RESUME must STILL reject when detected is null
  const tcPausedRaw = {
    webhooks: { state: 'ready' },
    print_stats: { state: 'paused' },
    idle_timeout: { state: 'Idle' },
    toolhead: { homed_axes: 'xyz' },
    toolchanger: { status: 'ready', has_detection: true, tool_number: 0, detected_tool_number: -1 },
    configfile: { settings: { toolchanger: {}, 'gcode_macro resume': {} } },
  }
  const tcStatus = { ...normalizeStatus(tcPausedRaw), capabilities: capabilities(tcPausedRaw) }
  assert.match(auxActionReason(tcStatus, 'resume', true, false), /Toolchanger/i)

  // Single-tool maintenance macros run directly without T=0 or PICKUP_TOOL
  const idleRaw = singleToolTridentRaw()
  const idleStatus = { ...normalizeStatus(idleRaw), capabilities: capabilities(idleRaw) }
  assert.equal(toolActionReason(idleStatus, 'load', 0, true, false), '')
  assert.equal(toolActionReason(idleStatus, 'unload', 0, true, false), '')
  assert.equal(toolActionReason(idleStatus, 'clean', 0, true, false), '')
  assert.equal(toolActionReason(idleStatus, 'purge', 0, true, false), '')
  assert.equal(commandFor({ action: 'load', tool: 0 }, idleRaw).body.script, 'LOAD_FILAMENT\nM400')
  assert.equal(commandFor({ action: 'unload', tool: 0 }, idleRaw).body.script, 'UNLOAD_FILAMENT\nM400')
  assert.equal(commandFor({ action: 'clean', tool: 0 }, idleRaw).body.script, 'CLEAN_NOZZLE\nM400')
  assert.equal(commandFor({ action: 'purge', tool: 0 }, idleRaw).body.script, 'PURGE_NOZZLE\nM400')

  // Toolchanger-only actions rejected on single-tool
  assert.throws(() => commandFor({ action: 'park', tool: 0 }, idleRaw))
  assert.throws(() => commandFor({ action: 'pickup', tool: 0 }, idleRaw))
  assert.throws(() => commandFor({ action: 'select', tool: 0 }, idleRaw))
})

test('GET /api/temperature-history infers single-tool count on cold start before /api/status', async () => {
  const mockMoonraker = http.createServer((req, res) => {
    if (req.url === '/server/temperature_store') {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          result: {
            extruder: { temperatures: [210, 212], targets: [215, 215] },
            heater_bed: { temperatures: [60, 61], targets: [60, 60] },
          },
        }),
      )
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise(resolve => mockMoonraker.listen(0, '127.0.0.1', resolve))
  const mockUrl = `http://127.0.0.1:${mockMoonraker.address().port}`
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-single-temp-'))
  const store = createSettingsStore({
    filePath: path.join(dir, '.dockyard-settings.json'),
    env: { PRINTER_URL: mockUrl, PRINTER_NAME: 'V01' },
  })
  const { printerMiddleware, closeLiveFeed } = createPrinterRuntime({ store })
  const server = http.createServer((req, res) => printerMiddleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/temperature-history`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.series.length, 2)
    assert.equal(body.series[0].id, 'extruder')
    assert.equal(body.series[0].label, 'Extruder')
    assert.equal(body.series[1].id, 'heater_bed')
  } finally {
    closeLiveFeed()
    await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => mockMoonraker.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('1-arg detectToolCount(raw) and extractBedSize(raw) fall back to raw.configfile.settings', () => {
  const rawTrident = {
    configfile: {
      settings: {
        extruder: { max_temp: 300 },
        stepper_x: { position_min: -5, position_max: 300 },
        stepper_y: { position_min: 0, position_max: 300 },
      },
    },
  }
  assert.deepEqual(extractBedSize(rawTrident), { originX: 0, originY: 0, width: 300, depth: 300 })

  const raw4Tool = {
    toolchanger: { status: 'ready' },
    configfile: {
      settings: {
        toolchanger: {},
        'tool t0': {},
        'tool t1': {},
        'tool t2': {},
        'tool t3': {},
      },
    },
  }
  assert.equal(detectToolCount(raw4Tool), 4)
})

test('normalizeStatus matches mixed-case led_effect keys and hyphenated single-tool neopixels', () => {
  const raw = {
    extruder: { temperature: 210, target: 210 },
    'neopixel sb-leds': {
      color_data: [
        [0.5, 1, 0.2, 0],
        [1, 1, 1, 0],
        [1, 1, 1, 0],
      ],
    },
    'led_effect SB_Idle': { enabled: true },
    configfile: {
      settings: {
        extruder: { max_temp: 300 },
        'led_effect sb_idle': { leds: 'neopixel:sb-leds' },
      },
    },
  }
  const data = normalizeStatus(raw)
  assert.deepEqual(data.tools[0].leds.number, [0.5, 1, 0.2, 0])
  assert.deepEqual(data.tools[0].effects, ['SB_Idle'])
})

test('calibration scales matrices and tool index bounds dynamically for 4-tool and 8-tool toolchangers', () => {
  const makeTc = count => {
    const settings = {
      toolchanger: {},
      'gcode_macro beacon_calibrate_z': {},
      'gcode_macro beacon_calibrate_nozzle_temp_offset': {},
    }
    const raw = {
      webhooks: { state: 'ready' },
      print_stats: { state: 'standby' },
      idle_timeout: { state: 'Idle' },
      toolhead: { homed_axes: 'xyz' },
      toolchanger: { status: 'ready', tool_names: Array.from({ length: count }, (_, i) => `tool T${i}`) },
      configfile: { settings },
    }
    for (let i = 0; i < count; i++) {
      settings[i ? `extruder${i}` : 'extruder'] = { max_temp: 300 }
      settings[`tool t${i}`] = {}
    }
    return raw
  }

  const tc8 = makeTc(8)
  const cal8 = normalizeCalibrationData({ rawStatus: tc8 })
  assert.equal(cal8.toolCount, 8)
  assert.equal(cal8.nudgeXy.length, 8)
  assert.equal(cal8.nudgeXy[0].length, 8)
  assert.equal(cal8.beaconZ.length, 8)
  assert.equal(commandFor({ action: 'calibrate_beacon_z', tool: 7 }, tc8).body.script, 'BEACON_CALIBRATE_Z INITIAL_TOOL=7')
  assert.throws(() => commandFor({ action: 'calibrate_beacon_z', tool: 8 }, tc8), err => err.status === 400)

  const tc4 = makeTc(4)
  const cal4 = normalizeCalibrationData({ rawStatus: tc4 })
  assert.equal(cal4.toolCount, 4)
  assert.equal(cal4.nudgeXy.length, 4)
  assert.throws(() => commandFor({ action: 'calibrate_beacon_z', tool: 4 }, tc4), err => err.status === 400)
})

test('GET /api/presets infers single-tool count on cold start before /api/status', async () => {
  const mockMoonraker = http.createServer((req, res) => {
    if (req.url?.startsWith('/server/database/item?namespace=mainsail')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          result: {
            value: {
              '0': { name: 'PLA', values: { heater_bed: { value: 60 }, extruder: { value: 210 } } },
            },
          },
        }),
      )
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise(resolve => mockMoonraker.listen(0, '127.0.0.1', resolve))
  const mockUrl = `http://127.0.0.1:${mockMoonraker.address().port}`
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-single-presets-'))
  const store = createSettingsStore({
    filePath: path.join(dir, '.dockyard-settings.json'),
    env: { PRINTER_URL: mockUrl, PRINTER_NAME: 'V01' },
  })
  const { printerMiddleware, closeLiveFeed } = createPrinterRuntime({ store })
  const server = http.createServer((req, res) => printerMiddleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/presets`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.presets[0].tools.length, 1)
  } finally {
    closeLiveFeed()
    await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => mockMoonraker.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('Paket A single-tool fixes: M84 motors_off, atomic preheat, pause filament unlock, perToolZAdjust gating, native pause_resume, and hyphenated fans', () => {
  const raw = singleToolTridentRaw({
    'fan_generic nevermore-micro': { speed: 0.8 },
    'fan_generic fan0': { speed: 0.4 },
    'fan_generic fan3': { speed: 0.2 },
    configfile: {
      settings: {
        extruder: { max_temp: 300, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        pause_resume: {},
        'gcode_macro set_gcode_offset': { gcode: 'SET_GCODE_OFFSET_BASE' },
        'gcode_macro load_filament': {},
        'gcode_macro unload_filament': {},
        'gcode_macro purge_nozzle': {},
        'gcode_macro clean_nozzle': {},
        'fan_generic nevermore-micro': { max_power: 1 },
        'fan_generic fan0': { max_power: 1 },
        'fan_generic fan3': { max_power: 1 },
      },
    },
  })

  // 1. motors_off emits standard Klipper M84 when DISABLE_MOTORS macro is absent
  assert.equal(commandFor({ action: 'motors_off' }, raw).body.script, 'M84')
  const withMacro = singleToolTridentRaw()
  withMacro.configfile.settings['gcode_macro disable_motors'] = {}
  assert.equal(commandFor({ action: 'motors_off' }, withMacro).body.script, 'DISABLE_MOTORS')

  // 2. Atomic combined preheat
  const pre = commandFor({ action: 'preheat', extruder: 255, bed: 110 }, raw)
  assert.equal(
    pre.body.script,
    'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=255\nSET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=110',
  )
  assert.equal(pre.label, 'Vorheizen · Extruder 255 °C · Bett 110 °C')
  assert.throws(() => commandFor({ action: 'preheat' }, raw))
  assert.throws(() => commandFor({ action: 'preheat', extruder: 300 }, raw))

  // 3. Pause mode unlocks single-tool load/unload/purge (M600 recovery) while keeping clean locked
  const paused = { ...raw, print_stats: { state: 'paused' } }
  assert.equal(commandFor({ action: 'load', tool: 0 }, paused).body.script, 'LOAD_FILAMENT\nM400')
  assert.equal(commandFor({ action: 'unload', tool: 0 }, paused).body.script, 'UNLOAD_FILAMENT\nM400')
  assert.equal(commandFor({ action: 'purge', tool: 0 }, paused).body.script, 'PURGE_NOZZLE\nM400')
  assert.throws(() => commandFor({ action: 'clean', tool: 0 }, paused), /gesperrt/)

  // 4. Native [pause_resume] enables pause/resume without custom PAUSE/RESUME macros
  const caps = capabilities(raw)
  assert.equal(caps.pause, true)
  assert.equal(caps.resume, true)

  // 5. perToolZAdjust stays false on 1-tool even with SET_GCODE_OFFSET macro wrapper -> Z reset works
  assert.equal(caps.perToolZAdjust, false)
  assert.equal(commandFor({ action: 'tune_z_offset', reset: true }, paused).body.script, 'SET_GCODE_OFFSET Z=0 MOVE=1')

  // 6. Single-tool fan labels preserve fan0/fan3 and allow hyphenated fan_generic names
  assert.ok(caps.fans.some(f => f.name === 'nevermore-micro' && f.label === 'nevermore-micro'))
  assert.ok(caps.fans.some(f => f.name === 'fan0' && f.label === 'fan0'))
  assert.ok(caps.fans.some(f => f.name === 'fan3' && f.label === 'fan3'))
  assert.equal(
    commandFor({ action: 'fan', fan: 'nevermore-micro', percent: 75 }, raw).body.script,
    'SET_FAN_SPEED FAN=nevermore-micro SPEED=0.75',
  )
})

test('Paket B1: manual extrude/retract with canExtrude guard, pause support, and multi-sensor filament toggles (BTT SFS v2)', () => {
  const raw = singleToolTridentRaw({
    'filament_switch_sensor sfs_switch': { enabled: true, filament_detected: true },
    'filament_motion_sensor sfs_encoder': { enabled: true, filament_detected: false },
  })

  // Multi-sensor array exposes BOTH switch and motion sensors independently
  const status = normalizeStatus(raw)
  assert.equal(status.filamentSensors.length, 2)
  assert.ok(status.filamentSensors.some(s => s.name === 'sfs_switch' && s.kind === 'switch' && s.detected === true))
  assert.ok(status.filamentSensors.some(s => s.name === 'sfs_encoder' && s.kind === 'motion' && s.detected === false))

  // Filament sensor toggle works even while actively printing
  const printing = { ...raw, print_stats: { state: 'printing' } }
  const toggleOff = commandFor({ action: 'filament_sensor', sensor: 'sfs_encoder', enabled: false }, printing)
  assert.equal(toggleOff.body.script, 'SET_FILAMENT_SENSOR SENSOR=sfs_encoder ENABLE=0')
  assert.throws(() => commandFor({ action: 'filament_sensor', sensor: 'unknown_sensor', enabled: false }, printing), /konfiguriert/)
  assert.throws(() => commandFor({ action: 'filament_sensor', sensor: 'sfs_encoder\nG28', enabled: false }, printing))

  // Manual extrude & retract work in standby AND paused, reject cold extruder and active printing
  const extrudeCmd = commandFor({ action: 'extrude', distance: 25, speed: 5 }, raw)
  assert.match(extrudeCmd.body.script, /SAVE_GCODE_STATE NAME=DOCKYARD_UI_EXTRUDE\nM83\nG1 E25 F300\nM400\nRESTORE_GCODE_STATE NAME=DOCKYARD_UI_EXTRUDE MOVE=0/)
  assert.equal(extrudeCmd.async, true)

  const paused = { ...raw, print_stats: { state: 'paused' } }
  const retractCmd = commandFor({ action: 'extrude', distance: -10, speed: 10 }, paused)
  assert.match(retractCmd.body.script, /G1 E-10 F600/)

  assert.throws(() => commandFor({ action: 'extrude', distance: 10, speed: 5 }, printing), /laufenden Drucks/)
  const cold = { ...raw, extruder: { ...raw.extruder, can_extrude: false } }
  assert.throws(() => commandFor({ action: 'extrude', distance: 10, speed: 5 }, cold), /zu kalt/)
  assert.throws(() => commandFor({ action: 'extrude', distance: 200, speed: 5 }, raw), /150 mm/)
  assert.throws(() => commandFor({ action: 'extrude', distance: 10, speed: 50 }, raw), /30 mm\/s/)
})

test('Paket B1 HTTP: G-code upload, delete (active print guard), subfolders, fileExists, and job queue', async () => {
  const gcodeFiles = [
    { path: 'VORON/benchy.gcode', size: 102400, modified: 2000 },
    { path: 'active_part.gcode', size: 204800, modified: 3000 },
  ]
  const queued = [{ job_id: 'q1', filename: 'VORON/benchy.gcode', time_added: 1000, time_in_queue: 12 }]
  let queueState = 'ready'
  let uploadedFilename = ''
  let deletedPath = ''

  const mockMoonraker = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('Content-Type', 'application/json')
    if (u.pathname === '/server/files/list') {
      return res.end(JSON.stringify({ result: gcodeFiles }))
    }
    if (u.pathname === '/server/history/list') {
      return res.end(
        JSON.stringify({
          result: {
            jobs: [
              { job_id: 'h1', filename: 'VORON/benchy.gcode', status: 'completed', print_duration: 600 },
              { job_id: 'h2', filename: 'deleted_old.gcode', status: 'completed', print_duration: 300 },
            ],
          },
        }),
      )
    }
    if (u.pathname === '/server/files/upload' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const text = Buffer.concat(chunks).toString('utf8')
      const m = /filename="([^"]+)"/.exec(text)
      uploadedFilename = m?.[1] ?? 'uploaded.gcode'
      gcodeFiles.push({ path: `VORON/${uploadedFilename}`, size: 120, modified: 4000 })
      return res.end(JSON.stringify({ item: { path: `VORON/${uploadedFilename}` } }))
    }
    if (u.pathname === '/printer/objects/list') {
      return res.end(JSON.stringify({ result: { objects: ['webhooks', 'print_stats'] } }))
    }
    if (u.pathname === '/printer/objects/query') {
      return res.end(
        JSON.stringify({
          result: {
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'printing', filename: 'active_part.gcode' },
            },
          },
        }),
      )
    }
    if (u.pathname.startsWith('/server/files/gcodes/') && req.method === 'DELETE') {
      deletedPath = decodeURIComponent(u.pathname.slice('/server/files/gcodes/'.length))
      return res.end(JSON.stringify({ result: { item: { path: deletedPath } } }))
    }
    if (u.pathname === '/server/job_queue/status') {
      return res.end(JSON.stringify({ result: { queue_state: queueState, queued_jobs: queued } }))
    }
    if (u.pathname === '/server/job_queue/job' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      queued.push({ job_id: 'q2', filename: body.filenames[0], time_added: 2000, time_in_queue: 0 })
      return res.end(JSON.stringify({ result: { queue_state: queueState, queued_jobs: queued } }))
    }
    if (u.pathname === '/server/job_queue/pause' && req.method === 'POST') {
      queueState = 'paused'
      return res.end(JSON.stringify({ result: { queue_state: queueState, queued_jobs: queued } }))
    }
    res.statusCode = 404
    res.end('{}')
  })

  await new Promise(resolve => mockMoonraker.listen(0, '127.0.0.1', resolve))
  const mockUrl = `http://127.0.0.1:${mockMoonraker.address().port}`
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-b1-print-'))
  const store = createSettingsStore({
    filePath: path.join(dir, '.dockyard-settings.json'),
    env: { PRINTER_URL: mockUrl, PRINTER_NAME: 'Crucible' },
  })
  const { printerMiddleware, closeLiveFeed } = createPrinterRuntime({ store })
  const server = http.createServer((req, res) => printerMiddleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    // Files list includes dir + recentJobs.fileExists
    const listRes = await (await fetch(`${base}/api/print/files`)).json()
    assert.equal(listRes.files.find(f => f.path === 'VORON/benchy.gcode').dir, 'VORON')
    assert.equal(listRes.recentJobs.find(j => j.filename === 'VORON/benchy.gcode').fileExists, true)
    assert.equal(listRes.recentJobs.find(j => j.filename === 'deleted_old.gcode').fileExists, false)

    // Upload .gcode into subfolder
    const upRes = await fetch(`${base}/api/print/upload`, {
      method: 'POST',
      headers: {
        Origin: base,
        'X-Cockpit-Request': '1',
        'Content-Type': 'application/octet-stream',
        'X-Gcode-Filename': encodeURIComponent('cube.gcode'),
        'X-Gcode-Path': encodeURIComponent('VORON'),
      },
      body: Buffer.from('; test gcode\nG28\n'),
    })
    assert.equal(upRes.status, 200)
    const upBody = await upRes.json()
    assert.equal(uploadedFilename, 'cube.gcode')
    assert.equal(upBody.path, 'VORON/cube.gcode')

    // Reject deleting currently active print file (409)
    const blockedDel = await fetch(`${base}/api/print/file?filename=active_part.gcode`, {
      method: 'DELETE',
      headers: { Origin: base, 'X-Cockpit-Request': '1' },
    })
    assert.equal(blockedDel.status, 409)

    // Allow deleting inactive file
    const okDel = await fetch(`${base}/api/print/file?filename=${encodeURIComponent('VORON/benchy.gcode')}`, {
      method: 'DELETE',
      headers: { Origin: base, 'X-Cockpit-Request': '1' },
    })
    assert.equal(okDel.status, 200)
    assert.equal(deletedPath, 'VORON/benchy.gcode')

    // Job queue GET + POST add + POST pause
    const qGet = await (await fetch(`${base}/api/print/queue`)).json()
    assert.equal(qGet.available, true)
    assert.equal(qGet.jobs.length, 1)

    const qAdd = await (
      await fetch(`${base}/api/print/queue`, {
        method: 'POST',
        headers: { Origin: base, 'X-Cockpit-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', filename: 'VORON/cube.gcode' }),
      })
    ).json()
    assert.equal(qAdd.jobs.length, 2)

    const qPause = await (
      await fetch(`${base}/api/print/queue`, {
        method: 'POST',
        headers: { Origin: base, 'X-Cockpit-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
      })
    ).json()
    assert.equal(qPause.queueState, 'paused')
  } finally {
    closeLiveFeed()
    await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => mockMoonraker.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

test('Paket B2: save_z_offset, SAVE_CONFIG, generic heaters, temperature_fan, output_pin, auxFans, and public macros', () => {
  const raw = singleToolTridentRaw({
    gcode_move: { speed_factor: 1, extrude_factor: 1, homing_origin: [0, 0, -0.045, 0] },
    'heater_generic chamber_heater': { temperature: 45, target: 50, power: 0.4 },
    'temperature_fan exhaust': { temperature: 42, target: 50, speed: 0.3 },
    'output_pin caselight': { value: 0.5 },
    'output_pin nevermore_relay': { value: 1 },
    'heater_fan hotend_fan': { speed: 1, rpm: 6400 },
    'controller_fan electronics': { speed: 0.5 },
    configfile: {
      save_config_pending: true,
      settings: {
        extruder: { max_temp: 300, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        stepper_z: {},
        probe: {},
        'heater_generic chamber_heater': { max_temp: 80 },
        'temperature_fan exhaust': { min_temp: 0, max_temp: 75 },
        'output_pin caselight': { pwm: true, scale: 1 },
        'output_pin nevermore_relay': { pwm: false, scale: 1 },
        'gcode_macro heatsoak': { description: 'Heat chamber' },
        'gcode_macro _internal_helper': {},
        'gcode_macro pause': {},
      },
    },
  })

  const status = normalizeStatus(raw)
  assert.equal(status.saveConfigPending, true)
  assert.equal(status.genericHeaters.length, 1)
  assert.equal(status.genericHeaters[0].maxTemp, 75)
  assert.equal(status.outputPins.length, 2)
  assert.equal(status.auxFans.length, 2)
  assert.equal(status.auxFans.find(f => f.name === 'hotend_fan').rpm, 6400)
  assert.deepEqual(
    status.publicMacros.map(m => m.name),
    ['HEATSOAK'],
  )

  // Z-Offset Apply routes to Probe when [probe] exists, Endstop otherwise
  assert.equal(commandFor({ action: 'save_z_offset' }, raw).body.script, 'Z_OFFSET_APPLY_PROBE')
  const endstopOnly = structuredClone(raw)
  delete endstopOnly.configfile.settings.probe
  assert.equal(commandFor({ action: 'save_z_offset' }, endstopOnly).body.script, 'Z_OFFSET_APPLY_ENDSTOP')

  // SAVE_CONFIG restarts Klipper and blocks during active print
  const saveCmd = commandFor({ action: 'save_config' }, raw)
  assert.equal(saveCmd.body.script, 'SAVE_CONFIG')
  assert.equal(saveCmd.restartsKlipper, true)
  assert.throws(
    () => commandFor({ action: 'save_config' }, { ...raw, print_stats: { state: 'printing' } }),
    err => err.status === 409,
  )

  // Generic heater (Klipper short name!), temperature_fan, output_pin, and whitelisted macro execution
  assert.equal(
    commandFor({ action: 'temperature', heater: 'heater_generic chamber_heater', target: 55 }, raw).body.script,
    'SET_HEATER_TEMPERATURE HEATER=chamber_heater TARGET=55',
  )
  assert.throws(
    () => commandFor({ action: 'temperature', heater: 'heater_generic chamber_heater', target: 79 }, raw),
    err => err.status === 400,
  )
  assert.equal(
    commandFor({ action: 'temperature_fan', fan: 'exhaust', target: 55 }, raw).body.script,
    'SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=exhaust TARGET=55',
  )
  assert.equal(
    commandFor({ action: 'output_pin', pin: 'caselight', value: 0.75 }, raw).body.script,
    'SET_PIN PIN=caselight VALUE=0.75',
  )
  assert.throws(
    () => commandFor({ action: 'output_pin', pin: 'nevermore_relay', value: 0.5 }, raw),
    err => err.status === 400,
  )
  assert.equal(commandFor({ action: 'macro', name: 'HEATSOAK' }, raw).body.script, 'HEATSOAK')
  assert.throws(() => commandFor({ action: 'macro', name: '_internal_helper' }, raw), err => err.status === 400)
  assert.throws(() => commandFor({ action: 'macro', name: 'UNKNOWN_MACRO' }, raw), err => err.status === 409)
})

test('Paket C1: macro parameter parsing & safe execution + WCAG-safe per-printer UI accent theme', async () => {
  const { extractMacroParams } = await import('../server/status.mjs')
  const { computePrinterTheme, contrastRatio } = await import('../src/theme-accent.mjs')

  const gcode = `
    {% set temp = params.TEMP|default(60)|float %}
    {% set dur = params['DURATION']|default(15)|int %}
    {% set fan = params.get("FAN_SPEED", 0.8) %}
    M140 S{temp}
  `
  assert.deepEqual(extractMacroParams(gcode), [
    { name: 'TEMP', defaultValue: '60' },
    { name: 'DURATION', defaultValue: '15' },
    { name: 'FAN_SPEED', defaultValue: '0.8' },
  ])

  const raw = singleToolTridentRaw({
    configfile: {
      settings: {
        extruder: { max_temp: 300 },
        heater_bed: { max_temp: 120 },
        'gcode_macro heatsoak': { description: 'Bauraum aufheizen', gcode },
      },
    },
  })
  const status = normalizeStatus(raw)
  assert.equal(status.publicMacros[0].params.length, 3)

  const cmd = commandFor({ action: 'macro', name: 'HEATSOAK', params: { TEMP: 55, DURATION: 20, FAN_SPEED: '' } }, raw)
  assert.equal(cmd.body.script, 'HEATSOAK TEMP=55 DURATION=20')
  assert.throws(
    () => commandFor({ action: 'macro', name: 'HEATSOAK', params: { TEMP: '55\nG28' } }, raw),
    err => err.status === 400,
  )
  assert.throws(
    () => commandFor({ action: 'macro', name: 'HEATSOAK', params: { TEMP: '55 G28' } }, raw),
    err => err.status === 400,
  )

  // Every printer accent swatch produces >= 5.2:1 contrast against dark #192125 surface
  const surface = [25, 33, 37]
  const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  for (const hex of ['#c5f76b', '#d62828', '#38d9c0', '#3b82f6', '#f3c67b', '#9b5de5', '#dce6e2', '#495860']) {
    const theme = computePrinterTheme(hex)
    const ratio = contrastRatio(hexToRgb(theme.accent), surface)
    assert.ok(ratio >= 5.1, `expected ${hex} -> ${theme.accent} to have >= 5.1:1 contrast, got ${ratio.toFixed(2)}`)
  }
  // Acid Lime stays exact signature color
  assert.equal(computePrinterTheme('#c5f76b').accent, '#c5f76b')
})

test('Paket C2: live PA/velocity/retraction tuning, RGBW set_led, presets mutation, and status fields', async () => {
  const { applyMainsailPresetMutation, normalizePresets } = await import('../server/presets.mjs')

  const raw = singleToolTridentRaw({
    print_stats: { state: 'printing', filename: 'benchy.gcode', print_duration: 120 },
    toolhead: {
      homed_axes: 'xyz',
      position: [60, 60, 10, 0],
      max_velocity: 300,
      max_accel: 4000,
      minimum_cruise_ratio: 0.5,
      square_corner_velocity: 5,
    },
    extruder: {
      temperature: 215,
      target: 215,
      power: 0.4,
      can_extrude: true,
      pressure_advance: 0.042,
      smooth_time: 0.04,
    },
    firmware_retraction: {
      retract_length: 0.6,
      retract_speed: 35,
      unretract_extra_length: 0,
      unretract_speed: 35,
    },
    manual_probe: { is_active: true, z_position: 0.15, z_position_lower: 0.1, z_position_upper: 0.2 },
    'neopixel chamber_leds': { color_data: [[0.5, 0.25, 0.1, 0.8]] },
    configfile: {
      save_config_pending: false,
      warnings: [{ message: 'Deprecated option in [stepper_z]' }],
      settings: {
        printer: { max_velocity: 500, max_accel: 10000 },
        extruder: { max_temp: 300 },
        heater_bed: { max_temp: 120 },
        firmware_retraction: { retract_length: 0.5 },
        'neopixel chamber_leds': { color_order: 'GRBW' },
      },
    },
  })

  const status = normalizeStatus(raw)
  assert.equal(status.tools[0].pressureAdvanceSmoothTime, 0.04)
  assert.equal(status.motionLimits.maxVelocity, 300)
  assert.equal(status.motionLimits.maxAccel, 4000)
  assert.equal(status.firmwareRetraction.retractLength, 0.6)
  assert.equal(status.manualProbe.isActive, true)
  assert.deepEqual(status.configWarnings, ['Deprecated option in [stepper_z]'])
  assert.equal(status.neopixels.length, 1)
  assert.equal(status.neopixels[0].name, 'chamber_leds')
  assert.equal(status.neopixels[0].hasWhite, true)

  // Live print tuning commands
  assert.equal(
    commandFor({ action: 'tune_pressure_advance', advance: 0.055, smoothTime: 0.03 }, raw).body.script,
    'SET_PRESSURE_ADVANCE ADVANCE=0.055 SMOOTH_TIME=0.03',
  )
  assert.equal(
    commandFor(
      { action: 'tune_velocity_limits', velocity: 250, accel: 3500, minCruiseRatio: 0.4, squareCornerVelocity: 6 },
      raw,
    ).body.script,
    'SET_VELOCITY_LIMIT VELOCITY=250 ACCEL=3500 MINIMUM_CRUISE_RATIO=0.4 SQUARE_CORNER_VELOCITY=6',
  )
  assert.equal(
    commandFor(
      { action: 'tune_retraction', retractLength: 0.8, retractSpeed: 40, unretractExtraLength: 0.1, unretractSpeed: 30 },
      raw,
    ).body.script,
    'SET_RETRACTION RETRACT_LENGTH=0.8 RETRACT_SPEED=40 UNRETRACT_EXTRA_LENGTH=0.1 UNRETRACT_SPEED=30',
  )
  assert.throws(() => commandFor({ action: 'tune_velocity_limits', accel: 99999 }, raw), err => err.status === 400)

  // Direct RGBW LED command
  const ledCmd = commandFor(
    { action: 'set_led', led: 'chamber_leds', red: 1, green: 0.5, blue: 0, white: 0.25 },
    raw,
  )
  assert.equal(ledCmd.body.script, 'SET_LED LED=chamber_leds RED=1 GREEN=0.5 BLUE=0 WHITE=0.25 SYNC=0 TRANSMIT=1')
  assert.throws(() => commandFor({ action: 'set_led', led: 'unknown_led', red: 1 }, raw), err => err.status === 409)

  // Mainsail preset DB upsert + delete
  const db1 = applyMainsailPresetMutation({}, { action: 'upsert', name: 'ASA', extruder: 255, bed: 105 })
  const list1 = normalizePresets({ mainsail: db1, toolCount: 1 })
  assert.ok(list1.some(p => p.name === 'ASA' && p.bed === 105 && p.tools[0] === 255))
  const db2 = applyMainsailPresetMutation(db1, { action: 'delete', name: 'ASA' })
  const list2 = normalizePresets({ mainsail: db2, toolCount: 1 })
  assert.ok(!list2.some(p => p.name === 'ASA'))
})

test('Paket C2 HTTP: endstops, gcode dir metadata/mkdir/move, presets POST, config create & protected delete', async () => {
  const gcodeFiles = [{ path: 'benchy.gcode', size: 102400, modified: 2000 }]
  const configFiles = [
    { path: 'printer.cfg', size: 512, modified: 1000, permissions: 'rw' },
    { path: 'custom.cfg', size: 64, modified: 1000, permissions: 'rw' },
  ]
  let presetsDb = {}
  const calls = []

  const mockMoonraker = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('Content-Type', 'application/json')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    if (u.pathname === '/printer/query_endstops/status') {
      return res.end(JSON.stringify({ result: { x: 'open', y: 'TRIGGERED', z: 'open' } }))
    }
    if (u.pathname === '/printer/objects/list') {
      return res.end(JSON.stringify({ result: { objects: ['webhooks', 'print_stats', 'idle_timeout'] } }))
    }
    if (u.pathname === '/printer/objects/query') {
      return res.end(
        JSON.stringify({
          result: {
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'standby', filename: '' },
              idle_timeout: { state: 'Idle' },
            },
          },
        }),
      )
    }
    if (u.pathname === '/server/files/list' && u.searchParams.get('root') === 'gcodes') {
      return res.end(JSON.stringify({ result: gcodeFiles }))
    }
    if (u.pathname === '/server/files/list' && u.searchParams.get('root') === 'config') {
      return res.end(JSON.stringify({ result: configFiles }))
    }
    if (u.pathname === '/server/files/directory' && req.method === 'GET') {
      return res.end(
        JSON.stringify({
          result: {
            dirs: [{ dirname: 'VORON', modified: 1900 }],
            files: [
              {
                filename: 'benchy.gcode',
                estimated_time: 1800,
                filament_weight_total: 14.5,
                layer_height: 0.2,
                thumbnails: [{ width: 300, height: 300, relative_path: '.thumbs/benchy-300x300.png' }],
              },
            ],
          },
        }),
      )
    }
    if (u.pathname === '/server/files/directory' && req.method === 'POST') {
      calls.push({ kind: 'mkdir', body: JSON.parse(rawBody) })
      return res.end(JSON.stringify({ result: { action: 'create_dir' } }))
    }
    if (u.pathname === '/server/files/move' && req.method === 'POST') {
      calls.push({ kind: 'move', body: JSON.parse(rawBody) })
      return res.end(JSON.stringify({ result: { action: 'move_item' } }))
    }
    if (u.pathname === '/server/history/list') {
      return res.end(JSON.stringify({ result: { jobs: [] } }))
    }
    if (u.pathname === '/server/database/item' && req.method === 'GET') {
      return res.end(JSON.stringify({ result: { value: presetsDb } }))
    }
    if (u.pathname === '/server/database/item' && req.method === 'POST') {
      const parsed = JSON.parse(rawBody)
      presetsDb = parsed.value
      calls.push({ kind: 'presets_save', namespace: parsed.namespace, key: parsed.key })
      return res.end(JSON.stringify({ result: { value: presetsDb } }))
    }
    if (u.pathname === '/server/files/upload' && req.method === 'POST') {
      calls.push({ kind: 'config_upload', raw: rawBody })
      configFiles.push({ path: 'macros.cfg', size: 20, modified: 2000, permissions: 'rw' })
      return res.end(JSON.stringify({ item: { path: 'macros.cfg', modified: 2000 } }))
    }
    if (u.pathname.startsWith('/server/files/config/') && req.method === 'DELETE') {
      calls.push({ kind: 'config_delete', path: decodeURIComponent(u.pathname.slice('/server/files/config/'.length)) })
      return res.end(JSON.stringify({ result: { item: { path: 'custom.cfg' } } }))
    }
    res.statusCode = 404
    res.end('{}')
  })

  await new Promise(resolve => mockMoonraker.listen(0, '127.0.0.1', resolve))
  const mockUrl = `http://127.0.0.1:${mockMoonraker.address().port}`
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-c2-http-'))
  const store = createSettingsStore({
    filePath: path.join(dir, '.dockyard-settings.json'),
    env: { PRINTER_URL: mockUrl, PRINTER_NAME: 'V0.1' },
  })
  const runtime = createPrinterRuntime({ store })
  const apiServer = http.createServer((req, res) => runtime.printerMiddleware(req, res, () => res.end('next')))
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve))
  const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`
  const writeHeaders = { Origin: apiOrigin, 'X-Cockpit-Request': '1', 'Content-Type': 'application/json' }

  try {
    // 1. Endstops
    const esRes = await fetch(`${apiOrigin}/api/system/endstops`)
    assert.equal(esRes.status, 200)
    const esData = await esRes.json()
    assert.equal(esData.endstops.length, 3)
    assert.equal(esData.endstops.find(e => e.name === 'y').triggered, true)

    // 2. G-Code files with extended metadata & dirs
    const filesRes = await fetch(`${apiOrigin}/api/print/files`)
    assert.equal(filesRes.status, 200)
    const filesData = await filesRes.json()
    assert.equal(filesData.dirs[0].name, 'VORON')
    assert.equal(filesData.files[0].estimatedTime, 1800)
    assert.equal(filesData.files[0].filamentWeight, 14.5)
    assert.equal(filesData.files[0].thumbnail, '.thumbs/benchy-300x300.png')

    // 3. Mkdir & Move
    const mkRes = await fetch(`${apiOrigin}/api/print/mkdir`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ path: 'TestParts' }),
    })
    assert.equal(mkRes.status, 200)
    assert.equal(calls.find(c => c.kind === 'mkdir').body.path, 'gcodes/TestParts')

    const mvRes = await fetch(`${apiOrigin}/api/print/move`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ source: 'benchy.gcode', dest: 'benchy_v2.gcode' }),
    })
    assert.equal(mvRes.status, 200)
    assert.deepEqual(calls.find(c => c.kind === 'move').body, {
      source: 'gcodes/benchy.gcode',
      dest: 'gcodes/benchy_v2.gcode',
    })

    // 4. Presets POST
    const preRes = await fetch(`${apiOrigin}/api/presets`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ action: 'upsert', name: 'TPU', extruder: 225, bed: 45 }),
    })
    assert.equal(preRes.status, 200)
    const preData = await preRes.json()
    assert.ok(preData.presets.some(p => p.name === 'TPU' && p.bed === 45))

    // 5. Config create + protected delete (printer.cfg blocked 403, custom.cfg deleted 200)
    const crRes = await fetch(`${apiOrigin}/api/system/config/create`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ path: 'macros.cfg' }),
    })
    assert.equal(crRes.status, 200)

    const delCore = await fetch(`${apiOrigin}/api/system/config/file?path=printer.cfg`, {
      method: 'DELETE',
      headers: { Origin: apiOrigin, 'X-Cockpit-Request': '1' },
    })
    assert.equal(delCore.status, 403)

    const delCustom = await fetch(`${apiOrigin}/api/system/config/file?path=custom.cfg`, {
      method: 'DELETE',
      headers: { Origin: apiOrigin, 'X-Cockpit-Request': '1' },
    })
    assert.equal(delCustom.status, 200)
    assert.equal(calls.find(c => c.kind === 'config_delete').path, 'custom.cfg')
  } finally {
    runtime.closeLiveFeed()
    apiServer.close()
    mockMoonraker.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Paket D1 safety: multi-tool extrude dock-guard & extruder restore + hardware-accurate Z-offset/probe/endstop detection', async () => {
  const { calibrationCapabilities } = await import('../server/calibration.mjs')

  // 1. Multi-tool extrude blocks docked tool and restores previous extruder when switching (incl. tool 0!)
  const tcRaw = {
    webhooks: { state: 'ready' },
    print_stats: { state: 'paused' },
    idle_timeout: { state: 'Idle' },
    toolchanger: { has_detection: true, tool_number: 0, detected_tool_number: 0, status: 'ready' },
    toolhead: { homed_axes: 'xyz', extruder: 'extruder2' },
    extruder: { temperature: 220, target: 220, can_extrude: true },
    extruder1: { temperature: 220, target: 220, can_extrude: true },
    extruder2: { temperature: 220, target: 220, can_extrude: true },
    configfile: {
      settings: {
        toolchanger: {},
        extruder: { max_temp: 300, min_extrude_temp: 170 },
        extruder1: { max_temp: 300, min_extrude_temp: 170 },
        extruder2: { max_temp: 300, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        stepper_z: { endstop_pin: 'probe:z_virtual_endstop' },
        beacon: {},
      },
    },
  }
  // Docked T1 rejected (prevents extruding into silicone dock pad!)
  assert.throws(() => commandFor({ action: 'extrude', tool: 1, distance: 10, speed: 5 }, tcRaw), err => err.status === 409)
  // Mounted T0 while extruder2 is active switches to extruder AND restores extruder2 afterwards
  const ext0 = commandFor({ action: 'extrude', tool: 0, distance: 10, speed: 5 }, tcRaw)
  assert.ok(ext0.body.script.startsWith('ACTIVATE_EXTRUDER EXTRUDER=extruder\n'))
  assert.ok(ext0.body.script.endsWith('\nACTIVATE_EXTRUDER EXTRUDER=extruder2'))
  // Toolchanger disables zOffsetSaveTarget so per-tool homing_origin isn't misapplied
  assert.equal(capabilities(tcRaw).zOffsetSaveTarget, null)

  // 2. Single-tool Beacon routes save_z_offset to BEACON_OFFSET_APPLY & disables PROBE_CALIBRATE / Z_ENDSTOP_CALIBRATE
  const beacon1Tool = singleToolTridentRaw({
    gcode_move: { homing_origin: [0, 0, -0.04, 0] },
    configfile: {
      settings: {
        extruder: { max_temp: 300, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        stepper_z: { endstop_pin: 'probe:z_virtual_endstop' },
        beacon: {},
      },
    },
  })
  assert.equal(capabilities(beacon1Tool).zOffsetSaveTarget, 'beacon')
  assert.equal(commandFor({ action: 'save_z_offset' }, beacon1Tool).body.script, 'BEACON_OFFSET_APPLY')
  const beaconCalCaps = calibrationCapabilities(beacon1Tool.configfile.settings)
  assert.equal(beaconCalCaps.probeCalibrate, false)
  assert.equal(beaconCalCaps.zEndstopCalibrate, false)
  assert.equal(beaconCalCaps.probeAccuracy, true)

  // 3. Single-tool Voron 2.4 with physical Z endstop + Klicky probe routes save_z_offset to Z_OFFSET_APPLY_ENDSTOP
  const physZWithProbe = singleToolTridentRaw({
    gcode_move: { homing_origin: [0, 0, -0.04, 0] },
    configfile: {
      settings: {
        extruder: { max_temp: 300, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        stepper_z: { endstop_pin: '^PG10' },
        probe: {},
      },
    },
  })
  assert.equal(capabilities(physZWithProbe).zOffsetSaveTarget, 'endstop')
  assert.equal(commandFor({ action: 'save_z_offset' }, physZWithProbe).body.script, 'Z_OFFSET_APPLY_ENDSTOP')
  assert.equal(calibrationCapabilities(physZWithProbe.configfile.settings).zEndstopCalibrate, true)
  assert.equal(calibrationCapabilities(physZWithProbe.configfile.settings).probeCalibrate, true)

  // 4. Single-tool Tap / virtual endstop disables Z_ENDSTOP_CALIBRATE & routes save_z_offset to Z_OFFSET_APPLY_PROBE
  const tapVirtual = singleToolTridentRaw({
    gcode_move: { homing_origin: [0, 0, -0.04, 0] },
    configfile: {
      settings: {
        extruder: { max_temp: 300, min_extrude_temp: 170 },
        heater_bed: { max_temp: 120 },
        stepper_z: { endstop_pin: 'probe:z_virtual_endstop' },
        probe: {},
      },
    },
  })
  assert.equal(capabilities(tapVirtual).zOffsetSaveTarget, 'probe')
  assert.equal(commandFor({ action: 'save_z_offset' }, tapVirtual).body.script, 'Z_OFFSET_APPLY_PROBE')
  assert.equal(calibrationCapabilities(tapVirtual.configfile.settings).zEndstopCalibrate, false)
  assert.equal(calibrationCapabilities(tapVirtual.configfile.settings).probeCalibrate, true)
})

test('Paket D2 unit: G32/M600 macros, macros during pause, multi-tool presets bool fix, and multi-tool pidLimits.toolMax', async () => {
  const { applyMainsailPresetMutation, normalizePresets } = await import('../server/presets.mjs')
  const { normalizeCalibrationData } = await import('../server/calibration.mjs')

  // 1. G32 and M600 appear in publicMacros (while G28/M104 stay filtered out), and macros are allowed while paused
  const rawPaused = singleToolTridentRaw({
    print_stats: { state: 'paused', filename: 'part.gcode' },
    configfile: {
      settings: {
        extruder: { max_temp: 300 },
        heater_bed: { max_temp: 120 },
        'gcode_macro g32': { description: 'QGL & Home', gcode: 'G28\nQUAD_GANTRY_LEVEL' },
        'gcode_macro m600': { description: 'Filamentwechsel', gcode: 'PAUSE' },
        'gcode_macro g28': { gcode: 'G28' },
        'gcode_macro m104': { gcode: 'M104' },
      },
    },
  })
  const st = normalizeStatus(rawPaused)
  assert.deepEqual(
    st.publicMacros.map(m => m.name),
    ['G32', 'M600'],
  )
  assert.equal(commandFor({ action: 'macro', name: 'M600' }, rawPaused).body.script, 'M600')
  assert.throws(
    () => commandFor({ action: 'macro', name: 'M600' }, { ...rawPaused, print_stats: { state: 'printing' } }),
    err => err.status === 409,
  )

  // 2. applyMainsailPresetMutation handles single-heater (bool: false when 0/null) & multi-tool extruder propagation
  const dbSingle = applyMainsailPresetMutation({}, { action: 'upsert', name: 'NozzleOnly', extruder: 140, bed: 0, toolCount: 1 })
  const entrySingle = Object.values(dbSingle.presets ?? dbSingle)[0]
  assert.equal(entrySingle.values.extruder.bool, true)
  assert.equal(entrySingle.values.extruder.value, 140)
  assert.equal(entrySingle.values.heater_bed.bool, false)

  const dbTc = applyMainsailPresetMutation({}, { action: 'upsert', name: 'ASA_TC', extruder: 250, bed: 105, toolCount: 6 })
  const listTc = normalizePresets({ mainsail: dbTc, toolCount: 6 })
  const tcPreset = listTc.find(p => p.name === 'ASA_TC')
  assert.ok(tcPreset)
  assert.deepEqual(tcPreset.tools, [250, 250, 250, 250, 250, 250])
  assert.equal(tcPreset.bed, 105)

  // 3. Multi-tool pidLimits.toolMax extracts per-tool safe max (max_temp - 5)
  const cal = normalizeCalibrationData({
    rawStatus: {
      toolchanger: {},
      configfile: {
        settings: {
          toolchanger: {},
          extruder: { max_temp: 300 },
          extruder1: { max_temp: 280 },
          extruder2: { max_temp: 320 },
          heater_bed: { max_temp: 120 },
        },
      },
    },
  })
  assert.deepEqual(cal.pidLimits.toolMax.slice(0, 3), [295, 275, 315])
})

test('Paket D2 HTTP & runtime: non-blocking side actions during async job, gcode download, delete dir & upload+print guard', async () => {
  let mockPrintState = 'standby'
  let mockPrintFile = ''
  const wsScripts = []
  let releaseSlowJob = null
  const deletedDirs = []

  class FakeRuntimeWS {
    constructor() {
      this.readyState = 1
      setImmediate(() => this.onopen?.())
    }
    send(payload) {
      const msg = JSON.parse(payload)
      if (msg.method === 'printer.gcode.script') {
        const script = msg.params?.script ?? ''
        wsScripts.push(script)
        if (script === 'G28') {
          // Hold the slow homing job open so a concurrent non-blocking side command can run!
          releaseSlowJob = () => {
            this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }) })
          }
          return
        }
        setImmediate(() => {
          this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }) })
        })
      }
    }
    close() {
      this.readyState = 3
    }
  }

  const mockMoonraker = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const c of req) chunks.push(c)

    if (u.pathname === '/printer/objects/list') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ result: { objects: ['webhooks', 'print_stats', 'idle_timeout', 'fan', 'toolhead', 'configfile'] } }))
    }
    if (u.pathname === '/printer/objects/query') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(
        JSON.stringify({
          result: {
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: mockPrintState, filename: mockPrintFile },
              idle_timeout: { state: 'Idle' },
              toolhead: { homed_axes: 'xyz' },
              fan: { speed: 0 },
              configfile: {
                settings: {
                  extruder: { max_temp: 300 },
                  heater_bed: { max_temp: 120 },
                  fan: {},
                },
              },
            },
          },
        }),
      )
    }
    if (u.pathname === '/server/files/gcodes/benchy.gcode' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/plain')
      return res.end('; GCODE BENCHY\nG28\n')
    }
    if (u.pathname === '/server/files/directory' && req.method === 'DELETE') {
      deletedDirs.push(u.searchParams.get('path'))
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ result: { action: 'delete_dir' } }))
    }
    if (u.pathname === '/server/files/upload' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ item: { path: 'new.gcode' } }))
    }
    res.statusCode = 404
    res.end('{}')
  })

  await new Promise(resolve => mockMoonraker.listen(0, '127.0.0.1', resolve))
  const mockUrl = `http://127.0.0.1:${mockMoonraker.address().port}`
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-d2-http-'))
  const store = createSettingsStore({
    filePath: path.join(dir, '.dockyard-settings.json'),
    env: { PRINTER_URL: mockUrl, PRINTER_NAME: 'V0.1' },
  })
  const runtime = createPrinterRuntime({ store })
  const apiServer = http.createServer((req, res) => runtime.printerMiddleware(req, res, () => res.end('next')))
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve))
  const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`

  try {
    // 1. Start async home job -> stays active while we execute a non-blocking fan command!
    const homeRes = await runtime.control(
      { action: 'home', axis: 'all' },
      { async: true, WebSocketImpl: FakeRuntimeWS },
    )
    assert.equal(homeRes.statusCode, 202)

    // Non-blocking fan succeeds WHILE home is still running!
    const fanRes = await runtime.control(
      { action: 'fan', fan: '__part_fan__', percent: 50 },
      { WebSocketImpl: FakeRuntimeWS },
    )
    assert.ok(fanRes.message)
    assert.ok(wsScripts.some(s => s.startsWith('M106')))

    // Blocking home while home is running still throws 409!
    await assert.rejects(
      () => runtime.control({ action: 'home', axis: 'all' }, { WebSocketImpl: FakeRuntimeWS }),
      err => err.status === 409,
    )

    // Finish the slow homing job
    releaseSlowJob?.()
    await new Promise(resolve => setTimeout(resolve, 40))

    // 2. G-Code Download
    const dlRes = await fetch(`${apiOrigin}/api/print/download?filename=benchy.gcode`)
    assert.equal(dlRes.status, 200)
    assert.ok((dlRes.headers.get('content-disposition') || '').includes('benchy.gcode'))
    assert.equal(await dlRes.text(), '; GCODE BENCHY\nG28\n')

    // 3. Delete empty folder succeeds, and deleting folder containing active print is blocked 409!
    const delDirOk = await fetch(`${apiOrigin}/api/print/dir?path=OldPrints`, {
      method: 'DELETE',
      headers: { Origin: apiOrigin, 'X-Cockpit-Request': '1' },
    })
    assert.equal(delDirOk.status, 200)
    assert.deepEqual(deletedDirs, ['gcodes/OldPrints'])

    mockPrintState = 'printing'
    mockPrintFile = 'ActiveDir/part.gcode'
    const delDirBlocked = await fetch(`${apiOrigin}/api/print/dir?path=ActiveDir`, {
      method: 'DELETE',
      headers: { Origin: apiOrigin, 'X-Cockpit-Request': '1' },
    })
    assert.equal(delDirBlocked.status, 409)

    // 4. Upload with X-Gcode-Print: 1 is blocked while printing!
    const upPrintBlocked = await fetch(`${apiOrigin}/api/print/upload`, {
      method: 'POST',
      headers: {
        Origin: apiOrigin,
        'X-Cockpit-Request': '1',
        'X-Gcode-Filename': 'new.gcode',
        'X-Gcode-Print': '1',
      },
      body: Buffer.from('; GCODE\n'),
    })
    assert.equal(upPrintBlocked.status, 409)
  } finally {
    releaseSlowJob?.()
    runtime.closeLiveFeed()
    apiServer.close()
    mockMoonraker.close()
    await rm(dir, { recursive: true, force: true })
  }
})
