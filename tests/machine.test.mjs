import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { printerMiddleware, control, getControlState } from '../server/printer.mjs'
import {
  MAX_CONFIG_BYTES,
  LOG_TAIL_BYTES,
  LOG_TAIL_MAX_LINES,
  ALLOWED_SYSTEMD_SERVICES,
  validateConfigPath,
  classifyConfigFile,
  normalizeConfigList,
  validateWritableConfigPath,
  validateConfigContent,
  resolveRestartTargetForFile,
  buildConfigUploadFormData,
  validateRestartTarget,
  evaluateMachineWriteGuard,
  normalizeSystemOverview,
  normalizeUpdateStatus,
  validateUpdateTarget,
  filterRelevantReleases,
  validateLogPath,
  normalizeLogList,
  parseLogTail,
  checkExpectedModified,
  encodeMoonrakerPath,
} from '../server/machine.mjs'

test('constants match spec bounds and allowlist', () => {
  assert.equal(MAX_CONFIG_BYTES, 524288)
  assert.equal(LOG_TAIL_BYTES, 131072)
  assert.equal(LOG_TAIL_MAX_LINES, 400)
  assert.deepEqual(ALLOWED_SYSTEMD_SERVICES, [
    'klipper',
    'moonraker',
    'crowsnest',
    'sonar',
    'mobileraker',
    'helixscreen',
    'klipper-mcu',
  ])
})

test('validateConfigPath rejects traversal, hidden themes, control chars and binaries', () => {
  for (const bad of [
    '',
    null,
    '../printer.cfg',
    'atom/../../printer.cfg',
    '%2e%2e/printer.cfg',
    'a\\b.cfg',
    '.theme/custom.css',
    '.theme/favicon.png',
    'foo\0bar.cfg',
    'foo\nbar.cfg',
    '/printer.cfg',
    'config-20260404.zip',
    'ShakeTune_results/input_shaper/a.png',
    'logo.svg',
    'firmware.bin',
    'data.stdata',
  ]) {
    assert.equal(validateConfigPath(bad), null, `expected ${JSON.stringify(bad)} to be rejected`)
  }

  for (const ok of [
    'printer.cfg',
    'atom/tool0.cfg',
    'Margt NEW/macros.cfg',
    'printer.cfg.bak-20260902-1001',
    'backup/old.cfg',
    'moonraker.conf',
    'notes.txt',
    'README.md',
    'settings.json',
    'helper.sh',
    'tool.py',
    'printer-20260105_014004.cfg-old',
    'moonraker.conf.2026-04-18-1025.bkp',
  ]) {
    assert.equal(validateConfigPath(ok), ok, `expected ${ok} to be accepted`)
  }
})

