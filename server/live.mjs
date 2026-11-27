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

const PROMPT_BUTTON_STYLES = new Set(['primary', 'secondary', 'info', 'warning', 'error'])

export function createPromptParser() {
  let draft = null
  let active = null
  let currentGroup = null

  function parseButtonSpec(raw) {
    const parts = String(raw ?? '').split('|')
    const label = (parts[0] ?? '').trim()
    if (!label) return null
    const gcode = (parts[1] ?? label).trim()
    const rawStyle = (parts[2] ?? '').trim().toLowerCase()
    const style = PROMPT_BUTTON_STYLES.has(rawStyle) ? rawStyle : 'secondary'
    return { label, gcode, style }
  }

  return {
    getActive() {
      return active
    },
    reset() {
      const hadActive = Boolean(active?.open)
      draft = null
      active = null
      currentGroup = null
      return hadActive ? { open: false } : null
    },
    feed(rawLine) {
      if (typeof rawLine !== 'string') return null
      const match = /^(?:\/\/\s*)?action:prompt_([a-z_]+)(?:\s+(.*))?$/i.exec(rawLine.trim())
      if (!match) return null
      const cmd = match[1].toLowerCase()
      const arg = (match[2] ?? '').trim()

      if (cmd === 'begin') {
        draft = { title: arg || 'Klipper', items: [], footerButtons: [] }
        currentGroup = null
        return null
      }
      if (cmd === 'end') {
        draft = null
        currentGroup = null
        const hadActive = Boolean(active?.open)
        active = null
        return hadActive ? { open: false } : null
      }
      if (!draft) return null

      if (cmd === 'text') {
        if (arg) draft.items.push({ kind: 'text', text: arg })
        return null
      }
      if (cmd === 'button_group_start') {
        currentGroup = { kind: 'group', buttons: [] }
        draft.items.push(currentGroup)
        return null
      }
      if (cmd === 'button_group_end') {
        currentGroup = null
        return null
      }
      if (cmd === 'button') {
        const btn = parseButtonSpec(arg)
        if (!btn) return null
        if (currentGroup) currentGroup.buttons.push(btn)
        else draft.items.push({ kind: 'button', ...btn })
        return null
      }
      if (cmd === 'footer_button') {
        const btn = parseButtonSpec(arg)
        if (btn) draft.footerButtons.push(btn)
        return null
      }
      if (cmd === 'show') {
        active = {
          open: true,
          title: draft.title,
          items: draft.items,
          footerButtons: draft.footerButtons,
        }
        return active
      }
      return null
    },
  }
}

