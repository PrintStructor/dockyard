import { computed, ref } from 'vue'

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

const loadingFile = ref(false)
const saving = ref(false)
const fileError = ref('')
const saveFeedback = ref(null)
const conflict = ref(null)

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
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Konfigurationsliste nicht erreichbar.')
    files.value = Array.isArray(data.files) ? data.files : []
    return true
  } catch (cause) {
    listError.value = cause.message || 'Konfigurationsliste nicht erreichbar.'
    return false
  } finally {
    loadingList.value = false
  }
}

async function openFile(path) {
  if (!path) return false
  ensureUnloadGuard()
  loadingFile.value = true
  fileError.value = ''
  saveFeedback.value = null
  conflict.value = null
  try {
    const response = await fetch(`/api/system/config/file?path=${encodeURIComponent(path)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Datei konnte nicht geladen werden.')
    currentPath.value = data.path
    originalContent.value = data.content
    content.value = data.content
    modified.value = data.modified ?? null
    size.value = data.size ?? null
    readonly.value = Boolean(data.readonly)
    isBackup.value = Boolean(data.isBackup)
    isScript.value = Boolean(data.isScript)
    return true
  } catch (cause) {
    fileError.value = cause.message || 'Datei konnte nicht geladen werden.'
    return false
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

async function saveFile({ restart = 'none', force = false } = {}) {
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
        force,
        restart,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => ({}))
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
    loadingFile,
    saving,
    fileError,
    saveFeedback,
    conflict,
    isDirty,
    loadFileList,
    openFile,
    setContent,
    discardChanges,
    saveFile,
    clearConflict,
  }
}
