import test from 'node:test'
import assert from 'node:assert/strict'
import { commandFor, capabilities } from '../server/control.mjs'
import { control, getControlState } from '../server/printer.mjs'
import { normalizeStatus } from '../server/status.mjs'
import { printControlReason, Z_BABYSTEP_DELTAS } from '../src/print-control-state.mjs'

function makeRaw(overrides = {}) {
  const config = {
    virtual_sdcard: { path: '~/printer_data/gcodes' },
    pause_resume: {},
    'gcode_macro cancel_print': { gcode: 'CANCEL_PRINT_BASE' },
    'gcode_macro pause': { gcode: 'PAUSE_BASE' },
    'gcode_macro resume': { gcode: 'RESUME_BASE' },
    'gcode_macro set_gcode_offset': { gcode: 'SET_TOOL_Z_ADJUST Z={params.Z_ADJUST}' },
    'gcode_macro z_adjust_reset': { gcode: 'SET_TOOL_Z_ADJUST RESET=1' },
    toolchanger: {},
  }
  const raw = {
    webhooks: { state: 'ready', state_message: 'Printer is ready' },
    print_stats: { state: 'standby', filename: '' },
    idle_timeout: { state: 'Idle' },
    toolhead: { homed_axes: 'xyz', position: [100, 100, 20, 0] },
    gcode_move: { speed_factor: 1.0, extrude_factor: 1.0, homing_origin: [0, 0, 0, 0] },
    exclude_object: {
      objects: [
        { name: 'Part_A', center: [100, 100] },
        { name: 'Part_B', center: [200, 150] },
      ],
      excluded_objects: ['Part_C'],
      current_object: 'Part_A',
    },
    toolchanger: { has_detection: true, tool_number: 1, detected_tool_number: 1, status: 'ready' },
    'gcode_macro LOAD_WATCH': { active: 0, temp: 240 },
    configfile: { settings: config },
    ...overrides,
  }
  return raw
}

test('normalizeStatus extracts live print tuning (speed, flow, Z offset) and exclude_object without inventing missing fields', () => {
  const raw = makeRaw({
    gcode_move: { speed_factor: 1.25, extrude_factor: 0.95, homing_origin: [0, 0, -0.025, 0] },
  })
  const st = normalizeStatus(raw)
  assert.equal(st.speedPercent, 125)
  assert.equal(st.flowPercent, 95)
  assert.equal(st.zOffset, -0.025)
  assert.deepEqual(st.excludeObjects, {
    available: true,
    objects: [
      { name: 'Part_A', center: [100, 100] },
      { name: 'Part_B', center: [200, 150] },
    ],
    excluded: ['Part_C'],
    current: 'Part_A',
  })

  const empty = normalizeStatus({ webhooks: { state: 'ready' } })
  assert.equal(empty.speedPercent, null)
  assert.equal(empty.flowPercent, null)
  assert.equal(empty.zOffset, null)
  assert.deepEqual(empty.excludeObjects, { available: false, objects: [], excluded: [], current: null })
})

test('print_start validates filenames, allows cold-start unhomed prints, and blocks active prints, conflicts or errors', () => {
  const raw = makeRaw()
  const cmd = commandFor({ action: 'print_start', filename: 'Voron/benchy.gcode' }, raw)
  assert.equal(cmd.rpcMethod, 'printer.print.start')
  assert.deepEqual(cmd.rpcParams, { filename: 'Voron/benchy.gcode' })
  assert.equal(cmd.label, 'Druck starten · benchy.gcode')

  // Cold boot unhomed + uninitialized toolchanger is permitted (PRINT_START homes & initializes)
  const cold = makeRaw()
  cold.toolhead.homed_axes = ''
  cold.toolchanger.status = 'uninitialized'
  cold.toolchanger.tool_number = -1
  assert.equal(commandFor({ action: 'print_start', filename: 'test.gcode' }, cold).rpcMethod, 'printer.print.start')

  // Reject unsafe filenames
  for (const bad of ['', '../printer.cfg', 'printer.cfg', 'a\nb.gcode', '/etc/passwd.gcode', 42, null]) {
    assert.throws(() => commandFor({ action: 'print_start', filename: bad }, raw))
  }

  // Block while printing, paused, external motion, load watch, conflict, tc error, or missing virtual_sdcard
  const blockedMutations = [
    r => (r.print_stats.state = 'printing'),
    r => (r.print_stats.state = 'paused'),
    r => (r.idle_timeout.state = 'Printing'),
    r => (r['gcode_macro LOAD_WATCH'].active = 1),
    r => (r.toolchanger.status = 'error'),
    r => {
      r['tool T0'] = { detect_state: 1 }
      r['tool T1'] = { detect_state: 1 }
    },
    r => delete r.configfile.settings.virtual_sdcard,
  ]
  for (const mutate of blockedMutations) {
    const r = makeRaw()
    mutate(r)
    assert.throws(() => commandFor({ action: 'print_start', filename: 'test.gcode' }, r))
  }
})