function matchesDynamicSubscription(name, baseObjects) {
  return (
    baseObjects.includes(name) ||
    /^extruder([1-7])?$/.test(name) ||
    /^tool T[0-7]$/.test(name) ||
    name === 'z_tilt' ||
    name === 'quad_gantry_level' ||
    name === 'bed_screws' ||
    name === 'screws_tilt_adjust' ||
    name === 'manual_probe' ||
    name === 'firmware_retraction' ||
    name === 'gcode_macro SET_PAUSE_NEXT_LAYER' ||
    name === 'gcode_macro SET_PAUSE_AT_LAYER' ||
    name === 'fan' ||
    /^fan_generic [A-Za-z0-9_-]+$/.test(name) ||
    /^heater_fan [A-Za-z0-9_-]+$/.test(name) ||
    /^controller_fan [A-Za-z0-9_-]+$/.test(name) ||
    /^heater_generic [A-Za-z0-9_-]+$/.test(name) ||
    /^output_pin [A-Za-z0-9_-]+$/.test(name) ||
    /^temperature_sensor .+$/.test(name) ||
    /^temperature_fan .+$/.test(name) ||
    /^filament_(?:switch|motion)_sensor .+$/.test(name) ||
    /^neopixel [A-Za-z0-9_-]+$/.test(name) ||
    /^led [A-Za-z0-9_-]+$/.test(name) ||
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
  liteThrottleMs = 500,
}) {
  const resolvePrinter = () => (typeof getPrinter === 'function' ? getPrinter() : printer)
  const clients = new Map()
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
  const promptParser = createPromptParser()

  const hasFullClient = () => {
    for (const meta of clients.values()) {
      if (!meta.lite) return true
    }
    return false
  }

  const isLedActive = (now = Date.now()) => lastLedChangeAt > 0 && now - lastLedChangeAt < ledActiveWindowMs
  const currentPollDelay = (now = Date.now()) => {
    if (ready && (polledLedObjects.length === 0 || !hasFullClient())) return Math.min(pingIntervalMs, 1000)
    return Math.min(isLedActive(now) ? activeLedPollMs : ledPollMs, pingIntervalMs)
  }

  const dropClient = res => {
    const meta = clients.get(res)
    if (meta?.trailingTimer) clearTimeout(meta.trailingTimer)
    clients.delete(res)
  }

  const writeToClient = (res, message) => {
    if (res.destroyed || res.writableLength > 128000) {
      res.destroy()
      dropClient(res)
      return false
    }
    res.write(message)
    return true
  }

  const emit = (event, value) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
    lastEmitAt = Date.now()
    for (const res of [...clients.keys()]) {
      writeToClient(res, message)
    }
  }

  const emitStatus = ({ force = false, ledOnly = false } = {}) => {
    if (!ready || !clients.size) return
    const now = Date.now()
    let serialized = null
    const getMessage = () => {
      if (serialized === null) serialized = `event: status\ndata: ${JSON.stringify(snapshot(raw))}\n\n`
      return serialized
    }
    for (const [res, meta] of [...clients.entries()]) {
      if (!meta.lite) {
        lastEmitAt = now
        writeToClient(res, getMessage())
        continue
      }
      if (ledOnly && !force) continue
      const elapsed = now - meta.lastStatusAt
      if (force || elapsed >= liteThrottleMs) {
        if (meta.trailingTimer) {
          clearTimeout(meta.trailingTimer)
          meta.trailingTimer = null
        }
        meta.lastStatusAt = now
        lastEmitAt = now
        writeToClient(res, getMessage())
      } else if (!meta.trailingTimer) {
        meta.trailingTimer = setTimeout(() => {
          meta.trailingTimer = null
          if (!ready || !clients.has(res)) return
          meta.lastStatusAt = Date.now()
          lastEmitAt = meta.lastStatusAt
          writeToClient(res, `event: status\ndata: ${JSON.stringify(snapshot(raw))}\n\n`)
        }, Math.max(20, liteThrottleMs - elapsed))
      }
    }
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
      // relaxing to 4 Hz when static, and emit only on diff. Skip completely when no LEDs exist
      // or when only ?lite=1 touchscreens are connected.
      if (ready && !ledPending && polledLedObjects.length > 0 && hasFullClient()) {
        ledPending = now
        send(
          3,
          'printer.objects.query',
          Object.fromEntries(polledLedObjects.map(name => [name, ['color_data']])),
        )
      } else if (ready && (polledLedObjects.length === 0 || !hasFullClient()) && !keepalivePending && now - lastMessage > 3500) {
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
            Object.fromEntries([
              ...selected.map(name => [name, null]),
              ['configfile', ['settings', 'save_config_pending', 'warnings']],
            ]),
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
            emitStatus({ ledOnly: true })
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
          if (message) {
            for (const line of message.split(/\r?\n/)) {
              const promptUpdate = promptParser.feed(line)
              if (promptUpdate && clients.size) emit('prompt', promptUpdate)
            }
            if (clients.size) {
              emit('console', { time: Date.now() / 1000, type: 'response', message })
            }
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
    const clearedPrompt = promptParser.reset()
    if (clearedPrompt && clients.size) emit('prompt', clearedPrompt)
  }

  return {
    handle(req, res) {
      let lite = false
      try {
        if (req?.url) {
          const parsed = new URL(req.url, 'http://localhost')
          lite = parsed.searchParams.get('lite') === '1'
        }
      } catch {
        lite = false
      }
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      res.write('retry: 2500\n\n')
      const meta = { lite, lastStatusAt: 0, trailingTimer: null }
      clients.set(res, meta)
      if (ready) {
        meta.lastStatusAt = Date.now()
        res.write(`event: status\ndata: ${JSON.stringify(snapshot(raw))}\n\n`)
      }
      const activePrompt = promptParser.getActive()
      if (activePrompt?.open) res.write(`event: prompt\ndata: ${JSON.stringify(activePrompt)}\n\n`)
      connect()
      res.on('close', () => {
        dropClient(res)
        if (!clients.size) close()
      })
    },
    getActivePrompt() {
      return promptParser.getActive()
    },
    clearPrompt() {
      const cleared = promptParser.reset()
      if (cleared && clients.size) emit('prompt', cleared)
    },
    notify() {
      emitStatus({ force: true })
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
      for (const [res, meta] of [...clients.entries()]) {
        if (meta?.trailingTimer) clearTimeout(meta.trailingTimer)
        res.end()
      }
      clients.clear()
      close()
    },
  }
}
