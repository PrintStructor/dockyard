import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseAllowedOrigins, resolvePrinterName } from '../server/config.mjs'
import { resolveStaticPath, createProductionServer } from '../server/start.mjs'
import { resolveMainsailUrl } from '../src/printer-ui-url.mjs'
import { normalizePresets } from '../server/presets.mjs'

test('resolveMainsailUrl uses explicit URL or derives same-host root URL when unset/auto', () => {
  assert.equal(
    resolveMainsailUrl('http://printer.example/', { protocol: 'http:', hostname: '127.0.0.1' }),
    'http://printer.example/',
  )
  assert.equal(
    resolveMainsailUrl('auto', { protocol: 'http:', hostname: 'printer.local' }),
    'http://printer.local/',
  )
  assert.equal(
    resolveMainsailUrl('', { protocol: 'https:', hostname: 'voron.example' }),
    'https://voron.example/',
  )
  assert.equal(
    resolveMainsailUrl(undefined, { protocol: 'http:', hostname: '::1' }),
    'http://[::1]/',
  )
  assert.equal(resolveMainsailUrl('auto', null), 'http://127.0.0.1/')
})

test('normalizePresets prefers Mainsail presets, falls back to legacy DB and safe defaults', () => {
  const fromMainsail = normalizePresets({
    mainsail: {
      presets: {
        a: {
          name: 'ABS all tools & bed',
          values: {
            heater_bed: { bool: true, value: '110' },
            extruder: { bool: true, value: '260' },
            extruder1: { bool: true, value: '260' },
            extruder2: { bool: true, value: '260' },
            extruder3: { bool: true, value: '260' },
            extruder4: { bool: true, value: '260' },
            extruder5: { bool: true, value: '260' },
          },
        },
        b: {
          name: 'BEACON ABS',
          values: { heater_bed: { bool: true, value: '110' }, extruder: { bool: true, value: '150' } },
        },
      },
    },
    legacy: [{ name: 'PLA', temps: { extruder: 215, heater_bed: 65 } }],
  })
  assert.deepEqual(fromMainsail, [
    { name: 'ABS', bed: 110, tools: [260, 260, 260, 260, 260, 260] },
    { name: 'PLA', bed: 65, tools: [215, 215, 215, 215, 215, 215] },
    { name: 'PETG', bed: 80, tools: [240, 240, 240, 240, 240, 240] },
    { name: 'BEACON ABS', bed: 110, tools: [150, 150, 150, 150, 150, 150] },
  ])

  const defaultsOnly = normalizePresets()
  assert.equal(defaultsOnly.length, 3)
  assert.deepEqual(
    defaultsOnly.map(p => [p.name, p.bed, p.tools[0]]),
    [
      ['ABS', 110, 255],
      ['PLA', 60, 210],
      ['PETG', 80, 240],
    ],
  )
})

test('parseAllowedOrigins validates strict HTTP(S) origins without paths or credentials', () => {
  assert.deepEqual(parseAllowedOrigins(''), [])
  assert.deepEqual(parseAllowedOrigins('http://printer.local:4173, https://voron.example'), [
    'http://printer.local:4173',
    'https://voron.example',
  ])
  for (const invalid of ['ftp://host', 'http://user:pass@host', 'http://host/path', 'http://host?a=1']) {
    assert.throws(() => parseAllowedOrigins(invalid))
  }
})

test('resolvePrinterName separates configurable printer badge from DOCKYARD brand', () => {
  assert.equal(resolvePrinterName({}), 'STORMTROOPER')
  assert.equal(resolvePrinterName({ PRINTER_NAME: '  VORON-LAB  ' }), 'VORON-LAB')
  assert.equal(resolvePrinterName({ PRINTER_NAME: '' }), '')
  assert.equal(resolvePrinterName({ VITE_PRINTER_NAME: 'ATLAS' }), 'ATLAS')
})

test('resolveStaticPath blocks directory traversal outside dist root', () => {
  const root = '/tmp/dockyard-dist'
  assert.equal(resolveStaticPath('/', root), path.join(root, 'index.html'))
  assert.equal(resolveStaticPath('/assets/app.js', root), path.join(root, 'assets/app.js'))
  assert.equal(resolveStaticPath('/../.env.local', root), null)
  assert.equal(resolveStaticPath('/%2e%2e/server/config.mjs', root), null)
})

test('standalone production server serves static files, API routes, and disables requestTimeout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dockyard-dist-'))
  await mkdir(path.join(dir, 'assets'))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><body>OK</body></html>')
  await writeFile(path.join(dir, 'assets', 'main.js'), 'console.log("ok")')

  const server = createProductionServer({ rootDir: dir })
  assert.equal(server.requestTimeout, 0)

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  try {
    const html = await fetch(`${base}/`)
    assert.equal(html.status, 200)
    assert.match(html.headers.get('content-type'), /text\/html/)
    assert.equal(html.headers.get('cache-control'), 'no-store')
    assert.match(await html.text(), /OK/)

    const asset = await fetch(`${base}/assets/main.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('cache-control'), /immutable/)

    const api404 = await fetch(`${base}/api/nonexistent`)
    assert.equal(api404.status, 404)
    assert.match(api404.headers.get('content-type'), /application\/json/)

    const badMethod = await fetch(`${base}/`, { method: 'POST' })
    assert.equal(badMethod.status, 405)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
