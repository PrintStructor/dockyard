<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  AlertTriangle,
  Check,
  Power,
  RefreshCw,
  RotateCw,
  Server,
} from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import { computeSystemState } from '../system-state.mjs'

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
let confirmTimer = null

onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
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

const isPrintActive = computed(() => props.online && ['printing', 'paused'].includes(props.status?.printState))
const printProgressPercent = computed(() =>
  Number.isFinite(props.status?.progress) ? Math.round(Math.max(0, Math.min(1, props.status.progress)) * 100) : null,
)
const detectedLabel = computed(() => (props.status?.detected == null ? 'Keines bestätigt' : `T${props.status.detected}`))

const sensors = computed(() => [
  ['Druckbett', props.status?.bed?.temperature],
  ['Bauraum', props.status?.chamber],
  ['Raspberry Pi', props.status?.raspberryPi],
  ['Octopus', props.status?.octopus],
  ['RP2350', props.status?.rp2350],
  ['Beacon-Spule', props.status?.beacon],
])

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
            <small v-if="overview?.klippy?.state">Klippy · {{ overview.klippy.state }}</small>
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
          <div><dt>Klipper</dt><dd>{{ effectiveKlipperState ?? t('Unbekannt') }}</dd></div>
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
          <div><dt>Toolchanger</dt><dd>{{ status?.toolchangerState ?? t('Unbekannt') }}</dd></div>
          <div>
            <dt>{{ t('Aktives Werkzeug') }}</dt>
            <dd>{{ status?.active == null ? t('Unbekannt') : `T${status.active}` }}</dd>
          </div>
          <div><dt>{{ t('Erkanntes Werkzeug') }}</dt><dd>{{ t(detectedLabel) }}</dd></div>
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
                ? t('Live-Verbindung · LED-Farben viermal pro Sekunde.')
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
    </div>
  </div>
</template>
