<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  Settings,
  X,
  Printer,
  Camera,
  SlidersHorizontal,
  Shield,
  Plus,
  Copy,
  Trash2,
  Check,
  AlertTriangle,
  Wifi,
  Download,
  Upload,
  Lock,
  RefreshCw,
} from '@lucide/vue'
import { t, language, setLanguage } from '../i18n.mjs'
import {
  displayMode,
  setDisplayMode,
  camerasHiddenPreference,
  setCamerasHidden,
  defaultTab,
  setDefaultTab,
} from '../display-mode.mjs'
import { resolveMainsailUrl } from '../printer-ui-url.mjs'
import {
  useSettings,
  buildPrintersExport,
  parsePrintersImport,
  mergePrinterProfiles,
} from '../useSettings.js'
import { useConfigEditor } from '../useConfigEditor.js'
import CockpitSelect from './CockpitSelect.vue'

const props = defineProps({
  open: Boolean,
  initialSection: { type: String, default: 'printers' },
})

const emit = defineEmits(['close', 'switched'])

const settingsStore = useSettings()
const configEditor = useConfigEditor()

const dialogEl = ref(null)
const importInputEl = ref(null)
const activeSection = ref('printers')

const draft = ref({
  activePrinterId: '',
  printers: [],
  network: {
    allowedOrigins: [],
    allowLanOrigins: false,
  },
})
const baselineJson = ref('')
const selectedPrinterId = ref('')
const deleteConfirmId = ref('')
const closeConfirmOpen = ref(false)
const dirtyConfigSwitchConfirm = ref(null) // { mode: 'switch' | 'save', printerId?, payload? }
const selfLockoutPending = ref(false)

const testState = ref({
  testing: false,
  result: null,
  forPrinterId: '',
})
const saveFeedback = ref(null) // { ok: boolean, message: string }
const originDraft = ref('')
const originError = ref('')

const importPreview = ref(null) // { filename, parsed, mode: 'merge' | 'replace' }
const importError = ref('')

const sections = computed(() => [
  { id: 'printers', label: t('Drucker & Verbindung'), icon: Printer },
  { id: 'cameras', label: t('Kameras'), icon: Camera },
  { id: 'interface', label: t('Oberfläche'), icon: SlidersHorizontal },
  { id: 'network', label: t('Netzwerk & Backup'), icon: Shield },
])

const languageOptions = computed(() => [
  { value: 'de', label: 'Deutsch (DE)', lang: 'de' },
  { value: 'en', label: 'English (EN)', lang: 'en' },
])

const defaultTabOptions = computed(() => [
  { value: 'tools', label: t('Werkzeuge') },
  { value: 'print', label: t('Drucken') },
  { value: 'controls', label: t('Steuerung') },
  { value: 'cameras', label: t('Kameras') },
  { value: 'history', label: t('Verlauf') },
  { value: 'system', label: t('System') },
])

const cameraServiceOptions = computed(() => [
  { value: 'camera-streamer', label: t('camera-streamer (WebRTC + MJPEG)') },
  { value: 'mjpeg', label: t('ustreamer / Direkt-MJPEG') },
])

const cameraTransportOptions = computed(() => [
  { value: 'webrtc', label: t('WebRTC (geringe Latenz)') },
  { value: 'mjpeg', label: t('MJPEG-Stream') },
])

const canWrite = computed(() => settingsStore.runtime.value?.canWrite !== false)
const envAllowLan = computed(() => Boolean(settingsStore.network.value?.envAllowLanOrigins))
const envAllowedOrigins = computed(() => settingsStore.network.value?.envAllowedOrigins ?? [])

function cloneDraftFromStore() {
  const current = settingsStore.settings.value
  const printers = (current?.printers ?? []).map(p => ({
    id: p.id,
    name: p.name,
    subtitle: p.subtitle ?? '',
    url: p.url,
    mainsailUrl: p.mainsailUrl || 'auto',
    cameras: (p.cameras ?? []).map(c => ({
      id: c.id,
      name: c.name,
      description: c.description ?? '',
      service: c.service === 'mjpeg' ? 'mjpeg' : 'camera-streamer',
      url: c.url,
      snapshotUrl: c.snapshotUrl ?? '',
      preferredMode: c.service === 'mjpeg' ? 'mjpeg' : c.preferredMode === 'mjpeg' ? 'mjpeg' : 'webrtc',
      enabled: c.enabled !== false,
    })),
  }))
  const activeId = printers.some(p => p.id === current?.activePrinterId)
    ? current.activePrinterId
    : printers[0]?.id ?? ''
  const nextDraft = {
    activePrinterId: activeId,
    printers,
    network: {
      allowedOrigins: [...(current?.network?.allowedOrigins ?? [])],
      allowLanOrigins: Boolean(current?.network?.allowLanOrigins),
    },
  }
  draft.value = nextDraft
  baselineJson.value = JSON.stringify(nextDraft)
  if (!printers.some(p => p.id === selectedPrinterId.value)) {
    selectedPrinterId.value = activeId
  }
  deleteConfirmId.value = ''
  closeConfirmOpen.value = false
  dirtyConfigSwitchConfirm.value = null
  selfLockoutPending.value = false
  testState.value = { testing: false, result: null, forPrinterId: '' }
}

const isServerDirty = computed(() => Boolean(baselineJson.value) && JSON.stringify(draft.value) !== baselineJson.value)
const isServerBackedTab = computed(() => activeSection.value !== 'interface')

const selectedPrinter = computed(
  () => draft.value.printers.find(p => p.id === selectedPrinterId.value) ?? draft.value.printers[0] ?? null,
)

