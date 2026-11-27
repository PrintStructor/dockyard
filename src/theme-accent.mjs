import { DEFAULT_ACCENT_COLOR, normalizeAccentColor } from './model-config.mjs'

const SURFACE_RGB = [25, 33, 37] // #192125 (--surface)
const LINE_BASE_RGB = [38, 49, 55] // #263137 (--line-subtle)
const MIN_CONTRAST_ON_SURFACE = 5.2

function hexToRgb(hex) {
  const clean = normalizeAccentColor(hex, DEFAULT_ACCENT_COLOR).slice(1)
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ]
}

function rgbToHex([r, g, b]) {
  return (
    '#' +
    [r, g, b]
      .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  )
}

function relativeLuminance([r, g, b]) {
  const lin = c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(rgbA, rgbB) {
  const lA = relativeLuminance(rgbA)
  const lB = relativeLuminance(rgbB)
  const bright = Math.max(lA, lB)
  const dark = Math.min(lA, lB)
  return (bright + 0.05) / (dark + 0.05)
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

function hslToRgb([h, s, l]) {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const hue2rgb = (p, q, t) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

function mixRgb(a, b, weightA) {
  const w = Math.max(0, Math.min(1, weightA))
  return [
    a[0] * w + b[0] * (1 - w),
    a[1] * w + b[1] * (1 - w),
    a[2] * w + b[2] * (1 - w),
  ]
}

/**
 * Derives WCAG-AA-safe dark-cockpit UI accent CSS variables from any printer hex color.
 * Keeps semantic warning (amber), danger (red) and status-ok (green) tokens independent.
 */
export function computePrinterTheme(rawHex) {
  const raw = normalizeAccentColor(rawHex, DEFAULT_ACCENT_COLOR)
  const rawRgb = hexToRgb(raw)

  // Preserve the exact signature Acid-Lime palette when using the default accent.
  if (raw === DEFAULT_ACCENT_COLOR) {
    return {
      raw,
      accent: '#c5f76b',
      accentHover: '#d6ff8b',
      accentTint: '#283522',
      accentLine: '#627c43',
      accentContrast: '#111618',
    }
  }

  let [h, s, l] = rgbToHsl(rawRgb)
  let fgRgb = rawRgb
  // Lift dark/saturated accents (e.g. VORON Red #d62828, Cobalt #3b82f6, Graphite #495860)
  // until they exceed 5.2:1 contrast on #192125 dark cards.
  while (contrastRatio(fgRgb, SURFACE_RGB) < MIN_CONTRAST_ON_SURFACE && l < 0.94) {
    l = Math.min(0.94, l + 0.02)
    fgRgb = hslToRgb([h, Math.min(s, l > 0.78 ? 0.85 : s), l])
  }

  const hoverRgb = hslToRgb([h, s, Math.min(0.95, l + 0.06)])
  const tintRgb = mixRgb(fgRgb, SURFACE_RGB, 0.16)
  const lineRgb = mixRgb(fgRgb, LINE_BASE_RGB, 0.48)
  const darkText = [17, 22, 24] // #111618
  const lightText = [248, 250, 252] // #f8fafc
  const accentContrast =
    contrastRatio(fgRgb, darkText) >= contrastRatio(fgRgb, lightText) ? '#111618' : '#f8fafc'

  return {
    raw,
    accent: rgbToHex(fgRgb),
    accentHover: rgbToHex(hoverRgb),
    accentTint: rgbToHex(tintRgb),
    accentLine: rgbToHex(lineRgb),
    accentContrast,
  }
}

export function themeStyleVars(rawHex) {
  const theme = computePrinterTheme(rawHex)
  return {
    '--accent': theme.accent,
    '--accent-hover': theme.accentHover,
    '--accent-tint': theme.accentTint,
    '--accent-line': theme.accentLine,
    '--accent-contrast': theme.accentContrast,
    '--accent-raw': theme.raw,
  }
}