test('print_cancel works during printing/paused even on toolchanger error, and rejects idle states', () => {
  const printing = makeRaw({ print_stats: { state: 'printing', filename: 'part.gcode' } })
  printing.toolchanger.status = 'error'
  printing.toolchanger.detected_tool_number = -1
  const cmd = commandFor({ action: 'print_cancel' }, printing)
  assert.equal(cmd.rpcMethod, 'printer.print.cancel')
  assert.equal(cmd.async, true)
  assert.equal(cmd.label, 'Druck abbrechen')

  const paused = makeRaw({ print_stats: { state: 'paused', filename: 'part.gcode' } })
  assert.equal(commandFor({ action: 'print_cancel' }, paused).rpcMethod, 'printer.print.cancel')

  const idle = makeRaw()
  assert.throws(() => commandFor({ action: 'print_cancel' }, idle), /aktiver/)

  const noCancel = makeRaw({ print_stats: { state: 'printing', filename: 'part.gcode' } })
  delete noCancel.configfile.settings['gcode_macro cancel_print']
  delete noCancel.configfile.settings.pause_resume
  assert.throws(() => commandFor({ action: 'print_cancel' }, noCancel), /konfiguriert/)
})

test('live tuning (speed, flow, Z babystepping) validates strict bounds and only executes during printing or paused', () => {
  const printing = makeRaw({ print_stats: { state: 'printing', filename: 'part.gcode' } })
  const paused = makeRaw({ print_stats: { state: 'paused', filename: 'part.gcode' } })
  const idle = makeRaw()

  // Speed %
  const speedCmd = commandFor({ action: 'tune_speed', percent: 120 }, printing)
  assert.equal(speedCmd.body.script, 'M220 S120')
  assert.equal(speedCmd.label, 'Geschwindigkeit auf 120 %')
  assert.equal(commandFor({ action: 'tune_speed', percent: 50 }, paused).body.script, 'M220 S50')
  for (const bad of [9, 301, 100.5, '100', null]) {
    assert.throws(() => commandFor({ action: 'tune_speed', percent: bad }, printing))
  }
  assert.throws(() => commandFor({ action: 'tune_speed', percent: 100 }, idle), /Druck/)

  // Flow %
  const flowCmd = commandFor({ action: 'tune_flow', percent: 95 }, printing)
  assert.equal(flowCmd.body.script, 'M221 S95')
  assert.equal(flowCmd.label, 'Fluss auf 95 %')
  for (const bad of [49, 201, 95.5, '95', null]) {
    assert.throws(() => commandFor({ action: 'tune_flow', percent: bad }, printing))
  }
  assert.throws(() => commandFor({ action: 'tune_flow', percent: 100 }, idle), /Druck/)

  // Z babystepping steps
  assert.ok(Z_BABYSTEP_DELTAS.includes(0.01) && Z_BABYSTEP_DELTAS.includes(-0.025))
  const zUp = commandFor({ action: 'tune_z_offset', delta: 0.01 }, printing)
  assert.equal(zUp.body.script, 'SET_GCODE_OFFSET Z_ADJUST=+0.010 MOVE=1')
  assert.equal(zUp.label, 'Z-Offset +0.010 mm')
  const zDown = commandFor({ action: 'tune_z_offset', delta: -0.025 }, paused)
  assert.equal(zDown.body.script, 'SET_GCODE_OFFSET Z_ADJUST=-0.025 MOVE=1')
  assert.equal(zDown.label, 'Z-Offset -0.025 mm')
  for (const bad of [0, 0.25, -0.5, 1, '0.01', NaN]) {
    assert.throws(() => commandFor({ action: 'tune_z_offset', delta: bad }, printing))
  }
  assert.throws(() => commandFor({ action: 'tune_z_offset', delta: 0.01, reset: true }, printing))
  assert.throws(() => commandFor({ action: 'tune_z_offset', delta: 0.01 }, idle), /Druck/)

  // Z reset uses installed Z_ADJUST_RESET macro on toolchanger, or fallback when absent
  const zReset = commandFor({ action: 'tune_z_offset', reset: true }, printing)
  assert.equal(zReset.body.script, 'Z_ADJUST_RESET')
  assert.equal(zReset.label, 'Z-Offset zurücksetzen')
  const plainKlipper = makeRaw({ print_stats: { state: 'printing', filename: 'part.gcode' } })
  delete plainKlipper.configfile.settings['gcode_macro z_adjust_reset']
  delete plainKlipper.configfile.settings['gcode_macro set_gcode_offset']
  assert.equal(commandFor({ action: 'tune_z_offset', reset: true }, plainKlipper).body.script, 'SET_GCODE_OFFSET Z=0 MOVE=1')
})

