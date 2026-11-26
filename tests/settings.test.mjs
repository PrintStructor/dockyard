import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  MODEL_PRESETS,
  normalizePrinterOrigin,
  isBlockedUpstreamHost,
  isPrivateLanHostname,
  normalizeCamera,
  normalizeMainsailSetting,
  normalizeModelSetting,
  slugifyId,
  validateSettingsPayload,
  createSettingsStore,
} from '../server/settings.mjs'
import { sameOriginRequest, isOriginWriteAllowed } from '../server/control.mjs'

test('normalizePrinterOrigin normalizes shorthand IPs/hosts and strips trailing slash', () => {
  assert.equal(normalizePrinterOrigin('192.168.1.50'), 'http://192.168.1.50')
  assert.equal(normalizePrinterOrigin('voron.local:7125/'), 'http://voron.local:7125')
  assert.equal(normalizePrinterOrigin('https://voron.example.com/'), 'https://voron.example.com')
  assert.equal(normalizePrinterOrigin('http://127.0.0.1:80/'), 'http://127.0.0.1')
})

test('normalizePrinterOrigin rejects credentials, paths, query strings, non-HTTP schemes, and cloud metadata hosts', () => {
  for (const bad of [
    '',
    '   ',
    'http://u:p@192.168.1.50',
    'http://192.168.1.50/api',
    'http://192.168.1.50?foo=1',
    'http://192.168.1.50#hash',
    'ftp://192.168.1.50',
    'http://169.254.169.254',
    'http://169.254.170.2',
    'http://metadata.google.internal',
    'http://[fd00:ec2::254]',
  ]) {
    assert.throws(() => normalizePrinterOrigin(bad), `expected rejection for ${bad}`)
  }
  assert.equal(isBlockedUpstreamHost('169.254.169.254'), true)
  assert.equal(isBlockedUpstreamHost('metadata.google.internal'), true)
  assert.equal(isBlockedUpstreamHost('192.168.1.50'), false)
})

test('normalizeCamera validates camera-streamer and mjpeg (ustreamer) cameras', () => {
  const csRel = normalizeCamera({ id: 'tophat', name: 'Tophat', description: 'Oben', url: '/webcam/' })
  assert.equal(csRel.service, 'camera-streamer')
  assert.equal(csRel.url, '/webcam')
  assert.equal(csRel.preferredMode, 'webrtc')
  assert.equal(csRel.enabled, true)

  const csExt = normalizeCamera({
    id: 'ext',
    name: 'External',
    service: 'camera-streamer',
    url: 'http://192.168.1.60:8080/cam/',
  })
  assert.equal(csExt.url, 'http://192.168.1.60:8080/cam')

  assert.throws(() =>
    normalizeCamera({ id: 'bad', name: 'Bad', service: 'camera-streamer', url: '/webcam/?action=stream' }),
  )

  const mjpeg = normalizeCamera({
    id: 'v0cam',
    name: 'V0 Cam',
    service: 'mjpeg',
    url: '/webcam/?action=stream',
    snapshotUrl: '/webcam/?action=snapshot',
    preferredMode: 'webrtc',
  })
  assert.equal(mjpeg.service, 'mjpeg')
  assert.equal(mjpeg.url, '/webcam/?action=stream')
  assert.equal(mjpeg.snapshotUrl, '/webcam/?action=snapshot')
  assert.equal(mjpeg.preferredMode, 'mjpeg')

  for (const badUrl of ['../etc/passwd', '/webcam/../secret', 'http://169.254.169.254/latest', 'javascript:alert(1)']) {
    assert.throws(() => normalizeCamera({ id: 'x', name: 'X', service: 'mjpeg', url: badUrl }))
  }
})

test('normalizeMainsailSetting and slugifyId handle defaults and special characters', () => {
  assert.equal(normalizeMainsailSetting(''), 'auto')
  assert.equal(normalizeMainsailSetting('auto'), 'auto')
  assert.equal(normalizeMainsailSetting('http://192.168.1.50/'), 'http://192.168.1.50/')
  assert.throws(() => normalizeMainsailSetting('http://user:pass@192.168.1.50/'))
  assert.equal(slugifyId('VORON 2.4 #1!'), 'voron-2-4-1')
  assert.equal(slugifyId('   ', 'printer'), 'printer')
})

