import test from 'node:test'
import assert from 'node:assert/strict'
import { commandFor } from '../server/control.mjs'
import {
  calibrationActions,
  calibrationCapabilities,
  validateShakeTuneImagePath,
  normalizeCalibrationData,
} from '../server/calibration.mjs'

const allCalibrationMacros = () => ({
  'gcode_macro nudge_calibrate_ring_xy': {},
  'gcode_macro nudge_calibrate_all_tools_xy': {},
  'gcode_macro nudge_restore_offsets': {},
  'gcode_macro beacon_calibrate_z': {},
  'gcode_macro beacon_calibrate_all_tools_z': {},
  'gcode_macro beacon_batch_abort': {},
  'gcode_macro beacon_calibrate_nozzle_temp_offset': {},
  'gcode_macro reset_all_tool_z_adjustments': {},
  'gcode_macro fine_quad_gantry_level': {},
  'gcode_macro beacon_measure_gantry_twist': {},
  'gcode_macro beacon_poke_test': {},
  'gcode_macro shaper_calibrate_foc': {},
  'gcode_macro axes_shaper_calibration': {},
  'gcode_macro compare_belts_responses': {},
  'gcode_macro create_vibrations_profile': {},
  bed_screws: { screw1: '60,5', screw1_name: 'front screw' },
  screws_tilt_adjust: {},
  resonance_tester: {},
  probe: {},
  extruder: { max_temp: 300 },
  heater_bed: { max_temp: 130 },
})

const readyState = () => ({
  webhooks: { state: 'ready' },
  print_stats: { state: 'standby' },
  idle_timeout: { state: 'Idle' },
  toolhead: { homed_axes: 'xyz', position: [177.5, 177.5, 20, 0] },
  toolchanger: { has_detection: true, tool_number: 0, detected_tool_number: 0, status: 'ready' },
  'gcode_macro _BEACON_BATCH_STATE': { running: 0, current_initial: 0, current_measure: 0, total_measurements: 0 },
  configfile: {
    settings: {
      heater_bed: { max_temp: 130 },
      extruder: { max_temp: 300 },
      quad_gantry_level: {},
      bed_mesh: {},
      ...allCalibrationMacros(),
    },
  },
})

test('calibrationCapabilities detects configured macros and returns false when absent', () => {
  const full = calibrationCapabilities(allCalibrationMacros())
  for (const key of Object.keys(full)) {
    assert.equal(full[key], true, `expected ${key} to be true`)
  }
  const empty = calibrationCapabilities({})
  for (const key of Object.keys(empty)) {
    assert.equal(empty[key], false, `expected ${key} to be false`)
  }
  assert.equal(calibrationActions.length, 27)
})

test('commandFor routes Nudge XY macros with SAVE_CONFIG restart flag and safety guards', () => {
  const unhomed = readyState()
  unhomed.toolhead.homed_axes = ''

  const ring = commandFor({ action: 'calibrate_nudge_ring' }, unhomed)
  assert.equal(ring.body.script, 'NUDGE_CALIBRATE_RING_XY')
  assert.equal(ring.async, true)
  assert.equal(ring.restartsKlipper, true)
  assert.equal(ring.timeoutMs, 2_700_000)

  const all = commandFor({ action: 'calibrate_nudge_all' }, unhomed)
  assert.equal(all.body.script, 'NUDGE_CALIBRATE_ALL_TOOLS_XY')
  assert.equal(all.restartsKlipper, true)
  assert.equal(all.timeoutMs, 2_700_000)

  const restore = commandFor({ action: 'calibrate_nudge_restore' }, unhomed)
  assert.equal(restore.body.script, 'NUDGE_RESTORE_OFFSETS')

  for (const printState of ['printing', 'paused']) {
    const busy = readyState()
    busy.print_stats.state = printState
    assert.throws(() => commandFor({ action: 'calibrate_nudge_ring' }, busy), err => err.status === 409)
  }

  const idlePrinting = readyState()
  idlePrinting.idle_timeout.state = 'Printing'
  assert.throws(() => commandFor({ action: 'calibrate_nudge_ring' }, idlePrinting), err => err.status === 409)

  const noMacro = readyState()
  delete noMacro.configfile.settings['gcode_macro nudge_calibrate_ring_xy']
  assert.throws(() => commandFor({ action: 'calibrate_nudge_ring' }, noMacro), err => err.status === 409)
})