test('classifyConfigFile and normalizeConfigList enforce backup, script and permission readonly rules', () => {
  const entries = [
    { path: '.theme/custom.css', size: 100, modified: 10, permissions: 'rw' },
    { path: 'config.zip', size: 5000, modified: 10, permissions: 'rw' },
    { path: 'ShakeTune_results/belts/b.png', size: 5000, modified: 10, permissions: 'rw' },
    { path: 'printer.cfg', size: 33400, modified: 100, permissions: 'rw' },
    { path: 'mainsail.cfg', size: 16400, modified: 90, permissions: 'r' },
    { path: 'notes.txt', size: 120, modified: 80, permissions: 'rw' },
    { path: 'settings.json', size: 220, modified: 80, permissions: 'rw' },
    { path: 'printer.cfg.bak-20260902-1001', size: 33700, modified: 70, permissions: 'rw' },
    { path: 'moonraker.conf.2026-04-18-1025.bkp', size: 3900, modified: 70, permissions: 'rw' },
    { path: 'printer.cfg.full-20261123-0930', size: 33900, modified: 70, permissions: 'rw' },
    { path: 'printer.cfg.ring-20261123-1007', size: 33900, modified: 70, permissions: 'rw' },
    { path: 'printer-20260105.cfg-old', size: 26600, modified: 70, permissions: 'rw' },
    { path: 'backup/old.cfg', size: 1200, modified: 60, permissions: 'rw' },
    { path: 'backups/v1.cfg', size: 1200, modified: 60, permissions: 'rw' },
    { path: 'atom/helper.sh', size: 500, modified: 50, permissions: 'rw' },
    { path: 'atom/tool.py', size: 600, modified: 50, permissions: 'rw' },
  ]

  assert.equal(classifyConfigFile(entries[0]), null)
  assert.equal(classifyConfigFile(entries[1]), null)
  assert.equal(classifyConfigFile(entries[2]), null)

  const list = normalizeConfigList(entries)
  const byPath = Object.fromEntries(list.map(item => [item.path, item]))

  assert.equal(byPath['printer.cfg'].readonly, false)
  assert.equal(byPath['printer.cfg'].isBackup, false)
  assert.equal(byPath['printer.cfg'].dir, '')

  assert.equal(byPath['mainsail.cfg'].readonly, true)
  assert.equal(byPath['mainsail.cfg'].isBackup, false)

  assert.equal(byPath['notes.txt'].readonly, false)
  assert.equal(byPath['settings.json'].readonly, false)

  for (const bkp of [
    'printer.cfg.bak-20260902-1001',
    'moonraker.conf.2026-04-18-1025.bkp',
    'printer.cfg.full-20261123-0930',
    'printer.cfg.ring-20261123-1007',
    'printer-20260105.cfg-old',
    'backup/old.cfg',
    'backups/v1.cfg',
  ]) {
    assert.equal(byPath[bkp].isBackup, true, `${bkp} should be backup`)
    assert.equal(byPath[bkp].readonly, true, `${bkp} should be readonly`)
  }

  assert.equal(byPath['atom/helper.sh'].isScript, true)
  assert.equal(byPath['atom/helper.sh'].readonly, true)
  assert.equal(byPath['atom/tool.py'].isScript, true)
  assert.equal(byPath['atom/tool.py'].readonly, true)
})

test('validateWritableConfigPath allows active config/text files and rejects readonly, backups and scripts', () => {
  const ok = validateWritableConfigPath('atom/tool0.cfg', {
    path: 'atom/tool0.cfg',
    permissions: 'rw',
    size: 100,
    modified: 10,
  })
  assert.deepEqual(ok, { path: 'atom/tool0.cfg', dir: 'atom', name: 'tool0.cfg' })

  assert.throws(
    () => validateWritableConfigPath('mainsail.cfg', { path: 'mainsail.cfg', permissions: 'r' }),
    err => err.status === 403,
  )
  assert.throws(
    () => validateWritableConfigPath('printer.cfg.bak-1', { path: 'printer.cfg.bak-1', permissions: 'rw' }),
    err => err.status === 403,
  )
  assert.throws(
    () => validateWritableConfigPath('helper.sh', { path: 'helper.sh', permissions: 'rw' }),
    err => err.status === 403,
  )
  assert.throws(
    () => validateWritableConfigPath('tool.py', { path: 'tool.py', permissions: 'rw' }),
    err => err.status === 403,
  )
  assert.throws(
    () => validateWritableConfigPath('missing.cfg', null),
    err => err.status === 404,
  )
})

test('validateConfigContent enforces string type, no null bytes, and 512 KB cap', () => {
  assert.equal(validateConfigContent('[printer]\nkinematics: corexy\n'), '[printer]\nkinematics: corexy\n')
  assert.throws(() => validateConfigContent(123), err => err.status === 400)
  assert.throws(() => validateConfigContent('abc\0def'), err => err.status === 400)
  assert.throws(() => validateConfigContent('a'.repeat(MAX_CONFIG_BYTES + 1)), err => err.status === 413)
})

test('checkExpectedModified detects SAVE_CONFIG external changes unless forced', () => {
  checkExpectedModified({ expectedModified: 1795500000.123, currentModified: 1795500000.123, force: false })
  assert.throws(
    () => checkExpectedModified({ expectedModified: 1795500000.1, currentModified: 1795500050.2, force: false }),
    err => err.status === 409 && err.code === 'FILE_CHANGED' && err.currentModified === 1795500050.2,
  )
  checkExpectedModified({ expectedModified: 1795500000.1, currentModified: 1795500050.2, force: true })
})

