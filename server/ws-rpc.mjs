import { ControlError } from './control.mjs'

export class AbortedCommandError extends Error {
  constructor(message = 'Befehl durch Not-Aus abgebrochen.') {
    super(message)
    this.name = 'AbortedCommandError'
  }
}

/**
 * Execute any Moonraker JSON-RPC method over /websocket to bypass Nginx 60 s HTTP
 * proxy_read_timeout while monitoring liveness via server.info heartbeats.
 */
export function executeMoonrakerRpc({
  printer,
  method,
  params = {},
  timeoutMs = 600_000,
  heartbeatMs = 25_000,
  heartbeatTimeoutMs = 15_000,
  signal,
  WebSocketImpl = WebSocket,
  onNotify,
  requireOkResult = false,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedCommandError())
      return
    }

    const wsUrl = printer.replace(/^http/, 'ws') + '/websocket'
    const rpcId = 1
    let nextPingId = 100
    let pendingPingId = null
    let pendingPingTimer = null
    let heartbeatTimer = null
    let overallTimer = null
    let settled = false
    let socket = null

    function cleanup() {
      clearTimeout(overallTimer)
      clearInterval(heartbeatTimer)
      clearTimeout(pendingPingTimer)
      signal?.removeEventListener('abort', onAbort)
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        try {
          if (socket.readyState === 0 || socket.readyState === 1) socket.close()
        } catch {
          // Ignore close errors during teardown.
        }
        socket = null
      }
    }

    function finish(fn, value) {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }

    function onAbort() {
      finish(reject, new AbortedCommandError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    overallTimer = setTimeout(() => {
      finish(reject, new Error('Zeitüberschreitung beim Warten auf Moonraker.'))
    }, timeoutMs)

    try {
      socket = new WebSocketImpl(wsUrl)
    } catch (error) {
      finish(reject, error instanceof Error ? error : new Error('WebSocket-Verbindung fehlgeschlagen.'))
      return
    }

    socket.onopen = () => {
      if (settled) return
      try {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          method,
          params,
        }))
      } catch (error) {
        finish(reject, error instanceof Error ? error : new Error('Befehl konnte nicht gesendet werden.'))
        return
      }

      if (settled) return

      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (settled || !socket || socket.readyState !== 1 || pendingPingId != null) return
          pendingPingId = nextPingId++
          try {
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: pendingPingId, method: 'server.info' }))
          } catch {
            finish(reject, new Error('Verbindung zu Moonraker unterbrochen.'))
            return
          }
          pendingPingTimer = setTimeout(() => {
            finish(reject, new Error('Moonraker antwortet nicht mehr.'))
          }, heartbeatTimeoutMs)
        }, heartbeatMs)
      }
    }

    socket.onmessage = event => {
      if (settled) return
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }

      if (data.id === pendingPingId) {
        pendingPingId = null
        clearTimeout(pendingPingTimer)
        pendingPingTimer = null
        return
      }

      if (data.method && onNotify) {
        try {
          onNotify(data)
        } catch {
          // Ignore listener exceptions.
        }
        return
      }

      if (data.id === rpcId) {
        if (data.error) {
          finish(reject, new ControlError(data.error.message || 'Moonraker hat den Befehl abgelehnt.', 409))
          return
        }
        if (requireOkResult) {
          if (data.result === 'ok') {
            finish(resolve, 'ok')
            return
          }
          finish(reject, new Error('Keine eindeutige Bestätigung von Moonraker'))
          return
        }
        finish(resolve, data.result ?? 'ok')
      }
    }

    socket.onerror = () => {
      finish(reject, new Error('Verbindung zu Moonraker unterbrochen.'))
    }

    socket.onclose = () => {
      finish(reject, new Error('WebSocket-Verbindung zu Moonraker unerwartet beendet.'))
    }
  })
}

export function executeGcodeScript({
  printer,
  script,
  timeoutMs = 600_000,
  heartbeatMs = 25_000,
  heartbeatTimeoutMs = 15_000,
  signal,
  WebSocketImpl = WebSocket,
}) {
  return executeMoonrakerRpc({
    printer,
    method: 'printer.gcode.script',
    params: { script },
    timeoutMs,
    heartbeatMs,
    heartbeatTimeoutMs,
    signal,
    WebSocketImpl,
    requireOkResult: true,
  })
}
