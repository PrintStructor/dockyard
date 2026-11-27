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

const SINGLE_TOOL_LED_PRIORITY = [
  'sb_leds',
  'sb-leds',
  'stealthburner_leds',
  'stealthburner-leds',
  'head_leds',
  'toolhead_leds',
  'nozzle_leds',
  'rgb',
]

function matchesDynamicSubscription(name, baseObjects) {
  return (
    baseObjects.includes(name) ||
    /^extruder([1-7])?$/.test(name) ||
    /^tool T[0-7]$/.test(name) ||
    name === 'z_tilt' ||
    name === 'quad_gantry_level' ||
    name === 'fan' ||
    /^fan_generic [A-Za-z0-9_-]+$/.test(name) ||
    /^temperature_sensor .+$/.test(name) ||
    /^temperature_fan .+$/.test(name) ||
    /^filament_(?:switch|motion)_sensor .+$/.test(name) ||
    /^neopixel [A-Za-z0-9_-]+$/.test(name) ||
    /^led_effect .+$/.test(name)
  )
}

function selectPolledLedObjects(available) {
  const etLeds = available.filter(name => /^neopixel et[0-7]_leds$/.test(name)).sort()
  if (etLeds.length > 0) return etLeds

  const neopixels = available.filter(name => /^neopixel [A-Za-z0-9_-]+$/.test(name))
  if (!neopixels.length) return []

  for (const preferred of SINGLE_TOOL_LED_PRIORITY) {
    const match = neopixels.find(name => name.slice(9).toLowerCase() === preferred)
    if (match) return [match]
  }
  return [neopixels[0]]
}

