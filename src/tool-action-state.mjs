export function mountedToolId(status) {
  if (!status) return undefined
  const maxTool = Math.max(0, (status.toolCount ?? 6) - 1)
  if (Number.isInteger(status.active) && status.active >= 0 && status.active <= maxTool) return status.active
  if (
    status.active == null &&
    !status.detectionConflict &&
    Number.isInteger(status.detected) &&
    status.detected >= 0 &&
    status.detected <= maxTool
  ) {
    return status.detected
  }
  return null
}

export const filamentToolIds = status =>
  (status?.tools ?? [])
    .filter(tool => tool.filamentEnabled === true && tool.filamentDetected === true)
    .map(tool => tool.id)

export const defaultActionTemperature = (status, action) =>
  status?.capabilities?.filamentDefaults?.[action.startsWith('unload') ? 'unload' : 'load'] ?? null

export function toolActionReason(status, action, tool, online = true, pending = false) {
  if (!online || !status) return 'Keine aktuellen Druckerdaten.'
  if (status.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (pending || status.control?.job) return 'Ein Befehl läuft noch oder muss geprüft werden.'
  if (!['standby', 'complete', 'cancelled', 'error'].includes(status.printState) || status.idleState === 'Printing') {
    return 'Während eines Drucks, einer Pause oder laufender Befehle gesperrt.'
  }
  if (status.loadWatchActive) return 'Einlegehilfe ist scharf. Zuerst mit „Fertig“ beenden.'

  const isToolchanger = status.isToolchanger ?? status.capabilities?.isToolchanger ?? true
  const maxTool = Math.max(0, (status.toolCount ?? status.capabilities?.toolCount ?? 6) - 1)

  if (!isToolchanger) {
    if (!['load', 'unload', 'clean', 'purge'].includes(action)) {
      return 'Nur für Toolchanger verfügbar.'
    }
    if (!status.capabilities?.toolActions?.[action]) {
      return 'Das benötigte Makro ist nicht vollständig konfiguriert.'
    }
    if (!Number.isInteger(tool) || tool < 0 || tool > maxTool) return 'Ungültiges Werkzeug.'
    if (
      (action === 'clean' || action === 'purge') &&
      ![...'xyz'].every(axis => status.homedAxes?.includes(axis))
    ) {
      return 'Zuerst alle Achsen homen.'
    }
    return ''
  }

  if (![...'xyz'].every(axis => status.homedAxes?.includes(axis))) return 'Zuerst alle Achsen homen.'
  if (!status.hasDetection || status.detectionMismatch || status.detectionConflict) return 'Werkzeugerkennung prüfen.'
  if (status.toolchangerState !== 'ready') return 'Toolchanger ist nicht bereit.'
  if (!status.capabilities?.toolActions?.[action]) return 'Das benötigte Makro ist nicht vollständig konfiguriert.'

  const bulk = action.endsWith('_all')
  if (!bulk && (!Number.isInteger(tool) || tool < 0 || tool > maxTool)) return 'Ungültiges Werkzeug.'
  if (action === 'park' && status.active !== tool) return 'Nur das aufgenommene Werkzeug kann geparkt werden.'
  if (action === 'pickup' && (status.active != null || status.detected != null)) {
    return 'Zuerst das aufgenommene Werkzeug parken.'
  }
  if (action === 'select') {
    if (status.active === tool) return 'Werkzeug ist bereits aufgenommen.'
    if (status.active == null || status.detected == null) {
      return 'Kein Werkzeug aufgenommen. Pickup verwenden.'
    }
  }
  if (
    (action === 'park' || action === 'pickup' || action === 'select' || status.active == null) &&
    (!Number.isFinite(status.position?.[2]) || status.position[2] > 300)
  ) {
    return 'Für Parken/Pickup/Wechsel muss die aktuelle Z-Position höchstens 300 mm sein.'
  }

  const ids = bulk ? filamentToolIds(status) : [tool]
  if (!ids.length) return 'Kein aktivierter Sensor meldet Filament am Eingang.'
  if (action !== 'park' && ids.some(id => !status.capabilities?.toolSelect?.[id])) {
    return 'Werkzeug oder Auswahlmakro fehlt.'
  }
  if (action !== 'park' && status.active == null && !status.capabilities?.toolActions?.pickup) {
    return 'Das Pickup-Makro fehlt.'
  }

  if (['load', 'unload', 'purge', 'load_all', 'unload_all'].includes(action)) {
    if (!bulk && !filamentToolIds(status).includes(tool)) {
      return 'Filament am Eingang einführen; der aktivierte Sensor muss es erkennen.'
    }
    const temperature = defaultActionTemperature(status, action)
    const outsideLimits =
      !Number.isFinite(temperature) ||
      ids.some(id => {
        const min = status.capabilities?.extrusionMin?.[id]
        const max = status.capabilities?.toolMax?.[id]
        return !Number.isFinite(min) || !Number.isFinite(max) || temperature < min || temperature > max
      })
    if (outsideLimits) {
      return 'Die Makro-Standardtemperatur fehlt oder liegt außerhalb der Extrusionsgrenzen.'
    }
  }

  return ''
}

const MAINTENANCE_LABELS = [
  ['load', 'Laden'],
  ['unload', 'Entladen'],
  ['clean', 'Clean'],
  ['purge', 'Purge'],
]

export function maintenanceRestriction(status, tool, online = true, pending = false) {
  const blocked = MAINTENANCE_LABELS.map(([id, label]) => ({
    id,
    label,
    reason: toolActionReason(status, id, tool, online, pending),
  })).filter(item => item.reason)

  if (!blocked.length) return null

  const firstReason = blocked[0].reason
  if (blocked.length === MAINTENANCE_LABELS.length && blocked.every(item => item.reason === firstReason)) {
    return {
      actions: [],
      reason:
        firstReason === 'Zuerst alle Achsen homen.'
          ? 'Für die einzelnen Werkzeugaktionen zuerst alle Achsen homen.'
          : firstReason,
    }
  }

  const sameReasonActions = blocked.filter(item => item.reason === firstReason).map(item => item.label)
  return {
    actions: sameReasonActions,
    reason: firstReason,
  }
}