test('isPrivateLanHostname allows private LAN/mDNS/loopback and rejects public and metadata hosts', () => {
  for (const host of [
    '127.0.0.1',
    'localhost',
    '::1',
    '10.0.0.5',
    '172.16.4.2',
    '172.31.255.1',
    '192.168.50.12',
    '169.254.1.2',
    'voron.local',
    'dockyard.lan',
    'pi-host',
    'fd12::1',
    'fe80::1',
  ]) {
    assert.equal(isPrivateLanHostname(host), true, `expected ${host} to be private LAN`)
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '172.15.0.1', 'example.com', '169.254.169.254', '169.254.170.2']) {
    assert.equal(isPrivateLanHostname(host), false, `expected ${host} NOT to be private LAN`)
  }
})

test('createSettingsStore bootstraps from env, persists atomically, switches printers, and respects env LAN override', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-settings-'))
  const filePath = path.join(dir, '.dockyard-settings.json')
  try {
    const store = createSettingsStore({
      filePath,
      env: {
        PRINTER_URL: 'http://192.168.1.50',
        PRINTER_NAME: 'STORMTROOPER',
        ALLOWED_ORIGINS: 'http://192.168.1.99:4173',
      },
    })

    const initial = store.getSettings()
    assert.equal(initial.printers.length, 1)
    assert.equal(store.getActivePrinter().name, 'STORMTROOPER')
    assert.equal(store.getActivePrinter().url, 'http://192.168.1.50')
    assert.equal(store.getActivePrinter().cameras.length, 2)
    assert.deepEqual(store.getEffectiveAllowedOrigins(), ['http://192.168.1.99:4173'])
    assert.equal(store.isLanOriginAllowed(), false)

    // First-run bootstrap must NOT have written the file yet.
    await assert.rejects(() => readFile(filePath, 'utf8'))

    const saved = await store.saveSettings({
      activePrinterId: 'stormtrooper',
      printers: [
        store.getActivePrinter(),
        {
          id: 'voron-v0',
          name: 'VORON-V0',
          subtitle: 'VORON 0.2',
          url: '192.168.50.77',
          mainsailUrl: 'auto',
          cameras: [{ id: 'v0cam', name: 'Chamber', service: 'mjpeg', url: '/webcam/?action=stream', enabled: true }],
        },
      ],
      network: {
        allowedOrigins: ['http://192.168.50.10:4173'],
        allowLanOrigins: false,
      },
    })
    assert.equal(saved.printerUrlChanged, false)
    assert.equal(saved.activePrinterChanged, false)

    // Reload from disk in a fresh store with ALLOW_LAN_ORIGINS=1 runtime override
    const reloaded = createSettingsStore({
      filePath,
      env: {
        PRINTER_URL: 'http://127.0.0.1',
        ALLOW_LAN_ORIGINS: '1',
      },
    })
    assert.equal(reloaded.getSettings().printers.length, 2)
    assert.equal(reloaded.getSettings().printers[1].url, 'http://192.168.50.77')
    assert.equal(reloaded.isLanOriginAllowed(), true)
    assert.equal(reloaded.hasEnvLanOriginOverride(), true)

    const switched = await reloaded.switchPrinter('voron-v0')
    assert.equal(switched.activePrinterChanged, true)
    assert.equal(switched.printerUrlChanged, true)
    assert.equal(reloaded.getActivePrinter().id, 'voron-v0')

    // Rejects deleting all printers
    assert.throws(() => validateSettingsPayload({ activePrinterId: 'x', printers: [], network: {} }))

    // Corrupt JSON on disk falls back safely to env defaults instead of crashing startup
    await writeFile(filePath, '{corrupt json', 'utf8')
    const recovered = createSettingsStore({ filePath, env: { PRINTER_URL: 'http://127.0.0.1', PRINTER_NAME: 'SAFE' } })
    assert.equal(recovered.getActivePrinter().name, 'SAFE')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sameOriginRequest and isOriginWriteAllowed enforce Meet LAN mode strictly', () => {
  const lanReq = {
    headers: {
      origin: 'http://192.168.50.12:4173',
      host: '192.168.50.12:4173',
      'x-cockpit-request': '1',
      'content-type': 'application/json',
    },
  }
  assert.equal(sameOriginRequest(lanReq, [], { allowLanOrigins: false }), false)
  assert.equal(sameOriginRequest(lanReq, [], { allowLanOrigins: true }), true)
  assert.equal(isOriginWriteAllowed({ headers: { origin: 'http://192.168.50.12:4173', host: '192.168.50.12:4173' } }, [], { allowLanOrigins: true }), true)

  // Cross-host mismatch must still be rejected even in Meet LAN mode
  assert.equal(
    sameOriginRequest(
      { headers: { ...lanReq.headers, host: '192.168.50.99:4173' } },
      [],
      { allowLanOrigins: true },
    ),
    false,
  )

  // Missing custom header must still be rejected
  assert.equal(
    sameOriginRequest(
      { headers: { origin: 'http://192.168.50.12:4173', host: '192.168.50.12:4173', 'content-type': 'application/json' } },
      [],
      { allowLanOrigins: true },
    ),
    false,
  )

  // Public internet origin must be rejected in Meet LAN mode unless explicitly allowed
  assert.equal(
    sameOriginRequest(
      {
        headers: {
          origin: 'https://evil.example.com',
          host: 'evil.example.com',
          'x-cockpit-request': '1',
          'content-type': 'application/json',
        },
      },
      [],
      { allowLanOrigins: true },
    ),
    false,
  )
})

