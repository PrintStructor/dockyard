import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseAllowedOrigins } from '../server/config.mjs'
import { resolveStaticPath, createProductionServer } from '../server/start.mjs'

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

test('resolveStaticPath blocks directory traversal outside dist root', () => {
  const root = '/tmp/stormtrooper-dist'
  assert.equal(resolveStaticPath('/', root), path.join(root, 'index.html'))
  assert.equal(resolveStaticPath('/assets/app.js', root), path.join(root, 'assets/app.js'))
  assert.equal(resolveStaticPath('/../.env.local', root), null)
  assert.equal(resolveStaticPath('/%2e%2e/server/config.mjs', root), null)
})

test('standalone production server serves static files, API routes, and disables requestTimeout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'stormtrooper-dist-'))
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
