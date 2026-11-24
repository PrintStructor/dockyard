import { ControlError } from './control.mjs'

export const MAX_CONFIG_BYTES = 524288
export const LOG_TAIL_BYTES = 131072
export const LOG_TAIL_MAX_LINES = 400
export const ALLOWED_SYSTEMD_SERVICES = [
  'klipper',
  'moonraker',
  'crowsnest',
  'sonar',
  'mobileraker',
  'helixscreen',
  'klipper-mcu',
]

const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|svg|zip|gz|tar|xz|bz2|7z|bin|elf|uf2|hex|stdata|pdf|woff2?|ttf|otf|mp4|mkv)$/i
const WRITABLE_EXT_RE = /\.(cfg|conf|md|txt|json)$/i
const SCRIPT_EXT_RE = /\.(sh|py)$/i
const BACKUP_DIR_RE = /^(backup|backups|ShakeTune_results)\//i
const BACKUP_NAME_RE = /(\.bak([._-].*)?|\.bkp|\.backup([._-].*)?|-old|\.full-[0-9_-]+|\.ring-[0-9_-]+|\.\d{4}-\d{2}-\d{2}[-_]\d{4})$/i
const PRIMARY_LOGS = ['klippy.log', 'moonraker.log', 'crowsnest.log', 'mobileraker.log']

const SERVICE_LABELS = {
  klipper: 'Klipper-Dienst neu starten',
  moonraker: 'Moonraker neu starten',
  crowsnest: 'Crowsnest neu starten',
  sonar: 'Sonar neu starten',
  mobileraker: 'Mobileraker neu starten',
  helixscreen: 'HelixScreen neu starten',
  'klipper-mcu': 'Klipper-MCU-Dienst neu starten',
}

function hasPathTraversalOrControl(raw) {
  if (typeof raw !== 'string') return true
  const trimmed = raw.trim()
  if (!trimmed || trimmed !== raw) return true
  if (trimmed.length > 300) return true
  if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return true
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return true
  if (/%2e|%2f|%5c|%00/i.test(trimmed)) return true
  const segments = trimmed.split('/')
  if (segments.some(seg => !seg || seg === '.' || seg === '..')) return true
  return false
}