test('commandFor routes Beacon Z, batch abort, thermal expansion and Z adjust reset with strict params', () => {
  const z = commandFor({ action: 'calibrate_beacon_z', tool: 2 }, readyState())
  assert.equal(z.body.script, 'BEACON_CALIBRATE_Z INITIAL_TOOL=2')
  assert.equal(z.async, true)

  assert.throws(() => commandFor({ action: 'calibrate_beacon_z', tool: 6 }, readyState()), err => err.status === 400)
  assert.throws(() => commandFor({ action: 'calibrate_beacon_z', tool: '0' }, readyState()), err => err.status === 400)

  const unhomed = readyState()
  unhomed.toolhead.homed_axes = 'xy'
  assert.throws(() => commandFor({ action: 'calibrate_beacon_z', tool: 0 }, unhomed), /homen/)
  assert.throws(() => commandFor({ action: 'calibrate_beacon_all_z', probeTemp: 150 }, unhomed), /homen/)

  const allZ = commandFor({ action: 'calibrate_beacon_all_z', probeTemp: 150 }, readyState())
  assert.equal(allZ.body.script, 'BEACON_CALIBRATE_ALL_TOOLS_Z PROBE_TEMP=150')

  const allZDefault = commandFor({ action: 'calibrate_beacon_all_z' }, readyState())
  assert.equal(allZDefault.body.script, 'BEACON_CALIBRATE_ALL_TOOLS_Z PROBE_TEMP=150')

  assert.throws(() => commandFor({ action: 'calibrate_beacon_all_z', probeTemp: 99 }, readyState()), err => err.status === 400)
  assert.throws(() => commandFor({ action: 'calibrate_beacon_all_z', probeTemp: 250 }, readyState()), err => err.status === 400)

  // Batch running blocks starting another batch, but allows BEACON_BATCH_ABORT even while idle_timeout === Printing.
  const batchRunning = readyState()
  batchRunning['gcode_macro _BEACON_BATCH_STATE'].running = 1
  batchRunning.idle_timeout.state = 'Printing'
  assert.throws(() => commandFor({ action: 'calibrate_beacon_all_z' }, batchRunning), err => err.status === 409)

  const abort = commandFor({ action: 'calibrate_beacon_abort' }, batchRunning)
  assert.equal(abort.body.script, 'BEACON_BATCH_ABORT')

  // Abort rejected when no batch is running.
  assert.throws(() => commandFor({ action: 'calibrate_beacon_abort' }, readyState()), err => err.status === 409)

  const exp = commandFor({ action: 'calibrate_nozzle_expansion', tool: 1 }, readyState())
  assert.equal(exp.body.script, 'BEACON_CALIBRATE_NOZZLE_TEMP_OFFSET INITIAL_TOOL=1')

  const reset = commandFor({ action: 'calibrate_reset_z_adjust' }, readyState())
  assert.equal(reset.body.script, 'RESET_ALL_TOOL_Z_ADJUSTMENTS')
})

test('commandFor routes Fine-QGL, Gantry Twist, Beacon Poke and FOC Shaper', () => {
  assert.equal(commandFor({ action: 'calibrate_fine_qgl' }, readyState()).body.script, 'FINE_QUAD_GANTRY_LEVEL')
  assert.equal(commandFor({ action: 'calibrate_gantry_twist' }, readyState()).body.script, 'BEACON_MEASURE_GANTRY_TWIST')
  assert.equal(commandFor({ action: 'calibrate_beacon_poke' }, readyState()).body.script, 'BEACON_POKE_TEST')
  assert.equal(
    commandFor({ action: 'calibrate_shaper_foc', axis: 'X' }, readyState()).body.script,
    'SHAPER_CALIBRATE_FOC AXIS=X',
  )
  assert.equal(
    commandFor({ action: 'calibrate_shaper_foc', axis: 'Y' }, readyState()).body.script,
    'SHAPER_CALIBRATE_FOC AXIS=Y',
  )
  assert.equal(
    commandFor({ action: 'calibrate_shaper_foc', axis: 'ALL' }, readyState()).body.script,
    'SHAPER_CALIBRATE_FOC',
  )
  assert.throws(() => commandFor({ action: 'calibrate_shaper_foc', axis: 'Z' }, readyState()), err => err.status === 400)

  const unhomed = readyState()
  unhomed.toolhead.homed_axes = ''
  assert.throws(() => commandFor({ action: 'calibrate_fine_qgl' }, unhomed), /homen/)
  assert.throws(() => commandFor({ action: 'calibrate_shaper_foc', axis: 'X' }, unhomed), /homen/)
})

