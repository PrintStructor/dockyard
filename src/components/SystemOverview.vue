<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  AlertTriangle,
  Check,
  Cpu,
  HardDrive,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  Monitor,
  CameraOff,
  Camera,
  Copy,
  Zap,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { computeSystemState } from '../system-state.mjs'
import { displayMode, showCameras, setDisplayMode, setCamerasHidden } from '../display-mode.mjs'

const props = defineProps({
  status: { type: Object, default: null },
  online: Boolean,
  moonrakerOnline: Boolean,
  printLocked: Boolean,
  uncertainOnly: Boolean,
  overview: { type: Object, default: null },
  loadingOverview: Boolean,
  overviewError: { type: String, default: '' },
  time: { type: String, default: '' },
})

const emit = defineEmits(['refresh-overview', 'restarted'])

const confirmingTarget = ref('')
const restartingTarget = ref('')
const restartFeedback = ref(null)
const copiedKioskUrl = ref(false)
const powerDevices = ref([])
const powerBusy = ref('')
const powerError = ref('')
const confirmPowerOff = ref('')
let confirmTimer = null
let copyTimer = null
let powerConfirmTimer = null

const kioskUrl = computed(() => {
  if (typeof globalThis.location === 'undefined') return '?display=1'
  return `${globalThis.location.origin}${globalThis.location.pathname}?display=1`
})