const printerSelectOptions = computed(() =>
  draft.value.printers.map(p => ({
    value: p.id,
    label: p.name || p.id,
    sublabel: p.url,
  })),
)

const resolvedMainsailPreview = computed(() => {
  const printer = selectedPrinter.value
  if (!printer) return ''
  return resolveMainsailUrl(printer.mainsailUrl, globalThis.location, printer.url)
})

const canAddCurrentOrigin = computed(() => {
  const origin = settingsStore.runtime.value?.requestOrigin
  if (!origin || !/^https?:\/\//i.test(origin)) return false
  return !draft.value.network.allowedOrigins.includes(origin) && !envAllowedOrigins.value.includes(origin)
})

function slugifyLocal(raw, fallback) {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  return slug || fallback
}

function uniquePrinterId(baseName) {
  const base = slugifyLocal(baseName, 'voron')
  const existing = new Set(draft.value.printers.map(p => p.id))
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

function addPrinter() {
  if (draft.value.printers.length >= 16) return
  const num = draft.value.printers.length + 1
  const name = `VORON-${num}`
  const id = uniquePrinterId(name)
  draft.value.printers.push({
    id,
    name,
    subtitle: 'VORON',
    url: 'http://192.168.1.100',
    mainsailUrl: 'auto',
    cameras: [
      {
        id: 'webcam',
        name: 'Webcam',
        description: '',
        service: 'camera-streamer',
        url: '/webcam',
        snapshotUrl: '',
        preferredMode: 'webrtc',
        enabled: true,
      },
    ],
  })
  selectedPrinterId.value = id
  testState.value = { testing: false, result: null, forPrinterId: id }
  saveFeedback.value = null
}

function duplicatePrinter(printer) {
  if (draft.value.printers.length >= 16) return
  const copyName = `${printer.name} Copy`.slice(0, 32)
  const id = uniquePrinterId(copyName)
  draft.value.printers.push({
    ...printer,
    id,
    name: copyName,
    cameras: printer.cameras.map(c => ({ ...c })),
  })
  selectedPrinterId.value = id
  saveFeedback.value = null
}

function requestDeletePrinter(printerId) {
  if (draft.value.printers.length <= 1) return
  if (deleteConfirmId.value !== printerId) {
    deleteConfirmId.value = printerId
    return
  }
  const idx = draft.value.printers.findIndex(p => p.id === printerId)
  if (idx === -1) return
  draft.value.printers.splice(idx, 1)
  deleteConfirmId.value = ''
  if (draft.value.activePrinterId === printerId) {
    draft.value.activePrinterId = draft.value.printers[0]?.id ?? ''
  }
  if (selectedPrinterId.value === printerId) {
    selectedPrinterId.value = draft.value.activePrinterId || draft.value.printers[0]?.id || ''
  }
  saveFeedback.value = null
}

function needsDirtyConfigConfirm(nextPrinterId) {
  if (!configEditor.isDirty.value) return false
  const currentActiveId = settingsStore.activePrinter.value?.id || ''
  return Boolean(nextPrinterId && currentActiveId && nextPrinterId !== currentActiveId)
}

async function activatePrinter(printer, confirmedDirty = false) {
  saveFeedback.value = null
  if (isServerDirty.value) {
    draft.value.activePrinterId = printer.id
    return
  }
  if (!canWrite.value) return
  if (!confirmedDirty && needsDirtyConfigConfirm(printer.id)) {
    dirtyConfigSwitchConfirm.value = { mode: 'switch', printerId: printer.id, printerName: printer.name }
    return
  }
  dirtyConfigSwitchConfirm.value = null
  const res = await settingsStore.switchPrinter(printer.id)
  if (!res.ok) {
    saveFeedback.value = { ok: false, message: res.error }
    return
  }
  cloneDraftFromStore()
  saveFeedback.value = { ok: true, message: t('Aktiver Drucker gewechselt auf {0}.', [printer.name]) }
  emit('switched', {
    activePrinterChanged: Boolean(res.data?.activePrinterChanged),
    printerUrlChanged: Boolean(res.data?.printerUrlChanged),
    settings: res.data,
  })
}

async function runConnectionTest() {
  const printer = selectedPrinter.value
  if (!printer || testState.value.testing) return
  testState.value = { testing: true, result: null, forPrinterId: printer.id }
  const result = await settingsStore.testConnection(printer.url)
  testState.value = { testing: false, result, forPrinterId: printer.id }
}

function uniqueCameraId(printer, base = 'cam') {
  const existing = new Set(printer.cameras.map(c => c.id))
  const clean = slugifyLocal(base, 'cam').replace(/-/g, '_')
  if (!existing.has(clean)) return clean
  let n = 2
  while (existing.has(`${clean}_${n}`)) n++
  return `${clean}_${n}`
}

function addCamera() {
  const printer = selectedPrinter.value
  if (!printer || printer.cameras.length >= 6) return
  const num = printer.cameras.length + 1
  const id = uniqueCameraId(printer, `cam_${num}`)
  printer.cameras.push({
    id,
    name: `${t('Kamera')} ${num}`,
    description: '',
    service: 'camera-streamer',
    url: `/webcam${num > 1 ? num : ''}`,
    snapshotUrl: '',
    preferredMode: 'webrtc',
    enabled: true,
  })
}

function removeCamera(index) {
  const printer = selectedPrinter.value
  if (!printer) return
  printer.cameras.splice(index, 1)
}

function onCameraServiceChange(cam, nextService) {
  cam.service = nextService === 'mjpeg' ? 'mjpeg' : 'camera-streamer'
  if (cam.service === 'mjpeg') {
    cam.preferredMode = 'mjpeg'
    if (cam.url === '/webcam') cam.url = '/webcam/?action=stream'
  } else {
    if (cam.url === '/webcam/?action=stream') cam.url = '/webcam'
    cam.snapshotUrl = ''
  }
}

function addAllowedOrigin(rawValue = originDraft.value) {
  originError.value = ''
  const raw = String(rawValue ?? '').trim()
  if (!raw) return
  let normalized
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Nur http:// oder https:// erlaubt.')
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error('Bitte nur Schema, Host und optional Port angeben (z. B. http://192.168.1.50:4173).')
    }
    normalized = parsed.origin
  } catch (err) {
    originError.value = err.message || 'Ungültiger Origin.'
    return
  }
  if (!draft.value.network.allowedOrigins.includes(normalized)) {
    draft.value.network.allowedOrigins.push(normalized)
  }
  originDraft.value = ''
}

