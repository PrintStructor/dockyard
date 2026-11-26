<script setup>
import { computed, ref, watch, defineAsyncComponent, nextTick, onMounted, onBeforeUnmount } from 'vue'
import {
  Box,
  Camera,
  SlidersHorizontal,
  RefreshCw,
  ArrowUpRight,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Wifi,
  WifiOff,
  Home,
  OctagonX,
  Terminal,
  Pause,
  Play,
  Loader2,
  Printer,
  History,
  Monitor,
  RotateCw,
  Power,
  Settings,
  X,
} from '@lucide/vue'
import { t, locale, language, setLanguage, setDocumentTitle } from './i18n.mjs'
import { displayMode, showCameras, defaultTab, toggleDisplayMode, sanitizeTabForCameras } from './display-mode.mjs'
import ControlsView from './components/ControlsView.vue'
import ConsoleView from './components/ConsoleView.vue'
import LedControls from './components/LedControls.vue'
import ToolActions from './components/ToolActions.vue'
import TemperatureTarget from './components/TemperatureTarget.vue'
import ThermalGauge from './components/ThermalGauge.vue'
import CameraView from './components/CameraView.vue'
import CockpitSelect from './components/CockpitSelect.vue'
import LivePrintTuning from './components/LivePrintTuning.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import SingleToolOverview from './components/SingleToolOverview.vue'
import { useControls } from './useControls.js'
import { usePrinter } from './usePrinter.js'
import { useConsole } from './useConsole.js'
import { useConfigEditor } from './useConfigEditor.js'
import { useSettings } from './useSettings.js'
import { useCameras } from './useCameras.js'
import { auxActionReason, ledProfiles } from './aux-action-state.mjs'
import { toolActionReason, filamentToolIds, mountedToolId, maintenanceRestriction } from './tool-action-state.mjs'
import { resolveMainsailUrl } from './printer-ui-url.mjs'
import { toolState, heatState } from '../server/status.mjs'

const ToolScene = defineAsyncComponent(() => import('./components/ToolScene.vue'))
const PrintView = defineAsyncComponent(() => import('./components/PrintView.vue'))
const HistoryView = defineAsyncComponent(() => import('./components/HistoryView.vue'))
const SystemView = defineAsyncComponent(() => import('./components/SystemView.vue'))

const languageOptions = [
  { value: 'de', label: 'DE · Deutsch', lang: 'de' },
  { value: 'en', label: 'EN · English', lang: 'en' },
]

const consoleStore = useConsole()
const configEditor = useConfigEditor()
const settingsStore = useSettings()
const camerasStore = useCameras()
const lastUpdateEvent = ref(null)
const printerSwitchKey = ref(0)
const settingsOpen = ref(false)
const settingsInitialSection = ref('printers')
const printerPopoverOpen = ref(false)
const switcherRoot = ref(null)
const popoverDirtyConfirm = ref(null)
const popoverError = ref('')

let lastAppliedTarget = { id: '', url: '', camerasJson: '' }

function syncCamerasFromActive(active) {
  const list = Array.isArray(active?.cameras) ? active.cameras : []
  for (const cam of list) {
    camerasStore.configureCamera(cam.id, {
      service: cam.service,
      preferredMode: cam.preferredMode,
    })
  }
}

const { status, connection, error, updating, refresh, resetForPrinterSwitch } = usePrinter({
  onConsole: entry => consoleStore.pushEntry(entry),
  onUpdate: payload => {
    lastUpdateEvent.value = { ...payload, _seq: Date.now() + Math.random() }
  },
  onSettings: payload => {
    applySettingsTransition(payload, { isFromSse: true })
  },
  onReconnect: () => {
    if (consoleStore.loaded.value) consoleStore.refresh()
  },
})

function applySettingsTransition(payload, { isFromSse = false } = {}) {
  if (!payload || typeof payload !== 'object') return
  settingsStore.applyRemoteSettings(payload)
  const active = settingsStore.activePrinter.value
  const nextId = active?.id || payload.activePrinterId || ''
  const nextUrl = active?.url || ''
  const nextCamerasJson = JSON.stringify(active?.cameras ?? [])

  const hasBaseline = Boolean(lastAppliedTarget.id || lastAppliedTarget.url)
  const targetChanged =
    hasBaseline && (lastAppliedTarget.id !== nextId || lastAppliedTarget.url !== nextUrl)
  const camerasChanged = hasBaseline && !targetChanged && lastAppliedTarget.camerasJson !== nextCamerasJson

  lastAppliedTarget = { id: nextId, url: nextUrl, camerasJson: nextCamerasJson }
  syncCamerasFromActive(active)

  if (targetChanged) {
    requestedPrintFile.value = ''
    lastUpdateEvent.value = null
    lastMountedTool = undefined
    clearFeedback()
    printerSwitchKey.value++
    resetForPrinterSwitch()
    consoleStore.clear()
    const editorRes = configEditor.handlePrinterSwitch(nextId, active?.name || nextId)
    if (tab.value === 'system' && systemSubtab.value === 'config' && editorRes.reloadList) {
      configEditor.loadFileList()
    }
    camerasStore.resetAll(new Set(activeCameras.value.map(c => c.id)))
  } else if (camerasChanged) {
    camerasStore.resetAll(new Set(activeCameras.value.map(c => c.id)))
  } else if (isFromSse && (payload.activePrinterChanged || payload.printerUrlChanged) && !hasBaseline) {
    // Edge case: SSE arrived before initial loadSettings completed.
    resetForPrinterSwitch()
  }
}

function openSettings(section = 'printers') {
  printerPopoverOpen.value = false
  popoverDirtyConfirm.value = null
  popoverError.value = ''
  settingsInitialSection.value = section
  settingsOpen.value = true
}

function onSettingsDialogSwitched(event) {
  if (event?.settings) {
    applySettingsTransition(event.settings)
  }
}

function onPrinterPillClick() {
  if (settingsStore.printers.value.length > 1) {
    popoverDirtyConfirm.value = null
    popoverError.value = ''
    printerPopoverOpen.value = !printerPopoverOpen.value
  } else {
    openSettings('printers')
  }
}

async function quickSwitchPrinter(printer, confirmedDirty = false) {
  popoverError.value = ''
  const currentId = settingsStore.activePrinter.value?.id || ''
  if (printer.id === currentId) {
    printerPopoverOpen.value = false
    return
  }
  if (!confirmedDirty && configEditor.isDirty.value) {
    popoverDirtyConfirm.value = printer
    return
  }
  popoverDirtyConfirm.value = null
  const res = await settingsStore.switchPrinter(printer.id)
  if (!res.ok) {
    popoverError.value = res.error || 'Druckerwechsel fehlgeschlagen.'
    return
  }
  printerPopoverOpen.value = false
  applySettingsTransition(res.data)
}

