// One read-only Moonraker subscription shared by all visible browser clients.
function colorDataEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ca = a[i]
    const cb = b[i]
    if (!Array.isArray(ca) || !Array.isArray(cb) || ca.length !== cb.length) return false
    for (let j = 0; j < ca.length; j++) {
      if (ca[j] !== cb[j]) return false
    }
  }
  return true
}

export function createLiveFeed({
  printer,
  baseObjects,
  snapshot,
  WebSocketImpl = WebSocket,
  ledPollMs = 250,
  pingIntervalMs = 2000,
}) {
  const clients = new Set()
  let ws = null
  let retry = null
  let tick = null
  let raw = {}
  let ready = false
  let lastMessage = 0
  let lastEmitAt = 0
  let ledPending = 0

  const emit = (event, value) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
    lastEmitAt = Date.now()
    for (const res of clients) {
      if (res.destroyed || res.writableLength > 128000) {
        res.destroy()
        clients.delete(res)
      } else {
        res.write(message)
      }
    }
  }

  const emitStatus = () => {
    if (ready && clients.size) emit('status', snapshot(raw))
  }

  const send = (id, method, objects) =>
    ws?.readyState === 1 &&
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(objects && { params: { objects } }) }))

  function merge(update) {
    if (!update || typeof update !== 'object') return false
    let changed = false
    for (const [key, value] of Object.entries(update)) {
      const prev = raw[key]
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, 'color_data')) {
        if (colorDataEqual(prev?.color_data, value.color_data)) continue
      }
      raw[key] = { ...prev, ...value }
      changed = true
    }
    return changed
  }

  function connect() {
    if (!clients.size || ws) return
    raw = {}
    ready = false
    lastMessage = Date.now()
    lastEmitAt = 0
    ledPending = 0

    const socket = new WebSocketImpl(printer.replace(/^http/, 'ws') + '/websocket')
    ws = socket

    socket.onopen = () => send(1, 'printer.objects.list')

    socket.onmessage = event => {
      if (ws !== socket) return
      lastMessage = Date.now()
      try {
        const data = JSON.parse(event.data)
        if (data.error) {
          socket.close()
          return
        }
        if (data.id === 1) {
          const available = data.result.objects
          const selected = available.filter(
            name => baseObjects.includes(name) || name.startsWith('led_effect ') || name.startsWith('fan_generic '),
          )
          send(
            2,
            'printer.objects.subscribe',
            Object.fromEntries([...selected.map(name => [name, null]), ['configfile', ['settings']]]),
          )
        } else if (data.id === 2) {
          raw = data.result.status
          ready = true
          emitStatus()
        } else if (data.id === 3) {
          ledPending = 0
          if (merge(data.result.status) && ready) emitStatus()
        } else if (data.method === 'notify_status_update') {
          if (merge(data.params?.[0]) && ready) emitStatus()
        } else if (data.method === 'notify_gcode_response') {
          const message = String(data.params?.[0] ?? '')
          if (message && clients.size) {
            emit('console', { time: Date.now() / 1000, type: 'response', message })
          }
        } else if (
          ['notify_klippy_disconnected', 'notify_klippy_shutdown', 'notify_klippy_ready'].includes(data.method)
        ) {
          ready = false
          emit('offline', {})
          socket.close()
        }
      } catch {
        socket.close()
      }
    }

    socket.onerror = () => socket.close()

    socket.onclose = () => {
      if (ws !== socket) return
      ws = null
      ready = false
      clearInterval(tick)
      emit('offline', {})
      if (clients.size) retry = setTimeout(connect, 2500)
    }

    tick = setInterval(() => {
      const now = Date.now()
      if (now - lastMessage > 7000 || (ledPending && now - ledPending > 5000)) {
        socket.close()
        return
      }
      // Keep SSE clients alive without pushing redundant full status snapshots during idle.
      if (ready && clients.size && now - lastEmitAt >= pingIntervalMs) {
        emit('ping', {})
      }
      // This installed led_effect mutates color_data in place: subscriptions don't
      // publish its animation frames. Query only the 18 LEDs at 4 Hz, emit only on diff.
      if (ready && !ledPending) {
        ledPending = now
        send(
          3,
          'printer.objects.query',
          Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`neopixel et${i}_leds`, ['color_data']])),
        )
      }
    }, ledPollMs)
  }

  function close() {
    clearTimeout(retry)
    clearInterval(tick)
    const old = ws
    ws = null
    old?.close()
    ready = false
    raw = {}
  }

  return {
    handle(req, res) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      res.write('retry: 2500\n\n')
      clients.add(res)
      if (ready) res.write(`event: status\ndata: ${JSON.stringify(snapshot(raw))}\n\n`)
      connect()
      res.on('close', () => {
        clients.delete(res)
        if (!clients.size) close()
      })
    },
    notify() {
      emitStatus()
    },
    emitConsole(entry) {
      if (clients.size && entry?.message) emit('console', entry)
    },
    close() {
      for (const res of clients) res.end()
      clients.clear()
      close()
    },
  }
}