test('buildConfigUploadFormData builds Moonraker multipart payload for root and nested files', () => {
  const rootForm = buildConfigUploadFormData('printer.cfg', '[printer]\n')
  assert.equal(rootForm.get('root'), 'config')
  assert.equal(rootForm.get('path'), null)
  assert.equal(rootForm.get('file').name, 'printer.cfg')

  const nestedForm = buildConfigUploadFormData('atom/tool0.cfg', '[tool T0]\n')
  assert.equal(nestedForm.get('root'), 'config')
  assert.equal(nestedForm.get('path'), 'atom')
  assert.equal(nestedForm.get('file').name, 'tool0.cfg')
})

test('resolveRestartTargetForFile picks context-sensitive restart target', () => {
  assert.equal(resolveRestartTargetForFile('moonraker.conf'), 'moonraker')
  assert.equal(resolveRestartTargetForFile('crowsnest.conf'), 'crowsnest')
  assert.equal(resolveRestartTargetForFile('printer.cfg'), 'klipper_restart')
  assert.equal(resolveRestartTargetForFile('atom/tool0.cfg'), 'klipper_restart')
  assert.equal(resolveRestartTargetForFile('notes.txt'), 'none')
  assert.equal(resolveRestartTargetForFile('README.md'), 'none')
  assert.equal(resolveRestartTargetForFile('settings.json'), 'none')
})

test('evaluateMachineWriteGuard blocks prints/jobs, allows Klippy-down recovery, avoids uncertain deadlock, fails closed when Moonraker down', () => {
  assert.deepEqual(
    evaluateMachineWriteGuard({
      queryStatus: 200,
      queryData: { webhooks: { state: 'ready' }, print_stats: { state: 'standby' }, idle_timeout: { state: 'Idle' } },
      serverInfo: null,
      job: null,
      allowUncertainRecovery: true,
    }),
    { klipperState: 'ready', mode: 'ready' },
  )

  for (const printState of ['printing', 'paused']) {
    assert.throws(
      () =>
        evaluateMachineWriteGuard({
          queryStatus: 200,
          queryData: { webhooks: { state: 'ready' }, print_stats: { state: printState }, idle_timeout: { state: 'Idle' } },
          job: null,
        }),
      err => err.status === 409,
    )
  }

  assert.throws(
    () =>
      evaluateMachineWriteGuard({
        queryStatus: 200,
        queryData: { webhooks: { state: 'ready' }, print_stats: { state: 'standby' }, idle_timeout: { state: 'Printing' } },
        job: null,
      }),
    err => err.status === 409,
  )

  assert.throws(
    () =>
      evaluateMachineWriteGuard({
        queryStatus: 200,
        queryData: { webhooks: { state: 'ready' }, print_stats: { state: 'standby' }, idle_timeout: { state: 'Idle' } },
        job: { id: 1, uncertain: false },
      }),
    err => err.status === 409,
  )

  // Klippy disconnected (503 from objects/query), Moonraker reachable -> recovery allowed.
  assert.deepEqual(
    evaluateMachineWriteGuard({
      queryStatus: 503,
      queryData: null,
      serverInfo: { klippy_connected: false, klippy_state: 'disconnected' },
      job: { id: 2, uncertain: true },
      allowUncertainRecovery: true,
    }),
    { klipperState: 'disconnected', mode: 'recovery' },
  )

  // Klipper shutdown/error + uncertain job -> recovery allowed for Klipper/config (no deadlock).
  assert.deepEqual(
    evaluateMachineWriteGuard({
      queryStatus: 200,
      queryData: { webhooks: { state: 'shutdown' }, print_stats: { state: 'standby' }, idle_timeout: { state: 'Idle' } },
      serverInfo: null,
      job: { id: 3, uncertain: true },
      allowUncertainRecovery: true,
    }),
    { klipperState: 'shutdown', mode: 'recovery' },
  )

  // Uncertain job while Klipper is already ready -> still blocked.
  assert.throws(
    () =>
      evaluateMachineWriteGuard({
        queryStatus: 200,
        queryData: { webhooks: { state: 'ready' }, print_stats: { state: 'standby' }, idle_timeout: { state: 'Idle' } },
        job: { id: 4, uncertain: true },
        allowUncertainRecovery: true,
      }),
    err => err.status === 409,
  )

  // Both query and serverInfo failed -> fail closed 503.
  assert.throws(
    () =>
      evaluateMachineWriteGuard({
        queryStatus: 503,
        queryData: null,
        serverInfo: null,
        job: null,
      }),
    err => err.status === 503,
  )
})

