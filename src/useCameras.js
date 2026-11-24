import { reactive } from 'vue'
import { extractJpegFrames, concatBytes } from './mjpeg.mjs'

const GRACE_MS = 10_000
const WEBRTC_CONNECT_TIMEOUT_MS = 7_000
const WEBRTC_DISCONNECT_GRACE_MS = 4_000
const MJPEG_STALL_TIMEOUT_MS = 8_000

const entries = new Map()
let visibilityBound = false

function createCameraEntry(id) {
  const state = reactive({
    id,
    preferredMode: 'webrtc', // 'webrtc' | 'mjpeg'
    activeTransport: null, // 'webrtc' | 'mjpeg' | null
    status: 'idle', // 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'
    stream: null, // MediaStream for WebRTC
    frameUrl: '', // ObjectURL for MJPEG
    lastFrameAt: 0,
    webrtcFailed: false,
  })

  let refs = 0
  let graceTimer = null
  let reconnectTimer = null
  let connectTimer = null
  let disconnectTimer = null
  let stallTimer = null
  let keepaliveTimer = null
  let pc = null
  let mjpegAbort = null
  let reconnectAttempt = 0
  let runId = 0

  function clearTimers() {
    clearTimeout(reconnectTimer)
    clearTimeout(connectTimer)
    clearTimeout(disconnectTimer)
    clearTimeout(stallTimer)
    clearInterval(keepaliveTimer)
    reconnectTimer = null
    connectTimer = null
    disconnectTimer = null
    stallTimer = null
    keepaliveTimer = null
  }

  function revokeFrame() {
    if (state.frameUrl) {
      URL.revokeObjectURL(state.frameUrl)
      state.frameUrl = ''
    }
  }

  function stopTransport(preserveFrame = false) {
    runId++
    clearTimers()
    if (mjpegAbort) {
      mjpegAbort.abort()
      mjpegAbort = null
    }
    if (pc) {
      pc.ontrack = null
      pc.ondatachannel = null
      pc.onicecandidate = null
      pc.onconnectionstatechange = null
      pc.oniceconnectionstatechange = null
      try {
        pc.close()
      } catch {
        // Ignore close errors.
      }
      pc = null
    }
    if (!preserveFrame) {
      state.stream = null
      revokeFrame()
      state.activeTransport = null
    }
  }

  function scheduleReconnect(fallbackToMjpeg = false) {
    if (refs <= 0 || document.hidden) return
    if (fallbackToMjpeg) {
      state.webrtcFailed = true
      startMjpeg()
      return
    }
    state.status = state.lastFrameAt ? 'reconnecting' : 'error'
    const delay = Math.min(8000, 1500 * Math.pow(2, reconnectAttempt))
    reconnectAttempt = Math.min(reconnectAttempt + 1, 4)
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      if (refs > 0 && !document.hidden) start()
    }, delay)
  }

  async function postWebRtc(payload, signal) {
    const response = await fetch(`/api/camera/${id}/webrtc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cockpit-Request': '1',
      },
      body: JSON.stringify(payload),
      signal,
    })
    if (!response.ok) throw new Error(`WebRTC HTTP ${response.status}`)
    return response.json()
  }

  async function startWebRtc() {
    if (typeof RTCPeerConnection === 'undefined') {
      state.webrtcFailed = true
      startMjpeg()
      return
    }

    stopTransport(true)
    const token = runId
    state.status = state.lastFrameAt ? 'reconnecting' : 'connecting'
    const abort = new AbortController()
    mjpegAbort = abort

    connectTimer = setTimeout(() => {
      if (token !== runId) return
      abort.abort()
      state.webrtcFailed = true
      startMjpeg()
    }, WEBRTC_CONNECT_TIMEOUT_MS)

    try {
      const offer = await postWebRtc({ type: 'request', iceServers: [], keepAlive: true }, abort.signal)
      if (token !== runId) return
      if (!offer?.sdp || !offer?.id) throw new Error('Ungültige WebRTC-Antwort')

      const peer = new RTCPeerConnection({ iceServers: offer.iceServers ?? [] })
      pc = peer

      peer.ontrack = event => {
        if (token !== runId) return
        const stream = event.streams?.[0] ?? new MediaStream([event.track])
        clearTimeout(connectTimer)
        connectTimer = null
        clearTimeout(disconnectTimer)
        disconnectTimer = null
        revokeFrame()
        state.stream = stream
        state.activeTransport = 'webrtc'
        state.status = 'live'
        state.lastFrameAt = Date.now()
        reconnectAttempt = 0
      }

      peer.ondatachannel = event => {
        if (token !== runId) return
        const channel = event.channel
        channel.onopen = () => {
          if (token !== runId) return
          try {
            channel.send('keepalive')
          } catch {
            // Ignore send errors.
          }
          clearInterval(keepaliveTimer)
          keepaliveTimer = setInterval(() => {
            if (token !== runId || channel.readyState !== 'open') return
            try {
              channel.send('keepalive')
            } catch {
              // Ignore send errors.
            }
          }, 2000)
        }
        channel.onclose = () => clearInterval(keepaliveTimer)
      }

      peer.onicecandidate = event => {
        if (token !== runId || !event.candidate) return
        postWebRtc({ type: 'remote_candidate', id: offer.id, candidates: [event.candidate] }, abort.signal).catch(() => {})
      }

      const handleState = () => {
        if (token !== runId) return
        const conn = peer.connectionState
        const ice = peer.iceConnectionState
        if (conn === 'connected' || ice === 'connected' || ice === 'completed') {
          clearTimeout(disconnectTimer)
          disconnectTimer = null
          if (state.stream) state.status = 'live'
          return
        }
        if (conn === 'failed' || conn === 'closed' || ice === 'failed' || ice === 'closed') {
          clearTimeout(disconnectTimer)
          stopTransport(true)
          scheduleReconnect(state.activeTransport !== 'webrtc')
          return
        }
        if ((conn === 'disconnected' || ice === 'disconnected') && !disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            if (token !== runId) return
            stopTransport(true)
            scheduleReconnect(false)
          }, WEBRTC_DISCONNECT_GRACE_MS)
        }
      }

      peer.onconnectionstatechange = handleState
      peer.oniceconnectionstatechange = handleState

      await peer.setRemoteDescription({ type: offer.type || 'offer', sdp: offer.sdp })
      if (token !== runId) return
      const answer = await peer.createAnswer()
      if (token !== runId) return
      await peer.setLocalDescription(answer)
      if (token !== runId) return
      await postWebRtc({ type: 'answer', id: offer.id, sdp: answer.sdp }, abort.signal)
    } catch {
      if (token !== runId) return
      stopTransport(true)
      state.webrtcFailed = true
      startMjpeg()
    }
  }

  async function startMjpeg() {
    stopTransport(true)
    const token = runId
    state.status = state.lastFrameAt ? 'reconnecting' : 'connecting'
    const abort = new AbortController()
    mjpegAbort = abort

    const resetStallWatchdog = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (token !== runId) return
        abort.abort()
      }, MJPEG_STALL_TIMEOUT_MS)
    }

    resetStallWatchdog()

    try {
      const response = await fetch(`/api/camera/${id}/stream?session=${Date.now()}`, {
        signal: abort.signal,
        cache: 'no-store',
      })
      if (token !== runId) return
      if (!response.ok || !response.body) throw new Error(`MJPEG HTTP ${response.status}`)

      const reader = response.body.getReader()
      let buffer = new Uint8Array(0)

      while (token === runId) {
        const { done, value } = await reader.read()
        if (token !== runId) {
          reader.cancel().catch(() => {})
          return
        }
        if (done) throw new Error('MJPEG-Stream beendet')
        if (!value?.length) continue

        buffer = concatBytes(buffer, value)
        const { frames, remainder } = extractJpegFrames(buffer)
        buffer = remainder

        if (frames.length > 0) {
          // Display the freshest frame if multiple arrived in one read burst.
          const latest = frames[frames.length - 1]
          const nextUrl = URL.createObjectURL(new Blob([latest], { type: 'image/jpeg' }))
          const previousUrl = state.frameUrl
          state.stream = null
          state.frameUrl = nextUrl
          state.activeTransport = 'mjpeg'
          state.status = 'live'
          state.lastFrameAt = Date.now()
          reconnectAttempt = 0
          if (previousUrl) URL.revokeObjectURL(previousUrl)
          resetStallWatchdog()
        }
      }
    } catch {
      if (token !== runId) return
      clearTimeout(stallTimer)
      stallTimer = null
      scheduleReconnect(false)
    }
  }

  function start() {
    if (refs <= 0 || document.hidden) return
    if (state.preferredMode === 'webrtc' && !state.webrtcFailed) {
      startWebRtc()
    } else {
      startMjpeg()
    }
  }

  function attach() {
    refs++
    clearTimeout(graceTimer)
    graceTimer = null
    if (state.status === 'idle' || state.status === 'error') {
      start()
    }
  }

  function detach() {
    refs = Math.max(0, refs - 1)
    if (refs === 0) {
      clearTimeout(graceTimer)
      graceTimer = setTimeout(() => {
        if (refs === 0) {
          stopTransport(false)
          state.status = 'idle'
          state.lastFrameAt = 0
          reconnectAttempt = 0
        }
      }, GRACE_MS)
    }
  }

  function reconnect() {
    reconnectAttempt = 0
    if (state.preferredMode === 'webrtc') state.webrtcFailed = false
    if (refs > 0 && !document.hidden) start()
  }

  function setPreferredMode(mode) {
    if (mode !== 'webrtc' && mode !== 'mjpeg') return
    state.preferredMode = mode
    state.webrtcFailed = false
    reconnectAttempt = 0
    if (refs > 0 && !document.hidden) start()
  }

  function handleVisibility() {
    if (document.hidden) {
      stopTransport(true)
      if (refs > 0) state.status = 'idle'
    } else if (refs > 0) {
      reconnectAttempt = 0
      start()
    }
  }

  return { state, attach, detach, reconnect, setPreferredMode, handleVisibility }
}

function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    for (const entry of entries.values()) entry.handleVisibility()
  })
}

export function useCameras() {
  bindVisibility()

  function getEntry(id) {
    if (!entries.has(id)) entries.set(id, createCameraEntry(id))
    return entries.get(id)
  }

  return {
    getCamera: id => getEntry(id).state,
    attach: id => getEntry(id).attach(),
    detach: id => getEntry(id).detach(),
    reconnect: id => getEntry(id).reconnect(),
    setPreferredMode: (id, mode) => getEntry(id).setPreferredMode(mode),
  }
}
