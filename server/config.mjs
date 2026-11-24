import { fileURLToPath } from 'node:url'

// Private machine settings stay outside Git. Deployment may use environment vars.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

function parseHttpOrigin(raw, label, allowHttps = false) {
  const url = new URL(raw)
  const validProtocol = url.protocol === 'http:' || (allowHttps && url.protocol === 'https:')
  if (!validProtocol || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an ${allowHttps ? 'HTTP(S)' : 'HTTP'} origin without credentials or a path.`)
  }
  return url.origin
}

export function parseAllowedOrigins(raw = '') {
  if (!raw || !String(raw).trim()) return []
  return String(raw)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => parseHttpOrigin(entry, 'ALLOWED_ORIGINS entry', true))
}

export const printerUrl = parseHttpOrigin(process.env.PRINTER_URL || 'http://127.0.0.1:1977', 'PRINTER_URL')
export const serverHost = (process.env.HOST || '127.0.0.1').trim() || '127.0.0.1'

const parsedPort = Number(process.env.PORT || 4173)
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.')
}
export const serverPort = parsedPort
export const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