async function fetchPowerDevices() {
  try {
    const res = await fetch('/api/system/power', { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return
    const data = await res.json().catch(() => null)
    powerDevices.value = data?.available && Array.isArray(data.devices) ? data.devices : []
  } catch {
    // Power plugin is optional
  }
}

function resetPowerConfirm() {
  confirmPowerOff.value = ''
  clearTimeout(powerConfirmTimer)
  powerConfirmTimer = null
}

async function togglePowerDevice(dev) {
  if (!props.moonrakerOnline || powerBusy.value) return
  const turningOff = dev.status === 'on'
  if (turningOff && dev.lockedWhilePrinting) {
    if (props.printLocked) return
    if (confirmPowerOff.value !== dev.device) {
      confirmPowerOff.value = dev.device
      clearTimeout(powerConfirmTimer)
      powerConfirmTimer = setTimeout(resetPowerConfirm, 6000)
      return
    }
  }
  resetPowerConfirm()
  powerBusy.value = dev.device
  powerError.value = ''
  try {
    const action = turningOff ? 'off' : 'on'
    const res = await fetch('/api/system/power', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cockpit-Request': '1' },
      body: JSON.stringify({ device: dev.device, action }),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Schalten fehlgeschlagen.')
    await fetchPowerDevices()
  } catch (err) {
    powerError.value = err.message || 'Schalten fehlgeschlagen.'
  } finally {
    powerBusy.value = ''
  }
}

async function triggerHostAction(action) {
  if (isTargetBlocked(`host_${action}`)) return
  cancelConfirm()
  restartingTarget.value = `host_${action}`
  restartFeedback.value = null
  try {
    const response = await fetch(`/api/system/host/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: '{}',
      signal: AbortSignal.timeout(12_000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Host-Aktion fehlgeschlagen.')
    restartFeedback.value = {
      ok: true,
      message: data.message || 'Host-Aktion ausgelöst.',
    }
    emit('restarted', { target: `host_${action}` })
  } catch (cause) {
    restartFeedback.value = {
      ok: false,
      message: cause.message || 'Host-Aktion fehlgeschlagen.',
    }
  } finally {
    restartingTarget.value = ''
  }
}

onMounted(() => {
  fetchPowerDevices()
})

async function copyKioskUrl() {
  try {
    await navigator.clipboard.writeText(kioskUrl.value)
    copiedKioskUrl.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedKioskUrl.value = false
    }, 2500)
  } catch {
    copiedKioskUrl.value = false
  }
}

onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
  if (copyTimer) clearTimeout(copyTimer)
  if (powerConfirmTimer) clearTimeout(powerConfirmTimer)
})

const computedState = computed(() =>
  computeSystemState({ status: props.status, online: props.online, overview: props.overview }),
)
const isKlippyRecoveryState = computed(() => computedState.value.klippyInRecovery)
const effectiveKlipperState = computed(() => computedState.value.effectiveKlipperState)

function isTargetBlocked(target) {
  if (!props.moonrakerOnline || props.printLocked || !!restartingTarget.value) return true
  if (props.uncertainOnly) {
    const recoveryAllowed = isKlippyRecoveryState.value && ['klipper_restart', 'firmware_restart', 'klipper'].includes(target)
    if (!recoveryAllowed) return true
  }
  return false
}

function requestConfirm(target) {
  if (isTargetBlocked(target)) return
  confirmingTarget.value = target
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => {
    confirmingTarget.value = ''
  }, 6000)
}

function cancelConfirm() {
  confirmingTarget.value = ''
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

async function triggerRestart(target) {
  if (isTargetBlocked(target)) return
  cancelConfirm()
  restartingTarget.value = target
  restartFeedback.value = null
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
    restartFeedback.value = {
      ok: true,
      message: data.message || 'Neustart ausgelöst. Verbindung wird automatisch neu aufgebaut.',
    }
    emit('restarted', { target })
  } catch (cause) {
    restartFeedback.value = {
      ok: false,
      message: cause.message || 'Neustart fehlgeschlagen.',
    }
  } finally {
    restartingTarget.value = ''
  }
}

const number = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale.value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'

const formatGb = bytes =>
  typeof bytes === 'number' && Number.isFinite(bytes)
    ? (bytes / (1024 ** 3)).toLocaleString(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—'

function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hrs = Math.floor((total % 86400) / 3600)
  const mins = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days} d ${hrs} h ${mins} min`
  if (hrs > 0) return `${hrs} h ${mins} min`
  return `${mins} min`
}

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

const printLabel = computed(
  () =>
    ({
      standby: 'Bereit',
      printing: 'Druckt',
      paused: 'Pausiert',
      complete: 'Abgeschlossen',
      cancelled: 'Abgebrochen',
      error: 'Fehler',
    })[props.status?.printState] ?? 'Unbekannt',
)

const statusStateLabels = {
  ready: 'Bereit',
  startup: 'Startet',
  shutdown: 'Heruntergefahren',
  error: 'Fehler',
  disconnected: 'Getrennt',
  uninitialized: 'Nicht initialisiert',
  initializing: 'Initialisiert',
  changing: 'Wechselt',
  unknown: 'Unbekannt',
}

function formatState(value) {
  if (!value) return t('Unbekannt')
  const key = String(value).toLowerCase()
  if (Object.hasOwn(statusStateLabels, key)) return t(statusStateLabels[key])
  return key.charAt(0).toUpperCase() + key.slice(1)
}

const isToolchanger = computed(() => Boolean(props.status?.isToolchanger))
const isPrintActive = computed(() => props.online && ['printing', 'paused'].includes(props.status?.printState))
const printProgressPercent = computed(() =>
  Number.isFinite(props.status?.progress) ? Math.round(Math.max(0, Math.min(1, props.status.progress)) * 100) : null,
)
const detectedLabel = computed(() => (props.status?.detected == null ? 'Keines bestätigt' : `T${props.status.detected}`))

const sensors = computed(() => {
  const bedRow = [['Druckbett', props.status?.bed?.temperature]]
  if (Array.isArray(props.status?.sensors) && props.status.sensors.length > 0) {
    return [...bedRow, ...props.status.sensors.map(s => [s.label, s.temperature])]
  }
  const legacy = [
    ['Bauraum', props.status?.chamber],
    ['Raspberry Pi', props.status?.raspberryPi],
    ['Octopus', props.status?.octopus],
    ['RP2350', props.status?.rp2350],
    ['Beacon-Spule', props.status?.beacon],
  ]
  return [...bedRow, ...legacy.filter(([, val]) => val != null || isToolchanger.value)]
})

const hostCaption = computed(() => {
  const h = props.overview?.host
  if (!h) return ''
  return [h.model, h.os, h.kernel ? `Kernel ${h.kernel}` : null].filter(Boolean).join(' · ')
})
</script>

<template>
  <div class="system-overview-stack">
    <div class="system-metrics-wrap">
      <div class="system-metrics-strip" :aria-label="t('Host-Kennzahlen')">
        <template v-if="loadingOverview && !overview">
          <div v-for="i in 4" :key="i" class="system-metric-cell">
            <span class="skeleton-bar sm" />
            <span class="skeleton-bar lg" />
            <span class="skeleton-bar sm" />
          </div>
        </template>
        <template v-else>
          <div class="system-metric-cell">
            <span>{{ t('CPU-Auslastung') }}</span>
            <strong>{{ overview?.cpuUsage != null ? `${number(overview.cpuUsage, 1)} %` : '—' }}</strong>
            <small v-if="overview?.cpuCores">{{ t('{0} Kerne', [overview.cpuCores]) }}</small>
          </div>
          <div class="system-metric-cell">
            <span>{{ t('Arbeitsspeicher') }}</span>
            <strong>{{ overview?.memory?.usedPercent != null ? `${number(overview.memory.usedPercent, 1)} %` : '—' }}</strong>
            <small v-if="overview?.memory?.totalBytes">
              {{ formatGb(overview.memory.usedBytes) }} / {{ formatGb(overview.memory.totalBytes) }} GB
            </small>
          </div>
          <div class="system-metric-cell">
            <span>{{ t('Host-Temperatur') }}</span>
            <strong>{{ overview?.cpuTemp != null ? `${number(overview.cpuTemp, 1)} °C` : '—' }}</strong>
            <small>{{ overview?.throttledFlags?.length ? t('Drosselung gemeldet') : t('Normalbereich') }}</small>
          </div>
          <div class="system-metric-cell">
            <span>{{ t('Host-Laufzeit') }}</span>
            <strong>{{ formatUptime(overview?.uptimeSeconds) }}</strong>
            <small v-if="overview?.klippy?.state">Klippy · {{ formatState(overview.klippy.state) }}</small>
          </div>
          <div v-if="overview?.disk?.totalBytes" class="system-metric-cell">
            <span><HardDrive :size="12" style="vertical-align: -2px; margin-right: 4px" />{{ t('Speicherplatz') }}</span>
            <strong>{{ overview.disk.usedPercent != null ? `${number(overview.disk.usedPercent, 1)} %` : '—' }}</strong>
            <small>
              {{ formatGb(overview.disk.freeBytes) }} / {{ formatGb(overview.disk.totalBytes) }} GB {{ t('frei') }}
            </small>
          </div>
        </template>
      </div>

      <div class="system-host-caption">
        <span>{{ hostCaption || (overviewError ? t(overviewError) : '') }}</span>
        <button
          type="button"
          class="subtle-button"
          style="padding: 4px 8px; font-size: 11px"
          :disabled="loadingOverview"
          @click="emit('refresh-overview')"
        >
          <RefreshCw :size="12" :class="{ spinning: loadingOverview }" />{{ t('Host-Daten aktualisieren') }}
        </button>
      </div>

      <div v-if="overview?.throttledFlags?.length" class="system-banner amber" role="alert">
        <AlertTriangle :size="16" />
        <span>{{ t('Host-Drosselung erkannt:') }} {{ overview.throttledFlags.join(', ') }}</span>
      </div>
    </div>

    <div class="system-layout">
      <article class="system-panel">
        <h2>{{ t('Druckerstatus') }}</h2>
        <dl class="measurements">
          <div><dt>Klipper</dt><dd>{{ formatState(effectiveKlipperState) }}</dd></div>
          <div><dt>{{ t('Druckstatus') }}</dt><dd>{{ t(printLabel) }}</dd></div>
          <div v-if="status?.filename"><dt>{{ t('Druckdatei') }}</dt><dd>{{ status.filename }}</dd></div>
          <div v-if="isPrintActive && printProgressPercent != null">
            <dt>{{ t('Fortschritt') }}</dt>
            <dd>{{ printProgressPercent }} %</dd>
          </div>
          <div v-if="isPrintActive && status?.printDuration != null">
            <dt>{{ t('Druckzeit') }}</dt>
            <dd>{{ formatDuration(status.printDuration) }}</dd>
          </div>
          <template v-if="isToolchanger">
            <div><dt>Toolchanger</dt><dd>{{ formatState(status?.toolchangerState) }}</dd></div>
            <div>
              <dt>{{ t('Aktives Werkzeug') }}</dt>
              <dd>{{ status?.active == null ? t('Unbekannt') : `T${status.active}` }}</dd>
            </div>
            <div><dt>{{ t('Erkanntes Werkzeug') }}</dt><dd>{{ t(detectedLabel) }}</dd></div>
          </template>
          <div v-if="status?.bedSize">
            <dt>{{ t('Druckfläche') }}</dt>
            <dd>{{ Math.round(status.bedSize.width) }} × {{ Math.round(status.bedSize.depth) }} mm</dd>
          </div>
          <div>
            <dt>{{ t('Referenzierte Achsen') }}</dt>
            <dd>{{ status?.homedAxes?.toUpperCase() || t('Keine bestätigt') }}</dd>
          </div>
        </dl>
        <p class="muted">{{ status?.klipperMessage }}</p>
      </article>

      <article class="system-panel">
        <h2>{{ t('Temperaturen') }}</h2>
        <dl class="measurements">
          <div v-for="[name, value] in sensors" :key="name">
            <dt>{{ t(name) }}</dt>
            <dd>{{ number(value, 1) }} °C</dd>
          </div>
        </dl>
        <p class="muted">
          {{
            online
              ? status?.transport === 'live'
                ? t('Live-Verbindung · LED-Farben adaptiv.')
                : t('Ersatzabfrage alle 3 Sekunden.')
              : t('Letzter Datenstand: {0}.', [time])
          }}
        </p>
      </article>

      <article class="system-panel system-services-panel">
        <div class="system-panel-head">
          <div>
            <h2>{{ t('Neustart & Dienste') }}</h2>
            <p>{{ t('Klipper, MCU-Firmware und Systemdienste kontrolliert neu starten.') }}</p>
          </div>
        </div>

        <div v-if="printLocked" class="system-banner amber" style="margin-bottom: 14px" role="status">
          <AlertTriangle :size="15" />
          <span>{{ t('Neustarts sind während eines aktiven oder pausierten Drucks gesperrt.') }}</span>
        </div>

        <div
          v-else-if="uncertainOnly && !isKlippyRecoveryState"
          class="system-banner amber"
          style="margin-bottom: 14px"
          role="status"
        >
          <AlertTriangle :size="15" />
          <span>{{ t('Ergebnis des letzten Befehls erst prüfen und Bediensperre aufheben.') }}</span>
        </div>

        <div
          v-if="restartFeedback"
          class="system-banner"
          :class="restartFeedback.ok ? 'lime' : 'amber'"
          style="margin-bottom: 14px"
          role="status"
        >
          <Check v-if="restartFeedback.ok" :size="15" />
          <AlertTriangle v-else :size="15" />
          <span>{{ t(restartFeedback.message) }}</span>
        </div>

        <div class="system-primary-restarts">
          <div class="confirm-inline">
            <template v-if="confirmingTarget === 'klipper_restart'">
              <button
                type="button"
                class="confirm-button"
                :disabled="isTargetBlocked('klipper_restart')"
                @click="triggerRestart('klipper_restart')"
              >
                <RotateCw :size="14" />{{ t('Klipper wirklich neu starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="isTargetBlocked('klipper_restart')"
              @click="requestConfirm('klipper_restart')"
            >
              <RotateCw :size="14" :class="{ spinning: restartingTarget === 'klipper_restart' }" />
              {{ t('Klipper neu starten') }}
            </button>
          </div>

          <div class="confirm-inline">
            <template v-if="confirmingTarget === 'firmware_restart'">
              <button
                type="button"
                class="danger-button"
                :disabled="isTargetBlocked('firmware_restart')"
                @click="triggerRestart('firmware_restart')"
              >
                <Power :size="14" />{{ t('Firmware wirklich neu starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="isTargetBlocked('firmware_restart')"
              @click="requestConfirm('firmware_restart')"
            >
              <Power :size="14" :class="{ spinning: restartingTarget === 'firmware_restart' }" />
              {{ t('Firmware-Neustart') }}
            </button>
          </div>

          <div class="confirm-inline">
            <template v-if="confirmingTarget === 'host_reboot'">
              <button
                type="button"
                class="confirm-button"
                :disabled="isTargetBlocked('host_reboot')"
                @click="triggerHostAction('reboot')"
              >
                <RotateCw :size="14" />{{ t('Host wirklich neu starten?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="isTargetBlocked('host_reboot')"
              @click="requestConfirm('host_reboot')"
            >
              <RotateCw :size="14" :class="{ spinning: restartingTarget === 'host_reboot' }" />
              {{ t('Host neu starten') }}
            </button>
          </div>

          <div class="confirm-inline">
            <template v-if="confirmingTarget === 'host_shutdown'">
              <button
                type="button"
                class="danger-button"
                :disabled="isTargetBlocked('host_shutdown')"
                @click="triggerHostAction('shutdown')"
              >
                <Power :size="14" />{{ t('Host wirklich herunterfahren?') }}
              </button>
              <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="isTargetBlocked('host_shutdown')"
              @click="requestConfirm('host_shutdown')"
            >
              <Power :size="14" />
              {{ t('Host herunterfahren') }}
            </button>
          </div>
        </div>

        <div v-if="overview?.services?.length" class="system-services-grid">
          <div v-for="svc in overview.services" :key="svc.name" class="service-card">
            <div class="service-card-info">
              <strong>{{ svc.name }}</strong>
              <span class="service-state-pill" :class="svc.active ? 'active' : 'inactive'">
                <span class="status-dot" />
                {{ svc.active ? t('Aktiv') : t('Inaktiv') }}
              </span>
            </div>
            <div class="confirm-inline">
              <template v-if="confirmingTarget === svc.name">
                <button
                  type="button"
                  class="confirm-button"
                  :disabled="isTargetBlocked(svc.name)"
                  @click="triggerRestart(svc.name)"
                >
                  {{ t('Wirklich?') }}
                </button>
                <button type="button" class="subtle-button" @click="cancelConfirm">{{ t('Abbrechen') }}</button>
              </template>
              <button
                v-else
                type="button"
                class="subtle-button"
                :disabled="isTargetBlocked(svc.name)"
                @click="requestConfirm(svc.name)"
              >
                <Server :size="13" />{{ t('Neu starten') }}
              </button>
            </div>
          </div>
        </div>
        <p v-else class="muted" style="margin-top: 0">{{ t('Keine verwalteten Systemdienste gemeldet.') }}</p>
      </article>

      <article v-if="powerDevices.length" class="system-panel system-power-panel">
        <div class="system-panel-head">
          <div>
            <h2><Zap :size="16" style="vertical-align: -2px; margin-right: 6px" />{{ t('Stromgeräte') }}</h2>
            <p>{{ t('Über Moonraker konfigurierte Schaltsteckdosen, Relais und Beleuchtung.') }}</p>
          </div>
        </div>
        <div v-if="powerError" class="system-banner amber" style="margin-bottom: 12px" role="alert">
          <AlertTriangle :size="15" />
          <span>{{ t(powerError) }}</span>
        </div>
        <div class="system-services-grid" @keydown.esc="resetPowerConfirm">
          <div v-for="dev in powerDevices" :key="dev.device" class="service-card">
            <div class="service-card-info">
              <strong>{{ dev.device }}</strong>
              <span class="service-state-pill" :class="dev.status === 'on' ? 'active' : 'inactive'">
                <span class="status-dot" />
                {{ dev.status === 'on' ? t('An') : t('Aus') }}
              </span>
            </div>
            <button
              type="button"
              class="subtle-button"
              :class="{ 'confirm-button': confirmPowerOff === dev.device }"
              :disabled="!moonrakerOnline || !!powerBusy || (dev.status === 'on' && dev.lockedWhilePrinting && printLocked)"
              @click="togglePowerDevice(dev)"
            >
              <Power :size="13" />
              {{
                confirmPowerOff === dev.device
                  ? t('Wirklich ausschalten?')
                  : dev.status === 'on'
                    ? t('Ausschalten')
                    : t('Einschalten')
              }}
            </button>
          </div>
        </div>
      </article>

      <article v-if="overview?.mcus?.length" class="system-panel system-mcu-panel">
        <div class="system-panel-head">
          <div>
            <h2><Cpu :size="16" style="vertical-align: -2px; margin-right: 6px" />{{ t('MCU-Diagnose') }}</h2>
            <p>{{ t('Auslastung, Zykluszeit und Paketwiederholungen der angeschlossenen Controller.') }}</p>
          </div>
        </div>
        <div class="cal-table-wrap">
          <table class="cal-table">
            <thead>
              <tr>
                <th>MCU</th>
                <th>{{ t('Auslastung') }}</th>
                <th>{{ t('Task Ø') }}</th>
                <th>{{ t('Retransmits') }}</th>
                <th>{{ t('Version') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in overview.mcus" :key="m.id">
                <td>{{ m.name }}</td>
                <td>{{ m.awakePercent != null ? `${number(m.awakePercent, 1)} %` : '—' }}</td>
                <td>{{ m.taskAvgUs != null ? `${m.taskAvgUs} µs` : '—' }}</td>
                <td :class="{ 'mcu-warn': (m.bytesRetransmit ?? 0) > 0 }">
                  {{ m.bytesRetransmit != null ? m.bytesRetransmit : '—' }}
                </td>
                <td class="mcu-ver" :title="m.version ?? ''">{{ m.version ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="system-panel system-display-panel">
        <div class="system-panel-head">
          <div>
            <h2>{{ t('Drucker-Display & Ansicht') }}</h2>
            <p>{{ t('Kompakte Touch-Ansicht ohne Kamerastreams für ein Display direkt am Drucker.') }}</p>
          </div>
        </div>

        <div class="display-settings-grid">
          <div class="display-setting-row">
            <div>
              <strong>{{ t('Display-Modus (Touch / Kiosk)') }}</strong>
              <p>{{ t('Größere Touch-Flächen, kompakte Kopfleiste und keine Kameras.') }}</p>
            </div>
            <button
              type="button"
              class="subtle-button display-switch-btn"
              :class="{ active: displayMode }"
              :aria-pressed="displayMode"
              @click="setDisplayMode(!displayMode)"
            >
              <Monitor :size="14" />
              {{ displayMode ? t('Aktiv') : t('Aus') }}
            </button>
          </div>

          <div class="display-setting-row">
            <div>
              <strong>{{ t('Kamerastreams im Cockpit') }}</strong>
              <p>{{ t('Ausgeblendete Kameras öffnen keinerlei WebRTC- oder MJPEG-Verbindungen.') }}</p>
            </div>
            <button
              type="button"
              class="subtle-button display-switch-btn"
              :class="{ active: showCameras }"
              :aria-pressed="showCameras"
              @click="setCamerasHidden(showCameras)"
            >
              <Camera v-if="showCameras" :size="14" />
              <CameraOff v-else :size="14" />
              {{ showCameras ? t('Sichtbar') : t('Ausgeblendet') }}
            </button>
          </div>
        </div>

        <div class="kiosk-url-bar">
          <div>
            <span class="field-label">{{ t('Direktlink für Drucker-Display (Kiosk-Browser)') }}</span>
            <code>{{ kioskUrl }}</code>
          </div>
          <button type="button" class="subtle-button" @click="copyKioskUrl">
            <Check v-if="copiedKioskUrl" :size="14" class="text-lime" />
            <Copy v-else :size="14" />
            {{ copiedKioskUrl ? t('Kopiert') : t('URL kopieren') }}
          </button>
        </div>
      </article>
    </div>
  </div>
</template>