test('isBlockedUpstreamHost blocks trailing-dot metadata DNS and IPv4-mapped IPv6 metadata hosts', () => {
  assert.throws(() => normalizePrinterOrigin('http://metadata.google.internal.'), /gesperrt|Sicherheitsgründen/i)
  assert.throws(() => normalizePrinterOrigin('http://[::ffff:169.254.169.254]'), /gesperrt|Sicherheitsgründen/i)
  assert.throws(() => normalizePrinterOrigin('http://[::ffff:169.254.170.2]'), /gesperrt|Sicherheitsgründen/i)
  assert.equal(isPrivateLanHostname('::ffff:169.254.169.254'), false)
  assert.equal(isPrivateLanHostname('metadata.google.internal.'), false)
})

test('createSettingsStore serializes concurrent commits cleanly without tmp race', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dockyard-race-'))
  try {
    const filePath = path.join(dir, '.dockyard-settings.json')
    const store = createSettingsStore({
      filePath,
      env: { PRINTER_URL: 'http://127.0.0.1', PRINTER_NAME: 'P1' },
    })
    await store.saveSettings({
      activePrinterId: 'p1',
      printers: [
        { id: 'p1', name: 'P1', subtitle: '', url: 'http://127.0.0.1:7125', mainsailUrl: 'auto', cameras: [] },
        { id: 'p2', name: 'P2', subtitle: '', url: 'http://127.0.0.1:7126', mainsailUrl: 'auto', cameras: [] },
      ],
      network: { allowedOrigins: [], allowLanOrigins: false },
    })
    const results = await Promise.all([
      store.switchPrinter('p2'),
      store.switchPrinter('p1'),
      store.switchPrinter('p2'),
      store.switchPrinter('p1'),
      store.switchPrinter('p2'),
    ])
    assert.equal(results.length, 5)
    assert.equal(store.getActivePrinter().id, 'p2')
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'))
    assert.equal(onDisk.activePrinterId, 'p2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('normalizeModelSetting and validateSettingsPayload default missing model to auto and reject invalid presets', () => {
  assert.deepEqual(MODEL_PRESETS, ['auto', 'stormtrooper-6tc', 'none'])
  assert.deepEqual(normalizeModelSetting(undefined), { preset: 'auto' })
  assert.deepEqual(normalizeModelSetting({}), { preset: 'auto' })
  assert.deepEqual(normalizeModelSetting({ preset: 'stormtrooper-6tc' }), { preset: 'stormtrooper-6tc' })
  assert.deepEqual(normalizeModelSetting({ preset: 'none' }), { preset: 'none' })
  assert.throws(() => normalizeModelSetting({ preset: 'bogus' }), /Modell|Preset/i)
  assert.throws(() => normalizeModelSetting('invalid'), /Modell/i)

  const validated = validateSettingsPayload({
    activePrinterId: 'v01',
    printers: [
      { id: 'v01', name: 'V0.1', url: 'http://192.168.1.60', cameras: [] },
      { id: 'st', name: 'ST', url: 'http://192.168.1.50', model: { preset: 'stormtrooper-6tc' }, cameras: [] },
      { id: 'trident', name: 'Trident', url: 'http://192.168.1.61', model: { preset: 'none' }, cameras: [] },
    ],
    network: { allowedOrigins: [], allowLanOrigins: false },
  })
  assert.deepEqual(validated.printers[0].model, { preset: 'auto' })
  assert.deepEqual(validated.printers[1].model, { preset: 'stormtrooper-6tc' })
  assert.deepEqual(validated.printers[2].model, { preset: 'none' })

  assert.throws(
    () =>
      validateSettingsPayload({
        activePrinterId: 'bad',
        printers: [{ id: 'bad', name: 'Bad', url: 'http://192.168.1.70', model: { preset: 'bogus' }, cameras: [] }],
        network: {},
      }),
    /Modell|Preset/i,
  )
})
