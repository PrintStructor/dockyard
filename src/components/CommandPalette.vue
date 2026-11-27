<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  Box,
  Camera,
  History,
  Home,
  Printer,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Snowflake,
  Terminal,
  X,
} from '@lucide/vue'
import { t } from '../i18n.mjs'
import { computePrinterTheme } from '../theme-accent.mjs'

const props = defineProps({
  open: Boolean,
  printers: { type: Array, default: () => [] },
  activePrinterId: { type: String, default: '' },
  status: { type: Object, default: null },
  online: Boolean,
  isSingleTool: Boolean,
  showCameras: Boolean,
})

const emit = defineEmits(['close', 'navigate', 'switch-printer', 'open-settings', 'command'])

const dialogEl = ref(null)
const inputEl = ref(null)
const query = ref('')
const activeIdx = ref(0)
const confirmingId = ref('')

watch(
  () => props.open,
  async isOpen => {
    if (isOpen) {
      query.value = ''
      activeIdx.value = 0
      confirmingId.value = ''
      dialogEl.value?.showModal()
      await nextTick()
      inputEl.value?.focus()
    } else if (dialogEl.value?.open) {
      confirmingId.value = ''
      dialogEl.value.close()
    }
  },
)

const canMotion = computed(
  () =>
    props.online &&
    props.status?.klipperState === 'ready' &&
    !props.status?.control?.job &&
    !['printing', 'paused'].includes(props.status?.printState) &&
    props.status?.idleState !== 'Printing',
)

const items = computed(() => {
  const list = []

  // Views / Navigation
  list.push(
    {
      id: 'nav-tools',
      group: 'Ansichten',
      label: props.isSingleTool ? t('Cockpit') : t('Werkzeuge'),
      hint: props.isSingleTool ? t('Temperaturen, 3D & Steuerung') : t('Werkzeugübersicht'),
      icon: Box,
      run: () => emit('navigate', { tab: 'tools' }),
    },
    ...(!props.isSingleTool
      ? [
          {
            id: 'nav-controls',
            group: 'Ansichten',
            label: t('Bedienung'),
            hint: t('Achsen, Heizungen & Lüfter'),
            icon: Home,
            run: () => emit('navigate', { tab: 'controls' }),
          },
        ]
      : []),
    {
      id: 'nav-print',
      group: 'Ansichten',
      label: t('Druck & 3D-Vorschau'),
      hint: t('Dateien, Warteschlange & 3D-G-Code'),
      icon: Printer,
      run: () => emit('navigate', { tab: 'print' }),
    },
    {
      id: 'nav-history',
      group: 'Ansichten',
      label: t('Verlauf'),
      hint: t('Druckhistorie & Statistik'),
      icon: History,
      run: () => emit('navigate', { tab: 'history' }),
    },
    ...(props.showCameras
      ? [
          {
            id: 'nav-cameras',
            group: 'Ansichten',
            label: t('Kameras'),
            hint: t('Livestreams'),
            icon: Camera,
            run: () => emit('navigate', { tab: 'cameras' }),
          },
        ]
      : []),
    {
      id: 'nav-sys-overview',
      group: 'Ansichten',
      label: `${t('System')} · ${t('Übersicht')}`,
      hint: t('Host, Dienste, Strom & MCU'),
      icon: SlidersHorizontal,
      run: () => emit('navigate', { tab: 'system', sub: 'overview' }),
    },
    {
      id: 'nav-cal',
      group: 'Ansichten',
      label: `${t('System')} · ${t('Kalibrierung')}`,
      hint: 'Bed Mesh, PID, Shaper, Bed Screws',
      icon: SlidersHorizontal,
      run: () => emit('navigate', { tab: 'system', sub: 'calibration' }),
    },
    {
      id: 'nav-cfg',
      group: 'Ansichten',
      label: `${t('System')} · ${t('Konfiguration')}`,
      hint: 'printer.cfg, moonraker.conf',
      icon: SlidersHorizontal,
      run: () => emit('navigate', { tab: 'system', sub: 'config' }),
    },
    {
      id: 'nav-maint',
      group: 'Ansichten',
      label: `${t('System')} · ${t('Wartung')}`,
      hint: t('Updates & Logs'),
      icon: SlidersHorizontal,
      run: () => emit('navigate', { tab: 'system', sub: 'maintenance' }),
    },
    {
      id: 'nav-console',
      group: 'Ansichten',
      label: t('Konsole'),
      hint: t('Direkt mit Klipper.'),
      icon: Terminal,
      run: () => emit('navigate', { tab: 'console' }),
    },
    {
      id: 'nav-settings',
      group: 'Ansichten',
      label: t('Einstellungen'),
      hint: t('Drucker, Kameras & Farbakzent'),
      icon: Settings,
      run: () => emit('open-settings', 'printers'),
    },
  )

  // Printers
  if (props.printers.length > 1) {
    for (const p of props.printers) {
      const isCurrent = p.id === props.activePrinterId
      list.push({
        id: `printer-${p.id}`,
        group: 'Druckerprofile',
        label: p.name || p.id,
        hint: isCurrent ? t('Aktiv') : p.url,
        dotColor: computePrinterTheme(p.model?.accentColor).accent,
        disabled: isCurrent,
        run: () => !isCurrent && emit('switch-printer', p),
      })
    }
  }

  // Quick Safe Commands
  if (canMotion.value) {
    list.push({
      id: 'cmd-home',
      group: 'Aktionen',
      label: t('Alle Achsen homen'),
      hint: 'G28',
      icon: Home,
      requiresConfirm: true,
      run: () => emit('command', { action: 'home', axis: 'all' }),
    })
    if (props.status?.saveConfigPending) {
      list.push({
        id: 'cmd-save-config',
        group: 'Aktionen',
        label: 'SAVE_CONFIG',
        hint: t('Kalibrierungswerte speichern & Klipper neu starten'),
        icon: Save,
        requiresConfirm: true,
        run: () => emit('command', { action: 'save_config' }),
      })
    }
  }
  if (props.online && props.status?.klipperState === 'ready' && props.status?.printState !== 'printing') {
    list.push({
      id: 'cmd-cooldown',
      group: 'Aktionen',
      label: t('Alle Heizungen ausschalten'),
      hint: 'TURN_OFF_HEATERS',
      icon: Snowflake,
      run: () => emit('command', { action: 'heaters_off' }),
    })
  }

  // Public Macros (non-parameterized require 2-step confirm; parameterized jump to Console)
  for (const m of props.status?.publicMacros ?? []) {
    const hasParams = Boolean(m.params?.length)
    list.push({
      id: `macro-${m.name}`,
      group: 'Makros',
      label: m.name,
      hint: hasParams
        ? `${m.params.map(p => p.name).join(', ')} · ${t('in Konsole öffnen')}`
        : m.description || t('Klipper-Makro'),
      icon: Terminal,
      disabled: !hasParams && !canMotion.value,
      requiresConfirm: !hasParams,
      run: () => {
        if (hasParams) {
          emit('navigate', { tab: 'console' })
        } else if (canMotion.value) {
          emit('command', { action: 'macro', name: m.name })
        }
      },
    })
  }

  return list
})

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return items.value.slice(0, 14)
  return items.value
    .filter(item => item.label.toLowerCase().includes(q) || (item.hint && item.hint.toLowerCase().includes(q)))
    .slice(0, 16)
})

