<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { search as cmSearch, searchKeymap } from '@codemirror/search'
import {
  Search,
  RefreshCw,
  Folder,
  FolderOpen,
  FileCode2,
  Save,
  RotateCcw,
  AlertTriangle,
  Lock,
  Check,
  X,
  ChevronDown,
  ChevronRight,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { klipperLanguage, stormtrooperEditorTheme } from '../klipper-lang.mjs'
import { useConfigEditor } from '../useConfigEditor.js'

const props = defineProps({
  printLocked: Boolean,
  moonrakerOnline: Boolean,
})

const emit = defineEmits(['saved', 'restarted', 'moonraker-status'])

const store = useConfigEditor()
const cmHost = ref(null)
const pendingSwitchPath = ref('')
const mobileTreeCollapsed = ref(false)
const openDirs = ref(new Set(['']))

let editorView = null
let applyingExternal = false
const readOnlyCompartment = new Compartment()

const effectiveReadonly = computed(() => store.readonly.value || props.printLocked || !props.moonrakerOnline)

const visibleFiles = computed(() => {
  const q = store.search.value.trim().toLowerCase()
  return store.files.value.filter(file => {
    if (!store.showBackups.value && file.isBackup) return false
    if (q && !file.path.toLowerCase().includes(q)) return false
    return true
  })
})

const groupedDirs = computed(() => {
  const map = new Map()
  for (const file of visibleFiles.value) {
    const dir = file.dir || ''
    if (!map.has(dir)) map.set(dir, [])
    map.get(dir).push(file)
  }
  return Array.from(map.entries()).map(([dir, items]) => ({
    dir,
    label: dir || t('(Hauptverzeichnis)'),
    items,
  }))
})

const restartTarget = computed(() => {
  if (!store.currentPath.value || store.readonly.value || store.isBackup.value || store.isScript.value) return 'none'
  const lower = store.currentPath.value.split('/').pop().toLowerCase()
  if (lower === 'moonraker.conf') return 'moonraker'
  if (lower === 'crowsnest.conf') return 'crowsnest'
  if (/\.(cfg|conf)$/i.test(lower)) return 'klipper_restart'
  return 'none'
})

const restartActionLabel = computed(() => {
  if (restartTarget.value === 'moonraker') return t('Speichern & Moonraker-Neustart')
  if (restartTarget.value === 'crowsnest') return t('Speichern & Crowsnest-Neustart')
  if (restartTarget.value === 'klipper_restart') return t('Speichern & Klipper-Neustart')
  return ''
})

const readonlyReason = computed(() => {
  if (props.printLocked) return t('Schreibgeschützt · Druck läuft')
  if (!props.moonrakerOnline) return t('Schreibgeschützt · Offline')
  if (store.isScript.value) return t('Schreibgeschützt · Skript')
  if (store.isBackup.value) return t('Schreibgeschützt · Backup')
  if (store.readonly.value) return t('Schreibgeschützt')
  return ''
})

function isDirOpen(dir) {
  if (store.search.value.trim()) return true
  return openDirs.value.has(dir)
}

function toggleDir(dir) {
  const next = new Set(openDirs.value)
  if (next.has(dir)) next.delete(dir)
  else next.add(dir)
  openDirs.value = next
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatModified(ts) {
  if (!Number.isFinite(ts)) return '—'
  return new Date(ts * 1000).toLocaleString(locale.value, {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

async function handleSave(restart = 'none', force = false) {
  if (effectiveReadonly.value || store.saving.value) return
  if (!store.isDirty.value && !force) return
  const result = await store.saveFile({ restart, force })
  if (result.ok) {
    emit('saved', { path: store.currentPath.value })
    if (result.restarted) emit('restarted', { target: result.restarted })
  }
}

function mountEditor() {
  if (!cmHost.value) return
  destroyEditor()

  const saveShortcut = keymap.of([
    {
      key: 'Mod-s',
      run: () => {
        handleSave('none')
        return true
      },
    },
  ])

  const state = EditorState.create({
    doc: store.content.value,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      cmSearch({ top: true }),
      klipperLanguage,
      ...stormtrooperEditorTheme,
      readOnlyCompartment.of([
        EditorState.readOnly.of(effectiveReadonly.value),
        EditorView.editable.of(!effectiveReadonly.value),
      ]),
      saveShortcut,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !applyingExternal) {
          store.setContent(update.state.doc.toString())
        }
      }),
    ],
  })

  editorView = new EditorView({
    state,
    parent: cmHost.value,
  })
}

function destroyEditor() {
  if (editorView) {
    editorView.destroy()
    editorView = null
  }
}

function syncEditorDoc(nextDoc) {
  if (!editorView) return
  const currentDoc = editorView.state.doc.toString()
  if (currentDoc === nextDoc) return
  applyingExternal = true
  try {
    editorView.dispatch({
      changes: { from: 0, to: currentDoc.length, insert: nextDoc },
    })
  } finally {
    applyingExternal = false
  }
}

watch(effectiveReadonly, isRo => {
  if (!editorView) return
  editorView.dispatch({
    effects: readOnlyCompartment.reconfigure([
      EditorState.readOnly.of(isRo),
      EditorView.editable.of(!isRo),
    ]),
  })
})

watch(
  () => [store.currentPath.value, store.loadingFile.value],
  async ([path, loading]) => {
    if (!path || loading) return
    await nextTick()
    mountEditor()
  },
)

watch(
  () => store.content.value,
  nextValue => {
    if (editorView && editorView.state.doc.toString() !== nextValue) {
      syncEditorDoc(nextValue)
    }
  },
)

async function requestSelectFile(path) {
  if (path === store.currentPath.value) return
  if (store.isDirty.value) {
    pendingSwitchPath.value = path
    return
  }
  pendingSwitchPath.value = ''
  const ok = await store.openFile(path)
  emit('moonraker-status', ok)
}

async function confirmDiscardAndSwitch() {
  const target = pendingSwitchPath.value
  pendingSwitchPath.value = ''
  store.discardChanges()
  if (target) {
    const ok = await store.openFile(target)
    emit('moonraker-status', ok)
  }
}

async function reloadFromDisk() {
  if (!store.currentPath.value) return
  pendingSwitchPath.value = ''
  const ok = await store.openFile(store.currentPath.value)
  emit('moonraker-status', ok)
}

async function refreshList() {
  const ok = await store.loadFileList()
  emit('moonraker-status', ok)
}

onMounted(async () => {
  if (!store.files.value.length) {
    const ok = await store.loadFileList()
    emit('moonraker-status', ok)
  }
  if (!store.currentPath.value && store.files.value.length) {
    const preferred =
      store.files.value.find(f => f.path === 'printer.cfg') ??
      store.files.value.find(f => !f.isBackup) ??
      store.files.value[0]
    if (preferred) {
      const ok = await store.openFile(preferred.path)
      emit('moonraker-status', ok)
    }
  } else if (store.currentPath.value && !store.loadingFile.value) {
    await nextTick()
    mountEditor()
  }
})

onBeforeUnmount(() => {
  destroyEditor()
})
</script>

<template>
  <div class="config-workbench">
    <aside class="config-tree" :class="{ collapsed: mobileTreeCollapsed }" :aria-label="t('Konfigurationsdateien')">
      <div class="config-tree-head">
        <div class="config-tree-search">
          <Search :size="14" />
          <input
            v-model="store.search.value"
            type="search"
            :placeholder="t('Dateien durchsuchen …')"
            :aria-label="t('Dateien durchsuchen')"
          />
          <button
            v-if="store.search.value"
            type="button"
            class="history-search-clear"
            :aria-label="t('Suche leeren')"
            @click="store.search.value = ''"
          >
            <X :size="13" />
          </button>
        </div>
        <div class="config-tree-toggle">
          <label>
            <input v-model="store.showBackups.value" type="checkbox" />
            <span>{{ t('Backups anzeigen') }}</span>
          </label>
          <div class="confirm-inline">
            <button
              type="button"
              class="icon-button"
              :disabled="store.loadingList.value"
              :title="t('Dateiliste aktualisieren')"
              :aria-label="t('Dateiliste aktualisieren')"
              @click="refreshList"
            >
              <RefreshCw :size="14" :class="{ spinning: store.loadingList.value }" />
            </button>
            <button
              type="button"
              class="icon-button config-tree-mobile-toggle"
              :aria-expanded="!mobileTreeCollapsed"
              :aria-label="mobileTreeCollapsed ? t('Dateiliste einblenden') : t('Dateiliste ausblenden')"
              @click="mobileTreeCollapsed = !mobileTreeCollapsed"
            >
              <ChevronRight v-if="mobileTreeCollapsed" :size="15" />
              <ChevronDown v-else :size="15" />
            </button>
          </div>
        </div>
      </div>

      <div class="config-tree-scroll">
        <div v-if="store.loadingList.value && !store.files.value.length" class="skeleton-block">
          <span class="skeleton-bar" />
          <span class="skeleton-bar sm" />
          <span class="skeleton-bar" />
          <span class="skeleton-bar sm" />
          <span class="skeleton-bar" />
        </div>

        <div v-else-if="store.listError.value && !store.files.value.length" class="system-banner amber">
          <AlertTriangle :size="15" />
          <span>{{ t(store.listError.value) }}</span>
        </div>

        <div v-else-if="!groupedDirs.length" class="config-empty-pane" style="min-height: 160px; padding: 20px">
          <span>{{ t('Keine passenden Dateien gefunden.') }}</span>
        </div>

        <div v-for="group in groupedDirs" :key="group.dir" class="config-dir-group">
          <button
            type="button"
            class="config-dir-button"
            :aria-expanded="isDirOpen(group.dir)"
            @click="toggleDir(group.dir)"
          >
            <FolderOpen v-if="isDirOpen(group.dir)" :size="14" />
            <Folder v-else :size="14" />
            <span>{{ group.label }}</span>
            <span class="config-dir-count">{{ group.items.length }}</span>
          </button>
          <ul v-show="isDirOpen(group.dir)" class="config-file-list">
            <li v-for="file in group.items" :key="file.path">
              <button
                type="button"
                class="config-file-button"
                :class="{ active: store.currentPath.value === file.path }"
                @click="requestSelectFile(file.path)"
              >
                <span class="config-file-name">{{ file.name }}</span>
                <span v-if="file.readonly" class="config-ro-tag" :title="t('Schreibgeschützt')">RO</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </aside>

    <section class="config-editor-pane" :aria-label="t('Konfigurationseditor')">
      <template v-if="store.currentPath.value || store.loadingFile.value">
        <header class="config-editor-toolbar">
          <div class="config-editor-title">
            <div class="config-editor-path">
              <strong>{{ store.currentPath.value || t('Lade Datei …') }}</strong>
              <span v-if="store.isDirty.value" class="status-pill amber">{{ t('Ungespeichert') }}</span>
              <span v-if="readonlyReason" class="status-pill muted">
                <Lock :size="11" />{{ readonlyReason }}
              </span>
            </div>
            <span v-if="store.currentPath.value" class="config-editor-meta">
              {{ formatBytes(store.size.value) }} · {{ t('Geändert') }}: {{ formatModified(store.modified.value) }}
            </span>
          </div>

          <div class="config-editor-actions">
            <button
              type="button"
              class="subtle-button"
              :disabled="!store.isDirty.value || store.saving.value"
              @click="store.discardChanges()"
            >
              <RotateCcw :size="14" />{{ t('Verwerfen') }}
            </button>
            <button
              type="button"
              class="subtle-button"
              :disabled="!store.isDirty.value || effectiveReadonly || store.saving.value"
              :title="t('Änderungen speichern (Strg/Cmd+S)')"
              @click="handleSave('none')"
            >
              <Save :size="14" />{{ store.saving.value ? t('Speichere …') : t('Speichern') }}
            </button>
            <button
              v-if="restartTarget !== 'none'"
              type="button"
              class="primary-control"
              :disabled="!store.isDirty.value || effectiveReadonly || store.saving.value"
              @click="handleSave(restartTarget)"
            >
              <Check :size="14" />{{ restartActionLabel }}
            </button>
          </div>
        </header>

        <div v-if="pendingSwitchPath" class="config-editor-notice amber" role="alert">
          <AlertTriangle :size="15" />
          <span>{{ t('Ungespeicherte Änderungen in {0} — trotzdem wechseln?', [store.currentPath.value]) }}</span>
          <div class="config-editor-notice-actions">
            <button type="button" class="confirm-button" @click="confirmDiscardAndSwitch">
              {{ t('Verwerfen & wechseln') }}
            </button>
            <button type="button" class="subtle-button" @click="pendingSwitchPath = ''">
              {{ t('Bleiben') }}
            </button>
          </div>
        </div>

        <div v-if="store.conflict.value" class="config-editor-notice amber" role="alert">
          <AlertTriangle :size="15" />
          <span>{{ t(store.conflict.value.message) }}</span>
          <div class="config-editor-notice-actions">
            <button type="button" class="subtle-button" @click="reloadFromDisk">
              {{ t('Neu laden (Änderungen verwerfen)') }}
            </button>
            <button
              type="button"
              class="confirm-button"
              :disabled="store.saving.value"
              @click="handleSave(store.conflict.value.pendingRestart || 'none', true)"
            >
              {{ t('Trotzdem überschreiben') }}
            </button>
          </div>
        </div>

        <div v-if="props.printLocked" class="config-editor-notice amber" role="status">
          <Lock :size="15" />
          <span>{{ t('Während eines aktiven oder pausierten Drucks ist der Editor schreibgeschützt.') }}</span>
        </div>

        <div
          v-if="store.saveFeedback.value"
          class="config-editor-notice"
          :class="store.saveFeedback.value.ok ? 'lime' : 'amber'"
          role="status"
        >
          <Check v-if="store.saveFeedback.value.ok" :size="15" />
          <AlertTriangle v-else :size="15" />
          <span>{{ t(store.saveFeedback.value.message) }}</span>
        </div>

        <div v-if="store.fileError.value" class="config-editor-notice amber" role="alert">
          <AlertTriangle :size="15" />
          <span>{{ t(store.fileError.value) }}</span>
        </div>

        <div v-if="store.loadingFile.value" class="skeleton-block" style="min-height: 440px">
          <span class="skeleton-bar lg" />
          <span class="skeleton-bar" />
          <span class="skeleton-bar sm" />
          <span class="skeleton-bar" />
          <span class="skeleton-bar" />
          <span class="skeleton-bar sm" />
        </div>
        <div v-else ref="cmHost" class="config-cm-host" />
      </template>

      <div v-else class="config-empty-pane">
        <FileCode2 :size="24" />
        <p>{{ t('Wähle links eine Konfigurationsdatei aus, um sie anzusehen oder zu bearbeiten.') }}</p>
      </div>
    </section>
  </div>
</template>