test('validateShakeTuneImagePath restricts strictly to ShakeTune_results/**/*.png', () => {
  assert.equal(
    validateShakeTuneImagePath('ShakeTune_results/input_shaper/inputshaper_20260817_072751_axis_X.png'),
    'ShakeTune_results/input_shaper/inputshaper_20260817_072751_axis_X.png',
  )
  for (const bad of [
    '',
    null,
    '../printer.cfg',
    'ShakeTune_results/foo.stdata',
    'ShakeTune_results/../printer.cfg',
    'ShakeTune_results/sub/%2e%2e/a.png',
    'printer.cfg',
    'ShakeTune_results/a\\b.png',
  ]) {
    assert.equal(validateShakeTuneImagePath(bad), null, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('normalizeCalibrationData extracts 6x6 matrices, mesh stats, beacon, shaper and ShakeTune charts', () => {
  const rawStatus = {
    toolchanger: { initial_tool: 0, tool_number: 0, detected_tool_number: 0, status: 'ready' },
    quad_gantry_level: { applied: true },
    beacon: {
      model: 'default',
      last_received_sample: { freq: 5147245.5, temp: 28.1 },
    },
    'temperature_sensor beacon_coil': { temperature: 29.4 },
    'gcode_macro _BEACON_BATCH_STATE': { running: 1, current_initial: 2, current_measure: 4, total_measurements: 14 },
    bed_mesh: {
      profile_name: 'default',
      mesh_min: [20, 20],
      mesh_max: [330, 330],
      probed_matrix: [
        [-0.02, 0.01],
        [0.03, 0.04],
      ],
      mesh_matrix: [
        [-0.02, 0.01],
        [0.03, 0.04],
      ],
    },
    save_variables: {
      variables: {
        nudge_ring_closure: [0.0048, -0.0073],
        nudge_xy_0_1: [-0.1827, -0.0671],
        tool_z_offset_t0_t1: 0.126875,
        tool_z_adjust_t1: -0.01,
        nozzle_expansion_coefficient_t0: 0.000569,
        z_offset_reference_tool: 0,
      },
    },
    extruder: { pressure_advance: 0.032 },
    extruder1: { pressure_advance: 0.035 },
    'tool T0': { gcode_x_offset: 0, gcode_y_offset: 0, gcode_z_offset: 0 },
    'tool T1': { gcode_x_offset: -0.1827, gcode_y_offset: -0.0671, gcode_z_offset: 0.1268 },
    configfile: {
      settings: {
        input_shaper: {
          shaper_type_x: 'mzv',
          shaper_freq_x: 59,
          damping_ratio_x: 0.118,
          shaper_type_y: 'mzv',
          shaper_freq_y: 36,
          damping_ratio_y: 0.138,
        },
        quad_gantry_level: {},
        bed_mesh: {},
        ...allCalibrationMacros(),
      },
    },
  }

  const configFiles = [
    { path: 'printer.cfg', size: 1000, modified: 100 },
    { path: 'ShakeTune_results/belts/beltscomparison_20260816.png', size: 352000, modified: 200 },
    { path: 'ShakeTune_results/input_shaper/inputshaper_20260817_axis_X.png', size: 1127000, modified: 300 },
    { path: 'ShakeTune_results/vibrations/vibrationsprofile_20260817.png', size: 1852000, modified: 400 },
    { path: 'ShakeTune_results/input_shaper/data.stdata', size: 1000, modified: 500 },
  ]

  const data = normalizeCalibrationData({ rawStatus, configFiles })
  assert.equal(data.tools.length, 6)
  assert.equal(data.tools[0].expansionCoeff, 0.000569)
  assert.equal(data.tools[0].pressureAdvance, 0.032)
  assert.equal(data.tools[1].zAdjust, -0.01)
  assert.deepEqual(data.nudgeRingClosure, { x: 0.0048, y: -0.0073 })
  assert.deepEqual(data.nudgeXy[0][1], [-0.1827, -0.0671])
  assert.equal(data.nudgeXy[0][0], null)
  assert.equal(data.beaconZ[0][1], 0.126875)
  assert.equal(data.beaconZ[0][0], 0)
  assert.equal(data.zReferenceTool, 0)
  assert.deepEqual(data.beaconBatch, {
    running: true,
    currentInitial: 2,
    currentMeasure: 4,
    totalMeasurements: 14,
    totalTarget: 30,
  })
  assert.equal(data.bedMesh.active, true)
  assert.equal(data.bedMesh.profileName, 'default')
  assert.equal(data.bedMesh.min, -0.02)
  assert.equal(data.bedMesh.max, 0.04)
  assert.equal(Math.round(data.bedMesh.range * 1000) / 1000, 0.06)
  assert.equal(data.qgl.applied, true)
  assert.equal(data.beacon.model, 'default')
  assert.equal(data.beacon.coilTemp, 29.4)
  assert.deepEqual(data.inputShaper.x, { type: 'mzv', freq: 59, damping: 0.118 })
  assert.deepEqual(data.inputShaper.y, { type: 'mzv', freq: 36, damping: 0.138 })
  assert.deepEqual(
    data.shakeTune.map(c => c.category),
    ['vibrations', 'input_shaper', 'belts'],
  )

  // Empty 1x0 bed mesh should normalize cleanly to active: false.
  const emptyMesh = normalizeCalibrationData({
    rawStatus: { ...rawStatus, bed_mesh: { profile_name: '', probed_matrix: [[]], mesh_matrix: [[]] } },
    configFiles: [],
  })
  assert.equal(emptyMesh.bedMesh.active, false)
  assert.deepEqual(emptyMesh.bedMesh.matrix, [])
})

test('normalizeCalibrationData exposes bedMesh and QGL config parameters and avoids coercing missing shaper to 0', () => {
  const data = normalizeCalibrationData({
    rawStatus: {
      bed_mesh: { profile_name: '', probed_matrix: [[]], mesh_matrix: [[]] },
      quad_gantry_level: { applied: false },
      configfile: {
        settings: {
          bed_mesh: {
            probe_count: [21, 21],
            mesh_min: [25, 35],
            mesh_max: [330, 335],
            zero_reference_position: [177.5, 177.5],
            algorithm: 'bicubic',
            fade_start: 0.6,
            fade_end: 5,
          },
          quad_gantry_level: {
            retries: 5,
            retry_tolerance: 0.0075,
            horizontal_move_z: 2,
          },
          input_shaper: {},
        },
      },
    },
    configFiles: [],
  })

  assert.deepEqual(data.bedMesh.config, {
    probeCount: [21, 21],
    meshMin: [25, 35],
    meshMax: [330, 335],
    zeroReference: [177.5, 177.5],
    algorithm: 'bicubic',
    fadeStart: 0.6,
    fadeEnd: 5,
  })
  assert.equal(data.qgl.retries, 5)
  assert.equal(data.qgl.retryTolerance, 0.0075)
  assert.equal(data.qgl.horizontalMoveZ, 2)
  assert.equal(data.inputShaper.x.freq, null)
  assert.equal(data.inputShaper.x.damping, null)
})

test('Paket B2 calibration: mesh profiles, V0.1 bed_screws workflow, screws_tilt, PID, standard shaper, ShakeTune, and probe_accuracy', () => {
  const base = readyState()
  base.bed_screws = { is_active: false, state: null, current_stage: 0, accepted_screws: 0 }
  base.bed_mesh = {
    profile_name: 'default',
    profiles: { default: {}, abs_110: {} },
    probed_matrix: [[0, 0.01], [-0.01, 0]],
  }

  // Bed Mesh profile commands + injection guard
  assert.equal(commandFor({ action: 'mesh_profile_load', profile: 'abs_110' }, base).body.script, 'BED_MESH_PROFILE LOAD="abs_110"')
  assert.equal(commandFor({ action: 'mesh_profile_save', profile: 'petg-80' }, base).body.script, 'BED_MESH_PROFILE SAVE="petg-80"')
  assert.equal(commandFor({ action: 'mesh_profile_remove', profile: 'abs_110' }, base).body.script, 'BED_MESH_PROFILE REMOVE="abs_110"')
  assert.equal(commandFor({ action: 'mesh_clear' }, base).body.script, 'BED_MESH_CLEAR')
  assert.throws(() => commandFor({ action: 'mesh_profile_load', profile: 'bad" G28' }, base), err => err.status === 400)

  // BED_SCREWS_ADJUST start + interactive ACCEPT/ADJUSTED/ABORT guard
  assert.equal(commandFor({ action: 'bed_screws_start' }, base).body.script, 'BED_SCREWS_ADJUST')
  assert.throws(() => commandFor({ action: 'bed_screws_accept' }, base), err => err.status === 409)
  const activeScrews = { ...base, bed_screws: { is_active: true, state: 'adjust', accepted_screws: 1 } }
  assert.equal(commandFor({ action: 'bed_screws_accept' }, activeScrews).body.script, 'ACCEPT')
  assert.equal(commandFor({ action: 'bed_screws_adjusted' }, activeScrews).body.script, 'ADJUSTED')
  assert.equal(commandFor({ action: 'bed_screws_abort' }, activeScrews).body.script, 'ABORT')

  // SCREWS_TILT_CALCULATE & PROBE_ACCURACY
  assert.equal(commandFor({ action: 'screws_tilt_calculate' }, base).body.script, 'SCREWS_TILT_CALCULATE')
  assert.equal(commandFor({ action: 'probe_accuracy' }, base).body.script, 'PROBE_ACCURACY')

  // PID_CALIBRATE bounds check
  const pidE = commandFor({ action: 'calibrate_pid', heater: 'extruder', target: 230 }, base)
  assert.equal(pidE.body.script, 'PID_CALIBRATE HEATER=extruder TARGET=230')
  assert.equal(pidE.async, true)
  assert.equal(commandFor({ action: 'calibrate_pid', heater: 'heater_bed', target: 100 }, base).body.script, 'PID_CALIBRATE HEATER=heater_bed TARGET=100')
  assert.throws(() => commandFor({ action: 'calibrate_pid', heater: 'extruder', target: 30 }, base), err => err.status === 400)
  assert.throws(() => commandFor({ action: 'calibrate_pid', heater: 'heater_bed', target: 200 }, base), err => err.status === 400)

  // Standard SHAPER_CALIBRATE & ShakeTune triggers
  assert.equal(commandFor({ action: 'calibrate_shaper', axis: 'ALL' }, base).body.script, 'SHAPER_CALIBRATE')
  assert.equal(commandFor({ action: 'calibrate_shaper', axis: 'X' }, base).body.script, 'SHAPER_CALIBRATE AXIS=X')
  assert.equal(commandFor({ action: 'shaketune_shaper' }, base).body.script, 'AXES_SHAPER_CALIBRATION')
  assert.equal(commandFor({ action: 'shaketune_belts' }, base).body.script, 'COMPARE_BELTS_RESPONSES')
  assert.equal(commandFor({ action: 'shaketune_vibrations' }, base).body.script, 'CREATE_VIBRATIONS_PROFILE')

  // normalizeCalibrationData extracts profiles, bedScrews, pidLimits
  const norm = normalizeCalibrationData({ rawStatus: base, configFiles: [] })
  assert.deepEqual(norm.bedMesh.profiles, ['abs_110', 'default'])
  assert.equal(norm.bedScrews.configured, true)
  assert.deepEqual(norm.bedScrews.screws, [{ index: 1, name: 'front screw' }])
  assert.equal(norm.pidLimits.extruderMax, 295)
  assert.equal(norm.pidLimits.bedMax, 125)
})
