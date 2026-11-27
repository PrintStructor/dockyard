<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Camera, RefreshCw, Expand, X, Download } from '@lucide/vue'
import { t } from '../i18n.mjs'
import { useCameras } from '../useCameras.js'

const props = defineProps({
  id: String,
  name: String,
  description: String,
  service: { type: String, default: 'camera-streamer' },
  preferredMode: { type: String, default: 'webrtc' },
  flipX: { type: Boolean, default: false },
  flipY: { type: Boolean, default: false },
  rotate: { type: Number, default: 0 },
})

const cameras = useCameras()
const camera = cameras.getCamera(props.id)

watch(
  [() => props.service, () => props.preferredMode],
  ([service, preferredMode]) => {
    cameras.configureCamera(props.id, { service, preferredMode })
  },
  { immediate: true },
)

const mediaStyle = computed(() => {
  const parts = []
  if (props.flipX) parts.push('scaleX(-1)')
  if (props.flipY) parts.push('scaleY(-1)')
  const rot = [0, 90, 180, 270].includes(Number(props.rotate)) ? Number(props.rotate) : 0
  if (rot) parts.push(`rotate(${rot}deg)`)
  return parts.length ? { transform: parts.join(' ') } : undefined
})

const capturing = ref(false)

async function captureSnapshot() {
  if (capturing.value || !hasMedia.value) return
  capturing.value = true
  try {
    const safeName = (props.name || props.id || 'camera').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const videoEl = expanded.value ? modalVideo.value : inlineVideo.value
    if (isWebRtc.value && videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      const rot = [0, 90, 180, 270].includes(Number(props.rotate)) ? Number(props.rotate) : 0
      const swapped = rot === 90 || rot === 270
      const canvas = document.createElement('canvas')
      canvas.width = swapped ? videoEl.videoHeight : videoEl.videoWidth
      canvas.height = swapped ? videoEl.videoWidth : videoEl.videoHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.translate(canvas.width / 2, canvas.height / 2)
        if (rot) ctx.rotate((rot * Math.PI) / 180)
        ctx.scale(props.flipX ? -1 : 1, props.flipY ? -1 : 1)
        ctx.drawImage(videoEl, -videoEl.videoWidth / 2, -videoEl.videoHeight / 2)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
        if (blob) {
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `${safeName}-${stamp}.jpg`
          document.body.appendChild(link)
          link.click()
          link.remove()
          URL.revokeObjectURL(url)
          return
        }
      }
    }
    const res = await fetch(`/api/camera/${encodeURIComponent(props.id)}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return
    const blob = await res.blob()
    const ext = blob.type.includes('png') ? 'png' : 'jpg'
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${safeName}-${stamp}.${ext}`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  } catch {
    // Ignore transient snapshot failures
  } finally {
    capturing.value = false
  }
}

const expanded = ref(false)
const dialog = ref(null)
const inlineVideo = ref(null)
const modalVideo = ref(null)

const isWebRtc = computed(() => camera.activeTransport === 'webrtc' && !!camera.stream)
const isMjpeg = computed(() => camera.activeTransport === 'mjpeg' && !!camera.frameUrl)
const hasMedia = computed(() => isWebRtc.value || isMjpeg.value)
const isLive = computed(() => camera.status === 'live' && hasMedia.value)
const isReconnecting = computed(() => camera.status === 'reconnecting')
const isError = computed(() => camera.status === 'error')

const badgeText = computed(() => {
  if (isLive.value) return isWebRtc.value ? 'Live · WebRTC' : 'Live · MJPEG'
  if (isReconnecting.value) return t('Verbindung unterbrochen · verbinde neu …')
  if (isError.value) return t('Kamerastream nicht erreichbar')
  return t('Kamerastream wird verbunden …')
})

const nextMode = computed(() => (camera.preferredMode === 'webrtc' ? 'mjpeg' : 'webrtc'))

function syncVideoElement(el, stream) {
  if (!el) return
  if (el.srcObject !== stream) el.srcObject = stream
  if (stream) el.play().catch(() => {})
}