function removeAllowedOrigin(origin) {
  draft.value.network.allowedOrigins = draft.value.network.allowedOrigins.filter(item => item !== origin)
}

function exportProfiles() {
  const data = buildPrintersExport({
    activePrinterId: draft.value.activePrinterId,
    printers: draft.value.printers,
  })
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'dockyard-printers-backup.json'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function triggerImportPicker() {
  importError.value = ''
  importInputEl.value?.click()
}

async function onImportFileSelected(event) {
  importError.value = ''
  importPreview.value = null
  const file = event.target?.files?.[0]
  if (event.target) event.target.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const parsed = parsePrintersImport(text)
    importPreview.value = {
      filename: file.name,
      parsed,
      mode: 'merge',
    }
  } catch (err) {
    importError.value = err.message || 'Import fehlgeschlagen.'
  }
}

function applyImportToDraft() {
  if (!importPreview.value) return
  importError.value = ''
  try {
    const merged = mergePrinterProfiles(
      draft.value.printers,
      importPreview.value.parsed.printers,
      importPreview.value.mode,
      draft.value.activePrinterId,
      importPreview.value.parsed.activePrinterId,
    )
    draft.value.printers = merged.printers.map(p => ({
      ...p,
      cameras: (p.cameras ?? []).map(c => ({
        id: c.id,
        name: c.name,
        description: c.description ?? '',
        service: c.service === 'mjpeg' ? 'mjpeg' : 'camera-streamer',
        url: c.url,
        snapshotUrl: c.snapshotUrl ?? '',
        preferredMode: c.service === 'mjpeg' ? 'mjpeg' : c.preferredMode === 'mjpeg' ? 'mjpeg' : 'webrtc',
        enabled: c.enabled !== false,
      })),
    }))
    draft.value.activePrinterId = merged.activePrinterId
    if (!draft.value.printers.some(p => p.id === selectedPrinterId.value)) {
      selectedPrinterId.value = merged.activePrinterId
    }
    importPreview.value = null
    saveFeedback.value = {
      ok: true,
      message: t('Profile in den Entwurf übernommen. Jetzt speichern, um sie dauerhaft zu sichern.'),
    }
  } catch (err) {
    importError.value = err.message || 'Import konnte nicht angewendet werden.'
  }
}

function buildSavePayload(confirmSelfLockout = false) {
  return {
    activePrinterId: draft.value.activePrinterId,
    printers: draft.value.printers.map(p => ({
      id: p.id,
      name: p.name.trim(),
      subtitle: p.subtitle.trim(),
      url: p.url.trim(),
      mainsailUrl: p.mainsailUrl.trim() || 'auto',
      cameras: p.cameras.map(c => {
        const cam = {
          id: c.id,
          name: c.name.trim(),
          description: c.description?.trim() || '',
          service: c.service === 'mjpeg' ? 'mjpeg' : 'camera-streamer',
          url: c.url.trim(),
          preferredMode: c.service === 'mjpeg' ? 'mjpeg' : c.preferredMode === 'mjpeg' ? 'mjpeg' : 'webrtc',
          enabled: c.enabled !== false,
        }
        if (cam.service === 'mjpeg' && c.snapshotUrl?.trim()) {
          cam.snapshotUrl = c.snapshotUrl.trim()
        }
        return cam
      }),
    })),
    network: {
      allowedOrigins: [...draft.value.network.allowedOrigins],
      allowLanOrigins: Boolean(draft.value.network.allowLanOrigins),
    },
    ...(confirmSelfLockout ? { confirmSelfLockout: true } : {}),
  }
}

async function handleSave({ confirmSelfLockout = false, confirmedDirty = false } = {}) {
  if (!canWrite.value || settingsStore.saving.value) return
  saveFeedback.value = null
  if (!confirmedDirty && needsDirtyConfigConfirm(draft.value.activePrinterId)) {
    const target = draft.value.printers.find(p => p.id === draft.value.activePrinterId)
    dirtyConfigSwitchConfirm.value = {
      mode: 'save',
      printerId: draft.value.activePrinterId,
      printerName: target?.name || draft.value.activePrinterId,
      confirmSelfLockout,
    }
    return
  }
  dirtyConfigSwitchConfirm.value = null
  const payload = buildSavePayload(confirmSelfLockout)
  const res = await settingsStore.saveSettings(payload)
  if (!res.ok) {
    if (res.code === 'SELF_LOCKOUT') {
      selfLockoutPending.value = true
    }
    saveFeedback.value = { ok: false, message: res.error }
    return
  }
  selfLockoutPending.value = false
  cloneDraftFromStore()
  saveFeedback.value = { ok: true, message: t('Einstellungen gespeichert und live übernommen.') }
  if (res.data?.activePrinterChanged || res.data?.printerUrlChanged) {
    emit('switched', {
      activePrinterChanged: Boolean(res.data.activePrinterChanged),
      printerUrlChanged: Boolean(res.data.printerUrlChanged),
      settings: res.data,
    })
  }
}

