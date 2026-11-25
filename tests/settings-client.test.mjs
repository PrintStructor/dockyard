import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMainsailUrl } from '../src/printer-ui-url.mjs'
import { resolveDefaultTab, setDefaultTab, DEFAULT_TAB_KEY } from '../src/display-mode.mjs'
import { buildPrintersExport, parsePrintersImport, mergePrinterProfiles } from '../src/useSettings.js'
import { useConfigEditor } from '../src/useConfigEditor.js'

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  }
}

test('resolveMainsailUrl handles explicit URLs, remote printer URLs, and loopback fallback', () => {
  assert.equal(
    resolveMainsailUrl('http://10.0.0.5:8080/', { protocol: 'http:', hostname: 'voron.local' }, 'http://192.168.1.50'),
    'http://10.0.0.5:8080/',
  )
  assert.equal(
    resolveMainsailUrl('auto', { protocol: 'http:', hostname: 'localhost' }, 'http://192.168.50.22'),
    'http://192.168.50.22/',
  )
  assert.equal(
    resolveMainsailUrl('auto', { protocol: 'http:', hostname: 'localhost' }, 'http://192.168.50.22:7125'),
    'http://192.168.50.22/',
  )
  assert.equal(
    resolveMainsailUrl('auto', { protocol: 'http:', hostname: 'voron.local' }, 'http://127.0.0.1'),
    'http://voron.local/',
  )
  assert.equal(
    resolveMainsailUrl('auto', { protocol: 'http:', hostname: 'voron.local' }, 'http://127.0.0.1:7125'),
    'http://voron.local/',
  )
  assert.equal(
    resolveMainsailUrl('auto', { protocol: 'https:', hostname: 'voron.local' }, 'http://localhost:7125'),
    'https://voron.local/',
  )
})

test('resolveDefaultTab and setDefaultTab validate and persist tab selection', () => {
  const store = memoryStorage()
  assert.equal(resolveDefaultTab(store), 'tools')
  assert.equal(setDefaultTab('print', store), true)
  assert.equal(store.getItem(DEFAULT_TAB_KEY), 'print')
  assert.equal(resolveDefaultTab(store), 'print')
  assert.equal(setDefaultTab('invalid-tab', store), false)
  assert.equal(resolveDefaultTab(store), 'print')
})