export function encodeMoonrakerPath(relPath) {
  return String(relPath)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

export function validateConfigPath(rawPath) {
  if (hasPathTraversalOrControl(rawPath)) return null
  if (rawPath === '.theme' || rawPath.startsWith('.theme/')) return null
  const name = rawPath.split('/').pop()
  if (BINARY_EXT_RE.test(name)) return null
  return rawPath
}

export function isBackupConfigPath(relPath) {
  if (BACKUP_DIR_RE.test(relPath)) return true
  const name = relPath.split('/').pop()
  if (name.startsWith('.') && name.endsWith('.bkp')) return true
  return BACKUP_NAME_RE.test(name)
}

export function isScriptConfigPath(relPath) {
  const name = relPath.split('/').pop()
  return SCRIPT_EXT_RE.test(name)
}

export function classifyConfigFile(entry) {
  const path = validateConfigPath(entry?.path)
  if (!path) return null
  const idx = path.lastIndexOf('/')
  const dir = idx === -1 ? '' : path.slice(0, idx)
  const name = idx === -1 ? path : path.slice(idx + 1)
  const permissions = typeof entry.permissions === 'string' ? entry.permissions : 'r'
  const isBackup = isBackupConfigPath(path)
  const isScript = isScriptConfigPath(path)
  const isWritableExt = WRITABLE_EXT_RE.test(name)
  const readonly = permissions !== 'rw' || isBackup || isScript || !isWritableExt

  return {
    path,
    name,
    dir,
    size: Number.isFinite(entry.size) ? entry.size : null,
    modified: Number.isFinite(entry.modified) ? entry.modified : null,
    permissions,
    isBackup,
    isScript,
    readonly,
  }
}

export function normalizeConfigList(entries) {
  if (!Array.isArray(entries)) return []
  return entries
    .map(classifyConfigFile)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.dir !== b.dir) {
        if (!a.dir) return -1
        if (!b.dir) return 1
        return a.dir.localeCompare(b.dir, undefined, { sensitivity: 'base' })
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
}

export function validateWritableConfigPath(rawPath, entry) {
  const validPath = validateConfigPath(rawPath)
  if (!validPath) throw new ControlError('Ungültiger Konfigurationspfad.', 400)
  if (!entry || entry.path !== validPath) {
    throw new ControlError('Konfigurationsdatei nicht gefunden.', 404)
  }
  const classified = classifyConfigFile(entry)
  if (!classified || classified.readonly) {
    if (classified?.isScript) {
      throw new ControlError('Skriptdateien sind aus Sicherheitsgründen schreibgeschützt.', 403)
    }
    if (classified?.isBackup) {
      throw new ControlError('Backup-Dateien sind schreibgeschützt.', 403)
    }
    throw new ControlError('Diese Datei ist schreibgeschützt.', 403)
  }
  return { path: classified.path, dir: classified.dir, name: classified.name }
}

export function validateConfigContent(content) {
  if (typeof content !== 'string') {
    throw new ControlError('Dateiinhalt muss Text sein.', 400)
  }
  if (content.includes('\0')) {
    throw new ControlError('Binärdaten können nicht gespeichert werden.', 400)
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ControlError('Konfigurationsdatei überschreitet das Limit von 512 KB.', 413)
  }
  return content
}

export function checkExpectedModified({ expectedModified, currentModified, force = false }) {
  if (force) return
  if (!Number.isFinite(expectedModified) || !Number.isFinite(currentModified)) return
  if (Math.abs(currentModified - expectedModified) > 0.001) {
    const err = new ControlError(
      'Die Datei wurde inzwischen auf dem Drucker geändert (z. B. durch SAVE_CONFIG).',
      409,
    )
    err.code = 'FILE_CHANGED'
    err.currentModified = currentModified
    throw err
  }
}

export function resolveRestartTargetForFile(relPath) {
  const valid = validateConfigPath(relPath)
  if (!valid || isBackupConfigPath(valid) || isScriptConfigPath(valid)) return 'none'
  const lower = valid.split('/').pop().toLowerCase()
  if (lower === 'moonraker.conf') return 'moonraker'
  if (lower === 'crowsnest.conf') return 'crowsnest'
  if (/\.(cfg|conf)$/i.test(lower)) return 'klipper_restart'
  return 'none'
}

export function buildConfigUploadFormData(relPath, content) {
  const valid = validateConfigPath(relPath)
  if (!valid) throw new ControlError('Ungültiger Konfigurationspfad.', 400)
  const idx = valid.lastIndexOf('/')
  const dir = idx === -1 ? '' : valid.slice(0, idx)
  const name = idx === -1 ? valid : valid.slice(idx + 1)
  const form = new FormData()
  form.append('root', 'config')
  if (dir) form.append('path', dir)
  form.append('file', new Blob([content], { type: 'text/plain; charset=utf-8' }), name)
  return form
}

export function validateRestartTarget(target, availableServices = []) {
  if (typeof target !== 'string' || !target.trim()) {
    throw new ControlError('Ungültiges Neustart-Ziel.', 400)
  }
  if (target === 'klipper_restart') {
    return { kind: 'klipper', label: 'Klipper neu starten' }
  }
  if (target === 'firmware_restart') {
    return { kind: 'firmware', label: 'Firmware neu starten' }
  }
  if (!ALLOWED_SYSTEMD_SERVICES.includes(target)) {
    throw new ControlError('Dieser Dienst darf nicht über das Cockpit neu gestartet werden.', 400)
  }
  if (!Array.isArray(availableServices) || !availableServices.includes(target)) {
    throw new ControlError('Dieser Dienst ist auf dem Drucker nicht verfügbar.', 409)
  }
  return {
    kind: 'service',
    service: target,
    label: SERVICE_LABELS[target] ?? `${target} neu starten`,
  }
}

export function evaluateMachineWriteGuard({
  queryData = null,
  queryStatus = 200,
  serverInfo = null,
  job = null,
  allowUncertainRecovery = false,
} = {}) {
  if (job && !job.uncertain) {
    throw new ControlError('Ein anderer Befehl läuft noch.', 409)
  }

  const hasValidQuery = queryStatus === 200 && queryData && typeof queryData === 'object'
  const webhooksState = hasValidQuery ? queryData.webhooks?.state : null
  const printState = hasValidQuery ? queryData.print_stats?.state : null
  const idleState = hasValidQuery ? queryData.idle_timeout?.state : null

  const queryRecovery = hasValidQuery && ['error', 'shutdown', 'startup'].includes(webhooksState)
  const queryUnavailable = !hasValidQuery || !printState

  if (queryUnavailable || queryRecovery) {
    if (queryRecovery) {
      if (job?.uncertain && !allowUncertainRecovery) {
        throw new ControlError('Ergebnis des letzten Befehls ist ungeklärt.', 409)
      }
      return { klipperState: webhooksState, mode: 'recovery' }
    }
    if (serverInfo && typeof serverInfo === 'object') {
      const klippyConnected = serverInfo.klippy_connected
      const klippyState = serverInfo.klippy_state ?? (klippyConnected === false ? 'disconnected' : 'unknown')
      if (klippyConnected === false || ['disconnected', 'error', 'shutdown', 'startup'].includes(klippyState)) {
        if (job?.uncertain && !allowUncertainRecovery) {
          throw new ControlError('Ergebnis des letzten Befehls ist ungeklärt.', 409)
        }
        return { klipperState: klippyState, mode: 'recovery' }
      }
    }
    throw new ControlError('Druckerstatus konnte nicht sicher geprüft werden.', 503)
  }

  if (printState === 'printing' || printState === 'paused') {
    throw new ControlError('Während eines aktiven oder pausierten Drucks gesperrt.', 409)
  }
  if (idleState === 'Printing') {
    throw new ControlError('Drucker führt gerade einen Befehl aus.', 409)
  }
  if (job?.uncertain) {
    throw new ControlError('Ergebnis des letzten Befehls ist ungeklärt. Bitte zuerst Bediensperre prüfen.', 409)
  }

  return { klipperState: webhooksState ?? 'ready', mode: 'ready' }
}

export function normalizeSystemOverview({ procStats = null, systemInfo = null, serverInfo = null } = {}) {
  const cpuInfo = systemInfo?.cpu_info ?? {}
  const dist = systemInfo?.distribution ?? {}
  const release = dist.release_info ?? {}
  const mem = procStats?.system_memory ?? {}
  const totalBytes = Number.isFinite(mem.total) ? mem.total * 1024 : null
  const usedBytes = Number.isFinite(mem.used) ? mem.used * 1024 : null
  const availableBytes = Number.isFinite(mem.available) ? mem.available * 1024 : null
  const usedPercent =
    totalBytes && usedBytes != null ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null

  const availableServices = Array.isArray(systemInfo?.available_services) ? systemInfo.available_services : []
  const serviceState = systemInfo?.service_state ?? {}
  const services = ALLOWED_SYSTEMD_SERVICES.filter(name => availableServices.includes(name)).map(name => {
    const state = serviceState[name] ?? {}
    return {
      name,
      active: state.active_state === 'active',
      activeState: state.active_state ?? 'unknown',
      subState: state.sub_state ?? null,
    }
  })

  const osLabel = release.name
    ? `${release.name}${release.version_id ? ` ${release.version_id}` : ''}`
    : (dist.name ?? null)

  return {
    cpuUsage: Number.isFinite(procStats?.system_cpu_usage?.cpu) ? procStats.system_cpu_usage.cpu : null,
    cpuCores: Number.isFinite(cpuInfo.cpu_count) ? cpuInfo.cpu_count : null,
    cpuTemp: Number.isFinite(procStats?.cpu_temp) ? procStats.cpu_temp : null,
    uptimeSeconds: Number.isFinite(procStats?.system_uptime) ? procStats.system_uptime : null,
    memory: {
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent,
    },
    throttledFlags: Array.isArray(procStats?.throttled_state?.flags)
      ? procStats.throttled_state.flags.filter(flag => typeof flag === 'string' && flag.trim())
      : [],
    host: {
      model: typeof cpuInfo.model === 'string' && cpuInfo.model ? cpuInfo.model : null,
      bits: typeof cpuInfo.bits === 'string' && cpuInfo.bits ? cpuInfo.bits : null,
      os: osLabel,
      kernel: typeof dist.kernel_version === 'string' && dist.kernel_version ? dist.kernel_version : null,
    },
    klippy: {
      connected: typeof serverInfo?.klippy_connected === 'boolean' ? serverInfo.klippy_connected : null,
      state: typeof serverInfo?.klippy_state === 'string' ? serverInfo.klippy_state : null,
    },
    services,
  }
}

const UPDATE_STATUS_ORDER = { dirty: 0, invalid: 1, outdated: 2, up_to_date: 3 }

export function normalizeUpdateStatus(raw = {}) {
  const versionInfo = raw?.version_info && typeof raw.version_info === 'object' ? raw.version_info : {}
  const items = Object.entries(versionInfo).map(([key, info]) => {
    const entry = info && typeof info === 'object' ? info : {}
    const type = entry.configured_type ?? 'unknown'
    const isDirty = entry.is_dirty === true
    const corrupt = entry.corrupt === true
    const isValid = entry.is_valid !== false
    const packageCount = Number.isFinite(entry.package_count) ? entry.package_count : 0
    const version = typeof entry.version === 'string' ? entry.version : null
    const remoteVersion = typeof entry.remote_version === 'string' ? entry.remote_version : null
    const hasVersionDiff =
      type === 'system'
        ? packageCount > 0
        : Boolean(version && remoteVersion && version !== '?' && remoteVersion !== '?' && version !== remoteVersion)

    let status = 'up_to_date'
    if (isDirty) status = 'dirty'
    else if (corrupt || !isValid) status = 'invalid'
    else if (hasVersionDiff) status = 'outdated'

    return {
      name: entry.name || key,
      type,
      branch: typeof entry.branch === 'string' ? entry.branch : null,
      version,
      remoteVersion,
      packageCount,
      isDirty,
      isValid,
      corrupt,
      status,
      warnings: Array.isArray(entry.warnings) ? entry.warnings.filter(Boolean) : [],
      anomalies: Array.isArray(entry.anomalies) ? entry.anomalies.filter(Boolean) : [],
    }
  })

  items.sort((a, b) => {
    const orderDiff = (UPDATE_STATUS_ORDER[a.status] ?? 9) - (UPDATE_STATUS_ORDER[b.status] ?? 9)
    if (orderDiff !== 0) return orderDiff
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  const summary = {
    total: items.length,
    outdated: items.filter(i => i.status === 'outdated').length,
    dirty: items.filter(i => i.status === 'dirty').length,
    invalid: items.filter(i => i.status === 'invalid').length,
  }

  return {
    busy: raw?.busy === true,
    summary,
    items,
  }
}

export function validateLogPath(rawPath) {
  if (hasPathTraversalOrControl(rawPath)) return null
  if (rawPath.includes('/')) return null
  if (!/^[A-Za-z0-9._-]+$/.test(rawPath)) return null
  return rawPath
}

export function normalizeLogList(entries) {
  if (!Array.isArray(entries)) return []
  return entries
    .map(entry => {
      const path = validateLogPath(entry?.path)
      if (!path) return null
      const primaryIndex = PRIMARY_LOGS.indexOf(path)
      return {
        path,
        name: path,
        size: Number.isFinite(entry.size) ? entry.size : 0,
        modified: Number.isFinite(entry.modified) ? entry.modified : null,
        primary: primaryIndex !== -1,
        _primaryIndex: primaryIndex,
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.primary && b.primary) return a._primaryIndex - b._primaryIndex
      if (a.primary) return -1
      if (b.primary) return 1
      return (b.modified ?? 0) - (a.modified ?? 0)
    })
    .map(({ _primaryIndex, ...rest }) => rest)
}

export function parseLogTail({
  text = '',
  totalBytes = 0,
  fetchedBytes = 0,
  statusCode = 200,
  maxLines = LOG_TAIL_MAX_LINES,
} = {}) {
  if (statusCode === 416 || totalBytes === 0 || !text) {
    return {
      lines: [],
      lineCount: 0,
      truncated: false,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
      fetchedBytes: Number.isFinite(fetchedBytes) ? fetchedBytes : 0,
      empty: true,
    }
  }

  let normalized = text.replace(/\r\n/g, '\n')
  if (normalized.endsWith('\n')) normalized = normalized.slice(0, -1)
  let lines = normalized.length ? normalized.split('\n') : []

  const byteTruncated = statusCode === 206 && totalBytes > fetchedBytes
  if (byteTruncated && lines.length > 1) {
    // Drop the leading line fragment that likely started mid-line / mid-UTF-8 sequence.
    lines = lines.slice(1)
  }

  let lineTruncated = false
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines)
    lineTruncated = true
  }

  return {
    lines,
    lineCount: lines.length,
    truncated: byteTruncated || lineTruncated,
    totalBytes: Number.isFinite(totalBytes) ? totalBytes : fetchedBytes,
    fetchedBytes: Number.isFinite(fetchedBytes) ? fetchedBytes : Buffer.byteLength(text, 'utf8'),
    empty: lines.length === 0,
  }
}