watch(filtered, () => {
  activeIdx.value = 0
  confirmingId.value = ''
})

function move(delta) {
  if (!filtered.value.length) return
  confirmingId.value = ''
  activeIdx.value = (activeIdx.value + delta + filtered.value.length) % filtered.value.length
}

function selectItem(item) {
  if (!item || item.disabled) return
  if (item.requiresConfirm && confirmingId.value !== item.id) {
    confirmingId.value = item.id
    return
  }
  confirmingId.value = ''
  emit('close')
  item.run()
}

function onKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    selectItem(filtered.value[activeIdx.value])
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="cmd-palette-dialog"
    :aria-label="t('Schnellsuche')"
    @cancel.prevent="emit('close')"
    @click.self="emit('close')"
  >
    <div class="cmd-palette-head">
      <Search :size="16" class="cmd-palette-search-icon" />
      <input
        ref="inputEl"
        v-model="query"
        type="search"
        :placeholder="t('Drucker, Ansicht, Aktion oder Makro suchen …')"
        :aria-label="t('Schnellsuche')"
        @keydown="onKeydown"
      />
      <button type="button" class="icon-button" :aria-label="t('Schließen')" @click="emit('close')">
        <X :size="16" />
      </button>
    </div>

    <div class="cmd-palette-list" role="listbox">
      <p v-if="!filtered.length" class="cmd-palette-empty">{{ t('Kein passender Eintrag gefunden.') }}</p>
      <button
        v-for="(item, idx) in filtered"
        :key="item.id"
        type="button"
        role="option"
        class="cmd-palette-row"
        :class="{ active: idx === activeIdx, disabled: item.disabled, confirming: confirmingId === item.id }"
        :aria-selected="idx === activeIdx"
        :disabled="item.disabled"
        @mouseenter="activeIdx = idx"
        @click="selectItem(item)"
      >
        <span class="cmd-palette-row-left">
          <span v-if="item.dotColor" class="printer-accent-dot" :style="{ background: item.dotColor }" />
          <component :is="item.icon" v-else :size="15" />
          <strong>{{ item.label }}</strong>
        </span>
        <span class="cmd-palette-row-meta">
          <small v-if="confirmingId === item.id" class="cmd-confirm-hint">
            {{ t('Erneut Enter / Klicken zum Ausführen') }}
          </small>
          <small v-else-if="item.hint">{{ item.hint }}</small>
          <span class="cmd-palette-group">{{ t(item.group) }}</span>
        </span>
      </button>
    </div>

    <footer class="cmd-palette-foot">
      <span>↑↓ {{ t('Wählen') }}</span>
      <span>↵ {{ t('Öffnen') }}</span>
      <span>Esc {{ t('Schließen') }}</span>
    </footer>
  </dialog>
</template>
