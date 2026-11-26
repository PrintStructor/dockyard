import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStatus, detectToolCount, extractBedSize } from '../server/status.mjs'
import { temperatureHistory, inferExtruderCountFromStore } from '../server/temperature.mjs'
import { normalizePresets } from '../server/presets.mjs'
import { normalizeCalibrationData } from '../server/calibration.mjs'

test('normalizeStatus handles single-tool VORON 2.4 with sb_leds, QGL, part fan, and 350x350 bed', () => {
  const raw = {
    webhooks: { state: 'ready' },
    print_stats: { state: 'standby' },
    extruder: { temperature: 210.5, target: 215, power: 0.4, pressure_advance: 0.04, can_extrude: true },
    heater_bed: { temperature: 105, target: 110 },
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
