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
  if (![...'xyz'].every(axis => status.homedAxes?.includes(axis))) return 'Zuerst alle Achsen homen.'
  if (!status.hasDetection || status.detectionMismatch || status.detectionConflict) return 'Werkzeugerkennung prüfen.'
  if (status.toolchangerState !== 'ready') return 'Toolchanger ist nicht bereit.'
  if (!status.capabilities?.toolActions?.[action]) return 'Das benötigte Makro ist nicht vollständig konfiguriert.'

  const bulk = action.endsWith('_all')
  if (!bulk && (!Number.isInteger(tool) || tool < 0 || tool > 5)) return 'Ungültiges Werkzeug.'
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
