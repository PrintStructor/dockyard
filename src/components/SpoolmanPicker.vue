<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, Check, Search, X, Loader2, Disc } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'

const props = defineProps({
  spoolman: { type: Object, required: true },
  online: { type: Boolean, default: false },
  canWrite: { type: Boolean, default: true },
})

const emit = defineEmits(['changed'])

const rootEl = ref(null)
const open = ref(false)
const loading = ref(false)
const saving = ref(false)
const query = ref('')
const spools = ref([])
const error = ref('')

const activeSpool = computed(() => props.spoolman?.activeSpool ?? null)
const interactive = computed(() => props.online && props.canWrite)

const formatGrams = value =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString(locale.value, { maximumFractionDigits: 0 })} g`
    : ''

const pillLabel = computed(() => {
  const s = activeSpool.value
  if (!s) return t('Spoolman · keine Spule')
  const parts = []
  if (s.material) parts.push(s.material)
  if (s.name) parts.push(s.name)
  return parts.join(' · ') || `#${s.id}`
})

const filteredSpools = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return spools.value
  return spools.value.filter(s => {
    const haystack = `#${s.id} ${s.vendor ?? ''} ${s.material ?? ''} ${s.name ?? ''} ${s.lotNr ?? ''}`.toLowerCase()
    return haystack.includes(q)
  })
})

async function loadSpools() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch('/api/spoolman/spools', {
      cache: 'no-store',
      signal: AbortSignal.timeout(7000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Spulenliste konnte nicht geladen werden.')
    spools.value = Array.isArray(data.spools) ? data.spools : []
  } catch (err) {
    error.value = err.message || 'Spulenliste konnte nicht geladen werden.'
  } finally {
    loading.value = false
  }
}

function togglePopover() {
  open.value = !open.value
  if (open.value) {
    query.value = ''
    loadSpools()
  }
}

async function selectSpool(spoolId) {
  if (!interactive.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const res = await fetch('/api/spoolman/active', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify({ spoolId }),
      signal: AbortSignal.timeout(7000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Aktive Spule konnte nicht geändert werden.')
    open.value = false
    emit('changed', data)
  } catch (err) {
    error.value = err.message || 'Aktive Spule konnte nicht geändert werden.'
  } finally {
    saving.value = false
  }
}

function onOutsidePointer(event) {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target)) {
    open.value = false
  }
}

function onKeydown(event) {
  if (event.key === 'Escape' && open.value) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onOutsidePointer)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutsidePointer)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="spoolman-wrap">
    <button
      type="button"
      class="spoolman-pill"
      :class="{ empty: !activeSpool, readonly: !interactive }"
      :aria-expanded="open"
      :aria-label="t('Spoolman-Spule auswählen')"
      @click="togglePopover"
    >
      <span
        class="spoolman-dot"
        :style="{ background: activeSpool?.color ?? '#879499' }"
        aria-hidden="true"
      />
      <span class="spoolman-pill-text">{{ pillLabel }}</span>
      <span v-if="activeSpool?.remainingWeight != null" class="spoolman-weight single-mono">
        {{ formatGrams(activeSpool.remainingWeight) }}
      </span>
      <ChevronDown :size="13" class="spoolman-chevron" :class="{ open }" />
    </button>

    <div v-if="open" class="spoolman-popover" role="dialog" :aria-label="t('Aktive Spoolman-Spule')">
      <div class="spoolman-popover-head">
        <span class="spoolman-popover-title"><Disc :size="13" />Spoolman</span>
        <button
          v-if="activeSpool && interactive"
          type="button"
          class="spoolman-clear-btn"
          :disabled="saving"
          @click="selectSpool(null)"
        >
          <X :size="12" />{{ t('Spule entfernen') }}
        </button>
      </div>

      <label class="spoolman-search">
        <Search :size="13" />
        <input
          v-model="query"
          type="text"
          :placeholder="t('Spule, Material oder Hersteller suchen …')"
          :aria-label="t('Spulen filtern')"
        />
      </label>

      <p v-if="!canWrite" class="spoolman-note">{{ t('Nur Lesezugriff: Spulenwechsel ist für diesen Browser gesperrt.') }}</p>
      <p v-else-if="error" class="spoolman-error" role="alert">{{ t(error) }}</p>

      <div v-if="loading" class="spoolman-state">
        <Loader2 :size="15" class="spinning" />
        <span>{{ t('Spulen werden geladen …') }}</span>
      </div>

      <div v-else-if="!filteredSpools.length" class="spoolman-state">
        <span>{{ spools.length ? t('Keine passende Spule gefunden.') : t('Keine aktiven Spulen in Spoolman vorhanden.') }}</span>
      </div>

      <div v-else class="spoolman-list" role="listbox" :aria-label="t('Verfügbare Spulen')">
        <button
          v-for="spool in filteredSpools"
          :key="spool.id"
          type="button"
          role="option"
          class="spoolman-row"
          :class="{ active: activeSpool?.id === spool.id }"
          :aria-selected="activeSpool?.id === spool.id"
          :disabled="!interactive || saving"
          @click="selectSpool(spool.id)"
        >
          <span class="spoolman-dot" :style="{ background: spool.color ?? '#879499' }" aria-hidden="true" />
          <span class="spoolman-row-main">
            <strong>
              <span v-if="spool.material" class="spoolman-mat">{{ spool.material }}</span>
              {{ spool.name }}
            </strong>
            <small>
              #{{ spool.id }}<template v-if="spool.vendor"> · {{ spool.vendor }}</template>
            </small>
          </span>
          <span v-if="spool.remainingWeight != null" class="spoolman-row-weight single-mono">
            {{ formatGrams(spool.remainingWeight) }}
          </span>
          <Check v-if="activeSpool?.id === spool.id" :size="14" class="spoolman-check" />
        </button>
      </div>
    </div>
  </div>
</template>
