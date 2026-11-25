function isLoopbackHost(hostname) {
  const lower = String(hostname ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1'
}

export function resolveMainsailUrl(configuredUrl, loc = globalThis.location, printerUrl = '') {
  const raw = typeof configuredUrl === 'string' ? configuredUrl.trim() : ''
  if (raw && raw.toLowerCase() !== 'auto') return raw
  const remoteRaw = typeof printerUrl === 'string' ? printerUrl.trim() : ''
  if (remoteRaw) {
    try {
      const parsed = new URL(remoteRaw)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname && !isLoopbackHost(parsed.hostname)) {
        const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[') ? `[${parsed.hostname}]` : parsed.hostname
        return `${parsed.protocol}//${host}/`
      }
    } catch {
      // Fall back to current location host when printerUrl is malformed.
    }
  }
  const hostname = typeof loc?.hostname === 'string' ? loc.hostname.trim() : ''
  if (hostname) {
    const protocol = loc.protocol === 'https:' ? 'https:' : 'http:'
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
    return `${protocol}//${host}/`
  }
  return 'http://127.0.0.1/'
}