watch(
  [() => camera.stream, isWebRtc, inlineVideo, modalVideo, expanded],
  () => {
    const stream = isWebRtc.value ? camera.stream : null
    syncVideoElement(inlineVideo.value, expanded.value ? null : stream)
    syncVideoElement(modalVideo.value, expanded.value ? stream : null)
  },
  { flush: 'post' },
)

function open() {
  expanded.value = true
  dialog.value?.showModal()
}

function close() {
  dialog.value?.close()
  expanded.value = false
}

function toggleMode() {
  cameras.setPreferredMode(props.id, nextMode.value)
}

function reconnect() {
  cameras.reconnect(props.id)
}

onMounted(() => cameras.attach(props.id))
onBeforeUnmount(() => {
  syncVideoElement(inlineVideo.value, null)
  syncVideoElement(modalVideo.value, null)
  cameras.detach(props.id)
})
</script>

<template>
  <article class="camera-panel">
    <div class="camera-title">
      <div>
        <Camera :size="17" />
        <h3>{{ t(name) }}</h3>
        <span v-if="description">{{ t(description) }}</span>
      </div>
      <div class="camera-controls">
        <button
          v-if="props.service !== 'mjpeg'"
          class="camera-mode-toggle"
          type="button"
          :title="
            nextMode === 'mjpeg'
              ? t('Auf MJPEG-Stream umschalten')
              : t('Auf WebRTC-Stream umschalten')
          "
          @click="toggleMode"
        >
          {{ isWebRtc ? 'WebRTC' : isMjpeg ? 'MJPEG' : camera.preferredMode.toUpperCase() }}
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="!hasMedia || capturing"
          :title="t('Schnappschuss speichern')"
          :aria-label="t('Schnappschuss von {0} speichern', [t(name)])"
          @click="captureSnapshot"
        >
          <Download :size="15" />
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="!hasMedia"
          :aria-label="t('{0} vergrößern', [t(name)])"
          @click="open"
        >
          <Expand :size="16" />
        </button>
      </div>
    </div>

    <div class="camera-image">
      <video
        v-if="isWebRtc"
        ref="inlineVideo"
        :style="mediaStyle"
        :class="{ 'camera-stale': !isLive }"
        muted
        autoplay
        playsinline
        :aria-label="t('{0} Livestream', [t(name)])"
      />
      <img
        v-else-if="isMjpeg"
        :src="camera.frameUrl"
        :style="mediaStyle"
        :class="{ 'camera-stale': !isLive }"
        :alt="t('{0} Livestream', [t(name)])"
      />

      <div v-if="!isLive" class="camera-empty" :class="{ overlay: hasMedia }">
        <Camera :size="27" />
        <p>{{ badgeText }}</p>
        <button v-if="isError || isReconnecting" class="subtle-button" type="button" @click="reconnect">
          <RefreshCw :size="14" />{{ t('Erneut verbinden') }}
        </button>
      </div>
      <span v-else class="camera-timestamp">{{ badgeText }}</span>
    </div>

    <dialog
      ref="dialog"
      class="camera-dialog"
      :aria-label="t(name)"
      @close="expanded = false"
      @click="event => event.target === dialog && close()"
    >
      <header>
        <h2>{{ t(name) }}</h2>
        <div class="camera-controls">
          <button
            class="icon-button"
            type="button"
            :disabled="!hasMedia || capturing"
            :title="t('Schnappschuss speichern')"
            :aria-label="t('Schnappschuss von {0} speichern', [t(name)])"
            @click="captureSnapshot"
          >
            <Download :size="16" />
          </button>
          <button class="icon-button" type="button" :aria-label="t('Kamerabild schließen')" @click="close">
            <X :size="20" />
          </button>
        </div>
      </header>
      <div class="camera-expanded-image">
        <video
          v-if="expanded && isWebRtc"
          ref="modalVideo"
          :style="mediaStyle"
          :class="{ 'camera-stale': !isLive }"
          muted
          autoplay
          playsinline
          :aria-label="t('{0} Livestream', [t(name)])"
        />
        <img
          v-else-if="expanded && isMjpeg"
          :src="camera.frameUrl"
          :style="mediaStyle"
          :class="{ 'camera-stale': !isLive }"
          :alt="t('{0} Livestream', [t(name)])"
        />
      </div>
      <p>{{ badgeText }}</p>
    </dialog>
  </article>
</template>
