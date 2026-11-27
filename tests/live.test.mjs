import test from 'node:test'
import assert from 'node:assert/strict'
import { createLiveFeed, createPromptParser } from '../server/live.mjs'

async function waitForCondition(predicate, timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

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
  await waitForCondition(() => events.some(e => e.event === 'status'))

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
  await waitForCondition(() => events.some(e => e.event === 'ping'))
  assert.ok(events.some(e => e.event === 'ping'))

  // Explicit notify() forces immediate status broadcast
  const beforeNotify = events.filter(e => e.event === 'status').length
  feed.notify()
  assert.equal(events.filter(e => e.event === 'status').length, beforeNotify + 1)

  feed.close()
})

test('live feed accelerates LED polling while colors animate and relaxes when static', async () => {
  let animate = false
  let frame = 0
  const ledQueries = []

  class AnimatedWS {
    constructor() {
      this.readyState = 1
      setImmediate(() => this.onopen?.())
    }
    send(payload) {
      const msg = JSON.parse(payload)
      if (msg.id === 1) {
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { objects: ['neopixel et0_leds'] } }),
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
                  'neopixel et0_leds': { color_data: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
                },
              },
            }),
          }),
        )
      } else if (msg.id === 3) {
        ledQueries.push(Date.now())
        if (animate) frame += 1
        const r = animate ? (frame % 10) / 10 : 0
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              result: {
                status: {
                  'neopixel et0_leds': { color_data: [[r, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
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
    baseObjects: ['neopixel et0_leds'],
    snapshot: raw => ({ led0: raw['neopixel et0_leds']?.color_data?.[0] }),
    WebSocketImpl: AnimatedWS,
    ledPollMs: 140,
    activeLedPollMs: 25,
    ledActiveWindowMs: 120,
    pingIntervalMs: 1000,
  })

  const fakeRes = {
    destroyed: false,
    writableLength: 0,
    setHeader() {},
    flushHeaders() {},
    write() {},
    end() {},
    destroy() {},
    on() {},
  }

  try {
    feed.handle({}, fakeRes)
    // Static phase: over ~180 ms with 140 ms idle interval -> at most 2 polls
    await new Promise(resolve => setTimeout(resolve, 180))
    const staticCount = ledQueries.length
    assert.ok(staticCount >= 1 && staticCount <= 2, `expected 1-2 static polls, got ${staticCount}`)

    // Start animation: next poll sees a diff -> polling accelerates to ~25 ms
    animate = true
    const beforeAnim = ledQueries.length
    await new Promise(resolve => setTimeout(resolve, 260))
    const animPolls = ledQueries.length - beforeAnim
    assert.ok(animPolls >= 4, `expected >= 4 accelerated polls during animation, got ${animPolls}`)

    // Stop animation and let active window expire -> polling relaxes back to ~140 ms
    animate = false
    await new Promise(resolve => setTimeout(resolve, 180))
    const afterCooldown = ledQueries.length
    await new Promise(resolve => setTimeout(resolve, 190))
    const relaxedPolls = ledQueries.length - afterCooldown
    assert.ok(relaxedPolls <= 2, `expected <= 2 relaxed polls after cooldown, got ${relaxedPolls}`)
  } finally {
    feed.close()
  }
})

test('live feed reconnects dynamically via getPrinter and broadcasts settings events', async () => {
  const connectedUrls = []
  let activeUrl = 'http://127.0.0.1:7101'

  class DynamicWS {
    constructor(url) {
      this.url = url
      this.readyState = 1
      connectedUrls.push(url)
      setImmediate(() => this.onopen?.())
    }
    send(payload) {
      const msg = JSON.parse(payload)
      if (msg.id === 1) {
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { objects: ['toolchanger'] } }),
          }),
        )
      } else if (msg.id === 2) {
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: { status: { toolchanger: { status: this.url } } },
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
    getPrinter: () => activeUrl,
    baseObjects: ['toolchanger'],
    snapshot: raw => ({ tc: raw.toolchanger?.status }),
    WebSocketImpl: DynamicWS,
    ledPollMs: 200,
    pingIntervalMs: 1000,
  })

  const events = []
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
    on() {},
  }

  try {
    feed.handle({}, fakeRes)
    await waitForCondition(() => events.some(e => e.event === 'status'))
    assert.equal(connectedUrls[0], 'ws://127.0.0.1:7101/websocket')
    assert.equal(events.filter(e => e.event === 'status').at(-1)?.data.tc, 'ws://127.0.0.1:7101/websocket')

    activeUrl = 'https://192.168.50.22'
    feed.emitSettings({ activePrinterId: 'v0', printerUrlChanged: true })
    feed.reconnect()
    await waitForCondition(() => events.filter(e => e.event === 'status').length >= 2)

    assert.ok(events.some(e => e.event === 'settings' && e.data.activePrinterId === 'v0'))
    assert.ok(events.some(e => e.event === 'offline'))
    assert.equal(connectedUrls[1], 'wss://192.168.50.22/websocket')
    assert.equal(events.filter(e => e.event === 'status').at(-1)?.data.tc, 'wss://192.168.50.22/websocket')
  } finally {
    feed.close()
  }
})