test('validateRestartTarget enforces explicit allowlist and available_services', () => {
  const avail = ['klipper', 'moonraker', 'crowsnest', 'klipper-backup-on-boot']
  assert.equal(validateRestartTarget('klipper_restart', avail).kind, 'klipper')
  assert.equal(validateRestartTarget('firmware_restart', avail).kind, 'firmware')
  assert.deepEqual(validateRestartTarget('crowsnest', avail), {
    kind: 'service',
    service: 'crowsnest',
    label: 'Crowsnest neu starten',
  })

  assert.throws(() => validateRestartTarget('ssh', avail), err => err.status === 400)
  assert.throws(() => validateRestartTarget('klipper-backup-on-boot', avail), err => err.status === 400)
  assert.throws(() => validateRestartTarget('helixscreen', avail), err => err.status === 409)
})

test('normalizeSystemOverview strips private serial numbers and network interfaces', () => {
  const overview = normalizeSystemOverview({
    procStats: {
      cpu_temp: 48.686,
      throttled_state: { bits: 0, flags: [] },
      system_cpu_usage: { cpu: 9.41, cpu0: 7.5 },
      system_uptime: 76496,
      system_memory: { total: 3706980, available: 3167740, used: 539240 },
    },
    systemInfo: {
      cpu_info: {
        cpu_count: 4,
        bits: '64bit',
        model: 'Raspberry Pi 4 Model B Rev 1.5',
        serial_number: '1000000014deeba2',
        total_memory: 3706980,
      },
      distribution: {
        name: 'Debian GNU/Linux 12 (bookworm)',
        release_info: { name: 'MainsailOS', version_id: '2.2.2' },
        kernel_version: '6.12.115+rpt-rpi-v8',
      },
      network: { eth0: { mac_address: 'aa:bb:cc:dd:ee:ff' } },
      available_services: ['klipper', 'moonraker', 'crowsnest', 'klipper-backup-on-boot'],
      service_state: {
        klipper: { active_state: 'active', sub_state: 'running' },
        moonraker: { active_state: 'active', sub_state: 'running' },
        crowsnest: { active_state: 'inactive', sub_state: 'dead' },
      },
    },
    serverInfo: { klippy_connected: true, klippy_state: 'ready' },
  })

  assert.equal(overview.cpuUsage, 9.41)
  assert.equal(overview.cpuCores, 4)
  assert.equal(overview.cpuTemp, 48.686)
  assert.equal(overview.memory.totalBytes, 3706980 * 1024)
  assert.equal(overview.memory.usedBytes, 539240 * 1024)
  assert.equal(overview.uptimeSeconds, 76496)
  assert.deepEqual(overview.throttledFlags, [])
  assert.equal(overview.host.model, 'Raspberry Pi 4 Model B Rev 1.5')
  assert.equal(overview.host.os, 'MainsailOS 2.2.2')
  assert.equal(JSON.stringify(overview).includes('1000000014deeba2'), false)
  assert.equal(JSON.stringify(overview).includes('aa:bb:cc'), false)
  assert.deepEqual(
    overview.services.map(s => [s.name, s.active]),
    [
      ['klipper', true],
      ['moonraker', true],
      ['crowsnest', false],
    ],
  )
})