function confirmDirtyConfigProceed() {
  const pending = dirtyConfigSwitchConfirm.value
  if (!pending) return
  dirtyConfigSwitchConfirm.value = null
  if (pending.mode === 'switch') {
    const printer = draft.value.printers.find(p => p.id === pending.printerId)
    if (printer) activatePrinter(printer, true)
  } else {
    handleSave({ confirmSelfLockout: Boolean(pending.confirmSelfLockout), confirmedDirty: true })
  }
}

function discardDraft() {
  cloneDraftFromStore()
  saveFeedback.value = null
  importPreview.value = null
  importError.value = ''
}

function requestClose(force = false) {
  if (!force && isServerDirty.value) {
    closeConfirmOpen.value = true
    return
  }
  closeConfirmOpen.value = false
  emit('close')
}

function onBackdropClick(event) {
  if (event.target === dialogEl.value) {
    requestClose(false)
  }
}

watch(
  () => props.open,
  async isOpen => {
    if (isOpen) {
      activeSection.value = props.initialSection || 'printers'
      saveFeedback.value = null
      importPreview.value = null
      importError.value = ''
      if (!settingsStore.loaded.value) {
        await settingsStore.loadSettings()
      } else {
        // Silently refresh runtime/canWrite and latest persisted settings when opening dialog.
        await settingsStore.loadSettings()
      }
      cloneDraftFromStore()
      await nextTick()
      if (dialogEl.value && !dialogEl.value.open) {
        dialogEl.value.showModal()
      }
    } else if (dialogEl.value?.open) {
      dialogEl.value.close()
    }
  },
)
</script>

