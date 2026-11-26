import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  normalizeSpool,
  spoolToToolMaterial,
  createSpoolmanReader,
} from '../server/spoolman.mjs'
import { createSettingsStore } from '../server/settings.mjs'
import { createModelStore } from '../server/models.mjs'
import { createPrinterRuntime } from '../server/printer.mjs'

function listen(middleware) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404
        res.end('not found')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

const sampleSpools = [
  {
    id: 12,
    remaining_weight: 410.44,
    initial_weight: 1000,
    lot_nr: 'L-12',
    archived: false,
    filament: {
      name: 'Jet Black',
      material: 'PLA',
      color_hex: '#111618',
      vendor: { name: 'Prusament' },
    },
  },
  {
    id: 7,
    remaining_weight: 742.36,
    initial_weight: 1000,
    archived: false,
    filament: {
      name: 'Voron Red',
      material: 'ABS',
      color_hex: 'd62828',
      vendor: { name: 'Polymaker' },
    },
  },
  {
    id: 19,
    remaining_weight: 880,
    archived: false,
    filament: {
      name: 'Rainbow Silk',
      material: 'PLA',
      color_hex: '',
      multi_color_hexes: 'ff00aa,00ffaa',
    },
  },
]

test('normalizeSpool and spoolToToolMaterial handle raw hex, multi-color fallback, missing vendor and invalid records', () => {
  assert.equal(normalizeSpool(null), null)
  assert.equal(normalizeSpool({ id: 'bad' }), null)

  const s7 = normalizeSpool(sampleSpools[1])
  assert.equal(s7.id, 7)
  assert.equal(s7.color, '#d62828')
  assert.equal(s7.vendor, 'Polymaker')
  assert.equal(s7.material, 'ABS')
  assert.equal(s7.remainingWeight, 742.4)

  const s19 = normalizeSpool(sampleSpools[2])
  assert.equal(s19.color, '#ff00aa')
  assert.equal(s19.vendor, null)

  // Null / empty weights must stay null, never coerce to 0 g
  const sNullWeight = normalizeSpool({
    id: 21,
    remaining_weight: null,
    initial_weight: '',
    filament: { name: 'Unweighed ABS', material: 'ABS' },
  })
  assert.equal(sNullWeight.remainingWeight, null)
  assert.equal(sNullWeight.initialWeight, null)

  const mat = spoolToToolMaterial(s7)
  assert.equal(mat.source, 'Spoolman')
  assert.equal(mat.type, 'ABS')
  assert.equal(mat.name, 'Polymaker Voron Red')
  assert.equal(mat.color, '#d62828')
  assert.equal(mat.spoolId, 7)
  assert.equal(mat.remainingWeight, 742.4)
})

