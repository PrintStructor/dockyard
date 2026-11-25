import test from 'node:test'
import assert from 'node:assert/strict'
import { commandFor, sameOriginRequest } from '../server/control.mjs'
import { control, getControlState } from '../server/printer.mjs'

const state = () => ({
  webhooks: { state: 'ready' },
  print_stats: { state: 'standby' },
  idle_timeout: { state: 'Idle' },
  toolhead: { homed_axes: 'xyz', position: [100, 100, 20, 0], axis_minimum: [0, 0, -5], axis_maximum: [355, 361, 330] },
  toolchanger: { has_detection: true, tool_number: 1, detected_tool_number: 1, status: 'ready' },
  configfile: { settings: { heater_bed: { max_temp: 130 }, extruder: { max_temp: 300 }, quad_gantry_level: {}, bed_mesh: {} } },
})

test('homing uses the installed G28 macro; Z requires XY', () => {
  assert.equal(commandFor({ action: 'home', axis: 'all' }, state()).body.script, 'G28')
  const raw = state()
  raw.toolhead.homed_axes = ''
  assert.throws(() => commandFor({ action: 'home', axis: 'z' }, raw), /XY/)
})

test('jog preserves coordinate mode, waits for motion, checks homing and travel limits', () => {
  const raw = state()
  const command = commandFor({ action: 'jog', axis: 'x', distance: -0.1 }, raw)
  assert.match(command.body.script, /G91\nG1 X-0.1 F1800\nM400\nRESTORE_GCODE_STATE.*MOVE=0/)
  raw.toolhead.position[0] = 0
  assert.throws(() => commandFor({ action: 'jog', axis: 'x', distance: -1 }, raw), /Verfahrbereich/)
  raw.toolhead.homed_axes = ''
  assert.throws(() => commandFor({ action: 'jog', axis: 'x', distance: 1 }, raw), /homen/)
})

test('rejects printing, paused, external motion, detection mismatch and arbitrary code', () => {
  for (const value of ['printing', 'paused']) {
    const raw = state()
    raw.print_stats.state = value
    assert.throws(() => commandFor({ action: 'home', axis: 'all' }, raw))
  }
  const raw = state()
  raw.idle_timeout.state = 'Printing'
  assert.throws(() => commandFor({ action: 'jog', axis: 'x', distance: 1 }, raw))
  raw.idle_timeout.state = 'Idle'
  raw.toolchanger.detected_tool_number = 2
  assert.throws(() => commandFor({ action: 'home', axis: 'all' }, raw))
  for (const cmd of [
    { action: 'gcode', script: 'G28' },
    { action: 'home', axis: 'all', script: 'G28' },
    { action: 'jog', axis: 'x\nG28', distance: 1 },
    { action: 'jog', axis: 'x', distance: 101 },
    { action: 'temperature', heater: 'extruder', target: '220' },
    { action: 'temperature', heater: 'extruder', target: 300 },
  ]) {
    assert.throws(() => commandFor(cmd, state()))
  }
})

test('temperature and heater shutdown preserve configured macros, estop bypasses G-code', () => {
  assert.equal(
    commandFor({ action: 'temperature', heater: 'extruder', target: 220 }, state()).body.script,
    'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=220',
  )
  assert.equal(commandFor({ action: 'heaters_off' }, state()).body.script, 'TURN_OFF_HEATERS')
  assert.equal(commandFor({ action: 'emergency_stop' }, null).endpoint, '/printer/emergency_stop')
})

test('cooldown (heaters_off) is blocked while printing and allowed while paused', () => {
  const printing = state()
  printing.print_stats.state = 'printing'
  assert.throws(() => commandFor({ action: 'heaters_off' }, printing), /Drucks gesperrt/)

  const paused = state()
  paused.print_stats.state = 'paused'
  assert.equal(commandFor({ action: 'heaters_off' }, paused).body.script, 'TURN_OFF_HEATERS')
})

