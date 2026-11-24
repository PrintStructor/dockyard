<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, Check } from '@lucide/vue'

const props = defineProps({
  modelValue: [String, Number],
  options: { type: Array, default: () => [] },
  ariaLabel: String,
  disabled: Boolean,
  placeholder: { type: String, default: '—' },
  size: { type: String, default: 'default' }, // 'default' | 'compact'
  align: { type: String, default: 'left' }, // 'left' | 'right'
})

const emit = defineEmits(['update:modelValue'])

const root = ref(null)
const trigger = ref(null)
const list = ref(null)
const open = ref(false)
const openUp = ref(false)
const activeIndex = ref(-1)
const instanceId = `cockpit-select-${Math.random().toString(36).slice(2, 9)}`
const listId = `${instanceId}-list`
const optionId = index => `${instanceId}-opt-${index}`

const selectedIndex = computed(() => props.options.findIndex(item => item.value === props.modelValue))
const selectedOption = computed(() => props.options[selectedIndex.value] ?? null)
const activeOptionId = computed(() => (open.value && activeIndex.value >= 0 ? optionId(activeIndex.value) : undefined))

function updateDirection() {
  if (!trigger.value || typeof window === 'undefined') return
  const rect = trigger.value.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const spaceAbove = rect.top
  openUp.value = spaceBelow < 220 && spaceAbove > spaceBelow
}

async function openMenu(initialIndex = selectedIndex.value) {
  if (props.disabled || !props.options.length) return
  updateDirection()
  open.value = true
  activeIndex.value = initialIndex >= 0 ? initialIndex : 0
  await nextTick()
  scrollActiveIntoView()
}

function closeMenu(returnFocus = false) {
  if (!open.value) return
  open.value = false
  activeIndex.value = -1
  if (returnFocus) trigger.value?.focus()
}

function toggle() {
  if (open.value) closeMenu(true)
  else openMenu()
}

function selectOption(option) {
  if (!option || option.disabled) return
  emit('update:modelValue', option.value)
  closeMenu(true)
}

function scrollActiveIntoView() {
  const el = list.value?.children?.[activeIndex.value]
  el?.scrollIntoView?.({ block: 'nearest' })
}

function moveActive(delta) {
  const len = props.options.length
  if (!len) return
  for (let step = 1; step <= len; step++) {
    const candidate = (activeIndex.value + delta * step + len * step) % len
    if (!props.options[candidate]?.disabled) {
      activeIndex.value = candidate
      nextTick(scrollActiveIntoView)
      return
    }
  }
}

function onKeydown(event) {
  if (props.disabled) return
  if (!open.value) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      openMenu(event.key === 'ArrowUp' ? Math.max(0, props.options.length - 1) : Math.max(0, selectedIndex.value))
    }
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu(true)
  } else if (event.key === 'Tab') {
    closeMenu(false)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    activeIndex.value = 0
    nextTick(scrollActiveIntoView)
  } else if (event.key === 'End') {
    event.preventDefault()
    activeIndex.value = props.options.length - 1
    nextTick(scrollActiveIntoView)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (activeIndex.value >= 0) selectOption(props.options[activeIndex.value])
  }
}

function onPointerDownOutside(event) {
  if (open.value && root.value && !root.value.contains(event.target)) {
    closeMenu(false)
  }
}

watch(
  () => props.disabled,
  disabled => {
    if (disabled) closeMenu(false)
  },
)

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDownOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDownOutside)
})
</script>

<template>
  <div
    ref="root"
    class="cockpit-select"
    :class="[size, { open, 'open-up': openUp, 'align-right': align === 'right' }]"
  >
    <button
      ref="trigger"
      type="button"
      class="cockpit-select-trigger"
      :disabled="disabled || !options.length"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="activeOptionId"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="cockpit-select-value" :lang="selectedOption?.lang">
        {{ selectedOption?.label ?? placeholder }}
      </span>
      <ChevronDown :size="14" class="cockpit-select-chevron" />
    </button>

    <ul
      v-if="open"
      :id="listId"
      ref="list"
      class="cockpit-select-menu"
      role="listbox"
      :aria-label="ariaLabel"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <li
        v-for="(option, index) in options"
        :id="optionId(index)"
        :key="option.value"
        role="option"
        class="cockpit-select-option"
        :class="{ selected: option.value === modelValue, active: index === activeIndex, disabled: option.disabled }"
        :aria-selected="option.value === modelValue"
        :aria-disabled="option.disabled || undefined"
        :lang="option.lang"
        @mouseenter="!option.disabled && (activeIndex = index)"
        @click="selectOption(option)"
      >
        <span class="cockpit-select-option-text">
          <span>{{ option.label }}</span>
          <small v-if="option.sublabel">{{ option.sublabel }}</small>
        </span>
        <Check v-if="option.value === modelValue" :size="14" class="cockpit-select-check" />
      </li>
    </ul>
  </div>
</template>