test('createSpoolmanReader backs off silently on 404, fetches active spool via proxy, resets on switch and invalidates on demand', async () => {
  let calls = 0
  const reader404 = createSpoolmanReader('http://v01.local', async () => {
    calls++
    return { ok: false, status: 404, json: async () => ({}) }
  })
  reader404.read()
  await new Promise(r => setTimeout(r, 20))
  const s1 = reader404.read()
  assert.deepEqual(s1, { available: false, connected: false, spoolId: null, activeSpool: null })
  assert.equal(calls, 1) // backed off, did not re-query immediately

  let activeId = 7
  let notified = 0
  const reader = createSpoolmanReader(
    'http://v24.local',
    async (url, init) => {
      if (url.endsWith('/server/spoolman/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { spoolman_connected: true, spool_id: activeId } }),
        }
      }
      if (url.endsWith('/server/spoolman/proxy')) {
        const body = JSON.parse(init.body)
        const id = Number(body.path.split('/').pop())
        const found = sampleSpools.find(s => s.id === id)
        return { ok: true, status: 200, json: async () => ({ result: found }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    },
    () => {
      notified++
    },
  )

  reader.read()
  await new Promise(r => setTimeout(r, 30))
  const loaded = reader.read()
  assert.equal(loaded.available, true)
  assert.equal(loaded.connected, true)
  assert.equal(loaded.spoolId, 7)
  assert.equal(loaded.activeSpool.name, 'Voron Red')
  assert.ok(notified >= 1)

  activeId = 12
  reader.invalidate()
  reader.read()
  await new Promise(r => setTimeout(r, 30))
  assert.equal(reader.read().activeSpool.id, 12)

  reader.reset()
  assert.deepEqual(reader.read(), { available: false, connected: false, spoolId: null, activeSpool: null })
})

test('HTTP /api/spoolman/spools, /api/spoolman/active and /api/status precedence work end-to-end', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-spoolman-http-'))
  let server
  try {
    const store = createSettingsStore({
      filePath: path.join(dir, 'settings.json'),
      env: { PRINTER_URL: 'http://mock-v24', PRINTER_NAME: 'VORON 2.4' },
    })
    const modelStore = createModelStore({ dir: path.join(dir, 'models') })

    let activeSpoolId = 7
    let spoolmanEnabled = true
    const postedSpoolIds = []

    const mockFetch = async (url, init = {}) => {
      const u = String(url)
      if (u.includes('/printer/objects/list')) {
        return { ok: true, status: 200, json: async () => ({ result: { objects: ['extruder', 'heater_bed', 'print_stats'] } }) }
      }
      if (u.includes('/printer/objects/query')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              status: {
                webhooks: { state: 'ready' },
                extruder: { temperature: 210, target: 210, power: 0.4 },
                heater_bed: { temperature: 60, target: 60, power: 0.2 },
                print_stats: { state: 'printing', filename: 'benchy.gcode' },
                toolhead: { homed_axes: 'xyz', position: [10, 20, 5, 0] },
                configfile: { settings: { stepper_x: { position_max: 350 }, stepper_y: { position_max: 350 } } },
              },
            },
          }),
        }
      }
      if (u.includes('/server/files/metadata')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: { slicer: 'OrcaSlicer', filament_type: ['PLA'], filament_colors: ['#00ff00'] },
          }),
        }
      }
      if (u.includes('/server/spoolman/status')) {
        if (!spoolmanEnabled) return { ok: false, status: 404, json: async () => ({}) }
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: { spoolman_connected: true, spool_id: activeSpoolId } }),
        }
      }
      if (u.includes('/server/spoolman/spool_id') && init.method === 'POST') {
        const body = JSON.parse(init.body)
        postedSpoolIds.push(body.spool_id)
        activeSpoolId = body.spool_id
        return { ok: true, status: 200, json: async () => ({ result: { spool_id: activeSpoolId } }) }
      }
      if (u.includes('/server/spoolman/proxy')) {
        if (!spoolmanEnabled) return { ok: false, status: 404, json: async () => ({}) }
        const body = JSON.parse(init.body)
        if (body.path === '/v1/spool') {
          return { ok: true, status: 200, json: async () => ({ result: sampleSpools }) }
        }
        const id = Number(body.path.split('/').pop())
        const found = sampleSpools.find(s => s.id === id)
        return { ok: true, status: 200, json: async () => ({ result: found }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }

    const runtime = createPrinterRuntime({ store, modelStore, fetchImpl: mockFetch })
    const started = await listen(runtime.printerMiddleware)
    server = started.server
    const { base } = started

    // GET /api/spoolman/spools sorts active spool (7) first
    const listRes = await fetch(`${base}/api/spoolman/spools`)
    assert.equal(listRes.status, 200)
    const listData = await listRes.json()
    assert.equal(listData.activeSpoolId, 7)
    assert.equal(listData.spools.length, 3)
    assert.equal(listData.spools[0].id, 7)

    // Untrusted origin blocked (403)
    const forbidden = await fetch(`${base}/api/spoolman/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-Cockpit-Request': '1' },
      body: JSON.stringify({ spoolId: 12 }),
    })
    assert.equal(forbidden.status, 403)

    // Invalid spoolId rejected (400)
    const badReq = await fetch(`${base}/api/spoolman/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Cockpit-Request': '1' },
      body: JSON.stringify({ spoolId: -5 }),
    })
    assert.equal(badReq.status, 400)

    // Trigger initial status fetch so background Spoolman + Materials readers populate
    await fetch(`${base}/api/status`)
    await new Promise(r => setTimeout(r, 40))
    const statusWithSpool = await (await fetch(`${base}/api/status`)).json()
    assert.equal(statusWithSpool.spoolman.activeSpool.id, 7)
    assert.equal(statusWithSpool.tools[0].material.source, 'Spoolman')
    assert.equal(statusWithSpool.tools[0].material.color, '#d62828')

    // Switch active spool to 12 and verify immediate /api/status reflects it synchronously (0ms delay)
    const switchRes = await fetch(`${base}/api/spoolman/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Cockpit-Request': '1' },
      body: JSON.stringify({ spoolId: 12 }),
    })
    assert.equal(switchRes.status, 200)
    const switched = await switchRes.json()
    assert.equal(switched.spoolId, 12)
    assert.equal(switched.activeSpool.name, 'Jet Black')
    assert.deepEqual(postedSpoolIds, [12])

    const immediateStatus = await (await fetch(`${base}/api/status`)).json()
    assert.equal(immediateStatus.spoolman.activeSpool.id, 12)
    assert.equal(immediateStatus.tools[0].material.color, '#111618')

    // Clear active spool (null) -> falls back to 1-slot slicer metadata on printing single-tool
    const clearRes = await fetch(`${base}/api/spoolman/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Cockpit-Request': '1' },
      body: JSON.stringify({ spoolId: null }),
    })
    assert.equal(clearRes.status, 200)
    await fetch(`${base}/api/status`)
    await new Promise(r => setTimeout(r, 40))
    const statusFallback = await (await fetch(`${base}/api/status`)).json()
    assert.equal(statusFallback.spoolman.activeSpool, null)
    assert.equal(statusFallback.tools[0].material.source, 'OrcaSlicer')
    assert.equal(statusFallback.tools[0].material.color, '#00ff00')

    // When Spoolman disabled on Moonraker -> /api/spoolman/spools returns 404
    spoolmanEnabled = false
    const noSpoolman = await fetch(`${base}/api/spoolman/spools`)
    assert.equal(noSpoolman.status, 404)

    runtime.closeLiveFeed()
  } finally {
    server?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