function onGlobalPointerDown(event) {
  if (printerPopoverOpen.value && switcherRoot.value && !switcherRoot.value.contains(event.target)) {
    printerPopoverOpen.value = false
    popoverDirtyConfirm.value = null
  }
}

function onGlobalKeydown(event) {
  if (event.key === 'Escape' && printerPopoverOpen.value) {
    printerPopoverOpen.value = false
    popoverDirtyConfirm.value = null
  }
}

const { pending, stopping, feedback, send, syncServerResult, clearFeedback } = useControls(refresh)

watch(
  () => status.value?.control?.lastResult,
  result => syncServerResult(result),
)

const fallbackPrinterName = (import.meta.env.VITE_PRINTER_NAME ?? 'STORMTROOPER').trim()
const printerName = computed(() => {
  if (settingsStore.loaded.value && settingsStore.activePrinter.value) {
    return String(settingsStore.activePrinter.value.name ?? '').trim()
  }
  const remote = status.value?.printerName
  return typeof remote === 'string' ? remote.trim() : fallbackPrinterName
})
const printerSubtitle = computed(() => {
  if (settingsStore.loaded.value && settingsStore.activePrinter.value) {
    return String(settingsStore.activePrinter.value.subtitle ?? '').trim()
  }
  const remote = status.value?.printerSubtitle
  if (typeof remote === 'string') return remote.trim()
  return 'VORON 2.4 / 6-Toolchanger'
})
const activeCameras = computed(() => {
  if (settingsStore.loaded.value && settingsStore.activePrinter.value) {
    return (settingsStore.activePrinter.value.cameras ?? []).filter(c => c.enabled !== false)
  }
  return []
})
watch(
  [language, printerName],
  ([nextLang, nextPrinter]) => setDocumentTitle(nextLang, nextPrinter),
  { immediate: true },
)
const mainsailUrl = computed(() =>
  resolveMainsailUrl(
    settingsStore.activePrinter.value?.mainsailUrl ?? import.meta.env.VITE_MAINSAIL_URL,
    globalThis.location,
    settingsStore.activePrinter.value?.url ?? '',
  ),
)
const validTabs = ['tools', 'controls', 'print', 'history', 'cameras', 'console', 'system']
const validSystemSubtabs = ['overview', 'config', 'calibration', 'maintenance']

