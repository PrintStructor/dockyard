import path from 'node:path'
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

export function resolvePrinterName(env = process.env) {
  if (Object.hasOwn(env, 'PRINTER_NAME') && env.PRINTER_NAME !== undefined) {
    return String(env.PRINTER_NAME).trim()
  }
  if (Object.hasOwn(env, 'VITE_PRINTER_NAME') && env.VITE_PRINTER_NAME !== undefined) {
    return String(env.VITE_PRINTER_NAME).trim()
  }
  return 'STORMTROOPER'
}

export function resolveAllowLanOrigins(env = process.env) {
  const raw = env?.ALLOW_LAN_ORIGINS
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

export const printerUrl = parseHttpOrigin(process.env.PRINTER_URL || 'http://127.0.0.1', 'PRINTER_URL', true)
export const printerName = resolvePrinterName()
export const mainsailUrlEnv = String(process.env.MAINSAIL_URL ?? process.env.VITE_MAINSAIL_URL ?? 'auto').trim() || 'auto'
export const serverHost = (process.env.HOST || '127.0.0.1').trim() || '127.0.0.1'

const parsedPort = Number(process.env.PORT || 4173)
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.')
}
export const serverPort = parsedPort
export const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
export const allowLanOriginsEnv = resolveAllowLanOrigins()
export const settingsFilePath =
  (process.env.DOCKYARD_SETTINGS_PATH || '').trim() ||
  fileURLToPath(new URL('../.dockyard-settings.json', import.meta.url))
export const modelsDir =
  (process.env.DOCKYARD_MODELS_DIR || '').trim() ||
  path.join(path.dirname(settingsFilePath), '.dockyard-models')