test('normalizeUpdateStatus prioritizes dirty > invalid > outdated > up_to_date', () => {
  const result = normalizeUpdateStatus({
    busy: false,
    version_info: {
      system: { configured_type: 'system', package_count: 0, name: 'system' },
      klipper: {
        configured_type: 'git_repo',
        version: 'v0.14.0-0',
        remote_version: 'v0.14.0-0',
        is_dirty: false,
        is_valid: true,
        corrupt: false,
        branch: 'master',
        warnings: [],
        anomalies: ["Repo has untracked source files: ['klippy/extras/tool.py']"],
      },
      'klipper-toolchanger-extended': {
        configured_type: 'git_repo',
        version: 'v1.1.0-35',
        remote_version: 'v1.1.0-35',
        is_dirty: true,
        is_valid: false,
        corrupt: false,
        branch: 'main',
        warnings: ["Repo is dirty. Detected modified files: ['klipper/extras/toolchanger.py']"],
        anomalies: [],
      },
      'tmc-4671': {
        configured_type: 'git_repo',
        version: '?',
        remote_version: '?',
        is_dirty: false,
        is_valid: false,
        corrupt: false,
        branch: 'main-upstream',
        warnings: [],
        anomalies: ['Repo not on official remote/branch'],
      },
      helixscreen: {
        configured_type: 'web',
        version: 'v1.0.2',
        remote_version: 'v1.0.11',
        is_valid: true,
        warnings: [],
        anomalies: [],
      },
    },
  })

  assert.equal(result.busy, false)
  assert.deepEqual(result.summary, { total: 5, outdated: 1, dirty: 1, invalid: 1 })
  assert.deepEqual(
    result.items.map(i => [i.name, i.status]),
    [
      ['klipper-toolchanger-extended', 'dirty'],
      ['tmc-4671', 'invalid'],
      ['helixscreen', 'outdated'],
      ['klipper', 'up_to_date'],
      ['system', 'up_to_date'],
    ],
  )
  assert.equal(result.items[0].isDirty, true)
  assert.equal(result.items[3].anomalies.length, 1)
})

test('validateLogPath, normalizeLogList and parseLogTail handle traversal, 416/empty and 206 partial lines', () => {
  assert.equal(validateLogPath('../printer.cfg'), null)
  assert.equal(validateLogPath('a/b.log'), null)
  assert.equal(validateLogPath('klippy.log'), 'klippy.log')
  assert.equal(validateLogPath('klippy.log.2026-11-23'), 'klippy.log.2026-11-23')

  const logs = normalizeLogList([
    { path: 'crowsnest.log.1', size: 3000, modified: 500 },
    { path: 'moonraker.log', size: 900, modified: 400 },
    { path: 'klippy.log', size: 5000, modified: 300 },
    { path: 'mainsail-error.log', size: 0, modified: 600 },
  ])
  assert.deepEqual(
    logs.map(l => l.path),
    ['klippy.log', 'moonraker.log', 'mainsail-error.log', 'crowsnest.log.1'],
  )

  const empty = parseLogTail({ text: '', totalBytes: 0, fetchedBytes: 0, statusCode: 416 })
  assert.deepEqual(empty, { lines: [], lineCount: 0, truncated: false, totalBytes: 0, fetchedBytes: 0, empty: true })

  const partial = parseLogTail({
    text: 'partial-first-line\nline 2\nline 3\n',
    totalBytes: 5_000_000,
    fetchedBytes: 131072,
    statusCode: 206,
    maxLines: 400,
  })
  assert.deepEqual(partial.lines, ['line 2', 'line 3'])
  assert.equal(partial.truncated, true)
  assert.equal(partial.empty, false)

  const capped = parseLogTail({
    text: Array.from({ length: 500 }, (_, i) => `row ${i + 1}`).join('\n'),
    totalBytes: 4000,
    fetchedBytes: 4000,
    statusCode: 200,
    maxLines: 400,
  })
  assert.equal(capped.lineCount, 400)
  assert.equal(capped.lines[0], 'row 101')
  assert.equal(capped.lines[399], 'row 500')
  assert.equal(capped.truncated, true)

  assert.equal(encodeMoonrakerPath('Margt NEW/macros.cfg'), 'Margt%20NEW/macros.cfg')
})

function invokeMiddleware(method, url, { headers = {}, body = '' } = {}) {
  return new Promise(resolve => {
    const req = Readable.from(body ? [Buffer.from(body)] : [])
    req.method = method
    req.url = url
    req.headers = headers
    const resHeaders = {}
    const chunks = []
    const res = {
      statusCode: 200,
      headersSent: false,
      destroyed: false,
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = v
      },
      getHeader(k) {
        return resHeaders[k.toLowerCase()]
      },
      on() {},
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        const rawBody = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(rawBody)
        } catch {}
        resolve({ status: this.statusCode, headers: resHeaders, body: rawBody, json })
      },
      destroy() {
        this.destroyed = true
      },
    }
    printerMiddleware(req, res, () => resolve({ status: 404, headers: resHeaders, body: 'next', json: null }))
  })
}

