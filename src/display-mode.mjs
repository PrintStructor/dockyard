import { computed, ref } from 'vue'

export const DISPLAY_MODE_KEY = 'dockyard.displayMode'
export const CAMERAS_HIDDEN_KEY = 'dockyard.camerasHidden'
export const DEFAULT_TAB_KEY = 'dockyard.defaultTab'
export const VALID_DEFAULT_TABS = ['tools', 'print', 'controls', 'cameras', 'history', 'console', 'system']
const LEGACY_DISPLAY_MODE_KEY = 'stormtrooper.displayMode'
const LEGACY_CAMERAS_HIDDEN_KEY = 'stormtrooper.camerasHidden'

function parseBoolParam(raw) {
  if (raw == null) return null
  const val = String(raw).trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(val)) return true
  if (['0', 'false', 'off', 'no'].includes(val)) return false
  return null
}

function safeStorage(storage) {
  if (storage !== undefined) return storage
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function readFlag(storage, key, legacyKey) {
  try {
    const value = storage?.getItem(key)
    if (value != null) return value === '1'
    return legacyKey ? storage?.getItem(legacyKey) === '1' : false
  } catch {
    return false
  }
}

function writeFlag(storage, key, enabled) {
  try {
    storage?.setItem(key, enabled ? '1' : '0')
  } catch {
    // Ignore storage errors in restricted kiosk/private browser sessions.
  }
}

export function resolveDisplaySettings({ search = '', storage } = {}) {
  const store = safeStorage(storage)
  const params = new URLSearchParams(search || '')
  const urlDisplay = parseBoolParam(params.get('display')) ?? parseBoolParam(params.get('kiosk'))
  const urlCamerasParam = parseBoolParam(params.get('cameras'))
  const urlCamerasHidden = urlCamerasParam === null ? null : !urlCamerasParam

  const savedDisplay = readFlag(store, DISPLAY_MODE_KEY, LEGACY_DISPLAY_MODE_KEY)
  const savedCamerasHidden = readFlag(store, CAMERAS_HIDDEN_KEY, LEGACY_CAMERAS_HIDDEN_KEY)

  const displayMode = urlDisplay ?? savedDisplay
  const camerasHidden = urlCamerasHidden ?? (displayMode ? true : savedCamerasHidden)

  return {
    displayMode,
    camerasHidden,
    showCameras: !camerasHidden,
    savedCamerasHidden,
  }
}

export function saveDisplayPreference(enabled, storage) {
  writeFlag(safeStorage(storage), DISPLAY_MODE_KEY, Boolean(enabled))
}

export function saveCamerasHiddenPreference(hidden, storage) {
  writeFlag(safeStorage(storage), CAMERAS_HIDDEN_KEY, Boolean(hidden))
}

export function sanitizeTabForCameras(tab, camerasVisible) {
  return !camerasVisible && tab === 'cameras' ? 'tools' : tab
}

const initial = resolveDisplaySettings({
  search: typeof globalThis.location !== 'undefined' ? globalThis.location.search : '',
})

export const displayMode = ref(initial.displayMode)
export const camerasHiddenPreference = ref(initial.savedCamerasHidden)
const explicitCamerasOverride = ref(
  (() => {
    if (typeof globalThis.location === 'undefined') return null
    const parsed = parseBoolParam(new URLSearchParams(globalThis.location.search).get('cameras'))
    return parsed === null ? null : !parsed
  })(),
)

export const showCameras = computed(() => {
  if (explicitCamerasOverride.value !== null) return !explicitCamerasOverride.value
  if (displayMode.value) return false
  return !camerasHiddenPreference.value
})

function syncUrlParams(keysToClear) {
  if (typeof globalThis.location === 'undefined' || typeof globalThis.history === 'undefined') return
  try {
    const url = new URL(globalThis.location.href)
    let changed = false
    for (const key of keysToClear) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key)
        changed = true
      }
    }
    if (changed) globalThis.history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch {
    // Ignore URL update errors in synthetic environments.
  }
}

export function setDisplayMode(enabled) {
  const next = Boolean(enabled)
  displayMode.value = next
  saveDisplayPreference(next)
  if (next && explicitCamerasOverride.value === false) {
    explicitCamerasOverride.value = null
    syncUrlParams(['display', 'kiosk', 'cameras'])
  } else {
    syncUrlParams(['display', 'kiosk'])
  }
}

export function toggleDisplayMode() {
  setDisplayMode(!displayMode.value)
}

export function setCamerasHidden(hidden) {
  const next = Boolean(hidden)
  camerasHiddenPreference.value = next
  explicitCamerasOverride.value = displayMode.value ? next : null
  saveCamerasHiddenPreference(next)
  syncUrlParams(['cameras'])
}

export function resolveDefaultTab(storage) {
  const store = safeStorage(storage)
  try {
    const saved = store?.getItem(DEFAULT_TAB_KEY)
    if (saved && VALID_DEFAULT_TABS.includes(saved)) return saved
  } catch {
    // Ignore storage errors in restricted browser sessions.
  }
  return 'tools'
}

export const defaultTab = ref(resolveDefaultTab())

export function setDefaultTab(tab, storage) {
  if (!VALID_DEFAULT_TABS.includes(tab)) return false
  defaultTab.value = tab
  try {
    safeStorage(storage)?.setItem(DEFAULT_TAB_KEY, tab)
  } catch {
    // Ignore storage errors in restricted browser sessions.
  }
  return true
}
