import { ref } from 'vue'

export function useControls(refresh) {
  const pending = ref(false)
  const stopping = ref(false)
  const feedback = ref(null)
  let lastResultId = null
  let initialized = false
  let dismissTimer = null

  function setFeedback(next, { autoDismiss = false } = {}) {
    if (dismissTimer) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
    feedback.value = next
    if (autoDismiss && next?.ok) {
      dismissTimer = setTimeout(() => {
        if (feedback.value === next) feedback.value = null
        dismissTimer = null
      }, 4200)
    }
  }

  function syncServerResult(result) {
    if (!initialized) {
      initialized = true
      lastResultId = result?.id ?? null
      return
    }
    if (!result || result.id == null || result.id === lastResultId) return
    lastResultId = result.id
    if (result.message) {
      setFeedback({ ok: !!result.ok, message: result.message }, { autoDismiss: !!result.ok })
    }
  }

  async function send(command) {
    const stop = command.action === 'emergency_stop'
    if ((stop && stopping.value) || (!stop && pending.value)) return false

    if (stop) stopping.value = true
    else pending.value = true

    setFeedback({
      ok: true,
      message: stop ? 'Not-Aus wird gesendet …' : 'Befehl wird geprüft und ausgeführt …',
    })

    try {
      const timeoutMs = stop ? 12_000 : command.action === 'console' ? 610_000 : 60_000
      const response = await fetch('/api/control', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cockpit-Request': '1',
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setFeedback({ ok: true, message: data.message }, { autoDismiss: true })
      return true
    } catch (error) {
      setFeedback({
        ok: false,
        message:
          error.name === 'TypeError' || error.name === 'TimeoutError'
            ? 'Verbindung unterbrochen. Das Ergebnis ist unbekannt. Drucker prüfen, bevor du erneut bedienst.'
            : error.message,
      })
      return false
    } finally {
      if (stop) stopping.value = false
      else pending.value = false
      refresh()
    }
  }

  function clearFeedback() {
    if (dismissTimer) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
    feedback.value = null
    lastResultId = null
    initialized = false
  }

  return { pending, stopping, feedback, send, syncServerResult, clearFeedback }
}