test('printerMiddleware enforces origin/header CSRF and method checks on /api/system write routes', async () => {
  for (const path of ['/api/system/config/save', '/api/system/service/restart', '/api/system/updates/refresh']) {
    const getRes = await invokeMiddleware('GET', path)
    assert.equal(getRes.status, 405, `GET ${path} must return 405`)

    const noHeaders = await invokeMiddleware('POST', path, { body: '{}' })
    assert.equal(noHeaders.status, 403, `POST ${path} without origin/header must return 403`)
  }
})

test('printerMiddleware rejects path traversal on /api/system read routes with 400', async () => {
  const cfg = await invokeMiddleware('GET', '/api/system/config/file?path=../etc/passwd')
  assert.equal(cfg.status, 400)

  const img = await invokeMiddleware('GET', '/api/system/calibration/shaketune-image?path=../printer.cfg')
  assert.equal(img.status, 400)

  const tail = await invokeMiddleware('GET', '/api/system/logs/tail?path=../etc/passwd')
  assert.equal(tail.status, 400)

  const dl = await invokeMiddleware('GET', '/api/system/logs/download?path=../etc/passwd')
  assert.equal(dl.status, 400)
})

test('control clears job cleanly instead of locking uncertain when a restartsKlipper calibration disconnects', async t => {
  class DroppingWs {
    constructor() {
      this.readyState = 0
      setImmediate(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }
    send() {
      setImmediate(() => {
        this.readyState = 3
        this.onclose?.()
      })
    }
    close() {
      this.readyState = 3
    }
  }

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      result: {
        objects: [],
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: 'standby' },
          idle_timeout: { state: 'Idle' },
          toolhead: { homed_axes: 'xyz' },
          toolchanger: { has_detection: true, tool_number: 0, detected_tool_number: 0, status: 'ready' },
          configfile: { settings: { 'gcode_macro nudge_calibrate_ring_xy': {} } },
        },
      },
    }),
  }))

  const result = await control({ action: 'calibrate_nudge_ring' }, { WebSocketImpl: DroppingWs })
  assert.match(result.message, /Klipper startet neu/)
  assert.equal(getControlState().job, null)
})

test('readJson preserves split multi-byte UTF-8 characters across chunk boundaries in /api/system/config/save', async t => {
  let savedText = null
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url.includes('/printer/objects/query')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: { status: { webhooks: { state: 'ready' }, print_stats: { state: 'standby' }, idle_timeout: { state: 'Idle' } } },
        }),
      }
    }
    if (url.includes('/server/files/list?root=config')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: [{ path: 'printer.cfg', permissions: 'rw', size: 100, modified: 1000 }] }),
      }
    }
    if (url.includes('/server/files/upload')) {
      savedText = await opts.body.get('file').text()
      return { ok: true, status: 201, json: async () => ({ item: { modified: 1001 } }) }
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  // Split the 2-byte UTF-8 sequence for 'ü' (0xC3 0xBC) across two separate Buffer chunks.
  const fullJson = Buffer.from(
    JSON.stringify({ path: 'printer.cfg', content: '# Düse 240 °C — Lüfter über prüfen\n', expectedModified: 1000 }),
    'utf8',
  )
  const splitIdx = fullJson.indexOf(0xc3) + 1
  const req = Readable.from([fullJson.subarray(0, splitIdx), fullJson.subarray(splitIdx)])
  req.method = 'POST'
  req.url = '/api/system/config/save'
  req.headers = {
    origin: 'http://127.0.0.1:4173',
    host: '127.0.0.1:4173',
    'x-cockpit-request': '1',
    'content-type': 'application/json',
  }

  const res = await new Promise(resolve => {
    const chunks = []
    const mockRes = {
      statusCode: 200,
      destroyed: false,
      setHeader() {},
      on() {},
      end(c) {
        if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      },
      destroy() {},
    }
    printerMiddleware(req, mockRes, () => resolve({ status: 404, body: '' }))
  })

  assert.equal(res.status, 200)
  assert.equal(savedText, '# Düse 240 °C — Lüfter über prüfen\n')
})