<template>
  <dialog
    ref="dialogEl"
    class="settings-dialog"
    :aria-label="t('Einstellungen')"
    @cancel.prevent="requestClose(false)"
    @click="onBackdropClick"
  >
    <div class="settings-shell">
      <header class="settings-header">
        <div class="settings-header-title">
          <Settings :size="17" />
          <div>
            <h2>{{ t('Einstellungen') }}</h2>
            <p v-if="settingsStore.activePrinter.value">
              {{ settingsStore.activePrinter.value.name }} ·
              <span class="settings-mono">{{ settingsStore.activePrinter.value.url }}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          class="icon-button settings-close-btn"
          :aria-label="t('Schließen')"
          @click="requestClose(false)"
        >
          <X :size="18" />
        </button>
      </header>

      <div class="settings-body">
        <nav class="settings-rail" :aria-label="t('Einstellungsbereiche')">
          <button
            v-for="sec in sections"
            :key="sec.id"
            type="button"
            class="settings-rail-btn"
            :class="{ active: activeSection === sec.id }"
            :aria-current="activeSection === sec.id ? 'page' : undefined"
            @click="activeSection = sec.id"
          >
            <component :is="sec.icon" :size="15" />
            <span>{{ sec.label }}</span>
          </button>
        </nav>

        <div class="settings-pane">
          <div v-if="!canWrite && isServerBackedTab" class="settings-notice amber" role="status">
            <Lock :size="15" />
            <div>
              <strong>{{ t('Nur Lesezugriff von diesem Browser-Origin') }}</strong>
              <p>
                {{
                  t(
                    'Dieser Browser greift über {0} zu und darf keine Server-Einstellungen ändern. Starte DOCKYARD mit ALLOW_LAN_ORIGINS=1 (Meet-Modus) oder trage den Origin in ALLOWED_ORIGINS ein.',
                    [settingsStore.runtime.value?.requestOrigin || '—'],
                  )
                }}
              </p>
            </div>
          </div>

          <div v-if="settingsStore.error.value && !settingsStore.loaded.value" class="settings-notice amber" role="alert">
            <AlertTriangle :size="15" />
            <span>{{ t(settingsStore.error.value) }}</span>
            <button type="button" class="subtle-button" @click="settingsStore.loadSettings()">
              <RefreshCw :size="13" />{{ t('Erneut laden') }}
            </button>
          </div>

          <!-- TAB 1: DRUCKER & VERBINDUNG -->
          <section v-if="activeSection === 'printers'" class="settings-section">
            <div class="settings-section-head">
              <div>
                <h3>{{ t('Druckerprofile') }}</h3>
                <p>{{ t('Mehrere Drucker verwalten und bei einem Meet oder IP-Wechsel ohne Neustart anpassen.') }}</p>
              </div>
              <button
                type="button"
                class="subtle-button"
                :disabled="!canWrite || draft.printers.length >= 16"
                @click="addPrinter"
              >
                <Plus :size="14" />{{ t('Drucker hinzufügen') }}
              </button>
            </div>

            <div class="settings-printer-list">
              <div
                v-for="printer in draft.printers"
                :key="printer.id"
                class="settings-printer-card"
                :class="{
                  selected: selectedPrinter?.id === printer.id,
                  active: draft.activePrinterId === printer.id,
                }"
              >
                <button
                  type="button"
                  class="settings-printer-main"
                  @click="selectedPrinterId = printer.id"
                >
                  <div class="settings-printer-head">
                    <strong>{{ printer.name || t('Unbenannter Drucker') }}</strong>
                    <span v-if="draft.activePrinterId === printer.id" class="status-pill lime">
                      {{ t('Aktiv') }}
                    </span>
                  </div>
                  <span v-if="printer.subtitle" class="settings-printer-sub">{{ printer.subtitle }}</span>
                  <span class="settings-printer-url settings-mono">{{ printer.url }}</span>
                </button>
                <div class="settings-printer-actions">
                  <button
                    v-if="draft.activePrinterId !== printer.id"
                    type="button"
                    class="subtle-button settings-activate-btn"
                    :disabled="!canWrite || settingsStore.saving.value"
                    @click="activatePrinter(printer)"
                  >
                    <Check :size="13" />{{ t('Aktivieren') }}
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="!canWrite || draft.printers.length >= 16"
                    :title="t('Duplizieren')"
                    :aria-label="t('Duplizieren')"
                    @click="duplicatePrinter(printer)"
                  >
                    <Copy :size="14" />
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    :class="{ 'settings-danger-confirm': deleteConfirmId === printer.id }"
                    :disabled="!canWrite || draft.printers.length <= 1"
                    :title="deleteConfirmId === printer.id ? t('Wirklich löschen?') : t('Löschen')"
                    :aria-label="deleteConfirmId === printer.id ? t('Wirklich löschen?') : t('Löschen')"
                    @click="requestDeletePrinter(printer.id)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </div>
              </div>
            </div>

            <div v-if="selectedPrinter" class="settings-card">
              <div class="settings-card-head">
                <h4>{{ t('Profil bearbeiten') }}: {{ selectedPrinter.name || selectedPrinter.id }}</h4>
                <span class="settings-id-tag settings-mono">{{ selectedPrinter.id }}</span>
              </div>

              <div class="settings-form-grid">
                <label class="settings-field">
                  <span>{{ t('Druckername (Badge)') }}</span>
                  <input
                    v-model="selectedPrinter.name"
                    type="text"
                    maxlength="32"
                    :disabled="!canWrite"
                    placeholder="STORMTROOPER"
                  />
                </label>

                <label class="settings-field">
                  <span>{{ t('Untertitel') }}</span>
                  <input
                    v-model="selectedPrinter.subtitle"
                    type="text"
                    maxlength="80"
                    :disabled="!canWrite"
                    placeholder="VORON 2.4 / 6-Toolchanger"
                  />
                </label>

                <div class="settings-field settings-field-full">
                  <label :for="`printer-url-${selectedPrinter.id}`">{{ t('Moonraker / Drucker-URL') }}</label>
                  <div class="settings-inline-action">
                    <input
                      :id="`printer-url-${selectedPrinter.id}`"
                      v-model="selectedPrinter.url"
                      type="text"
                      class="settings-mono"
                      :disabled="!canWrite"
                      placeholder="http://192.168.50.22 oder 192.168.50.22:7125"
                    />
                    <button
                      type="button"
                      class="subtle-button"
                      :disabled="!canWrite || testState.testing || !selectedPrinter.url.trim()"
                      @click="runConnectionTest"
                    >
                      <Wifi :size="14" :class="{ spinning: testState.testing }" />
                      {{ testState.testing ? t('Prüfe …') : t('Verbindung testen') }}
                    </button>
                  </div>
                  <small class="settings-hint">
                    {{ t('Unterstützt IP, Hostname (.local) oder Port, z. B. 192.168.50.22 oder http://voron.local:7125.') }}
                  </small>

                  <div
                    v-if="testState.result && testState.forPrinterId === selectedPrinter.id"
                    class="settings-probe-result"
                    :class="testState.result.ok ? 'lime' : 'amber'"
                    role="status"
                  >
                    <Check v-if="testState.result.ok" :size="14" />
                    <AlertTriangle v-else :size="14" />
                    <span v-if="testState.result.ok">
                      {{ t('Verbunden') }} ·
                      <span class="settings-mono">{{ testState.result.latencyMs }} ms</span>
                      <template v-if="testState.result.moonrakerVersion">
                        · Moonraker {{ testState.result.moonrakerVersion }}
                      </template>
                      <template v-if="testState.result.klippyState">
                        · Klipper {{ testState.result.klippyState }}
                      </template>
                      <template v-if="testState.result.hostname">
                        ({{ testState.result.hostname }})
                      </template>
                    </span>
                    <span v-else>{{ t(testState.result.error || 'Verbindung fehlgeschlagen.') }}</span>
                  </div>
                </div>

                <label class="settings-field settings-field-full">
                  <span>{{ t('Mainsail-Link') }}</span>
                  <input
                    v-model="selectedPrinter.mainsailUrl"
                    type="text"
                    class="settings-mono"
                    :disabled="!canWrite"
                    placeholder="auto"
                  />
                  <small class="settings-hint">
                    {{ t('„auto“ nutzt automatisch die Drucker-Adresse. Aktuelles Ziel:') }}
                    <span class="settings-mono">{{ resolvedMainsailPreview }}</span>
                  </small>
                </label>
              </div>
            </div>
          </section>

          <!-- TAB 2: KAMERAS -->
          <section v-else-if="activeSection === 'cameras'" class="settings-section">
            <div class="settings-card settings-toggle-row">
              <div>
                <h4>{{ t('Kameras auf diesem Gerät ausblenden') }}</h4>
                <p>{{ t('Lokale Browser-Einstellung. Ausgeblendete Kameras öffnen keinerlei WebRTC- oder MJPEG-Verbindungen.') }}</p>
              </div>
              <label class="settings-switch">
                <input
                  type="checkbox"
                  :checked="camerasHiddenPreference"
                  @change="setCamerasHidden($event.target.checked)"
                />
                <span>{{ camerasHiddenPreference ? t('Ausgeblendet') : t('Sichtbar') }}</span>
              </label>
            </div>

            <div class="settings-section-head">
              <div>
                <h3>{{ t('Kameras für Profil') }}</h3>
                <p>{{ t('Unterstützt camera-streamer (WebRTC + MJPEG) sowie ustreamer / Direkt-MJPEG.') }}</p>
              </div>
              <div class="settings-head-controls">
                <CockpitSelect
                  v-if="draft.printers.length > 1"
                  v-model="selectedPrinterId"
                  :options="printerSelectOptions"
                  :aria-label="t('Druckerprofil wählen')"
                  size="compact"
                />
                <button
                  type="button"
                  class="subtle-button"
                  :disabled="!canWrite || !selectedPrinter || selectedPrinter.cameras.length >= 6"
                  @click="addCamera"
                >
                  <Plus :size="14" />{{ t('Kamera hinzufügen') }}
                </button>
              </div>
            </div>

            <div v-if="selectedPrinter && !selectedPrinter.cameras.length" class="settings-empty">
              <Camera :size="20" />
              <p>{{ t('Für dieses Druckerprofil sind noch keine Kameras konfiguriert.') }}</p>
            </div>

            <div v-else-if="selectedPrinter" class="settings-camera-list">
              <div v-for="(cam, index) in selectedPrinter.cameras" :key="cam.id" class="settings-card">
                <div class="settings-card-head">
                  <label class="settings-cam-enable">
                    <input v-model="cam.enabled" type="checkbox" :disabled="!canWrite" />
                    <strong>{{ cam.name || cam.id }}</strong>
                    <span class="settings-id-tag settings-mono">{{ cam.id }}</span>
                  </label>
                  <button
                    type="button"
                    class="icon-button"
                    :disabled="!canWrite"
                    :title="t('Kamera entfernen')"
                    :aria-label="t('Kamera entfernen')"
                    @click="removeCamera(index)"
                  >
                    <Trash2 :size="14" />
                  </button>
                </div>

                <div class="settings-form-grid">
                  <label class="settings-field">
                    <span>{{ t('Name') }}</span>
                    <input v-model="cam.name" type="text" maxlength="32" :disabled="!canWrite" />
                  </label>

                  <label class="settings-field">
                    <span>{{ t('Beschreibung') }}</span>
                    <input
                      v-model="cam.description"
                      type="text"
                      maxlength="80"
                      :disabled="!canWrite"
                      :placeholder="t('z. B. Übersicht Bauraum')"
                    />
                  </label>

                  <div class="settings-field">
                    <span>{{ t('Dienst-Typ') }}</span>
                    <CockpitSelect
                      :model-value="cam.service"
                      :options="cameraServiceOptions"
                      :aria-label="t('Dienst-Typ')"
                      :disabled="!canWrite"
                      @update:model-value="onCameraServiceChange(cam, $event)"
                    />
                  </div>

                  <div class="settings-field">
                    <span>{{ t('Standard-Transport') }}</span>
                    <CockpitSelect
                      v-model="cam.preferredMode"
                      :options="cameraTransportOptions"
                      :aria-label="t('Standard-Transport')"
                      :disabled="!canWrite || cam.service === 'mjpeg'"
                    />
                  </div>

                  <label class="settings-field settings-field-full">
                    <span>{{ cam.service === 'mjpeg' ? t('Stream-URL / Pfad') : t('Kamera-Basispfad oder URL') }}</span>
                    <input
                      v-model="cam.url"
                      type="text"
                      class="settings-mono"
                      :disabled="!canWrite"
                      :placeholder="cam.service === 'mjpeg' ? '/webcam/?action=stream' : '/webcam'"
                    />
                    <small class="settings-hint">
                      {{
                        cam.service === 'mjpeg'
                          ? t('Relativer Pfad auf dem Drucker (z. B. /webcam/?action=stream) oder volle URL.')
                          : t('Basis-Pfad ohne /stream oder /webrtc (z. B. /webcam oder /webcam2).')
                      }}
                    </small>
                  </label>

                  <label v-if="cam.service === 'mjpeg'" class="settings-field settings-field-full">
                    <span>{{ t('Snapshot-URL (optional)') }}</span>
                    <input
                      v-model="cam.snapshotUrl"
                      type="text"
                      class="settings-mono"
                      :disabled="!canWrite"
                      placeholder="/webcam/?action=snapshot"
                    />
                  </label>
                </div>
              </div>
            </div>
          </section>

          <!-- TAB 3: OBERFLÄCHE (LOKAL) -->
          <section v-else-if="activeSection === 'interface'" class="settings-section">
            <div class="settings-section-head">
              <div>
                <h3>{{ t('Oberfläche & Anzeige') }}</h3>
                <p>{{ t('Diese Einstellungen gelten sofort lokal in diesem Browser und erfordern kein Server-Speichern.') }}</p>
              </div>
              <span class="status-pill lime">{{ t('Lokal · Sofort aktiv') }}</span>
            </div>

            <div class="settings-card settings-pref-list">
              <div class="settings-pref-row">
                <div>
                  <h4>{{ t('Sprache') }}</h4>
                  <p>{{ t('Oberflächensprache für Beschriftungen, Hinweise und Meldungen.') }}</p>
                </div>
                <CockpitSelect
                  :model-value="language"
                  :options="languageOptions"
                  :aria-label="t('Sprache')"
                  align="right"
                  @update:model-value="setLanguage"
                />
              </div>

              <div class="settings-pref-row">
                <div>
                  <h4>{{ t('Display-Modus (Touch / Kiosk)') }}</h4>
                  <p>{{ t('Größere Touch-Flächen, kompakte Kopfleiste und keine Kameras.') }}</p>
                </div>
                <label class="settings-switch">
                  <input
                    type="checkbox"
                    :checked="displayMode"
                    @change="setDisplayMode($event.target.checked)"
                  />
                  <span>{{ displayMode ? t('Aktiv') : t('Aus') }}</span>
                </label>
              </div>

              <div class="settings-pref-row">
                <div>
                  <h4>{{ t('Standard-Startansicht') }}</h4>
                  <p>{{ t('Welcher Reiter beim Öffnen von DOCKYARD standardmäßig aktiv ist.') }}</p>
                </div>
                <CockpitSelect
                  :model-value="defaultTab"
                  :options="defaultTabOptions"
                  :aria-label="t('Standard-Startansicht')"
                  align="right"
                  @update:model-value="setDefaultTab"
                />
              </div>
            </div>
          </section>

          <!-- TAB 4: NETZWERK & BACKUP -->
          <section v-else-if="activeSection === 'network'" class="settings-section">
            <div class="settings-section-head">
              <div>
                <h3>{{ t('Netzwerk & Zugriffsschutz') }}</h3>
                <p>{{ t('Steuert, welche Browser im LAN oder bei einem Meet Befehle und Einstellungen senden dürfen.') }}</p>
              </div>
            </div>

            <div class="settings-card settings-toggle-row">
              <div>
                <h4>{{ t('LAN / Meet-Modus (alle privaten LAN-Adressen erlauben)') }}</h4>
                <p>
                  {{
                    t(
                      'Erlaubt Schreibzugriff aus privaten Netzwerken (192.168.x.x, 10.x.x.x, 172.16–31.x.x und .local), auch wenn sich die IP bei einem Meet ändert.',
                    )
                  }}
                </p>
                <small v-if="envAllowLan" class="settings-hint settings-hint-lime">
                  {{ t('Per Umgebungsvariable ALLOW_LAN_ORIGINS=1 dauerhaft aktiv.') }}
                </small>
              </div>
              <label class="settings-switch">
                <input
                  v-if="envAllowLan"
                  type="checkbox"
                  checked
                  disabled
                />
                <input
                  v-else
                  v-model="draft.network.allowLanOrigins"
                  type="checkbox"
                  :disabled="!canWrite"
                />
                <span>{{ envAllowLan || draft.network.allowLanOrigins ? t('Aktiv') : t('Aus') }}</span>
              </label>
            </div>

            <div class="settings-card">
              <div class="settings-card-head">
                <h4>{{ t('Vertrauenswürdige Origins') }}</h4>
                <button
                  v-if="canAddCurrentOrigin && canWrite"
                  type="button"
                  class="subtle-button"
                  @click="addAllowedOrigin(settingsStore.runtime.value.requestOrigin)"
                >
                  <Plus :size="13" />{{ t('Aktuellen Origin hinzufügen') }}
                </button>
              </div>

              <div v-if="envAllowedOrigins.length || draft.network.allowedOrigins.length" class="settings-origin-chips">
                <span v-for="origin in envAllowedOrigins" :key="`env-${origin}`" class="settings-origin-chip env">
                  <span class="settings-mono">{{ origin }}</span>
                  <small>ENV</small>
                </span>
                <span v-for="origin in draft.network.allowedOrigins" :key="origin" class="settings-origin-chip">
                  <span class="settings-mono">{{ origin }}</span>
                  <button
                    type="button"
                    class="settings-chip-remove"
                    :disabled="!canWrite"
                    :aria-label="t('Entfernen')"
                    @click="removeAllowedOrigin(origin)"
                  >
                    <X :size="12" />
                  </button>
                </span>
              </div>
              <p v-else class="settings-hint">
                {{ t('Keine zusätzlichen Origins eingetragen. Lokaler Zugriff (127.0.0.1 / localhost) ist immer erlaubt.') }}
              </p>

              <div class="settings-inline-action" style="margin-top: 12px">
                <input
                  v-model="originDraft"
                  type="text"
                  class="settings-mono"
                  :disabled="!canWrite"
                  placeholder="http://192.168.50.10:4173"
                  @keydown.enter.prevent="addAllowedOrigin()"
                />
                <button
                  type="button"
                  class="subtle-button"
                  :disabled="!canWrite || !originDraft.trim()"
                  @click="addAllowedOrigin()"
                >
                  <Plus :size="14" />{{ t('Hinzufügen') }}
                </button>
              </div>
              <p v-if="originError" class="settings-inline-error">{{ t(originError) }}</p>
            </div>

            <div v-if="selfLockoutPending" class="settings-notice amber" role="alert">
              <AlertTriangle :size="15" />
              <div style="flex: 1">
                <strong>{{ t('Warnung: Eigenen Schreibzugriff sperren?') }}</strong>
                <p>
                  {{
                    t(
                      'Mit diesen Netzwerkeinstellungen verliert dein aktueller Browser ({0}) den Schreibzugriff auf DOCKYARD.',
                      [settingsStore.runtime.value?.requestOrigin || '—'],
                    )
                  }}
                </p>
              </div>
              <div class="settings-inline-buttons">
                <button type="button" class="subtle-button" @click="selfLockoutPending = false">
                  {{ t('Abbrechen') }}
                </button>
                <button
                  type="button"
                  class="confirm-button"
                  @click="handleSave({ confirmSelfLockout: true })"
                >
                  {{ t('Trotzdem speichern') }}
                </button>
              </div>
            </div>

            <div class="settings-card">
              <div class="settings-card-head">
                <h4>{{ t('Server-Information') }}</h4>
              </div>
              <dl class="settings-kv">
                <div>
                  <dt>{{ t('Server-Bindung') }}</dt>
                  <dd class="settings-mono">
                    {{ settingsStore.runtime.value?.host || '127.0.0.1' }}:{{ settingsStore.runtime.value?.port || 4173 }}
                  </dd>
                </div>
                <div>
                  <dt>{{ t('Aktueller Browser-Origin') }}</dt>
                  <dd class="settings-mono">{{ settingsStore.runtime.value?.requestOrigin || '—' }}</dd>
                </div>
                <div>
                  <dt>{{ t('Schreibzugriff') }}</dt>
                  <dd :class="canWrite ? 'text-lime' : 'settings-amber-text'">
                    {{ canWrite ? t('Erlaubt') : t('Schreibgeschützt') }}
                  </dd>
                </div>
              </dl>
            </div>

            <div class="settings-card">
              <div class="settings-card-head">
                <h4>{{ t('Druckerprofile sichern & importieren (JSON)') }}</h4>
              </div>
              <p class="settings-hint">
                {{
                  t(
                    'Exportiert nur deine Drucker- und Kamera-Profile. Netzwerkeinstellungen werden aus Sicherheitsgründen nicht exportiert.',
                  )
                }}
              </p>

              <div class="settings-backup-actions">
                <button type="button" class="subtle-button" @click="exportProfiles">
                  <Download :size="14" />{{ t('Profile exportieren (JSON)') }}
                </button>
                <button type="button" class="subtle-button" :disabled="!canWrite" @click="triggerImportPicker">
                  <Upload :size="14" />{{ t('Profile importieren (JSON)') }}
                </button>
                <input
                  ref="importInputEl"
                  type="file"
                  accept=".json,application/json"
                  class="sr-only"
                  @change="onImportFileSelected"
                />
              </div>

              <p v-if="importError" class="settings-inline-error">{{ t(importError) }}</p>

              <div v-if="importPreview" class="settings-import-box">
                <div class="settings-import-summary">
                  <strong>{{ importPreview.filename }}</strong>
                  <span>{{ t('{0} Druckerprofile erkannt', [importPreview.parsed.printers.length]) }}</span>
                </div>
                <p class="settings-hint">
                  {{ importPreview.parsed.printers.map(p => p.name).join(' · ') }}
                </p>
                <div class="settings-import-modes">
                  <label>
                    <input v-model="importPreview.mode" type="radio" value="merge" />
                    <span>{{ t('Hinzufügen / Aktualisieren (Merge)') }}</span>
                  </label>
                  <label>
                    <input v-model="importPreview.mode" type="radio" value="replace" />
                    <span>{{ t('Alle bestehenden Profile ersetzen') }}</span>
                  </label>
                </div>
                <div class="settings-inline-buttons">
                  <button type="button" class="subtle-button" @click="importPreview = null">
                    {{ t('Abbrechen') }}
                  </button>
                  <button type="button" class="primary-control" @click="applyImportToDraft">
                    <Check :size="14" />{{ t('In Entwurf übernehmen') }}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <!-- Inline confirmations & sticky footer -->
      <div v-if="dirtyConfigSwitchConfirm" class="settings-footer-banner amber" role="alert">
        <AlertTriangle :size="15" />
        <span>
          {{
            t(
              'Im Konfigurations-Editor sind ungespeicherte Änderungen in {0} offen. Beim Wechsel auf {1} bleibt der Editor geschützt im Lesemodus.',
              [configEditor.currentPath.value, dirtyConfigSwitchConfirm.printerName],
            )
          }}
        </span>
        <div class="settings-inline-buttons">
          <button type="button" class="subtle-button" @click="dirtyConfigSwitchConfirm = null">
            {{ t('Abbrechen') }}
          </button>
          <button type="button" class="confirm-button" @click="confirmDirtyConfigProceed">
            {{ t('Trotzdem wechseln') }}
          </button>
        </div>
      </div>

      <div v-if="closeConfirmOpen" class="settings-footer-banner amber" role="alert">
        <AlertTriangle :size="15" />
        <span>{{ t('Du hast ungespeicherte Änderungen. Wirklich schließen und verwerfen?') }}</span>
        <div class="settings-inline-buttons">
          <button type="button" class="subtle-button" @click="closeConfirmOpen = false">
            {{ t('Weiter bearbeiten') }}
          </button>
          <button type="button" class="confirm-button" @click="requestClose(true)">
            {{ t('Verwerfen & schließen') }}
          </button>
        </div>
      </div>

      <footer class="settings-footer">
        <div class="settings-footer-status">
          <span
            v-if="saveFeedback"
            class="settings-feedback"
            :class="saveFeedback.ok ? 'lime' : 'amber'"
            role="status"
          >
            <Check v-if="saveFeedback.ok" :size="14" />
            <AlertTriangle v-else :size="14" />
            {{ t(saveFeedback.message) }}
          </span>
          <span v-else-if="isServerDirty" class="status-pill amber">
            {{ t('Ungespeicherte Änderungen') }}
          </span>
        </div>

        <div class="settings-footer-actions">
          <template v-if="isServerBackedTab || isServerDirty">
            <button
              v-if="isServerDirty"
              type="button"
              class="subtle-button"
              :disabled="settingsStore.saving.value"
              @click="discardDraft"
            >
              {{ t('Verwerfen') }}
            </button>
            <button
              type="button"
              class="primary-control"
              :disabled="!isServerDirty || !canWrite || settingsStore.saving.value"
              @click="handleSave()"
            >
              <Check :size="14" />
              {{ settingsStore.saving.value ? t('Speichere …') : t('Speichern') }}
            </button>
          </template>
          <button v-else type="button" class="subtle-button" @click="requestClose(false)">
            {{ t('Schließen') }}
          </button>
        </div>
      </footer>
    </div>
  </dialog>
</template>
