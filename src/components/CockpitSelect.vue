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

const selectedIndex = computed(() => props.options.findIndex(item => item.value === props.modelValue))
const selectedOption = computed(() => props.options[selectedIndex.value] ?? null)

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
  if (!props.options.length) return
  const next = (activeIndex.value + delta + props.options.length) % props.options.length
  activeIndex.value = next
  nextTick(scrollActiveIntoView)
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
      ref="list"
      class="cockpit-select-menu"
      role="listbox"
      :aria-label="ariaLabel"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <li
        v-for="(option, index) in options"
        :key="option.value"
        role="option"
        class="cockpit-select-option"
        :class="{ selected: option.value === modelValue, active: index === activeIndex }"
        :aria-selected="option.value === modelValue"
        :lang="option.lang"
        @mouseenter="activeIndex = index"
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
