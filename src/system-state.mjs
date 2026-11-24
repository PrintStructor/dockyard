const RECOVERY_STATES = new Set(['disconnected', 'error', 'shutdown', 'startup'])

export function computeSystemState({ status = null, online = false, overview = null } = {}) {
  const overviewState = overview?.klippy?.state ?? null
  const overviewDown = overview?.klippy?.connected === false || RECOVERY_STATES.has(overviewState)
  const liveKlipperState = online ? (status?.klipperState ?? null) : null
  const liveDown = RECOVERY_STATES.has(liveKlipperState)

  const klippyInRecovery = Boolean(overviewDown || liveDown)
  const effectiveKlipperState = online
    ? (status?.klipperState ?? overviewState ?? null)
    : (overviewState ?? status?.klipperState ?? null)

  const activeJob = Boolean(status?.control?.job && !status.control.job.uncertain)
  const livePrintActive = online && !klippyInRecovery && ['printing', 'paused'].includes(status?.printState)
  const printLocked = Boolean(livePrintActive || activeJob)

  return {
    klippyInRecovery,
    printLocked,
    effectiveKlipperState,
  }
}

export function isConnectivityFailure(httpStatus) {
  return !httpStatus || httpStatus >= 502
}
