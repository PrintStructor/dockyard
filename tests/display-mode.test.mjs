import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISPLAY_MODE_KEY,
  CAMERAS_HIDDEN_KEY,
  resolveDisplaySettings,
  saveDisplayPreference,
  saveCamerasHiddenPreference,
  sanitizeTabForCameras,
} from '../src/display-mode.mjs'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => map.set(key, String(val)),
  }
}

test('resolveDisplaySettings defaults to normal desktop mode with cameras enabled', () => {
  const res = resolveDisplaySettings({ search: '', storage: memoryStorage() })
  assert.equal(res.displayMode, false)
  assert.equal(res.camerasHidden, false)
  assert.equal(res.showCameras, true)
})

test('URL parameters ?display=1, ?kiosk=1 and ?cameras=off control display mode and camera visibility', () => {
  const disp = resolveDisplaySettings({ search: '?display=1', storage: memoryStorage() })
  assert.equal(disp.displayMode, true)
  assert.equal(disp.camerasHidden, true)
  assert.equal(disp.showCameras, false)

  const kiosk = resolveDisplaySettings({ search: '?kiosk=true', storage: memoryStorage() })
  assert.equal(kiosk.displayMode, true)
  assert.equal(kiosk.showCameras, false)

  const camOff = resolveDisplaySettings({ search: '?cameras=off', storage: memoryStorage() })
  assert.equal(camOff.displayMode, false)
  assert.equal(camOff.camerasHidden, true)
  assert.equal(camOff.showCameras, false)

  const dispWithCam = resolveDisplaySettings({ search: '?display=1&cameras=on', storage: memoryStorage() })
  assert.equal(dispWithCam.displayMode, true)
  assert.equal(dispWithCam.showCameras, true)
})

test('URL overrides saved localStorage preferences and falls back safely when storage throws', () => {
  const storage = memoryStorage({ [DISPLAY_MODE_KEY]: '1', [CAMERAS_HIDDEN_KEY]: '1' })
  assert.equal(resolveDisplaySettings({ search: '', storage }).displayMode, true)
  assert.equal(resolveDisplaySettings({ search: '', storage }).showCameras, false)

  const overrideOff = resolveDisplaySettings({ search: '?display=0&cameras=on', storage })
  assert.equal(overrideOff.displayMode, false)
  assert.equal(overrideOff.showCameras, true)

  const legacyStorage = memoryStorage({ 'stormtrooper.displayMode': '1', 'stormtrooper.camerasHidden': '1' })
  assert.equal(resolveDisplaySettings({ search: '', storage: legacyStorage }).displayMode, true)
  assert.equal(resolveDisplaySettings({ search: '', storage: legacyStorage }).showCameras, false)

  const brokenStorage = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  const fallback = resolveDisplaySettings({ search: '', storage: brokenStorage })
  assert.equal(fallback.displayMode, false)
  assert.equal(fallback.showCameras, true)
  assert.doesNotThrow(() => saveDisplayPreference(true, brokenStorage))
  assert.doesNotThrow(() => saveCamerasHiddenPreference(true, brokenStorage))
})

test('saving display and camera preferences persists cleanly and redirects cameras tab when hidden', () => {
  const storage = memoryStorage()
  saveDisplayPreference(true, storage)
  assert.equal(storage.getItem(DISPLAY_MODE_KEY), '1')
  saveCamerasHiddenPreference(true, storage)
  assert.equal(storage.getItem(CAMERAS_HIDDEN_KEY), '1')
  saveDisplayPreference(false, storage)
  assert.equal(storage.getItem(DISPLAY_MODE_KEY), '0')

  assert.equal(sanitizeTabForCameras('cameras', false), 'tools')
  assert.equal(sanitizeTabForCameras('cameras', true), 'cameras')
  assert.equal(sanitizeTabForCameras('controls', false), 'controls')
})
