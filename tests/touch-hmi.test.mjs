import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import {
  isTouchAppMode,
  resolveTouchConfig,
  withPrinterParam,
  buildTouchKioskUrl,
  buildDesktopExitUrl,
  DEFAULT_SLEEP_SECONDS,
} from '../src/touch/touch-config.mjs'
import { createLiveFeed } from '../server/live.mjs'
import { createSettingsStore } from '../server/settings.mjs'
import { createPrinterRuntime } from '../server/printer.mjs'

async function waitForCondition(predicate, timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('Paket T1 config: URL parameters parse touch/printer/lock/cursor/sleep/lang and build clean kiosk/exit URLs', () => {
  assert.equal(isTouchAppMode(''), false)
  assert.equal(isTouchAppMode('?display=1'), false)
  assert.equal(isTouchAppMode('?touch=1'), true)
  assert.equal(isTouchAppMode('?screen=1'), true)
  assert.equal(isTouchAppMode('?hmi=true'), true)

  const cfg = resolveTouchConfig('?touch=1&printer=v0-1&lock=1&cursor=0&sleep=120&lang=en')
  assert.deepEqual(cfg, {
    touch: true,
    printerId: 'v0-1',
    locked: true,
    hideCursor: true,
    sleepSeconds: 120,
    lang: 'en',
  })

  // Malformed printer id and out-of-range sleep fall back safely
  const safe = resolveTouchConfig('?touch=1&printer=../evil&sleep=-5&lang=fr')
  assert.equal(safe.printerId, '')
  assert.equal(safe.sleepSeconds, DEFAULT_SLEEP_SECONDS)
  assert.equal(safe.lang, '')

  assert.equal(withPrinterParam('/api/status', 'v0'), '/api/status?printer=v0')
  assert.equal(withPrinterParam('/api/events?lite=1', 'v0'), '/api/events?lite=1&printer=v0')
  assert.equal(withPrinterParam('/api/status', ''), '/api/status')

  assert.equal(
    buildTouchKioskUrl({ origin: 'http://192.168.178.188:4173', printerId: 'v0', locked: true, hideCursor: true }),
    'http://192.168.178.188:4173/?touch=1&printer=v0&lock=1&cursor=0',
  )
  assert.equal(
    buildDesktopExitUrl('http://192.168.178.188:4173/?touch=1&printer=v0&lock=1&cursor=0&foo=bar'),
    '/?foo=bar',
  )
})

test('Paket T1 CSS contract: touch.css has zero box-shadows and zero undefined CSS custom properties', async () => {
  const css = await readFile(new URL('../src/touch/touch.css', import.meta.url), 'utf8')
  assert.equal(/box-shadow\s*:/i.test(css), false, 'touch.css must not use box-shadow')

  const defined = new Set()
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
    defined.add(m[1])
  }
  const missing = []
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(?:,|\))/gi)) {
    if (!defined.has(m[1])) missing.push(m[1])
  }
  assert.deepEqual(missing, [], `Undefined CSS variables in touch.css: ${missing.join(', ')}`)
})

test('Paket T1 ?lite=1 SSE: suppresses LED-only spam, throttles bursts with trailing flush, and notifies immediately on force', async () => {
  let activeSocket = null

  class LiteWS {
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
            data: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { objects: ['heater_bed', 'neopixel et0_leds'] },
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
                  heater_bed: { temperature: 25 },
                  'neopixel et0_leds': { color_data: [[0, 0, 0, 0]] },
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
    baseObjects: ['heater_bed', 'neopixel et0_leds'],
    snapshot: raw => ({ bed: raw.heater_bed?.temperature, led: raw['neopixel et0_leds']?.color_data?.[0]?.[0] }),
    WebSocketImpl: LiteWS,
    ledPollMs: 500,
    pingIntervalMs: 1000,
    liteThrottleMs: 80,
  })

  const makeClient = url => {
    const events = []
    return {
      events,
      req: { url },
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
    const fullClient = makeClient('/api/events')
    const liteClient = makeClient('/api/events?lite=1')
    feed.handle(fullClient.req, fullClient.res)
    feed.handle(liteClient.req, liteClient.res)
    await waitForCondition(() => fullClient.events.some(e => e.event === 'status'))
    assert.equal(liteClient.events.filter(e => e.event === 'status').length, 1)

    // LED-only poll frame -> full client gets it, lite client MUST ignore it
    activeSocket.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        result: { status: { 'neopixel et0_leds': { color_data: [[1, 0, 0, 0]] } } },
      }),
    })
    assert.equal(fullClient.events.filter(e => e.event === 'status').length, 2)
    assert.equal(liteClient.events.filter(e => e.event === 'status').length, 1)

    // Burst of 3 rapid bed temp updates -> lite throttles and flushes latest trailing value (28)
    for (const temp of [26, 27, 28]) {
      activeSocket.onmessage?.({
        data: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notify_status_update',
          params: [{ heater_bed: { temperature: temp } }],
        }),
      })
    }
    assert.equal(fullClient.events.filter(e => e.event === 'status').length, 5)
    assert.equal(liteClient.events.filter(e => e.event === 'status').length, 1)

    await waitForCondition(() => liteClient.events.filter(e => e.event === 'status').length >= 2)
    const liteStatuses = liteClient.events.filter(e => e.event === 'status')
    assert.equal(liteStatuses.length, 2)
    assert.equal(liteStatuses[1].data.bed, 28)

    // Explicit notify() bypasses throttle immediately
    feed.notify()
    assert.equal(liteClient.events.filter(e => e.event === 'status').length, 3)
  } finally {
    feed.close()
  }
})