export function createLiveFeed({
  printer,
  getPrinter,
  baseObjects,
  snapshot,
  WebSocketImpl = WebSocket,
  ledPollMs = 250,
  activeLedPollMs = Math.min(ledPollMs, 85),
  ledActiveWindowMs = 2000,
  pingIntervalMs = 2000,
}) {
  const resolvePrinter = () => (typeof getPrinter === 'function' ? getPrinter() : printer)
  const clients = new Set()
  let ws = null
  let retry = null
  let tick = null
  let raw = {}
  let polledLedObjects = []
  let ready = false
  let lastMessage = 0
  let lastEmitAt = 0
  let lastLedChangeAt = 0
  let ledPending = 0
  let keepalivePending = 0
  let tickDelay = ledPollMs

  const isLedActive = (now = Date.now()) => lastLedChangeAt > 0 && now - lastLedChangeAt < ledActiveWindowMs
  const currentPollDelay = (now = Date.now()) => {
    if (ready && polledLedObjects.length === 0) return Math.min(pingIntervalMs, 1000)
    return Math.min(isLedActive(now) ? activeLedPollMs : ledPollMs, pingIntervalMs)
  }

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
    let ledChanged = false
    for (const [key, value] of Object.entries(update)) {
      const prev = raw[key]
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, 'color_data')) {
        if (colorDataEqual(prev?.color_data, value.color_data)) continue
        ledChanged = true
      } else if (key.startsWith('neopixel ') && value && Object.hasOwn(value, 'color_data')) {
        if (!colorDataEqual(prev?.color_data, value.color_data)) ledChanged = true
      }
      raw[key] = { ...prev, ...value }
      changed = true
    }
    if (ledChanged) lastLedChangeAt = Date.now()
    return changed
  }

  function scheduleTick(socket, delay = currentPollDelay()) {
    clearTimeout(tick)
    tickDelay = delay
    tick = setTimeout(() => {
      if (ws !== socket) return
      const now = Date.now()
      if (
        now - lastMessage > 7000 ||
        (ledPending && now - ledPending > 5000) ||
        (keepalivePending && now - keepalivePending > 5000)
      ) {
        socket.close()
        return
      }
      // Keep SSE clients alive without pushing redundant full status snapshots during idle.
      if (ready && clients.size && now - lastEmitAt >= pingIntervalMs) {
        emit('ping', {})
      }
      // This installed led_effect mutates color_data in place: subscriptions don't
      // publish its animation frames. Poll adaptively up to ~12 Hz while LEDs animate,
      // relaxing to 4 Hz when static, and emit only on diff. Skip completely when no LEDs exist.
      if (ready && !ledPending && polledLedObjects.length > 0) {
        ledPending = now
        send(
          3,
          'printer.objects.query',
          Object.fromEntries(polledLedObjects.map(name => [name, ['color_data']])),
        )
      } else if (ready && polledLedObjects.length === 0 && !keepalivePending && now - lastMessage > 3500) {
        keepalivePending = now
        send(4, 'server.info')
      }
      scheduleTick(socket)
    }, delay)
  }

  function connect() {
    if (!clients.size || ws) return
    raw = {}
    polledLedObjects = []
    ready = false
    lastMessage = Date.now()
    lastEmitAt = 0
    lastLedChangeAt = 0
    ledPending = 0
    keepalivePending = 0

    const targetPrinter = resolvePrinter()
    const socket = new WebSocketImpl(targetPrinter.replace(/^http/, 'ws') + '/websocket')
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
          const available = Array.isArray(data.result?.objects) ? data.result.objects : []
          const selected = available.filter(name => matchesDynamicSubscription(name, baseObjects))
          polledLedObjects = selectPolledLedObjects(available)
          send(
            2,
            'printer.objects.subscribe',
            Object.fromEntries([...selected.map(name => [name, null]), ['configfile', ['settings']]]),
          )
        } else if (data.id === 2) {
          raw = data.result.status
          // Drop long enclosure strips (>8 LEDs) that status.mjs ignores as non-toolhead neopixels.
          if (polledLedObjects.length > 0 && !polledLedObjects.some(k => /^neopixel et[0-7]_leds$/.test(k))) {
            polledLedObjects = polledLedObjects.filter(key => {
              const cd = raw[key]?.color_data
              return !Array.isArray(cd) || (cd.length >= 1 && cd.length <= 8)
            })
          }
          ready = true
          emitStatus()
          if (polledLedObjects.length === 0) {
            scheduleTick(socket)
          }
        } else if (data.id === 3) {
          ledPending = 0
          const wasActive = isLedActive()
          if (merge(data.result.status) && ready) {
            emitStatus()
            if (!wasActive && isLedActive() && tickDelay > activeLedPollMs) {
              scheduleTick(socket, activeLedPollMs)
            }
          }
        } else if (data.id === 4) {
          keepalivePending = 0
        } else if (data.method === 'notify_status_update') {
          const wasActive = isLedActive()
          if (merge(data.params?.[0]) && ready) {
            emitStatus()
            if (!wasActive && isLedActive() && tickDelay > activeLedPollMs) {
              scheduleTick(socket, activeLedPollMs)
            }
          }
        } else if (data.method === 'notify_gcode_response') {
          const message = String(data.params?.[0] ?? '')
          if (message && clients.size) {
            emit('console', { time: Date.now() / 1000, type: 'response', message })
          }
        } else if (data.method === 'notify_update_response') {
          const info = data.params?.[0]
          if (info && clients.size) {
            emit('update', {
              application: info.application ?? null,
              message: typeof info.message === 'string' ? info.message : '',
              complete: Boolean(info.complete),
              time: Date.now() / 1000,
            })
          }
        } else if (data.method === 'notify_update_refreshed') {
          if (clients.size) emit('update', { refreshed: true, time: Date.now() / 1000 })
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
      clearTimeout(tick)
      tick = null
      emit('offline', {})
      if (clients.size) retry = setTimeout(connect, 2500)
    }

    scheduleTick(socket)
  }

  function close() {
    clearTimeout(retry)
    clearTimeout(tick)
    tick = null
    const old = ws
    ws = null
    old?.close()
    ready = false
    raw = {}
    polledLedObjects = []
    keepalivePending = 0
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
    emitUpdate(payload) {
      if (clients.size && payload) emit('update', payload)
    },
    emitSettings(payload) {
      if (clients.size && payload) emit('settings', payload)
    },
    reconnect() {
      close()
      if (clients.size) {
        emit('offline', {})
        connect()
      }
    },
    close() {
      for (const res of clients) res.end()
      clients.clear()
      close()
    },
  }
}
