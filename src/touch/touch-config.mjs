export const DEFAULT_SLEEP_SECONDS = 300

function parseBoolParam(raw) {
  if (raw == null) return null
  const val = String(raw).trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(val)) return true
  if (['0', 'false', 'off', 'no'].includes(val)) return false
  return null
}

export function isTouchAppMode(search = '') {
  const params = new URLSearchParams(search || '')
  return (
    parseBoolParam(params.get('touch')) === true ||
    parseBoolParam(params.get('screen')) === true ||
    parseBoolParam(params.get('hmi')) === true
  )
}

export function resolveTouchConfig(search = '') {
  const params = new URLSearchParams(search || '')
  const touch = isTouchAppMode(search)
  const rawPrinter = String(params.get('printer') ?? '').trim().toLowerCase()
  const printerId = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(rawPrinter) ? rawPrinter : ''
  const locked = parseBoolParam(params.get('lock')) === true
  const hideCursor = parseBoolParam(params.get('cursor')) === false
  const rawSleep = params.get('sleep')
  let sleepSeconds = DEFAULT_SLEEP_SECONDS
  if (rawSleep !== null && rawSleep !== '') {
    const parsed = Number(rawSleep)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 86_400) {
      sleepSeconds = Math.round(parsed)
    }
  }
  const rawLang = String(params.get('lang') ?? '').trim().toLowerCase()
  const lang = rawLang === 'de' || rawLang === 'en' ? rawLang : ''

  return {
    touch,
    printerId,
    locked,
    hideCursor,
    sleepSeconds,
    lang,
  }
}

export function withPrinterParam(url, printerId = '') {
  const pid = String(printerId ?? '').trim()
  if (!pid) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}printer=${encodeURIComponent(pid)}`
}

export function buildTouchKioskUrl({ origin = '', printerId = '', locked = false, hideCursor = false, sleepSeconds = null } = {}) {
  const params = new URLSearchParams()
  params.set('touch', '1')
  if (printerId) params.set('printer', printerId)
  if (locked) params.set('lock', '1')
  if (hideCursor) params.set('cursor', '0')
  if (Number.isInteger(sleepSeconds) && sleepSeconds >= 0 && sleepSeconds !== DEFAULT_SLEEP_SECONDS) {
    params.set('sleep', String(sleepSeconds))
  }
  const base = origin ? origin.replace(/\/+$/, '') : ''
  return `${base}/?${params.toString()}`
}

export function buildDesktopExitUrl(href = '/') {
  try {
    const url = new URL(href, 'http://localhost')
    for (const key of ['touch', 'screen', 'hmi', 'printer', 'lock', 'cursor', 'sleep']) {
      url.searchParams.delete(key)
    }
    const qs = url.searchParams.toString()
    return `${url.pathname}${qs ? `?${qs}` : ''}`
  } catch {
    return '/'
  }
}
