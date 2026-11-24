<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Activity, Crosshair, FileCode2, Wrench } from '@lucide/vue'
import { t } from '../i18n.mjs'
import { computeSystemState } from '../system-state.mjs'
import { useConfigEditor } from '../useConfigEditor.js'
import SystemOverview from './SystemOverview.vue'
import SystemCalibration from './SystemCalibration.vue'
import SystemMaintenance from './SystemMaintenance.vue'

const ConfigEditor = defineAsyncComponent(() => import('./ConfigEditor.vue'))

const props = defineProps({
  status: { type: Object, default: null },
  online: Boolean,
  pending: Boolean,
  send: { type: Function, required: true },
  subtab: { type: String, default: 'overview' },
  time: { type: String, default: '' },
  updateEvent: { type: Object, default: null },
})

const emit = defineEmits(['update:subtab', 'open-console', 'refresh'])

const configEditor = useConfigEditor()
const overview = ref(null)
const loadingOverview = ref(false)
const overviewError = ref('')
const moonrakerOnline = ref(true)

let pollTimer = null
let activeController = null

const systemState = computed(() =>
  computeSystemState({ status: props.status, online: props.online, overview: overview.value }),
)
const printLocked = computed(() => systemState.value.printLocked)
const uncertainOnly = computed(() => Boolean(props.status?.control?.job?.uncertain))

async function fetchOverview({ silent = false } = {}) {
  if (typeof document !== 'undefined' && document.hidden && silent) return
  activeController?.abort()
  activeController = new AbortController()
  if (!silent) loadingOverview.value = true
  overviewError.value = ''
  try {
    const response = await fetch('/api/system/overview', {
      signal: AbortSignal.any([activeController.signal, AbortSignal.timeout(7000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Moonraker-Systemdaten nicht erreichbar.')
    overview.value = data
    moonrakerOnline.value = true
  } catch (cause) {
    if (cause.name !== 'AbortError') {
      overviewError.value = cause.message || 'Moonraker-Systemdaten nicht erreichbar.'
      moonrakerOnline.value = false
    }
  } finally {
    loadingOverview.value = false
  }
}

function stopOverviewPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  activeController?.abort()
}

function startOverviewPolling() {
  stopOverviewPolling()
  fetchOverview()
  pollTimer = setInterval(() => {
    if (props.subtab === 'overview' && (typeof document === 'undefined' || !document.hidden)) {
      fetchOverview({ silent: true })
    }
  }, 5000)
}

function handleVisibility() {
  if (props.subtab === 'overview' && !document.hidden) {
    fetchOverview({ silent: true })
  }
}

watch(
  () => props.subtab,
  next => {
    if (next === 'overview') {
      startOverviewPolling()
    } else {
      stopOverviewPolling()
    }
  },
)

function handleRestarted() {
  emit('refresh')
  setTimeout(() => {
    if (props.subtab === 'overview') fetchOverview({ silent: true })
    emit('refresh')
  }, 2500)
}

function handleMoonrakerStatus(ok) {
  if (typeof ok === 'boolean') moonrakerOnline.value = ok
}

const subtabs = [
  { id: 'overview', label: 'Übersicht', icon: Activity },
  { id: 'config', label: 'Konfiguration', icon: FileCode2 },
  { id: 'calibration', label: 'Kalibrierung', icon: Crosshair },
  { id: 'maintenance', label: 'Wartung', icon: Wrench },
]

onMounted(() => {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility)
  }
  if (props.subtab === 'overview') {
    startOverviewPolling()
  } else {
    fetchOverview({ silent: true })
  }
})

onBeforeUnmount(() => {
  stopOverviewPolling()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibility)
  }
})
</script>

<template>
  <section class="system-workbench" :aria-label="t('System & Maschine')">
    <div class="system-subnav-bar">
      <div class="system-subnav" role="tablist" :aria-label="t('Systembereiche')">
        <button
          v-for="item in subtabs"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="subtab === item.id"
          @click="emit('update:subtab', item.id)"
        >
          <component :is="item.icon" :size="15" />
          <span>{{ t(item.label) }}</span>
          <span
            v-if="item.id === 'config' && configEditor.isDirty.value"
            class="nav-dirty-dot"
            :title="t('Ungespeicherte Änderungen')"
          />
        </button>
      </div>

      <div class="system-subnav-meta">
        <span class="status-dot" :class="moonrakerOnline ? 'live' : 'heating'" />
        <span>{{ moonrakerOnline ? t('Moonraker erreichbar') : t('Moonraker nicht erreichbar') }}</span>
      </div>
    </div>

    <SystemOverview
      v-if="subtab === 'overview'"
      :status="status"
      :online="online"
      :moonraker-online="moonrakerOnline"
      :print-locked="printLocked"
      :uncertain-only="uncertainOnly"
      :overview="overview"
      :loading-overview="loadingOverview"
      :overview-error="overviewError"
      :time="time"
      @refresh-overview="fetchOverview()"
      @restarted="handleRestarted"
    />

    <ConfigEditor
      v-else-if="subtab === 'config'"
      :print-locked="printLocked"
      :moonraker-online="moonrakerOnline"
      @restarted="handleRestarted"
      @moonraker-status="handleMoonrakerStatus"
    />

    <SystemCalibration
      v-else-if="subtab === 'calibration'"
      :status="status"
      :online="online"
      :pending="pending"
      :send="send"
      @open-console="emit('open-console')"
    />

    <SystemMaintenance
      v-else
      :print-locked="printLocked"
      :moonraker-online="moonrakerOnline"
      :update-event="updateEvent"
      @moonraker-status="handleMoonrakerStatus"
    />
  </section>
</template>