function parseRouteHash(rawHash) {
  const clean = (rawHash || '').replace(/^#/, '')
  const [mainTab, sub] = clean.split('/')
  const rawTab = clean && validTabs.includes(mainTab) ? mainTab : defaultTab.value
  const nextTab = sanitizeTabForCameras(rawTab, showCameras.value)
  const nextSub = nextTab === 'system' && validSystemSubtabs.includes(sub) ? sub : 'overview'
  return { nextTab, nextSub }
}

const initialRoute = parseRouteHash(location.hash)
const tab = ref(initialRoute.nextTab)
const systemSubtab = ref(initialRoute.nextSub)

watch(showCameras, visible => {
  if (!visible && tab.value === 'cameras') tab.value = 'tools'
})

watch(
  [tab, systemSubtab],
  ([nextTab, nextSub]) => {
    const targetHash = nextTab === 'system' && nextSub !== 'overview' ? `#system/${nextSub}` : `#${nextTab}`
    if (location.hash !== targetHash) history.replaceState(null, '', targetHash)
  },
  { immediate: true },
)

function handleHashChange() {
  const { nextTab, nextSub } = parseRouteHash(location.hash)
  tab.value = nextTab
  if (nextTab === 'system') systemSubtab.value = nextSub
}

const requestedPrintFile = ref('')

function openPrintFile(filename) {
  requestedPrintFile.value = filename
  tab.value = 'print'
}

const recoveryChecked = ref(false)
watch(
  () => status.value?.control?.job?.uncertain,
  uncertain => {
    if (!uncertain) recoveryChecked.value = false
  },
)

// Ticking clock for elapsed duration of long-running server jobs.
const nowTick = ref(Date.now())
let clockTimer = null
onMounted(() => {
  window.addEventListener('hashchange', handleHashChange)
  document.addEventListener('pointerdown', onGlobalPointerDown)
  document.addEventListener('keydown', onGlobalKeydown)
  settingsStore.loadSettings().then(res => {
    if (res.ok && res.data?.activePrinter) {
      lastAppliedTarget = {
        id: res.data.activePrinter.id,
        url: res.data.activePrinter.url,
        camerasJson: JSON.stringify(res.data.activePrinter.cameras ?? []),
      }
      syncCamerasFromActive(res.data.activePrinter)
    }
  })
  clockTimer = setInterval(() => {
    if (status.value?.control?.job) nowTick.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', handleHashChange)
  document.removeEventListener('pointerdown', onGlobalPointerDown)
  document.removeEventListener('keydown', onGlobalKeydown)
  clearInterval(clockTimer)
  clearTimeout(recoveryConfirmTimer)
})

const activeJob = computed(() => {
  const job = status.value?.control?.job
  return job && !job.uncertain ? job : null
})

const activeJobElapsed = computed(() => {
  if (!activeJob.value?.startedAt) return ''
  const secs = Math.max(0, Math.floor((nowTick.value - new Date(activeJob.value.startedAt).getTime()) / 1000))
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`
})

const ledColor = c => (c ? `rgb(${c.slice(0, 3).map(v => Math.round(Math.min(1, v + c[3]) * 255)).join(',')})` : 'transparent')

const effectLabel = name =>
  /^sb_logo_printing_t[0-5]$/.test(name) || /^status_temp_t[0-5]$/.test(name)
    ? 'Temperaturfarbe'
    : /^sb_logo_pause_t[0-5]$/.test(name)
      ? 'Pausensignal'
      : /^sb_logo_busy_t[0-5]$/.test(name)
        ? 'Beschäftigt'
        : ({
            rainbow_nature: 'Regenbogen',
            heating: 'Aufheizen',
            cooling: 'Abkühlen',
            homing: 'Homing',
            critical_error: 'Fehlersignal',
            set_nozzle_leds: 'Düsenlicht',
          }[name] ?? name)

const activityLabel = computed(() => {
  const a = status.value?.activity ?? {}
  if (a.homing) return 'Homing läuft'
  if (a.qgling) return 'Gantry wird ausgerichtet'
  if (a.probing) return 'Vermessung läuft'
  if (a.paused) return 'Druck pausiert'
  if (a.printing) return 'Druck läuft'
  if (a.heating_bed) return 'Bett heizt auf'
  if (a.heating_nozzle) return 'Düse heizt auf'
  return null
})

const selected = ref(0)
let lastMountedTool = undefined
const controlContext = ref('Achsen homen, schrittweise bewegen und Temperaturen einstellen.')
const controlsSubtitle = computed(() =>
  pending.value || !online.value ? controlContext.value : (feedback.value?.message ?? controlContext.value),
)
const scene = ref(null)

async function selectTool(id, { focus = false } = {}) {
  selected.value = id
  if (focus) {
    await nextTick()
    if (tab.value === 'tools') scene.value?.focusSelected()
  }
}

watch(
  () => mountedToolId(status.value),
  next => {
    if (next === undefined || next === lastMountedTool) return
    lastMountedTool = next
    if (next != null) selectTool(next)
  },
  { immediate: true },
)

async function handleToolCommand(command) {
  const ok = await send(command)
  if (ok && ['select', 'pickup'].includes(command.action) && Number.isInteger(command.tool)) {
    selectTool(command.tool)
  }
}

const isToolchanger = computed(() => Boolean(status.value?.isToolchanger))
const toolCount = computed(
  () =>
    status.value?.toolCount ??
    (settingsStore.activePrinter.value?.model?.preset === 'stormtrooper-6tc' ? 6 : 1),
)
const isSingleTool = computed(() =>
  status.value
    ? !status.value.isToolchanger && status.value.toolCount === 1
    : settingsStore.activePrinter.value?.model?.preset !== 'stormtrooper-6tc',
)
const show3dScene = computed(() => {
  const preset = settingsStore.activePrinter.value?.model?.preset ?? 'auto'
  if (preset === 'none' || isSingleTool.value) return false
  if (preset === 'stormtrooper-6tc') {
    return !status.value || (Boolean(status.value.isToolchanger) && status.value.toolCount === 6)
  }
  return Boolean(status.value?.isToolchanger && status.value?.toolCount === 6)
})
const hasLedDeck = computed(() => {
  const installed = status.value?.capabilities?.ledProfiles ?? []
  return ledProfiles.some(p => installed.includes(p.id))
})

const tools = computed(() => status.value?.tools ?? Array.from({ length: toolCount.value }, (_, id) => ({ id })))
watch(tools, list => {
  if (selected.value >= list.length) selected.value = 0
})
const current = computed(() => tools.value[selected.value] ?? tools.value[0] ?? { id: 0 })
const watchAction = computed(() => (status.value?.loadWatchActive ? 'watch_stop' : 'watch_start'))
const watchReason = computed(() => auxActionReason(status.value, watchAction.value, online.value, pending.value))
function toggleLoadWatch() {
  if (!watchReason.value) send({ action: watchAction.value })
}

const bulkReason = action => toolActionReason(status.value, action, undefined, online.value, pending.value)
const filamentCount = computed(() => filamentToolIds(status.value).length)
const actionRestriction = computed(() => {
  const item = maintenanceRestriction(status.value, selected.value, online.value, pending.value)
  if (!item) return ''
  if (!item.actions.length) return t(item.reason)
  return `${item.actions.map(label => t(label)).join(', ')}: ${t(item.reason)}`
})
function bulkFilament(action) {
  if (!bulkReason(action)) send({ action })
}

const filamentClass = tool =>
  !online.value || tool.filamentEnabled !== true || tool.filamentDetected == null
    ? 'unknown'
    : tool.filamentDetected
      ? 'present'
      : 'empty'
const shortFilament = tool =>
  filamentClass(tool) === 'unknown' ? 'Filament ?' : tool.filamentDetected ? 'Filament erkannt' : 'Kein Filament'

const online = computed(() => connection.value === 'online')
const connectionLabel = computed(
  () =>
    ({
      online: 'Verbunden',
      connecting: 'Verbinde …',
      stale: 'Daten veraltet',
      offline: 'Nicht verbunden',
    })[connection.value],
)

const number = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'
const temperature = value => number(value, 1)
const zOffset = tool => (tool.relativeZ == null ? '—' : `${tool.relativeZ > 0 ? '+' : ''}${number(tool.relativeZ, 4)} mm`)
const time = computed(() => (status.value?.at ? new Date(status.value.at).toLocaleTimeString(locale.value) : 'Noch keine Daten'))
const state = tool => toolState(tool, status.value) + (status.value && !online.value ? ' · zuletzt' : '')
const filament = tool =>
  tool.filamentEnabled === false
    ? 'Überwachung aus'
    : tool.filamentEnabled !== true || tool.filamentDetected == null
      ? 'Unbekannt'
      : tool.filamentDetected
        ? 'Filament erkannt'
        : 'Kein Filament erkannt'

const printAction = computed(() => (status.value?.printState === 'paused' ? 'resume' : 'pause'))
const printActionReason = computed(() => auxActionReason(status.value, printAction.value, online.value, pending.value))
const detectedLabel = computed(() => (status.value?.detected == null ? 'Keines bestätigt' : `T${status.value.detected}`))
const printLabel = computed(
  () =>
    ({
      standby: 'Bereit',
      printing: 'Druckt',
      paused: 'Pausiert',
      complete: 'Abgeschlossen',
      cancelled: 'Abgebrochen',
      error: 'Fehler',
    })[status.value?.printState] ?? 'Unbekannt',
)

const isPrintActive = computed(() => online.value && ['printing', 'paused'].includes(status.value?.printState))
const showPrintControl = computed(() => isPrintActive.value || status.value?.toolchangerState === 'error')
const klipperNeedsRecovery = computed(
  () => online.value && Boolean(status.value?.klipperState) && status.value.klipperState !== 'ready',
)
const klipperRecoveryTitle = computed(
  () =>
    ({
      shutdown: 'Klipper im Shutdown',
      error: 'Klipper-Fehler',
      startup: 'Klipper startet …',
      disconnected: 'Klipper nicht verbunden',
    })[status.value?.klipperState] ?? 'Klipper ist nicht bereit',
)
const confirmRecoveryTarget = ref('')
const restartingRecoveryTarget = ref('')
const recoveryFeedback = ref(null)
let recoveryConfirmTimer = null

function cancelRecoveryConfirm() {
  confirmRecoveryTarget.value = ''
  clearTimeout(recoveryConfirmTimer)
  recoveryConfirmTimer = null
}

function requestRecoveryConfirm(target) {
  if (!online.value || restartingRecoveryTarget.value) return
  confirmRecoveryTarget.value = target
  clearTimeout(recoveryConfirmTimer)
  recoveryConfirmTimer = setTimeout(() => {
    confirmRecoveryTarget.value = ''
  }, 6000)
}

async function triggerKlipperRecovery(target) {
  if (!online.value || restartingRecoveryTarget.value) return
  cancelRecoveryConfirm()
  restartingRecoveryTarget.value = target
  recoveryFeedback.value = null
  try {
    const response = await fetch('/api/system/service/restart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({ target }),
      signal: AbortSignal.timeout(12_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Neustart fehlgeschlagen.')
    recoveryFeedback.value = {
      ok: true,
      message: data.message || 'Neustart ausgelöst. Verbindung wird automatisch neu aufgebaut.',
    }
    refresh()
  } catch (cause) {
    recoveryFeedback.value = {
      ok: false,
      message: cause.message || 'Neustart fehlgeschlagen.',
    }
  } finally {
    restartingRecoveryTarget.value = ''
  }
}

watch(klipperNeedsRecovery, down => {
  if (!down) {
    cancelRecoveryConfirm()
    recoveryFeedback.value = null
  }
})
const liveTuningOpen = ref(false)
watch(isPrintActive, active => {
  if (!active) liveTuningOpen.value = false
})
const formattedLiveZ = computed(() => {
  const z = status.value?.zOffset
  if (z == null || Math.abs(z) < 1e-5) return ''
  const sign = z > 0 ? '+' : ''
  return `${sign}${z.toLocaleString(locale.value, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} mm`
})
const printProgressPercent = computed(() =>
  Number.isFinite(status.value?.progress) ? Math.round(Math.max(0, Math.min(1, status.value.progress)) * 100) : null,
)
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs} h ${String(mins).padStart(2, '0')} min`
  if (mins > 0) return `${mins} min ${String(secs).padStart(2, '0')} s`
  return `${secs} s`
}

const sensors = computed(() => [
  ['Druckbett', status.value?.bed?.temperature],
  ['Bauraum', status.value?.chamber],
  ['Raspberry Pi', status.value?.raspberryPi],
  ['Octopus', status.value?.octopus],
  ['RP2350', status.value?.rp2350],
  ['Beacon-Spule', status.value?.beacon],
])

const pageHeading = computed(
  () =>
    ({
      tools: isSingleTool.value ? 'Dein Drucker. Im Blick.' : 'Deine Werkzeuge. Im Blick.',
      controls: 'Drucker bedienen.',
      print: 'Druck & 3D-Vorschau.',
      history: 'Druckverlauf.',
      cameras: 'Blick in den Drucker.',
      console: 'Direkt mit Klipper.',
      system: 'System & Maschine.',
    })[tab.value],
)

const pageSubtitle = computed(() => {
  if (tab.value === 'controls') return controlsSubtitle.value
  return {
    tools: isSingleTool.value
      ? 'Temperaturen, Lüfter, Achsen und Sensoren direkt im Blick.'
      : 'Werkzeug auswählen und seinen aktuellen Zustand prüfen.',
    print: 'Aktuellen Druck oder G-Code-Dateien als 3D-Modell prüfen.',
    history: isToolchanger.value
      ? 'Vergangene Druckjobs, Laufzeiten, Filamentverbrauch und Werkzeugnutzung.'
      : 'Vergangene Druckjobs, Laufzeiten und Filamentverbrauch.',
    cameras: 'Aktive Druckerkameras · kontinuierliche Livestreams.',
    console: 'G-Code und Makros senden. Antworten direkt mitlesen.',
    system: isToolchanger.value
      ? 'Host, Konfiguration, Kalibrierung und Wartung deines Toolchangers.'
      : 'Host, Konfiguration, Kalibrierung und Wartung deines Druckers.',
  }[tab.value]
})

async function acknowledgeUncertain() {
  if (!recoveryChecked.value || pending.value || !online.value) return
  await send({ action: 'acknowledge' })
  recoveryChecked.value = false
}
</script>

<template>
  <div class="app-shell" :class="{ 'controls-active': tab === 'controls', 'display-mode': displayMode }">
    <header class="masthead">
      <div class="brand">
        <a href="#" :aria-label="t('DOCKYARD Werkzeugübersicht')" @click.prevent="tab = 'tools'">
          <img src="/voron-logo.svg" width="34" height="39" alt="DOCKYARD" />
        </a>
        <span>
          <span class="brand-title">
            <a href="#" @click.prevent="tab = 'tools'">DOCKYARD</a>
            <div v-if="printerName" ref="switcherRoot" class="brand-printer-switcher">
              <button
                type="button"
                class="brand-printer-pill interactive"
                :aria-expanded="settingsStore.printers.value.length > 1 ? printerPopoverOpen : undefined"
                :aria-haspopup="settingsStore.printers.value.length > 1 ? 'menu' : 'dialog'"
                :title="settingsStore.printers.value.length > 1 ? t('Drucker wechseln') : t('Einstellungen')"
                @click="onPrinterPillClick"
              >
                <span>{{ printerName }}</span>
                <ChevronDown v-if="settingsStore.printers.value.length > 1" :size="11" />
              </button>

              <div
                v-if="printerPopoverOpen && settingsStore.printers.value.length > 1"
                class="printer-popover"
                role="menu"
                :aria-label="t('Drucker wechseln')"
              >
                <div v-if="popoverDirtyConfirm" class="printer-popover-confirm" role="alert">
                  <span>
                    {{
                      t(
                        'Im Konfigurations-Editor sind ungespeicherte Änderungen in {0} offen. Beim Wechsel auf {1} bleibt der Editor geschützt im Lesemodus.',
                        [configEditor.currentPath.value, popoverDirtyConfirm.name],
                      )
                    }}
                  </span>
                  <div class="printer-popover-confirm-actions">
                    <button type="button" class="subtle-button" @click="popoverDirtyConfirm = null">
                      {{ t('Abbrechen') }}
                    </button>
                    <button
                      type="button"
                      class="confirm-button"
                      @click="quickSwitchPrinter(popoverDirtyConfirm, true)"
                    >
                      {{ t('Trotzdem wechseln') }}
                    </button>
                  </div>
                </div>

                <p v-if="popoverError" class="settings-inline-error" style="padding: 4px 8px; margin: 0">
                  {{ t(popoverError) }}
                </p>

                <button
                  v-for="printer in settingsStore.printers.value"
                  :key="printer.id"
                  type="button"
                  role="menuitemradio"
                  class="printer-popover-item"
                  :class="{ active: settingsStore.activePrinter.value?.id === printer.id }"
                  :aria-checked="settingsStore.activePrinter.value?.id === printer.id"
                  :disabled="settingsStore.saving.value"
                  @click="quickSwitchPrinter(printer)"
                >
                  <span class="printer-popover-meta">
                    <strong>{{ printer.name || printer.id }}</strong>
                    <small>{{ printer.url }}</small>
                  </span>
                  <Check v-if="settingsStore.activePrinter.value?.id === printer.id" :size="14" />
                </button>

                <div class="printer-popover-divider" />
                <button type="button" role="menuitem" class="printer-popover-manage" @click="openSettings('printers')">
                  <Settings :size="14" />{{ t('Drucker verwalten …') }}
                </button>
              </div>
            </div>
          </span>
          <small v-if="printerSubtitle">{{ printerSubtitle }}</small>
        </span>
      </div>
      <div class="header-meta">
        <button
          type="button"
          class="settings-trigger-btn"
          :aria-label="t('Einstellungen')"
          :title="t('Einstellungen')"
          @click="openSettings('printers')"
        >
          <Settings :size="16" />
        </button>
        <button
          type="button"
          class="icon-button display-toggle-btn"
          :class="{ active: displayMode }"
          :aria-pressed="displayMode"
          :aria-label="displayMode ? t('Display-Modus beenden') : t('Display-Modus aktivieren')"
          :title="
            displayMode
              ? t('Display-Modus aktiv (Touch-Ansicht ohne Kameras) · Klicken zum Beenden')
              : t('Display-Modus für Drucker-Touchscreen (ohne Kameras)')
          "
          @click="toggleDisplayMode"
        >
          <Monitor :size="16" />
        </button>
        <div class="language-control">
          <CockpitSelect
            :model-value="language"
            :options="languageOptions"
            :aria-label="t('Sprache')"
            size="compact"
            align="right"
            @update:model-value="setLanguage"
          />
        </div>
        <span class="connection" :class="connection">
          <Wifi v-if="online" :size="15" />
          <WifiOff v-else :size="15" />
          {{ t(connectionLabel) }}
        </span>
        <button
          v-if="showPrintControl"
          class="subtle-button print-control"
          type="button"
          :disabled="!!printActionReason"
          :title="
            printActionReason
              ? t(printActionReason)
              : printAction === 'pause'
                ? t('Laufenden Druck pausieren')
                : t('Pausierten Druck fortsetzen')
          "
          @click="!printActionReason && send({ action: printAction })"
        >
          <Pause v-if="printAction === 'pause'" :size="15" />
          <Play v-else :size="15" />
          {{ printAction === 'pause' ? t('Pause') : t('Fortsetzen') }}
        </button>
        <span class="header-divider" aria-hidden="true" />
        <button
          class="emergency-stop"
          type="button"
          :disabled="stopping"
          :title="t('Drucker sofort stoppen')"
          @click="send({ action: 'emergency_stop' })"
        >
          <OctagonX :size="17" />{{ stopping ? t('Stoppe …') : t('Not-Aus') }}
        </button>
      </div>
    </header>

    <nav class="main-nav" :aria-label="t('Ansichten')">
      <button
        type="button"
        :class="{ active: tab === 'tools' }"
        :aria-current="tab === 'tools' ? 'page' : undefined"
        @click="tab = 'tools'"
      >
        <Box :size="17" />{{ isSingleTool ? t('Übersicht') : t('Werkzeuge') }}
      </button>
      <button
        type="button"
        :class="{ active: tab === 'controls' }"
        :aria-current="tab === 'controls' ? 'page' : undefined"
        @click="tab = 'controls'"
      >
        <Home :size="17" />{{ t('Bedienung') }}
      </button>
      <button
        type="button"
        :class="{ active: tab === 'print' }"
        :aria-current="tab === 'print' ? 'page' : undefined"
        @click="tab = 'print'"
      >
        <Printer :size="17" />{{ t('Druck') }}
      </button>
      <button
        type="button"
        :class="{ active: tab === 'history' }"
        :aria-current="tab === 'history' ? 'page' : undefined"
        @click="tab = 'history'"
      >
        <History :size="17" />{{ t('Verlauf') }}
      </button>
      <button
        v-if="showCameras"
        type="button"
        :class="{ active: tab === 'cameras' }"
        :aria-current="tab === 'cameras' ? 'page' : undefined"
        @click="tab = 'cameras'"
      >
        <Camera :size="17" />{{ t('Kameras') }}
      </button>
      <button
        type="button"
        :class="{ active: tab === 'system' }"
        :aria-current="tab === 'system' ? 'page' : undefined"
        @click="tab = 'system'"
      >
        <SlidersHorizontal :size="17" />System
        <span
          v-if="configEditor.isDirty.value"
          class="nav-dirty-dot"
          :title="t('Ungespeicherte Konfigurationsänderungen')"
        />
      </button>
      <button
        type="button"
        :class="{ active: tab === 'console' }"
        :aria-current="tab === 'console' ? 'page' : undefined"
        @click="tab = 'console'"
      >
        <Terminal :size="17" />{{ t('Konsole') }}
      </button>
      <a class="mainsail-link" :href="mainsailUrl" target="_blank" rel="noopener">
        {{ t('Mainsail öffnen') }}<ArrowUpRight :size="16" />
      </a>
    </nav>

    <main>
      <div
        v-if="isPrintActive && tab !== 'print'"
        class="print-job-bar"
        :class="{ paused: status.printState === 'paused' }"
        role="status"
      >
        <div class="print-job-meta">
          <span class="print-job-badge">
            <Printer :size="14" />{{ t(printLabel) }}
          </span>
          <strong class="print-job-file">{{ status.filename || t('Unbekannte Datei') }}</strong>
          <span v-if="isToolchanger && status.active != null" class="print-job-detail">T{{ status.active }}</span>
          <span v-if="printProgressPercent != null" class="print-job-detail">{{ printProgressPercent }} %</span>
          <span v-if="status.printDuration != null" class="print-job-detail">
            {{ formatDuration(status.printDuration) }}
          </span>
          <span v-if="formattedLiveZ" class="print-tuning-pill">Z {{ formattedLiveZ }}</span>
          <span v-if="status.speedPercent != null && status.speedPercent !== 100" class="print-tuning-pill">
            {{ status.speedPercent }} %
          </span>
          <span v-if="status.flowPercent != null && status.flowPercent !== 100" class="print-tuning-pill">
            Flow {{ status.flowPercent }} %
          </span>
          <div class="print-job-bar-actions">
            <button
              type="button"
              class="print-job-tuning-toggle"
              :aria-expanded="liveTuningOpen"
              @click="liveTuningOpen = !liveTuningOpen"
            >
              <SlidersHorizontal :size="13" />{{ t('Live-Tuning') }}
            </button>
            <button type="button" class="print-job-open" @click="tab = 'print'">
              {{ t('3D-Druckansicht') }}<ChevronRight :size="14" />
            </button>
          </div>
        </div>
        <div v-if="printProgressPercent != null" class="print-job-track" aria-hidden="true">
          <div class="print-job-fill" :style="{ width: `${printProgressPercent}%` }" />
        </div>
        <LivePrintTuning
          v-if="liveTuningOpen"
          compact
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
        />
      </div>

      <div v-if="!online && connection !== 'connecting'" class="notice" role="status">
        <AlertTriangle :size="18" />
        <span>
          {{ t(error) }}
          {{
            status
              ? t('Letzter Datenstand: {0}.', [time])
              : t('Temperaturen und Werkzeugzustände werden angezeigt, sobald die Verbindung steht.')
          }}
        </span>
        <div class="notice-actions">
          <button type="button" @click="openSettings('printers')">{{ t('IP / Verbindung anpassen') }}</button>
          <button type="button" :disabled="updating" @click="refresh">{{ t('Erneut verbinden') }}</button>
        </div>
      </div>

      <div v-if="klipperNeedsRecovery" class="klipper-recovery-banner" role="alert">
        <div class="klipper-recovery-copy">
          <AlertTriangle :size="18" />
          <div>
            <strong>{{ t(klipperRecoveryTitle) }}</strong>
            <p v-if="status.klipperMessage">{{ status.klipperMessage }}</p>
            <p v-else>{{ t('Klipper ist nach einem Not-Aus oder Fehler angehalten und kann hier direkt neu gestartet werden.') }}</p>
          </div>
        </div>
        <div class="klipper-recovery-actions" @keydown.esc="cancelRecoveryConfirm">
          <template v-if="confirmRecoveryTarget === 'klipper_restart'">
            <button
              type="button"
              class="subtle-button recovery-confirm-btn"
              :disabled="!!restartingRecoveryTarget"
              @click="triggerKlipperRecovery('klipper_restart')"
            >
              <RotateCw :size="14" />{{ t('Klipper jetzt neu starten') }}
            </button>
            <button
              type="button"
              class="subtle-button recovery-cancel-btn"
              :aria-label="t('Abbrechen')"
              @click="cancelRecoveryConfirm"
            >
              <X :size="14" />
            </button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button"
            :disabled="!!restartingRecoveryTarget"
            @click="requestRecoveryConfirm('klipper_restart')"
          >
            <RotateCw :size="14" :class="{ spinning: restartingRecoveryTarget === 'klipper_restart' }" />
            {{ t('Klipper neu starten') }}
          </button>

          <template v-if="confirmRecoveryTarget === 'firmware_restart'">
            <button
              type="button"
              class="subtle-button recovery-confirm-btn"
              :disabled="!!restartingRecoveryTarget"
              @click="triggerKlipperRecovery('firmware_restart')"
            >
              <Power :size="14" />{{ t('Firmware jetzt neu starten') }}
            </button>
            <button
              type="button"
              class="subtle-button recovery-cancel-btn"
              :aria-label="t('Abbrechen')"
              @click="cancelRecoveryConfirm"
            >
              <X :size="14" />
            </button>
          </template>
          <button
            v-else
            type="button"
            class="subtle-button recovery-firmware-btn"
            :disabled="!!restartingRecoveryTarget"
            @click="requestRecoveryConfirm('firmware_restart')"
          >
            <Power :size="14" :class="{ spinning: restartingRecoveryTarget === 'firmware_restart' }" />
            {{ t('Firmware-Neustart') }}
          </button>
        </div>
        <p
          v-if="recoveryFeedback"
          class="klipper-recovery-feedback"
          :class="{ failed: !recoveryFeedback.ok }"
          role="status"
        >
          {{ t(recoveryFeedback.message) }}
        </p>
      </div>

      <div v-if="status?.detectionMismatch && !status?.homingCanInitialize" class="notice" role="alert">
        <AlertTriangle :size="18" />
        <span>
          {{
            status.detectionConflict
              ? t('Mehrere Tools melden eine Verbindung.')
              : t('Werkzeugerkennung weicht ab: erwartet {0}, erkannt {1}.', [
                  status.active == null ? t('keines') : `T${status.active}`,
                  t(detectedLabel),
                ])
          }}
        </span>
      </div>

      <div v-if="status?.control?.job?.uncertain" class="recovery-panel" role="alert">
        <p>{{ t('Das Ergebnis des letzten Befehls ist unklar.') }}</p>
        <label>
          <input v-model="recoveryChecked" type="checkbox" />
          {{ t('Ich habe am Drucker geprüft, dass keine Aktion mehr läuft.') }}
        </label>
        <button
          class="subtle-button"
          type="button"
          :disabled="!recoveryChecked || pending || !online"
          @click="acknowledgeUncertain"
        >
          {{ t('Bediensperre aufheben') }}
        </button>
      </div>

      <div v-else-if="activeJob" class="job-progress-banner" role="status">
        <div class="job-progress-head">
          <Loader2 :size="16" class="spinning" />
          <strong>{{ t(activeJob.label) }}</strong>
          <span v-if="activeJob.stepTotal > 1 && activeJob.step" class="job-progress-step">
            {{ t('Schritt {0}/{1} · {2}', [activeJob.stepIndex, activeJob.stepTotal, t(activeJob.step)]) }}
          </span>
          <span class="job-progress-time">{{ activeJobElapsed }}</span>
        </div>
        <div v-if="activeJob.stepTotal > 1" class="job-progress-track" aria-hidden="true">
          <div
            class="job-progress-fill"
            :style="{ width: `${Math.round((activeJob.stepIndex / activeJob.stepTotal) * 100)}%` }"
          />
        </div>
      </div>

      <div
        v-if="feedback && tab !== 'controls' && !activeJob && !status?.control?.job?.uncertain"
        :class="['command-feedback', { failed: !feedback.ok }]"
        role="status"
      >
        {{ t(feedback.message) }}
      </div>

      <div class="page-heading">
        <div>
          <h1>{{ t(pageHeading) }}</h1>
          <p
            :role="tab === 'controls' ? 'status' : undefined"
            :class="{ 'command-status-failed': tab === 'controls' && feedback && !feedback.ok && !pending }"
          >
            {{ t(pageSubtitle) }}
          </p>
        </div>
        <button
          class="icon-button refresh-button"
          type="button"
          :disabled="updating"
          :aria-label="t('Status jetzt aktualisieren')"
          :title="t('Status jetzt aktualisieren')"
          @click="refresh"
        >
          <RefreshCw :size="18" :class="{ spinning: updating }" />
        </button>
      </div>

      <section
        v-show="tab === 'tools'"
        class="tools-layout"
        :class="{ 'single-tool-layout': isSingleTool }"
        :aria-label="isSingleTool ? t('Druckerübersicht') : t('Werkzeugübersicht')"
      >
        <SingleToolOverview
          v-if="isSingleTool"
          :key="`single-${printerSwitchKey}`"
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
          :time="time"
          :printer-subtitle="printerSubtitle"
          @command="send"
        />

        <template v-else>
          <div class="scene-column">
            <ToolScene
              v-if="show3dScene"
              ref="scene"
              :tools="tools"
              :online="online"
              :selected="selected"
              :detected="status?.detected"
              @select="selectTool"
            />
            <div
              class="tool-choices"
              :class="{ 'no-scene': !show3dScene }"
              :style="{ '--tool-cols': Math.min(6, Math.max(2, tools.length)) }"
              :aria-label="t('Werkzeug auswählen')"
            >
              <article v-for="tool in tools" :key="tool.id" class="tool-card" :class="{ selected: selected === tool.id }">
                <button
                  type="button"
                  :class="['tool-choice', { selected: selected === tool.id, stale: !online }]"
                  :aria-pressed="selected === tool.id"
                  :aria-label="
                    t('T{0} auswählen · {1} °C · {2} · {3}', [
                      tool.id,
                      temperature(tool.temperature),
                      state(tool),
                      shortFilament(tool),
                    ])
                  "
                  @click="selectTool(tool.id)"
                >
                  <span class="tool-choice-top">
                    <strong>T{{ tool.id }}</strong>
                    <span v-if="tool.detected && online" class="detected-dot" role="img" :aria-label="t('Aufgenommen')">
                      <Check :size="13" />
                    </span>
                    <ChevronRight v-else :size="14" class="choice-arrow" />
                  </span>
                  <span class="tool-temperature">{{ temperature(tool.temperature) }}<small>°C</small></span>
                  <ThermalGauge
                    :id="tool.id"
                    :temperature="tool.temperature"
                    :target="tool.target"
                    :power="tool.power"
                    :max-temperature="status?.capabilities?.toolMax?.[tool.id]"
                    :online="online"
                    decorative
                  />
                  <span class="tool-status">{{ t(state(tool)) }}</span>
                  <span class="tool-filament" :class="filamentClass(tool)" :title="t(filament(tool))">
                    <span class="filament-mark" :style="{ '--filament-color': tool.material?.color ?? '#bec9cc' }" />
                    {{ t(shortFilament(tool)) }}
                  </span>
                  <span
                    class="tool-material"
                    :title="tool.material?.name ?? t('Noch keine Materialangaben aus einer aktiven Druckdatei')"
                  >
                    <span v-if="tool.material?.color" class="material-color" :style="{ background: tool.material.color }" />
                    {{ tool.material?.type ?? t('Material unbekannt') }}
                  </span>
                  <span v-if="isToolchanger" class="tool-z-offset"><span>ΔZ</span>{{ zOffset(tool) }}</span>
                </button>
                <ToolActions
                  v-if="isToolchanger"
                  mode="mount"
                  :tool="tool.id"
                  :status="status"
                  :online="online"
                  :pending="pending"
                  @command="handleToolCommand"
                />
              </article>
            </div>

            <section
              class="tools-machine-panel"
              :class="{ 'single-col': !hasLedDeck }"
              :aria-label="t('Maschine & Vorbereitung')"
            >
              <LedControls
                :key="`led-${printerSwitchKey}`"
                :status="status"
                :online="online"
                :pending="pending"
                @command="send"
              />
            </section>
          </div>

          <aside class="inspector" :aria-label="t('Details zum ausgewählten Werkzeug')">
            <div class="inspector-title">
              <h2>T{{ selected }}</h2>
              <span class="selection-label">{{ t('Ausgewählt') }}</span>
            </div>
            <div
              class="tool-condition"
              :class="{ confirmed: current.detected && online, warning: status?.detectionMismatch || !online }"
            >
              <span class="status-dot" />{{ t(state(current)) }}
            </div>
            <div class="temperature-block" :class="{ stale: !online }">
              <span class="field-label">{{ t('Düsentemperatur') }}</span>
              <div class="big-temperature">{{ temperature(current.temperature) }}<span>°C</span></div>
              <TemperatureTarget
                :key="`${printerSwitchKey}-${selected}`"
                :tool="selected"
                :target="current.target"
                :max="status?.capabilities?.toolMax?.[selected]"
                :online="online"
                :ready="status?.klipperState === 'ready'"
                :pending="pending || !!status?.control?.job"
                :send="send"
              />
            </div>
            <div class="tool-live-detail">
              <span :class="{ heating: heatState(current) === 'Heizt auf' && online }">{{ t(heatState(current)) }}</span>
              <div class="led-status">
                <span>{{ online ? 'LEDs' : t('LEDs zuletzt') }}</span>
                <span
                  v-for="[role, label] in [['number', 'Nummer'], ['left', 'Düse 1'], ['right', 'Düse 2']]"
                  :key="role"
                  class="led-swatch"
                  role="img"
                  :style="{ background: online ? ledColor(current.leds?.[role]) : 'transparent' }"
                  :title="t(label) + (current.leds?.[role] ? t(' · Druckerfarbe') : t(' · unbekannt'))"
                  :aria-label="t(label)"
                />
                <span>
                  {{
                    current.effects?.length
                      ? current.effects.map(effect => t(effectLabel(effect))).join(', ')
                      : current.leds?.number
                        ? t('Kein Effekt aktiv')
                        : t('Unbekannt')
                  }}
                </span>
              </div>
              <span v-if="activityLabel" class="printer-activity">
                {{ t(activityLabel) }}{{ !online ? t(' · zuletzt') : '' }}
              </span>
            </div>

            <dl class="measurements">
              <div>
                <dt>{{ t('Heizleistung') }}</dt>
                <dd>{{ current.power == null ? '—' : `${number(current.power * 100, 0)} %` }}</dd>
              </div>
              <div>
                <dt>Sensor T{{ selected }}</dt>
                <dd>{{ temperature(current.sensorTemperature) }} °C</dd>
              </div>
              <div>
                <dt>Filament</dt>
                <dd :class="{ 'text-lime': current.filamentEnabled && current.filamentDetected }">
                  {{ t(filament(current)) }}
                </dd>
              </div>
            </dl>

            <div class="inspector-tool-actions">
              <h3>{{ t('Aktionen für T{0}', [selected]) }}</h3>
              <ToolActions
                mode="maintenance"
                :tool="selected"
                :status="status"
                :online="online"
                :pending="pending"
                @command="handleToolCommand"
              />
              <p v-if="actionRestriction" class="tool-action-restriction" role="status">{{ actionRestriction }}</p>
            </div>

            <details class="calibration">
              <summary>{{ t('Kalibrierung') }}<ChevronRight :size="15" /></summary>
              <dl class="measurements">
                <div v-if="isToolchanger">
                  <dt>Offset X / Y / Z</dt>
                  <dd class="offsets">
                    {{ number(current.offsets?.x, 3) }} / {{ number(current.offsets?.y, 3) }} / {{ number(current.offsets?.z, 3) }} mm
                  </dd>
                </div>
                <div>
                  <dt>Pressure Advance</dt>
                  <dd>{{ number(current.pressureAdvance, 3) }}</dd>
                </div>
              </dl>
            </details>

            <details v-if="isToolchanger" class="inspector-filament">
              <summary>
                <span>{{ t('Filamentaktionen') }}</span>
                <span v-if="online && status?.loadWatchActive" class="text-lime">{{ t('Einlegehilfe scharf') }}</span>
                <ChevronRight :size="15" />
              </summary>
              <div class="tool-reference">
                {{ t('Z relativ zum Initial-Tool') }}
                <strong>
                  {{
                    status?.initialTool == null
                      ? status?.initialToolAvailable
                        ? t('noch nicht gesetzt')
                        : t('nicht gemeldet')
                      : `T${status.initialTool}`
                  }}
                </strong>
                <span v-if="status?.initialTool != null"> {{ t('· kalibriert') }}</span>
              </div>
              <div class="tool-operations-bar">
                <div class="tool-bulk-actions">
                  <span>
                    {{ online ? t('{0}/{1} mit Filament', [filamentCount, tools.length]) : t('Filamentstatus unbekannt') }}
                  </span>
                  <button
                    class="subtle-button"
                    type="button"
                    :disabled="!!bulkReason('load_all')"
                    :title="
                      bulkReason('load_all')
                        ? t(bulkReason('load_all'))
                        : t('Alle Tools mit erkanntem Filament nacheinander laden; das letzte bleibt aufgenommen')
                    "
                    @click="bulkFilament('load_all')"
                  >
                    {{ t('Alle laden') }}
                  </button>
                  <button
                    class="subtle-button"
                    type="button"
                    :disabled="!!bulkReason('unload_all')"
                    :title="
                      bulkReason('unload_all')
                        ? t(bulkReason('unload_all'))
                        : t('Alle Tools mit erkanntem Filament nacheinander entladen und parken')
                    "
                    @click="bulkFilament('unload_all')"
                  >
                    {{ t('Alle entladen') }}
                  </button>
                </div>
              </div>
              <div class="load-watch" :class="{ armed: online && status?.loadWatchActive }">
                <div>
                  <strong>
                    {{ t('Einlegehilfe') }}
                    <span v-if="online && status?.loadWatchActive">
                      {{ t('· Scharf ·') }} {{ status.loadWatchTemperature ?? '—' }} °C
                    </span>
                  </strong>
                  <p>
                    {{
                      status?.loadWatchActive
                        ? t('Filament neu einlegen. Aufheizen, Laden und Abkühlen laufen automatisch.')
                        : t('Aufheizen, Laden und Abkühlen übernimmt dein Makro.')
                    }}
                  </p>
                  <p
                    v-if="online && status?.capabilities?.watchAutoHome && ![...'xyz'].every(a => status?.homedAxes?.includes(a))"
                    class="watch-homing-note"
                  >
                    {{ t('Beim Toolwechsel wird automatisch gehomt. Das aktive Tool lädt ohne Homing an Ort und Stelle.') }}
                  </p>
                </div>
                <button
                  class="subtle-button"
                  type="button"
                  :disabled="!!watchReason"
                  :title="
                    watchReason
                      ? t(watchReason)
                      : status?.loadWatchActive
                        ? t('Einlegehilfe beenden; ein laufender Einzug wird nicht abgebrochen')
                        : t('LOAD_WATCH aktivieren: neue Sensorsignale wählen und laden das Tool automatisch')
                  "
                  @click="toggleLoadWatch"
                >
                  {{ status?.loadWatchActive ? t('Fertig') : t('Scharf schalten') }}
                </button>
              </div>
            </details>
          </aside>
        </template>

        <ConsoleView
          v-if="tab === 'tools'"
          :key="`console-compact-${printerSwitchKey}`"
          compact
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
          @open="tab = 'console'"
        />
      </section>

      <ControlsView
        v-if="tab === 'controls'"
        :key="`controls-${printerSwitchKey}`"
        :status="status"
        :online="online"
        :pending="pending"
        :selected="selected"
        :send="send"
        :show-cameras="showCameras"
        :cameras="activeCameras"
        :model-preset="settingsStore.activePrinter.value?.model?.preset ?? 'auto'"
        @select="selectTool"
        @command="send"
        @refresh="refresh"
        @context="controlContext = $event"
      />

      <PrintView
        v-if="tab === 'print'"
        :key="`print-${printerSwitchKey}`"
        :status="status"
        :online="online"
        :pending="pending"
        :send="send"
        :printer-name="printerName"
        :requested-file="requestedPrintFile"
      />

      <HistoryView
        v-if="tab === 'history'"
        :key="`history-${printerSwitchKey}`"
        :status="status"
        :online="online"
        :pending="pending"
        :send="send"
        @open-print="openPrintFile"
        @print-started="openPrintFile"
      />

      <section
        v-if="showCameras && (tab === 'cameras' || (tab === 'tools' && activeCameras.length > 0))"
        class="camera-section"
        :aria-label="t('Druckerkameras')"
      >
        <div v-if="tab === 'tools'" class="section-heading">
          <h2>{{ t('Am Drucker') }}</h2>
          <span>
            {{
              activeCameras.length === 1
                ? t('Live aus der Kamera')
                : t('Live aus {0} Kameras', [activeCameras.length])
            }}
          </span>
        </div>
        <h2 v-else class="sr-only">{{ t('Druckerkameras') }}</h2>
        <div v-if="activeCameras.length > 0" class="camera-grid">
          <CameraView
            v-for="cam in activeCameras"
            :key="`${printerSwitchKey}-${cam.id}`"
            :id="cam.id"
            :name="cam.name"
            :description="cam.description"
            :service="cam.service"
            :preferred-mode="cam.preferredMode"
          />
        </div>
        <div v-else class="settings-empty">
          <Camera :size="24" />
          <p>{{ t('Für diesen Drucker sind aktuell keine Kameras aktiviert.') }}</p>
          <button type="button" class="subtle-button" @click="openSettings('cameras')">
            <Settings :size="14" />{{ t('Kameras einrichten') }}
          </button>
        </div>
      </section>

      <ConsoleView
        v-if="tab === 'console'"
        :key="`console-${printerSwitchKey}`"
        :status="status"
        :online="online"
        :pending="pending"
        :send="send"
      />

      <SystemView
        v-if="tab === 'system'"
        :key="`system-${printerSwitchKey}`"
        :status="status"
        :online="online"
        :pending="pending"
        :send="send"
        :subtab="systemSubtab"
        :time="time"
        :update-event="lastUpdateEvent"
        @update:subtab="systemSubtab = $event"
        @open-console="tab = 'console'"
        @refresh="refresh"
      />

      <footer class="page-footer">
        <span>
          DOCKYARD<template v-if="printerName"> · {{ printerName }}</template>
          <span class="footer-divider" aria-hidden="true">/</span> {{ t('Lokale Druckerbedienung') }}
        </span>
        <span>
          Moonraker · {{ online ? t('verbunden') : t(connectionLabel).toLowerCase() }}
          <template v-if="show3dScene">
            <span class="footer-divider" aria-hidden="true">/</span> {{ t('CAD-Referenz') }}
          </template>
        </span>
      </footer>
    </main>

    <SettingsDialog
      :open="settingsOpen"
      :initial-section="settingsInitialSection"
      @close="settingsOpen = false"
      @switched="onSettingsDialogSwitched"
    />
  </div>
</template>
