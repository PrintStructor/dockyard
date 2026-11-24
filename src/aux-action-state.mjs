export const ledProfiles = [
  { id: 'wake', label: 'Wake Up LEDs', macro: 'WAKE_UP' },
  { id: 'ready', label: 'Ready', macro: 'STATUS_READY' },
  { id: 'printing', label: 'Printing', macro: 'STATUS_PRINTING' },
  { id: 'shutdown', label: 'Shutdown LEDs', macro: 'SHUTDOWN_LEDS' },
  { id: 'off', label: 'Off', macro: 'STATUS_OFF' },
  { id: 'pause', label: 'Status Pause', macro: 'STATUS_PAUSE' },
  { id: 'heating', label: 'Status Heating', macro: 'STATUS_HEATING' },
  { id: 'cooling', label: 'Status Cooling', macro: 'STATUS_COOLING' },
  { id: 'homing', label: 'Status Homing', macro: 'STATUS_HOMING' },
  { id: 'cleaning', label: 'Status Cleaning', macro: 'STATUS_CLEANING' },
]

export function auxActionReason(status, action, online = true, pending = false) {
  if (!online || !status) return 'Keine aktuellen Druckerdaten.'
  if (status.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (pending || status.control?.job) return 'Ein Befehl läuft noch oder muss geprüft werden.'

  if (action === 'watch_stop') {
    if (!status.capabilities?.loadWatch) return 'Einlegehilfe ist nicht konfiguriert.'
    return !status.loadWatchActive ? 'Einlegehilfe ist nicht scharf.' : ''
  }

  if (action === 'watch_start') {
    if (!status.capabilities?.loadWatch) return 'Einlegehilfe ist nicht konfiguriert.'
    if (status.loadWatchActive) return 'Einlegehilfe ist bereits scharf.'
    if (!['standby', 'complete', 'cancelled', 'error'].includes(status.printState) || status.idleState === 'Printing') {
      return 'Einlegehilfe nur bei ruhendem Drucker scharf schalten.'
    }
    if (
      status.toolchangerState !== 'ready' ||
      !status.hasDetection ||
      status.detectionMismatch ||
      status.detectionConflict
    ) {
      return 'Toolchanger und Werkzeugerkennung prüfen.'
    }
    if (![...'xyz'].every(axis => status.homedAxes?.includes(axis)) && !status.capabilities?.watchAutoHome) {
      return 'Zuerst alle Achsen homen.'
    }
    if (
      status.tools?.length !== 6 ||
      status.tools.some(tool => tool.filamentEnabled !== true || tool.filamentDetected == null)
    ) {
      return 'Alle sechs Filamentsensoren müssen aktiviert und verfügbar sein.'
    }
    const temperature = status.capabilities?.filamentDefaults?.load
    const outsideLimits =
      !Number.isFinite(temperature) ||
      status.tools.some(tool => {
        const min = status.capabilities?.extrusionMin?.[tool.id]
        const max = status.capabilities?.toolMax?.[tool.id]
        return !Number.isFinite(min) || !Number.isFinite(max) || temperature < min || temperature > max
      })
    if (outsideLimits) {
      return 'Die Makro-Standardtemperatur fehlt oder liegt außerhalb der Extrusionsgrenzen.'
    }
    return ''
  }

  if (action === 'led') return ''

  if (action === 'pause') {
    if (!status.capabilities?.pause) return 'PAUSE ist nicht konfiguriert.'
    return status.printState !== 'printing' ? 'Kein laufender Druck.' : ''
  }

  if (action === 'resume') {
    if (status.loadWatchActive) return 'Einlegehilfe zuerst mit Fertig beenden.'
    if (!status.capabilities?.resume) return 'RESUME ist nicht konfiguriert.'
    if (status.printState !== 'paused') return 'Kein pausierter Druck.'
    if (
      status.toolchangerState !== 'ready' ||
      status.detectionMismatch ||
      status.detectionConflict ||
      status.detected == null
    ) {
      return 'Toolchanger und Werkzeugerkennung vor dem Fortsetzen prüfen.'
    }
    if (![...'xyz'].every(axis => status.homedAxes?.includes(axis))) {
      return 'Achsen nicht referenziert. Druck am Gerät prüfen.'
    }
    return ''
  }

  if (action === 'initialize') {
    if (!status.capabilities?.initialize) return 'Toolchanger ist nicht konfiguriert.'
    if (!['standby', 'complete', 'cancelled', 'error'].includes(status.printState) || status.idleState === 'Printing') {
      return 'Initialisieren während Druck, Pause oder laufender Befehle gesperrt.'
    }
    if (!['ready', 'uninitialized'].includes(status.toolchangerState)) {
      return 'Toolchangerfehler zuerst am Gerät prüfen.'
    }
    if (!status.hasDetection || status.detectionConflict) return 'Eindeutige Werkzeugerkennung erforderlich.'
    if (status.loadWatchActive) return 'Einlegehilfe zuerst mit Fertig beenden.'
    return ''
  }

  return 'Unbekannte Aktion.'
}

export function quickMotionReason(status, action, online = true, pending = false) {
  if (!online || !status) return 'Keine aktuellen Druckerdaten.'
  if (status.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (pending || status.control?.job) return 'Ein Befehl läuft noch oder muss geprüft werden.'
  if (status.loadWatchActive) return 'Einlegehilfe ist scharf. Zuerst mit „Fertig“ beenden.'
  if (!['standby', 'complete', 'cancelled', 'error'].includes(status.printState) || status.idleState === 'Printing') {
    return 'Während eines Drucks, einer Pause oder laufender Befehle gesperrt.'
  }
  if (status.detectionConflict) return 'Werkzeugerkennung prüfen.'

  if (action === 'home') {
    if (status.detectionMismatch && !status.homingCanInitialize) return 'Werkzeugerkennung prüfen.'
    return ''
  }

  if (action === 'qgl') {
    if (status.detectionMismatch) return 'Werkzeugerkennung prüfen.'
    if (!status.capabilities?.qgl) return 'QGL ist nicht konfiguriert.'
    if (![...'xyz'].every(axis => status.homedAxes?.includes(axis))) return 'Zuerst alle Achsen homen.'
    return ''
  }

  return 'Unbekannte Aktion.'
}