test('control allows calibrate_beacon_abort while calibrate_beacon_all_z holds currentJob', async t => {
  const sentScripts = []
  const sockets = []
  class TrackingWs {
    constructor() {
      this.readyState = 0
      sockets.push(this)
      setImmediate(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(payload) {
      const msg = JSON.parse(payload)
      sentScripts.push(msg.params?.script)
      if (msg.params?.script === 'BEACON_BATCH_ABORT') {
        setImmediate(() => {
          this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }) })
        })
      }
    }
    close() {
      this.readyState = 3
    }
  }

  let batchRunning = 0
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      result: {
        objects: [],
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: 'standby' },
          idle_timeout: { state: batchRunning ? 'Printing' : 'Idle' },
          toolhead: { homed_axes: 'xyz' },
          toolchanger: { has_detection: true, tool_number: 0, detected_tool_number: 0, status: 'ready' },
          'gcode_macro _BEACON_BATCH_STATE': { running: batchRunning },
          configfile: {
            settings: {
              'gcode_macro beacon_calibrate_all_tools_z': {},
              'gcode_macro beacon_batch_abort': {},
            },
          },
        },
      },
    }),
  }))

  const batchPromise = control({ action: 'calibrate_beacon_all_z', probeTemp: 150 }, { WebSocketImpl: TrackingWs })
  await new Promise(resolve => setTimeout(resolve, 15))
  batchRunning = 1

  const abortResult = await control({ action: 'calibrate_beacon_abort' }, { WebSocketImpl: TrackingWs })
  assert.match(abortResult.message, /Beacon-Batch abbrechen/)
  assert.equal(sentScripts.includes('BEACON_BATCH_ABORT'), true)

  // Resolve the original batch socket cleanly so no job leaks into later tests.
  sockets[0].onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) })
  await batchPromise
  assert.equal(getControlState().job, null)
})

test('computeSystemState unlocks recovery after mid-print Klipper crash and never locks offline on 400/404', async () => {
  const { computeSystemState, isConnectivityFailure } = await import('../src/system-state.mjs')

  // Mid-print crash: SSE froze with printState='printing', online=false, Moonraker reports klippy_connected=false.
  const crashed = computeSystemState({
    status: { printState: 'printing', klipperState: 'ready', control: { job: null } },
    online: false,
    overview: { klippy: { connected: false, state: 'disconnected' } },
  })
  assert.equal(crashed.klippyInRecovery, true)
  assert.equal(crashed.printLocked, false)
  assert.equal(crashed.effectiveKlipperState, 'disconnected')

  // Live active print: online=true, klipperState='ready', printState='printing' -> MUST lock!
  const printing = computeSystemState({
    status: { printState: 'printing', klipperState: 'ready', control: { job: null } },
    online: true,
    overview: { klippy: { connected: true, state: 'ready' } },
  })
  assert.equal(printing.klippyInRecovery, false)
  assert.equal(printing.printLocked, true)
  assert.equal(printing.effectiveKlipperState, 'ready')

  // 400 / 404 / 413 are NOT Moonraker connectivity failures; 502 / 503 / 0 (network) ARE.
  assert.equal(isConnectivityFailure(400), false)
  assert.equal(isConnectivityFailure(404), false)
  assert.equal(isConnectivityFailure(413), false)
  assert.equal(isConnectivityFailure(502), true)
  assert.equal(isConnectivityFailure(503), true)
  assert.equal(isConnectivityFailure(0), true)
})

