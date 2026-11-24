export function resolveMainsailUrl(configuredUrl, loc = globalThis.location) {
  const raw = typeof configuredUrl === 'string' ? configuredUrl.trim() : ''
  if (raw && raw.toLowerCase() !== 'auto') return raw
  const hostname = typeof loc?.hostname === 'string' ? loc.hostname.trim() : ''
  if (hostname) {
    const protocol = loc.protocol === 'https:' ? 'https:' : 'http:'
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
    return `${protocol}//${host}/`
  }
  return 'http://127.0.0.1/'
}