test('Paket T1 Multi-Printer Isolation: ?printer=<id> stays pinned to its printer regardless of global activePrinter switches', async () => {
  function startMockMoonraker(label, bedTemp) {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('Content-Type', 'application/json')
      if (u.pathname === '/printer/objects/list') {
        return res.end(JSON.stringify({ result: { objects: ['webhooks', 'print_stats', 'heater_bed', 'extruder', 'configfile'] } }))
      }
      if (u.pathname === '/printer/objects/query') {
        return res.end(
          JSON.stringify({
            result: {
              status: {
                webhooks: { state: 'ready', state_message: label },
                print_stats: { state: 'standby', filename: '' },
                heater_bed: { temperature: bedTemp, target: 0, power: 0 },
                extruder: { temperature: 24, target: 0, power: 0 },
                configfile: { settings: { extruder: { max_temp: 300 }, heater_bed: { max_temp: 120 } } },
              },
            },
          }),
        )
      }
      res.statusCode = 404
      res.end('{}')
    })
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
      })
    })
  }

  const m1 = await startMockMoonraker('STORMTROOPER', 61)
  const m2 = await startMockMoonraker('VORON-V0', 108)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-t1-multi-'))
  const store = createSettingsStore({
    filePath: path.join(dir, '.dockyard-settings.json'),
    env: { PRINTER_URL: m1.url, PRINTER_NAME: 'STORMTROOPER' },
  })
  const cur = store.getSettings()
  await store.saveSettings({
    activePrinterId: 'stormtrooper',
    printers: [
      { ...cur.printers[0], id: 'stormtrooper', name: 'STORMTROOPER', url: m1.url },
      { ...cur.printers[0], id: 'v0', name: 'VORON-V0', url: m2.url },
    ],
    network: cur.network,
  })

  const runtime = createPrinterRuntime({ store })
  const apiServer = http.createServer((req, res) => runtime.printerMiddleware(req, res, () => res.end('next')))
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve))
  const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`

  try {
    // 1. Default route hits global active printer (stormtrooper, bed=61)
    const defRes = await fetch(`${apiOrigin}/api/status`)
    assert.equal(defRes.status, 200)
    const defData = await defRes.json()
    assert.equal(defData.activePrinterId, 'stormtrooper')
    assert.equal(defData.bed.temperature, 61)

    // 2. Scoped ?printer=v0 hits VORON-V0 (bed=108) while global remains stormtrooper!
    const v0Res = await fetch(`${apiOrigin}/api/status?printer=v0`)
    assert.equal(v0Res.status, 200)
    const v0Data = await v0Res.json()
    assert.equal(v0Data.activePrinterId, 'v0')
    assert.equal(v0Data.bed.temperature, 108)

    // 3. Switch global active printer to v0 -> pinned ?printer=stormtrooper STILL reads stormtrooper (61)!
    const swRes = await fetch(`${apiOrigin}/api/settings/switch`, {
      method: 'POST',
      headers: { Origin: apiOrigin, 'X-Cockpit-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: 'v0' }),
    })
    assert.equal(swRes.status, 200)

    const pinnedTcRes = await fetch(`${apiOrigin}/api/status?printer=stormtrooper`)
    assert.equal(pinnedTcRes.status, 200)
    const pinnedTcData = await pinnedTcRes.json()
    assert.equal(pinnedTcData.activePrinterId, 'stormtrooper')
    assert.equal(pinnedTcData.bed.temperature, 61)

    // 4. Unknown printer returns 404
    const missingRes = await fetch(`${apiOrigin}/api/status?printer=ghost`)
    assert.equal(missingRes.status, 404)
  } finally {
    runtime.closeLiveFeed()
    apiServer.close()
    m1.server.close()
    m2.server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
