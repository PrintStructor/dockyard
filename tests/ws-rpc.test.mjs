import test from 'node:test'
import assert from 'node:assert/strict'
import { executeGcodeScript, AbortedCommandError } from '../server/ws-rpc.mjs'
import { control, getControlState } from '../server/printer.mjs'

function createFakeWsClass(handler) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      setImmediate(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(raw) {
      handler(this, JSON.parse(raw))
    }
    close() {
      this.readyState = 3
    }
  }
}

test('executeGcodeScript executes via Moonraker WS JSON-RPC and handles heartbeats', async () => {
  let pings = 0
  const WS = createFakeWsClass((socket, msg) => {
    if (msg.method === 'server.info') {
      pings++
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { klippy_state: 'ready' } }) })
      if (pings >= 2) {
        socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) })
      }
    }
  })

  const result = await executeGcodeScript({
    printer: 'http://127.0.0.1:1977',
    script: 'QUAD_GANTRY_LEVEL',
    heartbeatMs: 15,
    heartbeatTimeoutMs: 50,
    timeoutMs: 1000,
    WebSocketImpl: WS,
  })
  assert.equal(result, 'ok')
  assert.ok(pings >= 2)
})

test('executeGcodeScript rejects on heartbeat timeout, Moonraker error, and abort signal', async () => {
  // Heartbeat timeout
  const SilentWS = createFakeWsClass(() => {})
  await assert.rejects(
    executeGcodeScript({
      printer: 'http://127.0.0.1:1977',
      script: 'G28',
      heartbeatMs: 15,
      heartbeatTimeoutMs: 25,
      timeoutMs: 1000,
      WebSocketImpl: SilentWS,
    }),
    /antwortet nicht mehr/,
  )

  // Explicit Klipper error
  const ErrorWS = createFakeWsClass((socket, msg) => {
    if (msg.id === 1) {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Must home first' } }) })
    }
  })
  await assert.rejects(
    executeGcodeScript({
      printer: 'http://127.0.0.1:1977',
      script: 'G1 X10',
      WebSocketImpl: ErrorWS,
    }),
    /Must home first/,
  )

  // AbortSignal cancellation
  const abortController = new AbortController()
  const pending = executeGcodeScript({
    printer: 'http://127.0.0.1:1977',
    script: 'G28',
    signal: abortController.signal,
    WebSocketImpl: SilentWS,
  })
  setTimeout(() => abortController.abort(), 15)
  await assert.rejects(pending, err => err instanceof AbortedCommandError)
})

test('async bulk load_all executes sequentially over WS with step progress and aborts on emergency stop', async t => {
  const config = Object.fromEntries(
    ['park_toolhead', 'pickup_tool', 'clean_nozzle', 'purge_nozzle', 'load_filament', 'unload_filament', '_load_settings', '_unload_settings', '_goto_purge_pos', '_purge_pos'].map(
      name => [`gcode_macro ${name}`, { gcode: 'installed' }],
    ),
  )
  const raw = {
    'gcode_macro _LOAD_SETTINGS': { temp_default: 240 },
    'gcode_macro _UNLOAD_SETTINGS': { temp_default: 235 },
    webhooks: { state: 'ready' },
    print_stats: { state: 'standby' },
    idle_timeout: { state: 'Idle' },
    toolhead: { homed_axes: 'xyz', position: [100, 100, 20, 0] },
    toolchanger: { has_detection: true, tool_number: 0, detected_tool_number: 0, status: 'ready' },
    configfile: { settings: config },
  }
  for (let i = 0; i < 6; i++) {
    config[`gcode_macro t${i}`] = {}
    config[`tool t${i}`] = {}
    config[i ? `extruder${i}` : 'extruder'] = { max_temp: 300, min_extrude_temp: 170 }
    raw[`filament_switch_sensor T${i}_filament_sensor`] = { enabled: true, filament_detected: i < 3 }
  }

  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts?.method === 'POST' && url.endsWith('/printer/emergency_stop')) {
      return { ok: true, json: async () => ({ result: 'ok' }) }
    }
    return { ok: true, json: async () => ({ result: { status: raw, objects: [] } }) }
  })

  const executedScripts = []
  const sockets = []
  const StepWS = createFakeWsClass((socket, msg) => {
    if (msg.method === 'printer.gcode.script') {
      executedScripts.push(msg.params.script)
      sockets.push(socket)
    }
  })

  const accepted = await control({ action: 'load_all' }, { async: true, WebSocketImpl: StepWS })
  assert.equal(accepted.statusCode, 202)
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.job.stepTotal, 3)

  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(executedScripts.length, 1)
  assert.equal(executedScripts[0], 'LOAD_FILAMENT T=0\nM400')
  assert.equal(getControlState().job.stepIndex, 1)
  assert.equal(getControlState().job.step, 'T0 laden')

  // Complete step 1 -> step 2 begins
  sockets[0].onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(executedScripts.length, 2)
  assert.equal(executedScripts[1], 'LOAD_FILAMENT T=1\nM400')
  assert.equal(getControlState().job.stepIndex, 2)

  // Press Emergency Stop mid-step 2 -> step 3 must NEVER run
  await control({ action: 'emergency_stop' })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(executedScripts.length, 2)
  assert.equal(getControlState().job, null)
})
