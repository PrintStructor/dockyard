import { ref, onMounted, onUnmounted } from 'vue'

export function usePrinter({ onConsole, onReconnect } = {}) {
  const status = ref(null)
  const connection = ref('connecting')
  const error = ref('')
  const updating = ref(false)

  let timer = null
  let controller = null
  let events = null
  let stopped = false
  let liveAt = 0
  let wasOnline = false

  function accept(data) {
    const reconnected = !wasOnline
    wasOnline = true
    status.value = data
    connection.value = 'online'
    error.value = ''
    if (reconnected) onReconnect?.()
  }

  function offline() {
    wasOnline = false
    connection.value = status.value ? 'stale' : 'offline'
    error.value = 'Keine aktuellen Druckerdaten. Verbindung prüfen und erneut versuchen.'
  }

  async function refresh() {
    if (updating.value || stopped) return
    updating.value = true
    controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 7000)
    const started = Date.now()
    try {
      const response = await fetch('/api/status', { signal: controller.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      if (!stopped && liveAt < started) accept(data)
    } catch {
      if (!stopped && liveAt < started) offline()
    } finally {
      clearTimeout(timeout)
      updating.value = false
    }
  }

  function connect() {
    events?.close()
    events = new EventSource('/api/events')
    events.addEventListener('status', event => {
      liveAt = Date.now()
      accept(JSON.parse(event.data))
    })
    events.addEventListener('ping', () => {
      liveAt = Date.now()
    })
    events.addEventListener('console', event => {
      liveAt = Date.now()
      try {
        onConsole?.(JSON.parse(event.data))
      } catch {
        // Ignore malformed console events.
      }
    })
    events.addEventListener('offline', () => {
      liveAt = 0
      offline()
    })
    events.onerror = () => {
      liveAt = 0
      offline()
    }
  }

  const visibility = () => {
    if (document.hidden) {
      events?.close()
      events = null
      liveAt = 0
      controller?.abort()
      offline()
    } else {
      connect()
      refresh()
    }
  }

  onMounted(() => {
    connect()
    refresh()
    timer = setInterval(() => {
      if (!document.hidden && Date.now() - liveAt > 4500) refresh()
    }, 3000)
    document.addEventListener('visibilitychange', visibility)
  })

  onUnmounted(() => {
    stopped = true
    clearInterval(timer)
    controller?.abort()
    events?.close()
    document.removeEventListener('visibilitychange', visibility)
  })

  return { status, connection, error, updating, refresh }
}
