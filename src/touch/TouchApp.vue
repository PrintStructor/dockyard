<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Home,
  Flame,
  Move,
  Printer,
  SlidersHorizontal,
  OctagonX,
  Wifi,
  WifiOff,
  AlertTriangle,
  RotateCw,
  Power,
  Check,
  X,
  Loader2,
  Save,
  ChevronDown,
} from '@lucide/vue'
import { t, language, setLanguage, setDocumentTitle } from '../i18n.mjs'
import { computePrinterTheme, themeStyleVars } from '../theme-accent.mjs'
import { auxActionReason } from '../aux-action-state.mjs'
import { usePrinter } from '../usePrinter.js'
import { useControls } from '../useControls.js'
import { useSettings } from '../useSettings.js'
import PromptDialog from '../components/PromptDialog.vue'
import TouchHome from './TouchHome.vue'
import TouchHeat from './TouchHeat.vue'
import TouchMove from './TouchMove.vue'
import TouchPrint from './TouchPrint.vue'
import TouchMore from './TouchMore.vue'
import TouchNumpad from './TouchNumpad.vue'
import TouchScreensaver from './TouchScreensaver.vue'
import { resolveTouchConfig, withPrinterParam, buildDesktopExitUrl } from './touch-config.mjs'

const touchConfig = resolveTouchConfig(typeof globalThis.location !== 'undefined' ? globalThis.location.search : '')
if (touchConfig.lang) setLanguage(touchConfig.lang)

const settingsStore = useSettings()
const activePrinterOverride = ref(touchConfig.printerId || '')
const scopedPrinterId = computed(() => activePrinterOverride.value || '')

const activePrompt = ref(null)
const activeTab = ref('home') // 'home' | 'heat' | 'move' | 'print' | 'more'
const moveInitialMode = ref('axes')
const printerPickerOpen = ref(false)
const localToast = ref(null)
let localToastTimer = null

const { status, connection, updating, refresh, resetForPrinterSwitch } = usePrinter({
  printerId: scopedPrinterId,
  lite: true,
  onSettings: payload => {
    if (!payload || typeof payload !== 'object') return
    settingsStore.applyRemoteSettings(payload)
    // Only reset when NOT pinned to a specific printer and the global active printer changed
    if (!activePrinterOverride.value && (payload.activePrinterChanged || payload.printerUrlChanged)) {
      activePrompt.value = null
      clearFeedback()
      resetForPrinterSwitch()
      loadPresets()
    }
  },
  onPrompt: payload => {
    activePrompt.value = payload?.open ? payload : null
    if (payload?.open) wakeFromScreensaver(false)
  },
})

const { pending, stopping, feedback, send, syncServerResult, clearFeedback } = useControls(refresh, {
  printerId: scopedPrinterId,
})

watch(
  () => status.value?.control?.lastResult,
  result => syncServerResult(result),
)

const online = computed(() => connection.value === 'online')
const canWrite = computed(() => settingsStore.runtime.value?.canWrite !== false)

const currentPrinterProfile = computed(() => {
  const list = settingsStore.printers.value ?? []
  if (activePrinterOverride.value) {
    const found = list.find(p => p.id === activePrinterOverride.value)
    if (found) return found
  }
  return settingsStore.activePrinter.value ?? list[0] ?? null
})

const printerName = computed(
  () => String(currentPrinterProfile.value?.name || status.value?.printerName || 'DOCKYARD').trim(),
)
const activeAccentColor = computed(() => currentPrinterProfile.value?.model?.accentColor ?? '#c5f76b')
const activeThemeVars = computed(() => themeStyleVars(activeAccentColor.value))

watch(
  activeThemeVars,
  vars => {
    if (typeof document === 'undefined') return
    const rootStyle = document.documentElement.style
    for (const [key, val] of Object.entries(vars)) rootStyle.setProperty(key, val)
  },
  { immediate: true },
)

watch(
  [language, printerName, () => Boolean(status.value?.isToolchanger)],
  ([lang, name, tc]) => setDocumentTitle(lang, name, tc),
  { immediate: true },
)

// Preheat presets
const DEFAULT_PRESETS = [
  { name: 'PLA', bed: 60, tools: [210] },
  { name: 'PETG', bed: 80, tools: [240] },
  { name: 'ABS', bed: 110, tools: [255] },
]
const presets = ref(DEFAULT_PRESETS)

