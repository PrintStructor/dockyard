import test from 'node:test'
import assert from 'node:assert/strict'
import { createLiveFeed } from '../server/live.mjs'

test('live feed suppresses idle LED poll broadcasts, emits on diff, sends ping and pushes console output', async () => {
  const sentToWs = []
  let activeSocket = null

  class FakeWS {
    constructor(url) {
      this.url = url
      this.readyState = 1
      activeSocket = this
      setImmediate(() => this.onopen?.())
    }
    send(payload) {
      const msg = JSON.parse(payload)
      sentToWs.push(msg)
      if (msg.id === 1) {
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { objects: ['toolchanger', 'neopixel et0_leds'] },
            }),
          }),
        )
      } else if (msg.id === 2) {
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: {
                status: {
                  toolchanger: { status: 'ready' },
                  'neopixel et0_leds': { color_data: [[0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
                },
              },
            }),
          }),
        )
      }
    }
    close() {
      this.readyState = 3
    }
  }

  const feed = createLiveFeed({
    printer: 'http://127.0.0.1:1977',
    baseObjects: ['toolchanger', 'neopixel et0_leds'],
    snapshot: raw => ({ tc: raw.toolchanger?.status, led0: raw['neopixel et0_leds']?.color_data?.[0] }),
    WebSocketImpl: FakeWS,
    ledPollMs: 40,
    pingIntervalMs: 80,
  })

  const events = []
  const closeListeners = []
  const fakeRes = {
    destroyed: false,
    writableLength: 0,
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      const match = chunk.match(/^event: (\w+)\ndata: (.+)\n\n$/s)
      if (match) events.push({ event: match[1], data: JSON.parse(match[2]) })
    },
    end() {},
    destroy() {},
    on(event, fn) {
      if (event === 'close') closeListeners.push(fn)
    },
  }

  feed.handle({}, fakeRes)
  await new Promise(resolve => setTimeout(resolve, 30))

  // Initial subscribe emits 1 status event
  assert.equal(events.filter(e => e.event === 'status').length, 1)

  // Simulate unchanged LED poll response -> must NOT emit another status event!
  activeSocket.onmessage?.({
    data: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      result: {
        status: {
          'neopixel et0_leds': { color_data: [[0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
        },
      },
    }),
  })
  assert.equal(events.filter(e => e.event === 'status').length, 1)

  // Simulate changed LED color -> MUST emit immediately!
  activeSocket.onmessage?.({
    data: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      result: {
        status: {
          'neopixel et0_leds': { color_data: [[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
        },
      },
    }),
  })
  assert.equal(events.filter(e => e.event === 'status').length, 2)
  assert.deepEqual(events.filter(e => e.event === 'status')[1].data.led0, [1, 0, 0, 0])

  // Simulate notify_gcode_response -> pushes console event immediately
  activeSocket.onmessage?.({
    data: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notify_gcode_response',
      params: ['// Tool T1 connected'],
    }),
  })
  const consoleEvents = events.filter(e => e.event === 'console')
  assert.equal(consoleEvents.length, 1)
  assert.equal(consoleEvents[0].data.message, '// Tool T1 connected')
  assert.equal(consoleEvents[0].data.type, 'response')

  // Wait for idle ping heartbeat
  await new Promise(resolve => setTimeout(resolve, 110))
  assert.ok(events.some(e => e.event === 'ping'))

  // Explicit notify() forces immediate status broadcast
  const beforeNotify = events.filter(e => e.event === 'status').length
  feed.notify()
  assert.equal(events.filter(e => e.event === 'status').length, beforeNotify + 1)

  feed.close()
})
