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