test('printer export/import excludes network and supports merge and replace modes', () => {
  const exported = buildPrintersExport({
    activePrinterId: 'stormtrooper',
    printers: [
      {
        id: 'stormtrooper',
        name: 'STORMTROOPER',
        subtitle: 'VORON 2.4 / 6-Toolchanger',
        url: 'http://192.168.1.10',
        mainsailUrl: 'auto',
        cameras: [{ id: 'tophat', name: 'Tophat', service: 'camera-streamer', url: '/webcam', enabled: true }],
      },
    ],
    network: {
      allowedOrigins: ['http://192.168.1.20:4173'],
      allowLanOrigins: true,
    },
    runtime: { host: '0.0.0.0', port: 4173, canWrite: true },
  })

  assert.equal(exported.version, 1)
  assert.equal('network' in exported, false)
  assert.equal('runtime' in exported, false)
  assert.equal(exported.printers.length, 1)

  assert.throws(() => parsePrintersImport('{bad json'), /JSON/i)
  assert.throws(() => parsePrintersImport(JSON.stringify({ printers: [] })), /Drucker/i)

  const parsed = parsePrintersImport(
    JSON.stringify({
      version: 1,
      activePrinterId: 'voron-v0',
      printers: [
        {
          id: 'stormtrooper',
          name: 'STORMTROOPER MEET',
          subtitle: 'VORON 2.4',
          url: 'http://10.42.0.50',
          mainsailUrl: 'auto',
          cameras: [],
        },
        {
          id: 'voron-v0',
          name: 'VORON-V0',
          subtitle: 'VORON 0.2',
          url: 'http://10.42.0.51',
          mainsailUrl: 'auto',
          cameras: [
            {
              id: 'chamber',
              name: 'Chamber',
              service: 'mjpeg',
              url: '/webcam/?action=stream',
              snapshotUrl: '/webcam/?action=snapshot',
              enabled: true,
            },
          ],
        },
      ],
    }),
  )
  assert.equal(parsed.printers.length, 2)

  const existing = [
    {
      id: 'stormtrooper',
      name: 'STORMTROOPER',
      subtitle: 'VORON 2.4',
      url: 'http://192.168.1.10',
      mainsailUrl: 'auto',
      cameras: [],
    },
    {
      id: 'trident',
      name: 'TRIDENT',
      subtitle: 'VORON Trident',
      url: 'http://192.168.1.12',
      mainsailUrl: 'auto',
      cameras: [],
    },
  ]

  const merged = mergePrinterProfiles(existing, parsed.printers, 'merge', 'trident')
  assert.equal(merged.printers.length, 3)
  assert.equal(merged.printers.find(p => p.id === 'stormtrooper').url, 'http://10.42.0.50')
  assert.equal(merged.printers.find(p => p.id === 'trident').name, 'TRIDENT')
  assert.equal(merged.printers.find(p => p.id === 'voron-v0').name, 'VORON-V0')
  assert.equal(merged.activePrinterId, 'trident')

  const replaced = mergePrinterProfiles(existing, parsed.printers, 'replace', 'trident', parsed.activePrinterId)
  assert.equal(replaced.printers.length, 2)
  assert.equal(replaced.printers.find(p => p.id === 'trident'), undefined)
  assert.equal(replaced.activePrinterId, 'voron-v0')
})

test('ConfigEditor locks dirty buffer non-destructively on printer switch and resets clean buffer', async () => {
  const editor = useConfigEditor()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      if (String(url).includes('/api/system/config/file')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            path: 'printer.cfg',
            printerId: 'stormtrooper',
            content: '[printer]\nkinematics: corexy\n',
            modified: 1700000000,
            size: 29,
            readonly: false,
            isBackup: false,
            isScript: false,
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ files: [] }) }
    }

    await editor.openFile('printer.cfg', { printerId: 'stormtrooper', printerName: 'STORMTROOPER' })
    assert.equal(editor.loadedPrinterId.value, 'stormtrooper')
    assert.equal(editor.isDirty.value, false)

    // Clean switch resets cleanly without locking
    const cleanSwitch = editor.handlePrinterSwitch('voron-v0', 'VORON-V0')
    assert.equal(cleanSwitch.locked, false)
    assert.equal(editor.currentPath.value, '')
    assert.equal(editor.printerMismatch.value, null)

    // Dirty buffer preserves content and locks editor on switch
    await editor.openFile('printer.cfg', { printerId: 'stormtrooper', printerName: 'STORMTROOPER' })
    editor.setContent('[printer]\nkinematics: corexy\n# unsaved edit\n')
    assert.equal(editor.isDirty.value, true)

    const dirtySwitch = editor.handlePrinterSwitch('voron-v0', 'VORON-V0')
    assert.equal(dirtySwitch.locked, true)
    assert.equal(editor.content.value, '[printer]\nkinematics: corexy\n# unsaved edit\n')
    assert.equal(editor.printerMismatch.value?.fromPrinterId, 'stormtrooper')
    assert.equal(editor.printerMismatch.value?.toPrinterId, 'voron-v0')

    // Save is blocked while mismatch lock is active
    const blockedSave = await editor.saveFile({ restart: 'none' })
    assert.equal(blockedSave.ok, false)
    assert.equal(blockedSave.printerChanged, true)

    // Acknowledge discards and clears mismatch
    await editor.acknowledgePrinterMismatchAndReload()
    assert.equal(editor.printerMismatch.value, null)
    assert.equal(editor.isDirty.value, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