test('writes require the exact loopback or explicitly allowed LAN origin, JSON and cockpit header', () => {
  const headers = {
    origin: 'http://127.0.0.1:4173',
    host: '127.0.0.1:4173',
    'x-cockpit-request': '1',
    'content-type': 'application/json',
  }
  assert.equal(sameOriginRequest({ headers }, []), true)
  for (const origin of ['https://example.com', 'http://127.0.0.1:4174', 'null', 'http://evil.test']) {
    assert.equal(sameOriginRequest({ headers: { ...headers, origin } }, []), false)
  }
  assert.equal(sameOriginRequest({ headers: { ...headers, 'x-cockpit-request': undefined } }, []), false)

  // Explicit trusted LAN origin
  const lanHeaders = {
    origin: 'http://printer.local:4173',
    host: 'printer.local:4173',
    'x-cockpit-request': '1',
    'content-type': 'application/json',
  }
  assert.equal(sameOriginRequest({ headers: lanHeaders }, []), false)
  assert.equal(sameOriginRequest({ headers: lanHeaders }, ['http://printer.local:4173']), true)
  assert.equal(sameOriginRequest({ headers: { ...lanHeaders, host: 'other.local:4173' } }, ['http://printer.local:4173']), false)
})

test('mock transport: serializes commands over WS, allows direct stop, keeps ambiguous results locked', async t => {
  const httpSent = []
  const wsSent = []
  let activeSocket = null
  let shouldDropWs = false

  class MockWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      activeSocket = this
      setImmediate(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(payload) {
      const parsed = JSON.parse(payload)
      wsSent.push(parsed)
      if (shouldDropWs) {
        setImmediate(() => {
          this.readyState = 3
          this.onclose?.()
        })
      }
    }
    close() {
      this.readyState = 3
    }
    respondOk(id = 1) {
      this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result: 'ok' }) })
    }
  }

  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!opts?.method) return { ok: true, json: async () => ({ result: { status: state(), objects: [] } }) }
    httpSent.push({ url, body: JSON.parse(opts.body) })
    if (url.endsWith('/printer/emergency_stop')) return { ok: true, json: async () => ({ result: 'ok' }) }
    throw new Error('Unexpected HTTP POST for G-code')
  })

  const waitFor = async (predicate, ms = 500) => {
    const deadline = Date.now() + ms
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  }

  // Start homing via WS RPC and verify concurrent request is blocked
  const first = control({ action: 'home', axis: 'all' }, { WebSocketImpl: MockWebSocket })
  await waitFor(() => wsSent.length >= 1)
  await assert.rejects(control({ action: 'home', axis: 'all' }, { WebSocketImpl: MockWebSocket }), /läuft noch/)

  // Resolve WS script cleanly
  activeSocket.respondOk(1)
  await first
  assert.equal(wsSent[0].method, 'printer.gcode.script')
  assert.equal(wsSent[0].params.script, 'G28')
  assert.equal(getControlState().job, null)

  // Direct emergency stop aborts an active WS job immediately
  const second = control({ action: 'home', axis: 'all' }, { WebSocketImpl: MockWebSocket })
  await waitFor(() => wsSent.length >= 2)
  await control({ action: 'emergency_stop' })
  assert.equal(httpSent[0].url.endsWith('/printer/emergency_stop'), true)
  await assert.rejects(second, /Not-Aus/)
  assert.equal(getControlState().job, null)

  // Unexpected WS drop marks job uncertain and locks until acknowledge
  shouldDropWs = true
  await assert.rejects(
    control({ action: 'home', axis: 'x' }, { WebSocketImpl: MockWebSocket }),
    /nicht automatisch wiederholt/,
  )
  assert.equal(getControlState().job.uncertain, true)
  await assert.rejects(
    control({ action: 'temperature', heater: 'extruder', target: 220 }, { WebSocketImpl: MockWebSocket }),
    /läuft noch/,
  )
  await control({ action: 'acknowledge' })
  assert.equal(getControlState().job, null)
  await assert.rejects(control(null), /Ungültiger/)
})

test('startup homing accepts one detected tool before initialization, other motion stays blocked', () => {
  const raw = state()
  raw.toolchanger.status = 'uninitialized'
  raw.toolchanger.tool_number = -1
  raw.toolhead.homed_axes = ''
  raw['tool T1'] = { detect_state: 1 }
  assert.equal(commandFor({ action: 'home', axis: 'all' }, raw).body.script, 'G28')
  assert.throws(() => commandFor({ action: 'motors_off' }, raw), /Werkzeugerkennung/)
  raw['tool T2'] = { detect_state: 1 }
  assert.throws(() => commandFor({ action: 'home', axis: 'all' }, raw), /Mehrere/)
  delete raw['tool T2']
  raw.toolchanger.status = 'ready'
  assert.throws(() => commandFor({ action: 'home', axis: 'all' }, raw), /Werkzeugerkennung/)
})

