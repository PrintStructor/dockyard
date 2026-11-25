import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function startMockMoonraker(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

import { createSettingsStore } from '../server/settings.mjs'
import { createPrinterRuntime } from '../server/printer.mjs'

async function startCockpitWithTempSettings() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-api-'))
  const settingsPath = path.join(dir, '.dockyard-settings.json')
  const store = createSettingsStore({
    filePath: settingsPath,
    env: {
      PRINTER_URL: 'http://127.0.0.1:1',
      PRINTER_NAME: 'STORMTROOPER',
    },
  })
  const { printerMiddleware, closeLiveFeed, control, getControlState } = createPrinterRuntime({ store })

  const server = http.createServer((req, res) => {
    printerMiddleware(req, res, () => {
      res.statusCode = 404
      res.end('Not Found')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const postJson = (urlPath, body, extraHeaders = {}) =>
    fetch(`${base}${urlPath}`, {
      method: 'POST',
      headers: {
        Origin: base,
        'X-Cockpit-Request': '1',
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    })

  return {
    base,
    port,
    store,
    control,
    getControlState,
    postJson,
    async cleanup() {
      closeLiveFeed()
      await new Promise(resolve => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('GET/POST /api/settings works offline, switches printers, tests connections, and guards self-lockout', async () => {
  const mockA = await startMockMoonraker((req, res) => {
    if (req.url === '/server/info') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result: { moonraker_version: 'v0.9.3-10', klippy_state: 'ready' } }))
      return
    }
    if (req.url === '/printer/info') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result: { hostname: 'voron-storm', software_version: 'v0.12.0' } }))
      return
    }
    if (req.url === '/redirect') {
      res.statusCode = 302
      res.setHeader('Location', 'http://127.0.0.1/')
      res.end()
      return
    }
    if (req.url === '/webcam/webrtc' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ type: 'answer', sdp: 'v=0' }))
      return
    }
    if (req.url === '/webcam/snapshot' || req.url === '/ustream/?action=snapshot') {
      res.setHeader('Content-Type', 'image/jpeg')
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      return
    }
    if (req.url === '/webcam/stream' || req.url === '/ustream/?action=stream') {
      res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
      res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\nDATA\r\n')
      res.end()
      return
    }
    if (req.url === '/printer/objects/list') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result: { objects: ['webhooks', 'print_stats', 'idle_timeout', 'toolhead'] } }))
      return
    }
    if (req.url?.startsWith('/printer/objects/query')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          result: {
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'standby' },
              idle_timeout: { state: 'Idle' },
              toolhead: { homed_axes: 'xyz' },
              configfile: { settings: {} },
            },
          },
        }),
      )
      return
    }
    res.statusCode = 404
    res.end()
  })

  const redirectServer = await startMockMoonraker((req, res) => {
    res.statusCode = 302
    res.setHeader('Location', mockA.url + '/server/info')
    res.end()
  })

  let app = null
  try {
    app = await startCockpitWithTempSettings()
    // 1. GET /api/settings works even while printer is offline (port 1)
    const getRes = await fetch(`${app.base}/api/settings`)
    assert.equal(getRes.status, 200)
    const initial = await getRes.json()
    assert.equal(initial.activePrinter.name, 'STORMTROOPER')
    assert.equal(initial.runtime.canWrite, true)

    // 2. POST /api/settings/test probes real mock Moonraker cleanly
    const testOkRes = await app.postJson('/api/settings/test', { url: mockA.url })
    assert.equal(testOkRes.status, 200)
    const testOk = await testOkRes.json()
    assert.equal(testOk.ok, true)
    assert.equal(testOk.moonrakerVersion, 'v0.9.3-10')
    assert.equal(testOk.klippyState, 'ready')
    assert.equal(testOk.hostname, 'voron-storm')
    assert.ok(Number.isFinite(testOk.latencyMs))

    // 3. Blocked SSRF metadata URL -> 400
    const testSsrfRes = await app.postJson('/api/settings/test', { url: 'http://169.254.169.254' })
    assert.equal(testSsrfRes.status, 400)

    // 4. Redirect response on probe -> ok: false (redirect: 'error')
    const testRedirRes = await app.postJson('/api/settings/test', { url: redirectServer.url })
    assert.equal(testRedirRes.status, 200)
    const testRedir = await testRedirRes.json()
    assert.equal(testRedir.ok, false)

    // 5. Save 2 VORON profiles including an mjpeg (ustreamer) camera
    const saveRes = await app.postJson('/api/settings', {
      activePrinterId: 'stormtrooper',
      printers: [
        {
          id: 'stormtrooper',
          name: 'STORMTROOPER',
          subtitle: 'VORON 2.4 / 6-Toolchanger',
          url: mockA.url,
          mainsailUrl: 'auto',
          cameras: [
            { id: 'tophat', name: 'Tophat', service: 'camera-streamer', url: '/webcam', enabled: true },
            { id: 'disabled_cam', name: 'Off', service: 'camera-streamer', url: '/webcam2', enabled: false },
          ],
        },
        {
          id: 'voron-v0',
          name: 'VORON-V0',
          subtitle: 'VORON 0.2',
          url: mockA.url,
          mainsailUrl: 'auto',
          cameras: [
            {
              id: 'v0cam',
              name: 'V0 Chamber',
              service: 'mjpeg',
              url: '/ustream/?action=stream',
              snapshotUrl: '/ustream/?action=snapshot',
              enabled: true,
            },
          ],
        },
      ],
      network: {
        allowedOrigins: [],
        allowLanOrigins: true,
      },
    })
    assert.equal(saveRes.status, 200)
    const saved = await saveRes.json()
    assert.equal(saved.printerUrlChanged, true)
    assert.equal(saved.printers.length, 2)

    // 6. Dynamic cameras on Profile A (camera-streamer works; disabled returns 404)
    const rtcRes = await app.postJson('/api/camera/tophat/webrtc', { type: 'request' })
    assert.equal(rtcRes.status, 200)
    const disRes = await fetch(`${app.base}/api/camera/disabled_cam`)
    assert.equal(disRes.status, 404)

    // 7. Create an uncertain lock on Printer A via broken WS, then switch to Printer B -> lock hidden on B, restored on A!
    class DroppingWS {
      constructor() {
        this.readyState = 1
        setImmediate(() => this.onopen?.())
      }
      send() {
        setImmediate(() => this.onclose?.())
      }
      close() {
        this.readyState = 3
      }
    }
    await assert.rejects(() => app.control({ action: 'motors_off' }, { WebSocketImpl: DroppingWS }))
    assert.equal(app.getControlState().job?.uncertain, true)

    // Switch to VORON-V0 -> uncertain lock is isolated per printerId!
    const switchB = await app.postJson('/api/settings/switch', { printerId: 'voron-v0' })
    assert.equal(switchB.status, 200)
    assert.equal(app.getControlState().job, null)

    // 8. On VORON-V0, mjpeg camera serves /stream & snapshot, rejects /webrtc with 404
    const v0Rtc = await app.postJson('/api/camera/v0cam/webrtc', { type: 'request' })
    assert.equal(v0Rtc.status, 404)
    const v0Snap = await fetch(`${app.base}/api/camera/v0cam`)
    assert.equal(v0Snap.status, 200)
    const v0Stream = await fetch(`${app.base}/api/camera/v0cam/stream`)
    assert.equal(v0Stream.status, 200)
    assert.ok((await v0Stream.text()).includes('DATA'))

    // 9. Cross-printer config save protection: saving with expectedPrinterId='stormtrooper' while on 'voron-v0' -> 409 PRINTER_CHANGED!
    const mismatchSave = await app.postJson('/api/system/config/save', {
      path: 'printer.cfg',
      content: '[printer]\nkinematics: corexy\n',
      expectedPrinterId: 'stormtrooper',
    })
    assert.equal(mismatchSave.status, 409)
    const mismatchBody = await mismatchSave.json()
    assert.equal(mismatchBody.code, 'PRINTER_CHANGED')

    // 10. Switch back to STORMTROOPER -> Printer A's unacknowledged uncertain lock is preserved!
    const switchA = await app.postJson('/api/settings/switch', { printerId: 'stormtrooper' })
    assert.equal(switchA.status, 200)
    assert.equal(app.getControlState().job?.uncertain, true)

    // 11. Self-lockout guard for non-loopback LAN client disabling allowLanOrigins
    const lanSaveRes = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        activePrinterId: 'stormtrooper',
        printers: saved.printers,
        network: { allowedOrigins: [], allowLanOrigins: false },
      })
      const req = http.request(
        {
          host: '127.0.0.1',
          port: app.port,
          path: '/api/settings',
          method: 'POST',
          headers: {
            Host: `192.168.50.12:${app.port}`,
            Origin: `http://192.168.50.12:${app.port}`,
            'X-Cockpit-Request': '1',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        res => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
    assert.equal(lanSaveRes.status, 400)
    assert.equal(lanSaveRes.body.code, 'SELF_LOCKOUT')

    // 12. Open-redirect protection across Moonraker proxy routes (/api/system/config/file, /api/console, /api/status)
    const switchToRedirect = await app.postJson('/api/settings', {
      activePrinterId: 'redir',
      printers: [
        {
          id: 'redir',
          name: 'REDIR',
          subtitle: '',
          url: redirectServer.url,
          mainsailUrl: 'auto',
          cameras: [],
        },
      ],
      network: { allowedOrigins: [], allowLanOrigins: false },
    })
    assert.equal(switchToRedirect.status, 200)
    const consoleRedir = await fetch(`${app.base}/api/console`)
    assert.equal(consoleRedir.status, 502)
    const cfgListRedir = await fetch(`${app.base}/api/system/config/list`)
    assert.equal(cfgListRedir.status, 502)
    const statusRedir = await fetch(`${app.base}/api/status`)
    assert.equal(statusRedir.status, 502)
  } finally {
    await app?.cleanup()
    await mockA.close()
    await redirectServer.close()
  }
})
