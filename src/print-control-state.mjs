export const Z_BABYSTEP_STEPS = [0.005, 0.01, 0.025, 0.05, 0.1]
export const Z_BABYSTEP_DELTAS = [-0.1, -0.05, -0.025, -0.01, -0.005, 0.005, 0.01, 0.025, 0.05, 0.1]
export const SPEED_MIN = 10
export const SPEED_MAX = 300
export const FLOW_MIN = 50
export const FLOW_MAX = 200

export function printControlReason(status, action, online = true, pending = false) {
  if (!online || !status) return 'Keine aktuellen Druckerdaten.'
  if (status.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (pending || status.control?.job) return 'Ein Befehl läuft noch oder muss geprüft werden.'

  const isPrintActive = ['printing', 'paused'].includes(status.printState)
  const isIdlePrint = ['standby', 'complete', 'cancelled', 'error'].includes(status.printState)

  if (action === 'print_start') {
    if (!status.capabilities?.printStart) return 'Druckstart ist nicht konfiguriert.'
    if (status.loadWatchActive) return 'Einlegehilfe ist scharf. Zuerst mit „Fertig“ beenden.'
    if (!isIdlePrint || status.idleState === 'Printing') {
      return 'Während eines Drucks, einer Pause oder laufender Befehle gesperrt.'
    }
    if (status.detectionConflict) return 'Werkzeugerkennung prüfen.'
    if (status.toolchangerState === 'error') return 'Toolchangerfehler zuerst am Gerät prüfen.'
    return ''
  }

  if (action === 'print_cancel') {
    if (!status.capabilities?.printCancel) return 'CANCEL_PRINT ist nicht konfiguriert.'
    if (!isPrintActive) return 'Kein aktiver Druck vorhanden.'
    return ''
  }

  if (['tune_speed', 'tune_flow', 'tune_z_offset'].includes(action)) {
    if (!isPrintActive) return 'Live-Tuning ist nur während eines aktiven oder pausierten Drucks verfügbar.'
    return ''
  }

  if (['tune_pressure_advance', 'tune_velocity_limits'].includes(action)) {
    return ''
  }

  if (action === 'tune_retraction') {
    if (!status.capabilities?.firmwareRetraction) return 'Firmware Retraction ist nicht konfiguriert.'
    return ''
  }

  if (action === 'save_z_offset') {
    if (!status.capabilities?.zOffsetSaveTarget) return 'Z-Offset-Übernahme ist nicht konfiguriert.'
    if (status.zOffset == null || Math.abs(status.zOffset) <= 1e-5) return 'Kein aktiver Z-Offset zum Übernehmen vorhanden.'
    return ''
  }

  if (action === 'exclude_object') {
    if (!status.capabilities?.excludeObject) return 'Exclude Object ist nicht konfiguriert.'
    if (!isPrintActive) return 'Objekte können nur während eines aktiven oder pausierten Drucks übersprungen werden.'
    return ''
  }

  if (action === 'pause_next_layer') {
    if (!status.capabilities?.pauseNextLayer) return 'SET_PAUSE_NEXT_LAYER ist nicht konfiguriert.'
    if (!isPrintActive) return 'Nur während eines aktiven oder pausierten Drucks verfügbar.'
    return ''
  }

  if (action === 'pause_at_layer') {
    if (!status.capabilities?.pauseAtLayer) return 'SET_PAUSE_AT_LAYER ist nicht konfiguriert.'
    if (!isPrintActive) return 'Nur während eines aktiven oder pausierten Drucks verfügbar.'
    return ''
  }

  return 'Unbekannte Aktion.'
}