test('console accepts explicit single commands but rejects malformed input and unready Klipper', () => {
  assert.equal(commandFor({ action: 'console', script: ' DEBUG_TOOL_DETECTION ' }, state()).body.script, 'DEBUG_TOOL_DETECTION')
  for (const script of ['', null, 'G28\nM112', 'X'.repeat(501), 'G28\u0000']) {
    assert.throws(() => commandFor({ action: 'console', script }, state()))
  }
  const raw = state()
  raw.webhooks.state = 'shutdown'
  assert.throws(() => commandFor({ action: 'console', script: 'G28' }, raw), /nicht bereit/)
})

test('large jog steps keep homing and travel-limit checks', () => {
  for (const distance of [25, 50, 100]) {
    assert.match(commandFor({ action: 'jog', axis: 'x', distance }, state()).body.script, new RegExp(`G1 X${distance} F1800`))
  }
  const raw = state()
  raw.toolhead.position[0] = 300
  assert.throws(() => commandFor({ action: 'jog', axis: 'x', distance: 100 }, raw), /Verfahrbereich/)
  raw.toolhead.homed_axes = ''
  assert.throws(() => commandFor({ action: 'jog', axis: 'z', distance: 25 }, raw), /homen/)
})

test('all-tools heating sets exactly six tools, leaves bed alone, and respects every limit', () => {
  const raw = state()
  for (let id = 1; id < 6; id++) raw.configfile.settings[`extruder${id}`] = { max_temp: 300 }
  for (const target of [0, 140, 210, 240, 255]) {
    const script = commandFor({ action: 'temperature_all', target }, raw).body.script
    assert.equal(script.split('\n').length, 6)
    for (let id = 0; id < 6; id++) {
      assert.ok(script.includes(`HEATER=${id ? `extruder${id}` : 'extruder'} TARGET=${target}`))
    }
    assert.ok(!script.includes('heater_bed'))
  }
  for (const target of [-1, 300, 140.5, '140', null]) {
    assert.throws(() => commandFor({ action: 'temperature_all', target }, raw), /Temperaturgrenzen/)
  }
  raw.configfile.settings.extruder5.max_temp = 140
  assert.throws(() => commandFor({ action: 'temperature_all', target: 140 }, raw), /Temperaturgrenzen/)
  delete raw.configfile.settings.extruder5
  assert.throws(() => commandFor({ action: 'temperature_all', target: 140 }, raw), /Temperaturgrenzen/)
  for (const printState of ['printing', 'paused']) {
    raw.print_stats.state = printState
    assert.throws(() => commandFor({ action: 'temperature_all', target: 140 }, raw), /gesperrt/)
  }
  raw.print_stats.state = 'standby'
  raw.idle_timeout.state = 'Printing'
  assert.throws(() => commandFor({ action: 'temperature_all', target: 140 }, raw), /gesperrt/)
})

test('move_to validates homed axis, travel bounds, and preserves coordinate mode in absolute G1 moves', () => {
  const raw = state()
  const moveX = commandFor({ action: 'move_to', axis: 'x', target: 175.5 }, raw)
  assert.match(moveX.body.script, /^SAVE_GCODE_STATE NAME=DOCKYARD_UI_MOVE\nG90\nG1 X175\.5 F3000\nM400\nRESTORE_GCODE_STATE/)
  assert.equal(moveX.label, 'X auf 175.5 mm')

  const moveZ = commandFor({ action: 'move_to', axis: 'z', target: 50 }, raw)
  assert.match(moveZ.body.script, /G90\nG1 Z50 F600\nM400/)
  assert.equal(moveZ.label, 'Z auf 50 mm')

  for (const bad of [
    { action: 'move_to', axis: 'e', target: 10 },
    { action: 'move_to', axis: 'x', target: -1 },
    { action: 'move_to', axis: 'x', target: 356 },
    { action: 'move_to', axis: 'y', target: 362 },
    { action: 'move_to', axis: 'z', target: -6 },
    { action: 'move_to', axis: 'z', target: 331 },
    { action: 'move_to', axis: 'y', target: '100' },
    { action: 'move_to', axis: 'x', target: Number.NaN },
  ]) {
    assert.throws(() => commandFor(bad, raw))
  }

  const unhomed = state()
  unhomed.toolhead.homed_axes = 'xy'
  assert.throws(() => commandFor({ action: 'move_to', axis: 'z', target: 20 }, unhomed), /homen/)

  const printing = state()
  printing.print_stats.state = 'printing'
  assert.throws(() => commandFor({ action: 'move_to', axis: 'x', target: 100 }, printing), /gesperrt/)
})
