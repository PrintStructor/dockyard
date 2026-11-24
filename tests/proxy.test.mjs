import test from 'node:test'
import assert from 'node:assert/strict'
import { printerMiddleware } from '../server/printer.mjs'

function request(url, method = 'GET') {
  const result = { statusCode: 200, headers: {}, body: null, next: false }
  const res = { set statusCode(code) { result.statusCode = code }, setHeader(key, value) { result.headers[key] = value }, end(body) { result.body = JSON.parse(body) } }
  printerMiddleware({ url, method }, res, () => { result.next = true })
  return result
}
test('Status- und Snapshot-Routen lehnen Schreibmethoden ab', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = request('/api/status', method)
    assert.equal(r.statusCode, 405)
    assert.equal(r.next, false)
  }
})
test('unbekannte G-Code-Routen und beliebige Zieladressen sind nicht erreichbar', () => {
  for (const path of ['/api/printer/gcode/script?script=T1', '/api/camera/unknown', '/api/proxy?url=http://example.com']) {
    const r = request(path)
    assert.equal(r.statusCode, 404)
    assert.equal(r.next, false)
  }
})
test('lokale Frontend-Dateien werden vom Proxy nicht abgefangen', () => {
  assert.equal(request('/src/App.vue').next, true)
})