async function loadPresets() {
  try {
    const res = await fetch(withPrinterParam('/api/presets', scopedPrinterId.value), {
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    if (Array.isArray(data?.presets) && data.presets.length) presets.value = data.presets
  } catch {
    // Keep safe defaults
  }
}

function showLocalToast(item) {
  clearTimeout(localToastTimer)
  localToast.value = item
  if (item?.ok) {
    localToastTimer = setTimeout(() => {
      if (localToast.value === item) localToast.value = null
    }, 3600)
  }
}

const activeToast = computed(() => localToast.value ?? feedback.value)
function dismissToast() {
  localToast.value = null
  clearFeedback()
}

// Auto-switch to Home (Active Print HUD) when a print starts
const isPrintActive = computed(() => online.value && ['printing', 'paused'].includes(status.value?.printState))
watch(isPrintActive, (nowActive, wasActive) => {
  if (nowActive && !wasActive) {
    wakeFromScreensaver(false)
    activeTab.value = 'home'
  }
})

function navigateTab(nextTab, sub = '') {
  if (nextTab === 'move' && sub) moveInitialMode.value = sub
  activeTab.value = nextTab
}

// Shared TouchNumpad modal state
const numpad = ref({
  open: false,
  title: '',
  unit: '°C',
  initialValue: '',
  min: 0,
  max: 300,
  allowDecimal: false,
  presets: [],
  onConfirm: null,
})

function openNumpad(cfg) {
  numpad.value = {
    open: true,
    title: cfg.title || '',
    unit: cfg.unit || '°C',
    initialValue: cfg.initialValue ?? '',
    min: cfg.min ?? 0,
    max: cfg.max ?? 300,
    allowDecimal: Boolean(cfg.allowDecimal),
    presets: Array.isArray(cfg.presets) ? cfg.presets : [],
    onConfirm: typeof cfg.onConfirm === 'function' ? cfg.onConfirm : null,
  }
}

function closeNumpad() {
  numpad.value = { ...numpad.value, open: false, onConfirm: null }
}

async function confirmNumpad(value) {
  const cb = numpad.value.onConfirm
  closeNumpad()
  if (cb) await cb(value)
}

// Safety / Recovery states
const klipperNeedsRecovery = computed(
  () => online.value && Boolean(status.value?.klipperState) && status.value.klipperState !== 'ready',
)
const showToolchangerError = computed(
  () => online.value && status.value?.isToolchanger && status.value?.toolchangerState === 'error',
)
const tcRecoverReason = computed(() => auxActionReason(status.value, 'initialize_recover', online.value, pending.value))
const confirmTcRecover = ref(false)
const confirmRestart = ref('')
const restarting = ref(false)
const recoveryChecked = ref(false)
let safetyTimer = null

function resetSafetyConfirms() {
  confirmTcRecover.value = false
  confirmRestart.value = ''
  clearTimeout(safetyTimer)
  safetyTimer = null
}

function armSafetyConfirm(setter) {
  clearTimeout(safetyTimer)
  setter()
  safetyTimer = setTimeout(resetSafetyConfirms, 6000)
}

async function triggerRestart(target) {
  if (!canWrite.value || restarting.value) return
  if (confirmRestart.value !== target) {
    armSafetyConfirm(() => {
      confirmRestart.value = target
    })
    return
  }
  resetSafetyConfirms()
  restarting.value = true
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Cockpit-Request': '1' }
    if (scopedPrinterId.value) headers['X-Dockyard-Printer'] = scopedPrinterId.value
    const res = await fetch(withPrinterParam('/api/system/service/restart', scopedPrinterId.value), {
      method: 'POST',
      headers,
      body: JSON.stringify({ target }),
      signal: AbortSignal.timeout(12_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Neustart fehlgeschlagen.')
    showLocalToast({ ok: true, message: data.message || 'Neustart ausgelöst.' })
    refresh()
  } catch (err) {
    showLocalToast({ ok: false, message: err.message || 'Neustart fehlgeschlagen.' })
  } finally {
    restarting.value = false
  }
}

async function handleTcRecover() {
  if (tcRecoverReason.value) return
  if (!confirmTcRecover.value) {
    armSafetyConfirm(() => {
      confirmTcRecover.value = true
    })
    return
  }
  resetSafetyConfirms()
  await send({ action: 'initialize_recover' })
}

async function acknowledgeUncertain() {
  if (!recoveryChecked.value || pending.value || !online.value) return
  await send({ action: 'acknowledge' })
  recoveryChecked.value = false
}

// Top bar Save Config quick button (2-step confirm)
const showSaveConfigPill = computed(
  () => online.value && status.value?.klipperState === 'ready' && status.value?.saveConfigPending === true && !isPrintActive.value,
)
const confirmSaveConfig = ref(false)
function handleSaveConfigPill() {
  if (!showSaveConfigPill.value || pending.value) return
  if (!confirmSaveConfig.value) {
    confirmSaveConfig.value = true
    clearTimeout(safetyTimer)
    safetyTimer = setTimeout(() => {
      confirmSaveConfig.value = false
    }, 6000)
    return
  }
  confirmSaveConfig.value = false
  send({ action: 'save_config' })
}

// Active job elapsed timer
const activeJob = computed(() => {
  const j = status.value?.control?.job
  return j && !j.uncertain ? j : null
})
const nowTick = ref(Date.now())
const activeJobElapsed = computed(() => {
  if (!activeJob.value?.startedAt) return ''
  const secs = Math.max(0, Math.floor((nowTick.value - new Date(activeJob.value.startedAt).getTime()) / 1000))
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
})

// Local printer switcher (never alters Desktop global activePrinter when unlocked!)
function selectLocalPrinter(printer) {
  printerPickerOpen.value = false
  if (!printer?.id || printer.id === currentPrinterProfile.value?.id) return
  activePrinterOverride.value = printer.id
  activePrompt.value = null
  clearFeedback()
  resetForPrinterSwitch({ reconnectSse: true })
  loadPresets()
}

function printerDotColor(printer) {
  return computePrinterTheme(printer?.model?.accentColor).accent
}

function exitToDesktop() {
  if (touchConfig.locked || typeof globalThis.location === 'undefined') return
  globalThis.location.href = buildDesktopExitUrl(globalThis.location.href)
}

// Screensaver + First-Tap-Wake-Guard
const sleeping = ref(false)
const wakeShieldActive = ref(false)
let lastActivityAt = Date.now()
let idleCheckTimer = null
let wakeShieldTimer = null

function markActivity() {
  lastActivityAt = Date.now()
}

function triggerSleep() {
  if (isPrintActive.value || klipperNeedsRecovery.value || showToolchangerError.value) return
  closeNumpad()
  printerPickerOpen.value = false
  sleeping.value = true
}

function wakeFromScreensaver(useGuard = true) {
  if (!sleeping.value) return
  sleeping.value = false
  lastActivityAt = Date.now()
  if (useGuard) {
    wakeShieldActive.value = true
    clearTimeout(wakeShieldTimer)
    wakeShieldTimer = setTimeout(() => {
      wakeShieldActive.value = false
    }, 380)
  }
}

onMounted(() => {
  settingsStore.loadSettings().then(() => loadPresets())
  idleCheckTimer = setInterval(() => {
    if (activeJob.value) nowTick.value = Date.now()
    if (
      touchConfig.sleepSeconds > 0 &&
      !sleeping.value &&
      !isPrintActive.value &&
      !klipperNeedsRecovery.value &&
      !showToolchangerError.value &&
      !activePrompt.value?.open &&
      !activeJob.value &&
      !numpad.value.open &&
      Date.now() - lastActivityAt >= touchConfig.sleepSeconds * 1000
    ) {
      sleeping.value = true
    }
  }, 1000)
})

onBeforeUnmount(() => {
  clearInterval(idleCheckTimer)
  clearTimeout(wakeShieldTimer)
  clearTimeout(localToastTimer)
  clearTimeout(safetyTimer)
})

// Top-bar quick telemetry when on non-home/non-heat screens
const activeToolObj = computed(() => {
  const idx = Number.isInteger(status.value?.active) && status.value.active >= 0 ? status.value.active : 0
  return status.value?.tools?.[idx] ?? status.value?.tools?.[0] ?? null
})
const progressPercent = computed(() =>
  Number.isFinite(status.value?.progress) ? Math.round(Math.max(0, Math.min(1, status.value.progress)) * 100) : null,
)
const topStatusText = computed(() => {
  if (!online.value) return t('Offline')
  if (status.value?.printState === 'printing') {
    return progressPercent.value != null ? `${t('Druckt')} ${progressPercent.value}%` : t('Druckt')
  }
  if (status.value?.printState === 'paused') return t('Pausiert')
  if (status.value?.displayMessage) return status.value.displayMessage
  return t('Bereit')
})
</script>

<template>
  <div
    class="touch-shell"
    :class="{ 'hide-cursor': touchConfig.hideCursor }"
    :style="activeThemeVars"
    @pointerdown.capture="markActivity"
    @keydown.capture="markActivity"
  >
    <!-- 48px TOP BAR -->
    <header class="touch-topbar">
      <div class="touch-topbar-left">
        <button
          type="button"
          class="touch-printer-pill"
          :class="{ interactive: !touchConfig.locked && settingsStore.printers.value.length > 1 }"
          :disabled="touchConfig.locked || settingsStore.printers.value.length <= 1"
          @click="printerPickerOpen = true"
        >
          <span class="touch-accent-dot" aria-hidden="true" />
          <strong>{{ printerName }}</strong>
          <ChevronDown v-if="!touchConfig.locked && settingsStore.printers.value.length > 1" :size="14" />
        </button>

        <span class="touch-conn-badge" :class="online ? 'online' : 'offline'">
          <Wifi v-if="online" :size="14" />
          <WifiOff v-else :size="14" />
          <span>{{ topStatusText }}</span>
        </span>

        <span v-if="online && activeTab !== 'home' && activeTab !== 'heat'" class="touch-top-temps">
          <template v-if="activeToolObj?.temperature != null">
            <Flame :size="13" />{{ Math.round(activeToolObj.temperature) }}°
          </template>
          <template v-if="status?.bed?.temperature != null">
            · {{ Math.round(status.bed.temperature) }}°
          </template>
        </span>

        <button
          v-if="showSaveConfigPill"
          type="button"
          class="touch-save-pill"
          :class="{ confirming: confirmSaveConfig }"
          @click="handleSaveConfigPill"
        >
          <Save :size="13" />{{ confirmSaveConfig ? t('Speichern?') : 'SAVE' }}
        </button>
      </div>

      <!-- ISOLATED E-STOP (physical dead-zone gap via margin-left: auto + padding-left: 24px) -->
      <div class="touch-estop-zone">
        <button
          type="button"
          class="touch-estop-btn"
          :disabled="stopping"
          :aria-label="t('Not-Aus')"
          @click="send({ action: 'emergency_stop' })"
        >
          <OctagonX :size="18" />
          <span>{{ stopping ? '…' : t('Not-Aus') }}</span>
        </button>
      </div>
    </header>

    <!-- BODY: 76px LEFT RAIL + 724x432 ZERO-SCROLL STAGE -->
    <div class="touch-workspace">
      <nav class="touch-rail" :aria-label="t('Navigation')">
        <button
          type="button"
          class="touch-rail-btn"
          :class="{ active: activeTab === 'home' }"
          :aria-current="activeTab === 'home' ? 'page' : undefined"
          @click="activeTab = 'home'"
        >
          <Home :size="22" />
          <span>{{ isPrintActive ? `${progressPercent ?? 0}%` : t('Home') }}</span>
        </button>

        <button
          type="button"
          class="touch-rail-btn"
          :class="{ active: activeTab === 'heat' }"
          :aria-current="activeTab === 'heat' ? 'page' : undefined"
          @click="activeTab = 'heat'"
        >
          <Flame :size="22" />
          <span>{{ t('Heizen') }}</span>
        </button>

        <button
          type="button"
          class="touch-rail-btn"
          :class="{ active: activeTab === 'move' }"
          :aria-current="activeTab === 'move' ? 'page' : undefined"
          @click="navigateTab('move', 'axes')"
        >
          <Move :size="22" />
          <span>{{ t('Achsen') }}</span>
        </button>

        <button
          type="button"
          class="touch-rail-btn"
          :class="{ active: activeTab === 'print' }"
          :aria-current="activeTab === 'print' ? 'page' : undefined"
          @click="activeTab = 'print'"
        >
          <Printer :size="22" />
          <span>{{ t('Drucken') }}</span>
        </button>

        <button
          type="button"
          class="touch-rail-btn"
          :class="{ active: activeTab === 'more' }"
          :aria-current="activeTab === 'more' ? 'page' : undefined"
          @click="activeTab = 'more'"
        >
          <SlidersHorizontal :size="22" />
          <span>{{ t('Mehr') }}</span>
        </button>
      </nav>

      <main class="touch-stage">
        <!-- ACTIVE JOB PROGRESS STRIP -->
        <div v-if="activeJob" class="touch-job-strip" role="status">
          <Loader2 :size="16" class="spinning" />
          <strong>{{ t(activeJob.label) }}</strong>
          <span v-if="activeJob.stepTotal > 1 && activeJob.step">
            {{ activeJob.stepIndex }}/{{ activeJob.stepTotal }} · {{ t(activeJob.step) }}
          </span>
          <span class="touch-job-time">{{ activeJobElapsed }}</span>
        </div>

        <!-- SAFETY BANNER: TOOLCHANGER TOOL-DROP RECOVERY -->
        <div v-if="showToolchangerError" class="touch-safety-bar danger" role="alert">
          <AlertTriangle :size="18" />
          <span>{{ t('Toolchanger-Fehler · Werkzeug prüfen') }}</span>
          <button
            type="button"
            class="touch-btn touch-btn-sm"
            :class="confirmTcRecover ? 'touch-btn-amber' : 'touch-btn-surface'"
            :disabled="!!tcRecoverReason"
            @click="handleTcRecover"
          >
            <RotateCw :size="15" />{{ confirmTcRecover ? t('Jetzt initialisieren?') : t('Wiederherstellen') }}
          </button>
        </div>

        <!-- STAGE VIEWS -->
        <TouchHome
          v-if="activeTab === 'home'"
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
          :presets="presets"
          :printer-id="scopedPrinterId"
          :can-write="canWrite"
          @open-numpad="openNumpad"
          @navigate="navigateTab"
          @command="send"
        />

        <TouchHeat
          v-else-if="activeTab === 'heat'"
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
          :presets="presets"
          @open-numpad="openNumpad"
        />

        <TouchMove
          v-else-if="activeTab === 'move'"
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
          :initial-mode="moveInitialMode"
          @open-numpad="openNumpad"
        />

        <TouchPrint
          v-else-if="activeTab === 'print'"
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
          :printer-id="scopedPrinterId"
          @started="activeTab = 'home'"
        />

        <TouchMore
          v-else
          :status="status"
          :online="online"
          :pending="pending"
          :send="send"
          :printer-id="scopedPrinterId"
          :locked="touchConfig.locked"
          :can-write="canWrite"
          @sleep="triggerSleep"
          @exit-desktop="exitToDesktop"
          @refresh="refresh"
          @toast="showLocalToast"
        />
      </main>
    </div>

    <!-- FLOATING TOAST -->
    <button
      v-if="activeToast && !activeJob && !status?.control?.job?.uncertain"
      type="button"
      class="touch-toast"
      :class="{ failed: !activeToast.ok }"
      role="status"
      @click="dismissToast"
    >
      <AlertTriangle v-if="!activeToast.ok" :size="16" />
      <Check v-else :size="16" />
      <span>{{ t(activeToast.message) }}</span>
      <X :size="14" />
    </button>

    <!-- KLIPPER SHUTDOWN / ERROR FULL RECOVERY MODAL -->
    <div v-if="klipperNeedsRecovery" class="touch-overlay" role="alertdialog" aria-modal="true">
      <div class="touch-sheet touch-recovery-sheet">
        <div class="touch-sheet-head">
          <h2><AlertTriangle :size="20" />{{ t('Klipper ist nicht bereit') }} ({{ status.klipperState }})</h2>
        </div>
        <p class="touch-recovery-msg">
          {{ status.klipperMessage || t('Klipper wurde angehalten und kann hier direkt neu gestartet werden.') }}
        </p>
        <div class="touch-confirm-actions">
          <button
            type="button"
            class="touch-btn touch-btn-lg"
            :class="confirmRestart === 'klipper_restart' ? 'touch-btn-amber' : 'touch-btn-surface'"
            :disabled="!canWrite || restarting"
            @click="triggerRestart('klipper_restart')"
          >
            <RotateCw :size="18" />{{ confirmRestart === 'klipper_restart' ? t('Klipper jetzt neu starten?') : t('Klipper neu starten') }}
          </button>
          <button
            type="button"
            class="touch-btn touch-btn-lg"
            :class="confirmRestart === 'firmware_restart' ? 'touch-btn-amber' : 'touch-btn-accent'"
            :disabled="!canWrite || restarting"
            @click="triggerRestart('firmware_restart')"
          >
            <Power :size="18" />{{ confirmRestart === 'firmware_restart' ? t('Firmware jetzt neu starten?') : t('Firmware-Neustart') }}
          </button>
        </div>
      </div>
    </div>

    <!-- UNCERTAIN JOB LOCK MODAL -->
    <div v-else-if="status?.control?.job?.uncertain" class="touch-overlay" role="alertdialog" aria-modal="true">
      <div class="touch-sheet touch-recovery-sheet">
        <div class="touch-sheet-head">
          <h2><AlertTriangle :size="20" />{{ t('Das Ergebnis des letzten Befehls ist unklar.') }}</h2>
        </div>
        <label class="touch-check-row">
          <input v-model="recoveryChecked" type="checkbox" />
          <span>{{ t('Ich habe am Drucker geprüft, dass keine Aktion mehr läuft.') }}</span>
        </label>
        <div class="touch-confirm-actions">
          <button
            type="button"
            class="touch-btn touch-btn-lg touch-btn-accent"
            :disabled="!recoveryChecked || pending || !online"
            @click="acknowledgeUncertain"
          >
            {{ t('Bediensperre aufheben') }}
          </button>
        </div>
      </div>
    </div>

    <!-- PRINTER SWITCHER SHEET (when !lock) -->
    <div
      v-if="printerPickerOpen && !touchConfig.locked"
      class="touch-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Drucker wechseln')"
      @click.self="printerPickerOpen = false"
    >
      <div class="touch-sheet">
        <div class="touch-sheet-head">
          <h2>{{ t('Drucker wechseln') }}</h2>
          <button type="button" class="touch-btn touch-btn-ghost touch-btn-icon" :aria-label="t('Schließen')" @click="printerPickerOpen = false">
            <X :size="20" />
          </button>
        </div>
        <div class="touch-printer-list">
          <button
            v-for="p in settingsStore.printers.value"
            :key="p.id"
            type="button"
            class="touch-btn touch-printer-choice"
            :class="currentPrinterProfile?.id === p.id ? 'touch-btn-accent' : 'touch-btn-surface'"
            @click="selectLocalPrinter(p)"
          >
            <span class="touch-accent-dot" :style="{ background: printerDotColor(p) }" aria-hidden="true" />
            <strong>{{ p.name || p.id }}</strong>
            <small>{{ p.url }}</small>
          </button>
        </div>
      </div>
    </div>

    <!-- SHARED NUMERIC KEYPAD -->
    <TouchNumpad
      :open="numpad.open"
      :title="numpad.title"
      :unit="numpad.unit"
      :initial-value="numpad.initialValue"
      :min="numpad.min"
      :max="numpad.max"
      :allow-decimal="numpad.allowDecimal"
      :presets="numpad.presets"
      @close="closeNumpad"
      @confirm="confirmNumpad"
    />

    <!-- NATIVE KLIPPER ACTION:PROMPT_* DIALOG -->
    <PromptDialog
      :prompt="activePrompt"
      :busy="pending"
      @action="gcode => send({ action: 'prompt_action', gcode })"
      @dismiss="send({ action: 'prompt_action', dismiss: true })"
    />

    <!-- SCREENSAVER + FIRST-TAP-WAKE-GUARD SHIELD -->
    <TouchScreensaver
      :active="sleeping"
      :printer-name="printerName"
      :status="status"
      :online="online"
      @wake="wakeFromScreensaver(true)"
    />
    <div
      v-if="wakeShieldActive"
      class="touch-wake-shield"
      aria-hidden="true"
      @pointerdown.prevent.stop
      @click.prevent.stop
    />
  </div>
</template>
