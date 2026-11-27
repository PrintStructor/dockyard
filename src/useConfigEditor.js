import { computed, ref } from 'vue'
import { isConnectivityFailure } from './system-state.mjs'
import { useSettings } from './useSettings.js'

const files = ref([])
const loadingList = ref(false)
const listError = ref('')
const showBackups = ref(false)
const search = ref('')

const currentPath = ref('')
const originalContent = ref('')
const content = ref('')
const modified = ref(null)
const size = ref(null)
const readonly = ref(false)
const isBackup = ref(false)
const isScript = ref(false)
const loadedPrinterId = ref('')
const loadedPrinterName = ref('')

const loadingFile = ref(false)
const saving = ref(false)
const fileError = ref('')
const saveFeedback = ref(null)
const conflict = ref(null)
const printerMismatch = ref(null)

const isDirty = computed(() => Boolean(currentPath.value) && !readonly.value && content.value !== originalContent.value)

let unloadListenerBound = false
function ensureUnloadGuard() {
  if (unloadListenerBound || typeof window === 'undefined') return
  unloadListenerBound = true
  window.addEventListener('beforeunload', event => {
    if (!isDirty.value) return
    event.preventDefault()
    event.returnValue = ''
  })
}

async function loadFileList() {
  loadingList.value = true
  listError.value = ''
  try {
    const response = await fetch('/api/system/config/list', { signal: AbortSignal.timeout(8000) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const err = new Error(data.error || 'Konfigurationsliste nicht erreichbar.')
      err.httpStatus = response.status
      throw err
    }
    files.value = Array.isArray(data.files) ? data.files : []
    return { ok: true, connectivityError: false }
  } catch (cause) {
    listError.value = cause.message || 'Konfigurationsliste nicht erreichbar.'
    return { ok: false, connectivityError: isConnectivityFailure(cause.httpStatus ?? 0) }
  } finally {
    loadingList.value = false
  }
}

async function openFile(path, { printerId, printerName } = {}) {
  if (!path) return { ok: false, connectivityError: false }
  ensureUnloadGuard()
  loadingFile.value = true
  fileError.value = ''
  saveFeedback.value = null
  conflict.value = null
  printerMismatch.value = null
  try {
    const response = await fetch(`/api/system/config/file?path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const err = new Error(data.error || 'Datei konnte nicht geladen werden.')
      err.httpStatus = response.status
      throw err
    }
    const settingsStore = useSettings()
    const resolvedId = data.printerId || printerId || settingsStore.activePrinter.value?.id || ''
    const matchedProfile = settingsStore.printers.value.find(p => p.id === resolvedId)
    currentPath.value = data.path
    originalContent.value = data.content
    content.value = data.content
    modified.value = data.modified ?? null
    size.value = data.size ?? null
    readonly.value = Boolean(data.readonly)
    isBackup.value = Boolean(data.isBackup)
    isScript.value = Boolean(data.isScript)
    loadedPrinterId.value = resolvedId
    loadedPrinterName.value =
      printerName || matchedProfile?.name || settingsStore.activePrinter.value?.name || resolvedId
    return { ok: true, connectivityError: false }
  } catch (cause) {
    fileError.value = cause.message || 'Datei konnte nicht geladen werden.'
    return { ok: false, connectivityError: isConnectivityFailure(cause.httpStatus ?? 0) }
  } finally {
    loadingFile.value = false
  }
}

function setContent(nextValue) {
  content.value = nextValue
  if (saveFeedback.value?.ok) saveFeedback.value = null
}

function discardChanges() {
  content.value = originalContent.value
  conflict.value = null
  saveFeedback.value = null
}

function clearConflict() {
  conflict.value = null
}

function resetBuffer() {
  currentPath.value = ''
  originalContent.value = ''
  content.value = ''
  modified.value = null
  size.value = null
  readonly.value = false
  isBackup.value = false
  isScript.value = false
  loadedPrinterId.value = ''
  loadedPrinterName.value = ''
  conflict.value = null
  saveFeedback.value = null
  fileError.value = ''
  printerMismatch.value = null
}

function handlePrinterSwitch(nextPrinterId, nextPrinterName = '') {
  const nextId = String(nextPrinterId ?? '').trim().toLowerCase()
  if (!currentPath.value) {
    files.value = []
    listError.value = ''
    printerMismatch.value = null
    return { locked: false, reloadList: true }
  }
  if (loadedPrinterId.value && nextId && loadedPrinterId.value === nextId) {
    printerMismatch.value = null
    return { locked: false, reloadList: false }
  }
  if (isDirty.value) {
    files.value = []
    listError.value = ''
    printerMismatch.value = {
      fromPrinterId: loadedPrinterId.value,
      fromPrinterName: loadedPrinterName.value || loadedPrinterId.value,
      toPrinterId: nextId,
      toPrinterName: nextPrinterName || nextId,
      filePath: currentPath.value,
    }
    return { locked: true, reloadList: true }
  }
  files.value = []
  listError.value = ''
  resetBuffer()
  return { locked: false, reloadList: true }
}

async function acknowledgePrinterMismatchAndReload() {
  resetBuffer()
  const res = await loadFileList()
  if (res.ok && files.value.length) {
    const preferred =
      files.value.find(f => f.path === 'printer.cfg') ??
      files.value.find(f => !f.isBackup) ??
      files.value[0]
    if (preferred) {
      await openFile(preferred.path)
    }
  }
  return res
}

async function saveFile({ restart = 'none', force = false } = {}) {
  if (printerMismatch.value) return { ok: false, printerChanged: true }
  if (!currentPath.value || readonly.value || saving.value) return { ok: false }
  saving.value = true
  fileError.value = ''
  saveFeedback.value = null
  if (force) conflict.value = null
  try {
    const response = await fetch('/api/system/config/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({
        path: currentPath.value,
        content: content.value,
        expectedModified: modified.value,
        expectedPrinterId: loadedPrinterId.value || undefined,
        force,
        restart,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => ({}))
    if (response.status === 409 && data.code === 'PRINTER_CHANGED') {
      const settingsStore = useSettings()
      printerMismatch.value = {
        fromPrinterId: loadedPrinterId.value,
        fromPrinterName: loadedPrinterName.value || loadedPrinterId.value,
        toPrinterId: settingsStore.activePrinter.value?.id || '',
        toPrinterName: settingsStore.activePrinter.value?.name || '',
        filePath: currentPath.value,
      }
      saveFeedback.value = {
        ok: false,
        message: data.error || 'Der aktive Drucker wurde geändert. Speichern abgebrochen.',
      }
      return { ok: false, printerChanged: true }
    }
    if (response.status === 409 && data.code === 'FILE_CHANGED') {
      conflict.value = {
        message: data.error || 'Die Datei wurde inzwischen auf dem Drucker geändert (z. B. durch SAVE_CONFIG).',
        currentModified: data.currentModified ?? null,
        pendingRestart: restart,
      }
      return { ok: false, conflict: true }
    }
    if (!response.ok) throw new Error(data.error || 'Speichern fehlgeschlagen.')

    originalContent.value = content.value
    if (data.modified != null) modified.value = data.modified
    size.value = new TextEncoder().encode(content.value).length
    conflict.value = null
    saveFeedback.value = { ok: true, message: data.message || `${currentPath.value} gespeichert.` }

    // Update cached metadata in file list without resetting tree state.
    const idx = files.value.findIndex(item => item.path === currentPath.value)
    if (idx !== -1) {
      files.value[idx] = {
        ...files.value[idx],
        size: size.value,
        modified: modified.value,
      }
    }
    return { ok: true, restarted: data.restarted ?? null }
  } catch (cause) {
    saveFeedback.value = { ok: false, message: cause.message || 'Speichern fehlgeschlagen.' }
    return { ok: false }
  } finally {
    saving.value = false
  }
}

async function createFile(relPath, initialContent = '') {
  const clean = String(relPath ?? '').trim()
  if (!clean) return { ok: false, error: 'Bitte einen Dateinamen angeben.' }
  saving.value = true
  fileError.value = ''
  saveFeedback.value = null
  try {
    const response = await fetch('/api/system/config/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({
        path: clean,
        content: initialContent || `# ${clean}\n`,
      }),
      signal: AbortSignal.timeout(12_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Datei konnte nicht erstellt werden.')
    await loadFileList()
    const createdPath = data.created || clean
    await openFile(createdPath)
    saveFeedback.value = { ok: true, message: `${createdPath} erstellt.` }
    return { ok: true, path: createdPath }
  } catch (cause) {
    const message = cause.message || 'Datei konnte nicht erstellt werden.'
    saveFeedback.value = { ok: false, message }
    return { ok: false, error: message }
  } finally {
    saving.value = false
  }
}

async function deleteFile(relPath = currentPath.value) {
  if (!relPath || saving.value) return { ok: false }
  saving.value = true
  fileError.value = ''
  saveFeedback.value = null
  try {
    const response = await fetch(`/api/system/config/file?path=${encodeURIComponent(relPath)}`, {
      method: 'DELETE',
      headers: { 'X-Cockpit-Request': '1' },
      signal: AbortSignal.timeout(12_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Konfigurationsdatei konnte nicht gelöscht werden.')
    if (currentPath.value === relPath) resetBuffer()
    await loadFileList()
    saveFeedback.value = { ok: true, message: `${relPath} gelöscht.` }
    return { ok: true }
  } catch (cause) {
    const message = cause.message || 'Konfigurationsdatei konnte nicht gelöscht werden.'
    saveFeedback.value = { ok: false, message }
    return { ok: false, error: message }
  } finally {
    saving.value = false
  }
}

export function useConfigEditor() {
  ensureUnloadGuard()
  return {
    files,
    loadingList,
    listError,
    showBackups,
    search,
    currentPath,
    originalContent,
    content,
    modified,
    size,
    readonly,
    isBackup,
    isScript,
    loadedPrinterId,
    loadedPrinterName,
    loadingFile,
    saving,
    fileError,
    saveFeedback,
    conflict,
    printerMismatch,
    isDirty,
    loadFileList,
    openFile,
    setContent,
    discardChanges,
    saveFile,
    createFile,
    deleteFile,
    clearConflict,
    handlePrinterSwitch,
    acknowledgePrinterMismatchAndReload,
  }
}