test('live feed polls discovered sb_leds on single-tool and skips LED polling when printer has zero neopixels', async () => {
  const runScenario = async objectsList => {
    const ledQueries = []
    class SingleToolWS {
      constructor() {
        this.readyState = 1
        setImmediate(() => this.onopen?.())
      }
      send(payload) {
        const msg = JSON.parse(payload)
        if (msg.id === 1) {
          setImmediate(() =>
            this.onmessage?.({
              data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { objects: objectsList } }),
            }),
          )
        } else if (msg.id === 2) {
          setImmediate(() =>
            this.onmessage?.({
              data: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                result: { status: { webhooks: { state: 'ready' }, extruder: { temperature: 25 } } },
              }),
            }),
          )
        } else if (msg.id === 3) {
          ledQueries.push(Object.keys(msg.params?.objects ?? {}))
          setImmediate(() =>
            this.onmessage?.({
              data: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { status: {} } }),
            }),
          )
        }
      }
      close() {
        this.readyState = 3
      }
    }

    const events = []
    const feed = createLiveFeed({
      printer: 'http://127.0.0.1:1978',
      baseObjects: ['webhooks', 'extruder'],
      snapshot: raw => ({ state: raw.webhooks?.state }),
      WebSocketImpl: SingleToolWS,
      ledPollMs: 30,
      pingIntervalMs: 70,
    })
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
      on() {},
    }
    try {
      feed.handle({}, fakeRes)
      await waitForCondition(() => events.some(e => e.event === 'ping'))
      return { events, ledQueries }
    } finally {
      feed.close()
    }
  }

  const withSb = await runScenario(['webhooks', 'extruder', 'neopixel sb_leds'])
  assert.ok(withSb.ledQueries.length >= 1)
  assert.deepEqual(withSb.ledQueries[0], ['neopixel sb_leds'])

  const withoutLeds = await runScenario(['webhooks', 'extruder', 'temperature_sensor skr_pico'])
  assert.ok(withoutLeds.events.some(e => e.event === 'status'))
  assert.ok(withoutLeds.events.some(e => e.event === 'ping'))
  assert.equal(withoutLeds.ledQueries.length, 0)
})

test('live feed polls hyphenated sb-leds and skips long >8-LED enclosure strips', async () => {
  const runWithInitial = async (objectsList, initialStatus) => {
    const ledQueries = []
    class StripWS {
      constructor() {
        this.readyState = 1
        setImmediate(() => this.onopen?.())
      }
      send(payload) {
        const msg = JSON.parse(payload)
        if (msg.id === 1) {
          setImmediate(() =>
            this.onmessage?.({
              data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { objects: objectsList } }),
            }),
          )
        } else if (msg.id === 2) {
          setImmediate(() =>
            this.onmessage?.({
              data: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { status: initialStatus } }),
            }),
          )
        } else if (msg.id === 3) {
          ledQueries.push(Object.keys(msg.params?.objects ?? {}))
          setImmediate(() =>
            this.onmessage?.({
              data: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { status: {} } }),
            }),
          )
        }
      }
      close() {
        this.readyState = 3
      }
    }

    const events = []
    const feed = createLiveFeed({
      printer: 'http://127.0.0.1:1979',
      baseObjects: ['webhooks', 'extruder'],
      snapshot: raw => ({ state: raw.webhooks?.state }),
      WebSocketImpl: StripWS,
      ledPollMs: 30,
      pingIntervalMs: 70,
    })
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
      on() {},
    }
    try {
      feed.handle({}, fakeRes)
      await waitForCondition(() => events.some(e => e.event === 'ping'))
      return { events, ledQueries }
    } finally {
      feed.close()
    }
  }

  const hyphenated = await runWithInitial(
    ['webhooks', 'extruder', 'neopixel sb-leds'],
    { webhooks: { state: 'ready' }, 'neopixel sb-leds': { color_data: [[1, 1, 1, 0], [0, 1, 0, 0], [0, 1, 0, 0]] } },
  )
  assert.ok(hyphenated.ledQueries.length >= 1)
  assert.deepEqual(hyphenated.ledQueries[0], ['neopixel sb-leds'])

  const caselight = await runWithInitial(
    ['webhooks', 'extruder', 'neopixel caselight'],
    {
      webhooks: { state: 'ready' },
      'neopixel caselight': { color_data: Array.from({ length: 24 }, () => [1, 1, 1, 0]) },
    },
  )
  assert.equal(caselight.ledQueries.length, 0)
})

