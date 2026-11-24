<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Camera, RefreshCw, Expand, X } from '@lucide/vue'
import { t } from '../i18n.mjs'
import { useCameras } from '../useCameras.js'

const props = defineProps({
  id: String,
  name: String,
  description: String,
})

const cameras = useCameras()
const camera = cameras.getCamera(props.id)

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
        <span>{{ t(description) }}</span>
      </div>
      <div class="camera-controls">
        <button
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
        :class="{ 'camera-stale': !isLive }"
        muted
        autoplay
        playsinline
        :aria-label="t('{0} Livestream', [t(name)])"
      />
      <img
        v-else-if="isMjpeg"
        :src="camera.frameUrl"
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
      @close="expanded = false"
      @click="event => event.target === dialog && close()"
    >
      <header>
        <h2>{{ t(name) }}</h2>
        <button class="icon-button" type="button" :aria-label="t('Kamerabild schließen')" @click="close">
          <X :size="20" />
        </button>
      </header>
      <div class="camera-expanded-image">
        <video
          v-if="expanded && isWebRtc"
          ref="modalVideo"
          :class="{ 'camera-stale': !isLive }"
          muted
          autoplay
          playsinline
          :aria-label="t('{0} Livestream', [t(name)])"
        />
        <img
          v-else-if="expanded && isMjpeg"
          :src="camera.frameUrl"
          :class="{ 'camera-stale': !isLive }"
          :alt="t('{0} Livestream', [t(name)])"
        />
      </div>
      <p>{{ badgeText }}</p>
    </dialog>
  </article>
</template>