test('exclude_object validates membership in active print objects and rejects already excluded or arbitrary strings', () => {
  const printing = makeRaw({ print_stats: { state: 'printing', filename: 'part.gcode' } })
  const cmd = commandFor({ action: 'exclude_object', name: 'Part_B' }, printing)
  assert.equal(cmd.body.script, 'EXCLUDE_OBJECT NAME=Part_B')
  assert.equal(cmd.label, 'Objekt überspringen · Part_B')

  // Reject already excluded, unknown, injection, idle, or disabled
  assert.throws(() => commandFor({ action: 'exclude_object', name: 'Part_C' }, printing), /bereits|Objekt/)
  assert.throws(() => commandFor({ action: 'exclude_object', name: 'Unknown_Part' }, printing), /Objekt/)
  assert.throws(() => commandFor({ action: 'exclude_object', name: 'Part_A\nG28' }, printing))
  assert.throws(() => commandFor({ action: 'exclude_object', name: 'Part_A' }, makeRaw()), /Druck/)

  const noEx = makeRaw({ print_stats: { state: 'printing', filename: 'part.gcode' } })
  delete noEx.exclude_object
  assert.throws(() => commandFor({ action: 'exclude_object', name: 'Part_A' }, noEx), /konfiguriert|Objekt/)

  // Client guard matches offline & pending
  const st = { ...normalizeStatus(printing), capabilities: capabilities(printing) }
  assert.equal(printControlReason(st, 'tune_speed', true, false), '')
  assert.match(printControlReason(st, 'tune_speed', false, false), /aktuellen/)
  assert.match(printControlReason(st, 'print_cancel', true, true), /Befehl/)
})

test('mock WS transport executes printer.print.start and printer.print.cancel JSON-RPC cleanly', async t => {
  const wsSent = []
  let printState = 'standby'

  class MockWS {
    constructor() {
      this.readyState = 1
      setImmediate(() => this.onopen?.())
    }
    send(payload) {
      const msg = JSON.parse(payload)
      wsSent.push(msg)
      setImmediate(() =>
        this.onmessage?.({
          data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }),
        }),
      )
    }
    close() {
      this.readyState = 3
    }
  }

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      result: {
        objects: ['exclude_object'],
        status: makeRaw({ print_stats: { state: printState, filename: printState === 'printing' ? 'demo.gcode' : '' } }),
      },
    }),
  }))

  const started = await control({ action: 'print_start', filename: 'demo.gcode' }, { WebSocketImpl: MockWS })
  assert.match(started.message, /Druck starten · demo\.gcode/)
  assert.equal(wsSent[0].method, 'printer.print.start')
  assert.deepEqual(wsSent[0].params, { filename: 'demo.gcode' })
  assert.equal(getControlState().job, null)

  printState = 'printing'
  const cancelled = await control({ action: 'print_cancel' }, { WebSocketImpl: MockWS })
  assert.match(cancelled.message, /Druck abbrechen/)
  assert.equal(wsSent[1].method, 'printer.print.cancel')
  assert.deepEqual(wsSent[1].params, {})
  assert.equal(getControlState().job, null)
})