test('Paket D2: createPromptParser parses Klipper action:prompt_* protocol and live feed replays open prompt', async () => {
  const parser = createPromptParser()

  assert.equal(parser.feed('// action:prompt_begin Filamentwechsel'), null)
  assert.equal(parser.feed('// action:prompt_text Bitte neues Filament einlegen.'), null)
  assert.equal(parser.feed('// action:prompt_button_group_start'), null)
  assert.equal(parser.feed('// action:prompt_button Laden|LOAD_FILAMENT|primary'), null)
  assert.equal(parser.feed('// action:prompt_button Abbrechen|CANCEL_PRINT|error'), null)
  assert.equal(parser.feed('// action:prompt_button_group_end'), null)
  assert.equal(parser.feed('// action:prompt_footer_button Fortsetzen|RESUME|warning'), null)
  assert.equal(parser.getActive(), null)

  const shown = parser.feed('// action:prompt_show')
  assert.ok(shown)
  assert.equal(shown.open, true)
  assert.equal(shown.title, 'Filamentwechsel')
  assert.equal(shown.items.length, 2)
  assert.equal(shown.items[0].kind, 'text')
  assert.equal(shown.items[1].kind, 'group')
  assert.equal(shown.items[1].buttons.length, 2)
  assert.equal(shown.items[1].buttons[0].gcode, 'LOAD_FILAMENT')
  assert.equal(shown.footerButtons[0].gcode, 'RESUME')
  assert.equal(parser.getActive()?.title, 'Filamentwechsel')

  const closed = parser.feed('// action:prompt_end')
  assert.deepEqual(closed, { open: false })
  assert.equal(parser.getActive(), null)

  // End-to-end replay via createLiveFeed SSE
  let activeSocket = null
  class PromptWS {
    constructor() {
      this.readyState = 1
      activeSocket = this
      setImmediate(() => this.onopen?.())
    }
    send(payload) {
      const msg = JSON.parse(payload)
      if (msg.id === 1) {
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { objects: ['webhooks'] } }),
          }),
        )
      } else if (msg.id === 2) {
        setImmediate(() =>
          this.onmessage?.({
            data: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { status: { webhooks: { state: 'ready' } } } }),
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
    baseObjects: ['webhooks'],
    snapshot: raw => ({ ok: raw.webhooks?.state === 'ready' }),
    WebSocketImpl: PromptWS,
    ledPollMs: 500,
    pingIntervalMs: 500,
  })

  const mkRes = () => {
    const events = []
    return {
      events,
      res: {
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
        on() {},
      },
    }
  }

  try {
    const c1 = mkRes()
    feed.handle({}, c1.res)
    await waitForCondition(() => c1.events.some(e => e.event === 'status'))

    activeSocket.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notify_gcode_response',
        params: ['// action:prompt_begin Test\n// action:prompt_button OK|M118 OK|primary\n// action:prompt_show'],
      }),
    })
    assert.ok(c1.events.some(e => e.event === 'prompt' && e.data.open === true && e.data.title === 'Test'))
    assert.equal(feed.getActivePrompt()?.title, 'Test')

    // Second client joining later receives the open prompt immediately!
    const c2 = mkRes()
    feed.handle({}, c2.res)
    assert.ok(c2.events.some(e => e.event === 'prompt' && e.data.open === true && e.data.title === 'Test'))
  } finally {
    feed.close()
  }
})