test('validateUpdateTarget, normalizeUpdateStatus and filterRelevantReleases enforce upgrade/recovery safety and changelog filtering', () => {
  const versionInfo = {
    helixscreen: {
      configured_type: 'web',
      owner: 'prestonbrown',
      repo_name: 'helixscreen',
      version: 'v1.0.2',
      remote_version: 'v1.1.0',
      is_valid: true,
    },
    'klipper-toolchanger-extended': {
      configured_type: 'git_repo',
      owner: 'PrintStructor',
      repo_name: 'klipper-toolchanger-extended',
      remote_url: 'https://github.com/PrintStructor/klipper-toolchanger-extended.git',
      version: 'v1.1.0-35',
      remote_version: 'v1.1.0-36',
      is_dirty: true,
      is_valid: false,
      warnings: ["Repo is dirty. Detected modified files: ['klipper/extras/toolchanger.py']"],
    },
    klipper: {
      configured_type: 'git_repo',
      owner: 'Klipper3d',
      repo_name: 'klipper',
      version: 'v0.14.0-0',
      remote_version: 'v0.14.0-0',
      is_dirty: false,
      is_valid: true,
      commits_behind: [{ sha: 'abc1234', author: 'Dev', date: '1700000000', subject: 'Fix homing', message: 'Fix homing' }],
      commits_behind_count: 1,
    },
    system: {
      configured_type: 'system',
      package_count: 2,
      package_list: ['openssl', 'curl'],
    },
  }

  const normalized = normalizeUpdateStatus({ busy: false, version_info: versionInfo })
  const byName = Object.fromEntries(normalized.items.map(i => [i.name, i]))

  assert.equal(byName.helixscreen.canUpgrade, true)
  assert.equal(byName.helixscreen.canRecover, false)
  assert.equal(byName.helixscreen.repoUrl, 'https://github.com/prestonbrown/helixscreen')
  assert.equal(byName['klipper-toolchanger-extended'].canUpgrade, false)
  assert.equal(byName['klipper-toolchanger-extended'].canRecover, true)
  assert.equal(byName.system.canUpgrade, true)
  assert.deepEqual(byName.system.packageList, ['openssl', 'curl'])
  assert.equal(byName.klipper.commitsBehind.length, 1)

  // Upgrade allowed for clean outdated web/system, rejected for dirty or already up-to-date.
  assert.equal(validateUpdateTarget('helixscreen', versionInfo, 'upgrade').name, 'helixscreen')
  assert.equal(validateUpdateTarget('system', versionInfo, 'upgrade').name, 'system')
  assert.throws(() => validateUpdateTarget('klipper-toolchanger-extended', versionInfo, 'upgrade'), err => err.status === 409)
  assert.throws(() => validateUpdateTarget('klipper', versionInfo, 'upgrade'), err => err.status === 409)
  assert.throws(() => validateUpdateTarget('unknown-pkg', versionInfo, 'upgrade'), err => err.status === 404)

  // Recover allowed for dirty/invalid git_repo, rejected for web/system/clean.
  assert.equal(validateUpdateTarget('klipper-toolchanger-extended', versionInfo, 'recover').name, 'klipper-toolchanger-extended')
  assert.throws(() => validateUpdateTarget('helixscreen', versionInfo, 'recover'), err => err.status === 400)
  assert.throws(() => validateUpdateTarget('system', versionInfo, 'recover'), err => err.status === 400)

  // Release filtering skips pre-releases when target is stable and keeps versions newer than installed.
  const filtered = filterRelevantReleases(
    [
      { tag_name: 'v1.1.0', name: 'v1.1.0', prerelease: false, published_at: '2026-11-24T03:00:00Z', html_url: 'https://github.com/a/b/releases/tag/v1.1.0', body: 'New stuff' },
      { tag_name: 'v1.1.0-rc.6', name: 'rc6', prerelease: true, published_at: '2026-11-23T02:00:00Z', html_url: 'https://github.com/a/b/releases/tag/v1.1.0-rc.6', body: 'RC' },
      { tag_name: 'v1.0.5', name: 'v1.0.5', prerelease: false, published_at: '2026-11-10T02:00:00Z', html_url: 'https://github.com/a/b/releases/tag/v1.0.5', body: 'Fix' },
      { tag_name: 'v1.0.2', name: 'v1.0.2', prerelease: false, published_at: '2026-10-01T02:00:00Z', html_url: 'https://github.com/a/b/releases/tag/v1.0.2', body: 'Old' },
    ],
    'v1.0.2',
    'v1.1.0',
  )
  assert.deepEqual(filtered.map(r => r.tag), ['v1.1.0', 'v1.0.5'])
})

test('printerMiddleware enforces CSRF/method checks on update upgrade/recover and validates notes name', async () => {
  for (const path of ['/api/system/updates/upgrade', '/api/system/updates/recover']) {
    const getRes = await invokeMiddleware('GET', path)
    assert.equal(getRes.status, 405)
    const noHeaders = await invokeMiddleware('POST', path, { body: '{"name":"helixscreen"}' })
    assert.equal(noHeaders.status, 403)
  }
  const badNotes = await invokeMiddleware('GET', '/api/system/updates/notes?name=../etc/passwd')
  assert.equal(badNotes.status, 400)
})
