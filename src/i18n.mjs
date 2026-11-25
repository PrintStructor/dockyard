import { computed, ref } from 'vue'
import en from './locales/en.json' with { type: 'json' }

export const storageKey = 'dockyard.language'
const legacyStorageKey = 'stormtrooper.language'

export function savedLanguage(storage) {
  try {
    const raw = storage?.getItem(storageKey) ?? storage?.getItem(legacyStorageKey)
    return raw === 'en' ? 'en' : 'de'
  } catch {
    return 'de'
  }
}

const storage = () => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export const language = ref(savedLanguage(storage()))
export const locale = computed(() => (language.value === 'en' ? 'en-GB' : 'de-DE'))
let currentPrinterName = ''

export function setDocumentTitle(value = language.value, printerName = currentPrinterName) {
  currentPrinterName = typeof printerName === 'string' ? printerName.trim() : ''
  if (typeof document === 'undefined') return
  document.documentElement.lang = value
  const suffix = value === 'en' ? 'Toolchanger cockpit' : 'Toolchanger-Cockpit'
  document.title = currentPrinterName ? `DOCKYARD · ${currentPrinterName} — ${suffix}` : `DOCKYARD · ${suffix}`
}

export function setLanguage(value) {
  if (!['de', 'en'].includes(value)) return
  language.value = value
  try {
    storage()?.setItem(storageKey, value)
  } catch {
    // Language still works with blocked storage.
  }
  setDocumentTitle(value)
}

setDocumentTitle(language.value)

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The API and shared guard functions retain their original messages. Only display
// text is localized; command identifiers, parameters and raw console output are not.
// Fully qualified patterns bridge dynamic messages from that existing API.
const patterns = Object.entries(en)
  .filter(([key]) => /\{\d+\}/.test(key) && !['T{0}: {1}{2}', 'T{0}: {1}. {2}'].includes(key))
  .map(([key, value]) => ({
    regex: new RegExp(
      '^' +
        key
          .split(/(\{\d+\})/)
          .map(part => (/^\{\d+\}$/.test(part) ? '(.+?)' : escapeRegex(part)))
          .join('') +
        '$',
    ),
    slots: [...key.matchAll(/\{(\d+)\}/g)].map(match => match[1]),
    value,
    specificity: key.replace(/\{\d+\}/g, '').length,
  }))
  .sort((a, b) => b.specificity - a.specificity)

export function translate(source, lang = 'de', params, depth = 0) {
  if (typeof source !== 'string') return source
  if (params) {
    return (lang === 'en' ? (en[source] ?? source) : source).replace(/\{(\d+)\}/g, (_, id) =>
      String(translate(params[id] ?? '', lang, undefined, depth + 1)),
    )
  }
  if (lang !== 'en' || depth > 5) return source
  if (Object.hasOwn(en, source)) return en[source]
  const trimmed = source.trim()
  if (trimmed !== source && Object.hasOwn(en, trimmed)) return source.replace(trimmed, en[trimmed])
  for (const { regex, slots, value } of patterns) {
    const match = regex.exec(source)
    if (match) {
      const values = Object.fromEntries(
        slots.map((id, index) => [id, translate(match[index + 1], lang, undefined, depth + 1)]),
      )
      return value.replace(/\{(\d+)\}/g, (_, id) => values[id])
    }
  }
  for (const suffix of [' · zuletzt', ' · wechselt zu diesem Tool']) {
    if (source.endsWith(suffix)) {
      return translate(source.slice(0, -suffix.length), lang, undefined, depth + 1) + en[suffix]
    }
  }
  return source
}

export const t = (source, params) => translate(source, language.value, params)
