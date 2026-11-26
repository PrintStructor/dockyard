import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore } from '../server/settings.mjs'
import { createModelStore, MAX_MODEL_BYTES } from '../server/models.mjs'
import { createPrinterRuntime } from '../server/printer.mjs'
import { makeValidGlb } from './models.test.mjs'

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

test('HTTP /api/models/:printerId/:slot enforces origin, printer existence, GLB validation, 25 MB limit, ETag/304, delete and profile cascade cleanup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-models-http-'))
  let server
  try {
    const store = createSettingsStore({
      filePath: path.join(dir, 'settings.json'),
      env: { PRINTER_URL: 'http://127.0.0.1:7125', PRINTER_NAME: 'VORON 24' },
    })
    await store.saveSettings({
      activePrinterId: 'voron24',
      printers: [
        { id: 'voron24', name: 'VORON 2.4', url: 'http://127.0.0.1:7125', model: { preset: 'stealthburner' }, cameras: [] },
        { id: 'crucible', name: 'Crucible', url: 'http://127.0.0.1:7126', model: { preset: 'custom' }, cameras: [] },
      ],
      network: { allowedOrigins: [], allowLanOrigins: false },
    })
    const modelStore = createModelStore({ dir: path.join(dir, 'models') })
    const runtime = createPrinterRuntime({ store, modelStore })
    const started = await listen(runtime.printerMiddleware)
    server = started.server
    const { base } = started

    const glb = makeValidGlb({ asset: { version: '2.0' } }, Buffer.from([1, 2, 3, 4]))

    // 403 on untrusted Origin
    const r403 = await fetch(`${base}/api/models/voron24/printer`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-Cockpit-Request': '1' },
      body: glb,
    })
    assert.equal(r403.status, 403)

    // 404 on unknown/unsaved printer ID
    const r404 = await fetch(`${base}/api/models/unsaved-printer/printer`, {
      method: 'POST',
      headers: { Origin: base, 'X-Cockpit-Request': '1' },
      body: glb,
    })
    assert.equal(r404.status, 404)

    // 400 on invalid binary
    const r400 = await fetch(`${base}/api/models/voron24/printer`, {
      method: 'POST',
      headers: { Origin: base, 'X-Cockpit-Request': '1', 'X-Model-Filename': 'bad.stl' },
      body: Buffer.from('solid fake\nendsolid\n'),
    })
    assert.equal(r400.status, 400)

    // 413 on > 25 MB upload
    const oversized = Buffer.alloc(MAX_MODEL_BYTES + 1024)
    const r413 = await fetch(`${base}/api/models/voron24/printer`, {
      method: 'POST',
      headers: { Origin: base, 'X-Cockpit-Request': '1' },
      body: oversized,
    })
    assert.equal(r413.status, 413)

    // 200 valid upload enriches returned settings
    const r200 = await fetch(`${base}/api/models/voron24/printer`, {
      method: 'POST',
      headers: {
        Origin: base,
        'X-Cockpit-Request': '1',
        'X-Model-Filename': encodeURIComponent('voron24-350.glb'),
        'Content-Type': 'model/gltf-binary',
      },
      body: glb,
    })
    assert.equal(r200.status, 200)
    const uploaded = await r200.json()
    assert.equal(uploaded.ok, true)
    assert.equal(uploaded.meta.filename, 'voron24-350.glb')
    assert.equal(uploaded.settings.activePrinter.customModels.printer.filename, 'voron24-350.glb')

    // GET returns binary + ETag + nosniff
    const getRes = await fetch(`${base}/api/models/voron24/printer`)
    assert.equal(getRes.status, 200)
    assert.equal(getRes.headers.get('content-type'), 'model/gltf-binary')
    assert.equal(getRes.headers.get('x-content-type-options'), 'nosniff')
    const etag = getRes.headers.get('etag')
    assert.ok(etag)
    assert.equal(Buffer.compare(Buffer.from(await getRes.arrayBuffer()), glb), 0)

    // GET with matching If-None-Match returns 304
    const res304 = await fetch(`${base}/api/models/voron24/printer`, { headers: { 'If-None-Match': etag } })
    assert.equal(res304.status, 304)

    // DELETE removes slot
    const delRes = await fetch(`${base}/api/models/voron24/printer`, {
      method: 'DELETE',
      headers: { Origin: base, 'X-Cockpit-Request': '1' },
    })
    assert.equal(delRes.status, 200)
    const deleted = await delRes.json()
    assert.equal(deleted.settings.activePrinter.customModels.printer, null)

    const afterDel = await fetch(`${base}/api/models/voron24/printer`)
    assert.equal(afterDel.status, 404)

    // Upload to crucible, then delete crucible profile via POST /api/settings -> disk cleaned up
    const upCruc = await fetch(`${base}/api/models/crucible/toolhead`, {
      method: 'POST',
      headers: { Origin: base, 'X-Cockpit-Request': '1', 'X-Model-Filename': 'crucible.glb' },
      body: glb,
    })
    assert.equal(upCruc.status, 200)
    assert.ok(modelStore.describePrinter('crucible').toolhead)

    const saveRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { Origin: base, 'X-Cockpit-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activePrinterId: 'voron24',
        printers: [
          { id: 'voron24', name: 'VORON 2.4', url: 'http://127.0.0.1:7125', model: { preset: 'stealthburner' }, cameras: [] },
        ],
        network: { allowedOrigins: [], allowLanOrigins: false },
      }),
    })
    assert.equal(saveRes.status, 200)
    assert.deepEqual(modelStore.describePrinter('crucible'), { toolhead: null, printer: null })

    runtime.closeLiveFeed()
  } finally {
    server?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
