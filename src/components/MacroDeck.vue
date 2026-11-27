<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ChevronDown, Play, SlidersHorizontal, Star, Terminal, X } from '@lucide/vue'
import { t } from '../i18n.mjs'

const props = defineProps({
  macros: { type: Array, default: () => [] },
  printerId: { type: String, default: '' },
  enabled: { type: Boolean, default: false },
  openByDefault: { type: Boolean, default: false },
})

const emit = defineEmits(['run'])

const macroQuery = ref('')
const confirmMacro = ref('')
const expandedMacro = ref(null)
const paramDrafts = reactive({})
const pinnedSet = ref(new Set())
let confirmTimer = null

function storageKey(id) {
  return `dockyard.pinnedMacros.${id || 'default'}`
}

function loadPinned(id) {
  try {
    const raw = localStorage.getItem(storageKey(id))
    const parsed = raw ? JSON.parse(raw) : []
    pinnedSet.value = new Set(Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [])
  } catch {
    pinnedSet.value = new Set()
  }
}

function savePinned(id) {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify([...pinnedSet.value]))
  } catch {
    // Ignore storage quota errors
  }
}

watch(
  () => props.printerId,
  id => {
    loadPinned(id)
    expandedMacro.value = null
    resetConfirm()
  },
  { immediate: true },
)

function togglePin(name) {
  const next = new Set(pinnedSet.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  pinnedSet.value = next
  savePinned(props.printerId)
}

function resetConfirm() {
  confirmMacro.value = ''
  clearTimeout(confirmTimer)
  confirmTimer = null
}

onBeforeUnmount(() => {
  resetConfirm()
})

const sortedMacros = computed(() => {
  const q = macroQuery.value.trim().toLowerCase()
  const list = props.macros.filter(item => {
    if (!q) return true
    return (
      item.name.toLowerCase().includes(q) ||
      item.label.toLowerCase().includes(q) ||
      (item.description && item.description.toLowerCase().includes(q))
    )
  })
  return [...list].sort((a, b) => {
    const ap = pinnedSet.value.has(a.name) ? 0 : 1
    const bp = pinnedSet.value.has(b.name) ? 0 : 1
    if (ap !== bp) return ap - bp
    return a.name.localeCompare(b.name)
  })
})

function openParamForm(macro) {
  if (expandedMacro.value?.name === macro.name) {
    expandedMacro.value = null
    return
  }
  resetConfirm()
  expandedMacro.value = macro
  for (const key of Object.keys(paramDrafts)) delete paramDrafts[key]
  for (const p of macro.params ?? []) {
    paramDrafts[p.name] = p.defaultValue ?? ''
  }
}

function handleMacroClick(macro) {
  if (!props.enabled) return
  if (macro.params?.length) {
    openParamForm(macro)
    return
  }
  if (confirmMacro.value !== macro.name) {
    expandedMacro.value = null
    confirmMacro.value = macro.name
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(resetConfirm, 5000)
    return
  }
  resetConfirm()
  emit('run', { action: 'macro', name: macro.name })
}

function submitParamMacro() {
  if (!props.enabled || !expandedMacro.value) return
  const params = {}
  for (const p of expandedMacro.value.params ?? []) {
    const val = String(paramDrafts[p.name] ?? '').trim()
    if (val !== '') params[p.name] = val
  }
  const name = expandedMacro.value.name
  expandedMacro.value = null
  emit('run', { action: 'macro', name, ...(Object.keys(params).length ? { params } : {}) })
}
</script>

<template>
  <details v-if="macros.length" class="single-macros-disclosure" :open="openByDefault || undefined">
    <summary>
      <span><Terminal :size="15" />{{ t('Makros') }} ({{ macros.length }})</span>
      <ChevronDown :size="15" class="single-graph-chevron" />
    </summary>
    <div class="single-macros-body" @keydown.esc="resetConfirm(); expandedMacro = null">
      <input
        v-if="macros.length > 6"
        v-model="macroQuery"
        type="search"
        class="macro-search-input"
        :placeholder="t('Makro filtern …')"
        :aria-label="t('Makro filtern')"
      />

      <form v-if="expandedMacro" class="macro-param-drawer" @submit.prevent="submitParamMacro">
        <div class="macro-param-head">
          <div>
            <strong>{{ expandedMacro.name }}</strong>
            <p v-if="expandedMacro.description">{{ expandedMacro.description }}</p>
          </div>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('Schließen')"
            @click="expandedMacro = null"
          >
            <X :size="14" />
          </button>
        </div>
        <div class="macro-param-fields">
          <label v-for="p in expandedMacro.params" :key="p.name" class="macro-param-field">
            <span>{{ p.name }}</span>
            <input
              v-model="paramDrafts[p.name]"
              type="text"
              maxlength="80"
              :placeholder="p.defaultValue || t('Optional')"
              :aria-label="`${expandedMacro.name} ${p.name}`"
            />
          </label>
        </div>
        <div class="macro-param-actions">
          <button type="submit" class="confirm-button" :disabled="!enabled">
            <Play :size="13" />{{ t('Makro ausführen') }}
          </button>
          <button type="button" class="subtle-button" @click="expandedMacro = null">
            {{ t('Abbrechen') }}
          </button>
        </div>
      </form>

      <div class="single-macros-grid">
        <div
          v-for="m in sortedMacros"
          :key="m.name"
          class="macro-chip-wrap"
          :class="{ pinned: pinnedSet.has(m.name), active: expandedMacro?.name === m.name }"
        >
          <button
            type="button"
            class="subtle-button single-macro-btn"
            :class="{
              confirming: confirmMacro === m.name,
              'has-params': m.params?.length > 0,
            }"
            :disabled="!enabled"
            :title="
              !enabled
                ? t('Während Druck oder Bewegung gesperrt.')
                : m.params?.length
                  ? t('{0} ({1} Parameter öffnen)', [m.name, m.params.length])
                  : confirmMacro === m.name
                    ? t('Erneut klicken, um {0} auszuführen', [m.name])
                    : m.description || m.name
            "
            @click="handleMacroClick(m)"
            @blur="confirmMacro === m.name && resetConfirm()"
          >
            <span class="single-macro-label">{{ confirmMacro === m.name ? t('Ausführen?') : m.name }}</span>
            <SlidersHorizontal v-if="m.params?.length" :size="11" class="macro-param-icon" />
          </button>
          <button
            type="button"
            class="macro-pin-btn"
            :class="{ pinned: pinnedSet.has(m.name) }"
            :aria-pressed="pinnedSet.has(m.name)"
            :aria-label="pinnedSet.has(m.name) ? t('{0} lösen', [m.name]) : t('{0} anpinnen', [m.name])"
            :title="pinnedSet.has(m.name) ? t('Favorit entfernen') : t('Als Favorit anpinnen')"
            @click="togglePin(m.name)"
          >
            <Star :size="11" />
          </button>
        </div>
      </div>
    </div>
  </details>
</template>
