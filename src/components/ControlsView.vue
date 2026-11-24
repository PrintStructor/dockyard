<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { Home, Move, Thermometer, Power, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Snowflake, Check } from '@lucide/vue'
import { t, locale } from '../i18n.mjs'
import FanControl from './FanControl.vue'
import CameraView from './CameraView.vue'
import TemperatureGraph from './TemperatureGraph.vue'

const props = defineProps({
  status: Object,
  online: Boolean,
  pending: Boolean,
  selected: Number,
  send: Function,
})

const emit = defineEmits(['command', 'select', 'refresh', 'context'])

const step = ref(1)
const allTools = ref(false)
const drafts = ref({})
const submitted = ref({})
const confirmMotors = ref(false)
let confirmMotorsTimer = null

const heaterName = computed(() => (allTools.value ? 'Alle Tools T0–T5' : `Werkzeug T${props.selected}`))
const heaterMax = computed(() => {
  const limits = props.status?.capabilities?.toolMax
  return allTools.value
    ? limits?.length === 6 && limits.every(Number.isFinite)
      ? Math.min(...limits)
      : null
    : limits?.[props.selected]
})

const presetTarget = preset =>
  allTools.value
    ? preset.tools.every(value => value === preset.tools[0])
      ? preset.tools[0]
      : null
    : preset.tools[props.selected]

const liveTarget = id => (id === 'bed' ? props.status?.bed?.target : props.status?.tools?.[id]?.target)
const draftValue = id => drafts.value[id] ?? (liveTarget(id) == null ? '' : String(Math.round(liveTarget(id))))
const limitFor = id => (id === 'bed' ? props.status?.capabilities?.bedMax : props.status?.capabilities?.toolMax?.[id])
const dirty = id => drafts.value[id] != null && (drafts.value[id] === '' || Number(drafts.value[id]) !== liveTarget(id))
const valid = id =>
  draftValue(id) !== '' &&
  Number.isInteger(Number(draftValue(id))) &&
  Number(draftValue(id)) >= 0 &&
  limitFor(id) != null &&
  Number(draftValue(id)) <= limitFor(id)

function selectHeater(id) {
  allTools.value = false
  emit('select', id)
}

function toggleAllTools() {
  allTools.value = !allTools.value
}

function editTarget(id, value) {
  drafts.value[id] = value
  if (id !== 'bed') selectHeater(id)
}

function acknowledgeTargets() {
  for (const [id, value] of Object.entries(submitted.value)) {
    if (liveTarget(id) === value) {
      if (Number(drafts.value[id]) === value) delete drafts.value[id]
      delete submitted.value[id]
    }
  }
}

watch(() => [props.status?.bed?.target, ...(props.status?.tools ?? []).map(tool => tool.target)], acknowledgeTargets)

async function applyTarget(id) {
  if (!enabled.value || !valid(id) || !dirty(id)) return
  const target = Number(draftValue(id))
  const ok = await props.send({
    action: 'temperature',
    heater: id === 'bed' ? 'heater_bed' : Number(id) ? `extruder${id}` : 'extruder',
    target,
  })
  if (ok) {
    submitted.value[id] = target
    acknowledgeTargets()
  }
}

const selectedIds = computed(() => (allTools.value ? [0, 1, 2, 3, 4, 5] : [props.selected]))

function stagePreset(target) {
  if (target != null) selectedIds.value.forEach(id => { drafts.value[id] = String(target) })
}

const groupReady = computed(
  () =>
    selectedIds.value.every(valid) &&
    selectedIds.value.some(dirty) &&
    selectedIds.value.every(id => Number(draftValue(id)) === Number(draftValue(selectedIds.value[0]))),
)

async function heatTools() {
  if (!groupReady.value || !enabled.value || (allTools.value && moving.value)) return
  if (!allTools.value) return applyTarget(props.selected)
  const target = Number(draftValue(0))
  const ids = [...selectedIds.value]
  const ok = await props.send({ action: 'temperature_all', target })
  if (ok) {
    ids.forEach(id => { submitted.value[id] = target })
    acknowledgeTargets()
  }
}

function coolAll() {
  if (!canCooldown.value) return
  drafts.value = {}
  submitted.value = {}
  emit('command', { action: 'heaters_off' })
}

async function coolBed() {
  if (await props.send({ action: 'temperature', heater: 'heater_bed', target: 0 })) {
    delete drafts.value.bed
    delete submitted.value.bed
  }
}

function resetMotorsConfirm() {
  confirmMotors.value = false
  clearTimeout(confirmMotorsTimer)
  confirmMotorsTimer = null
}

function releaseMotors() {
  if (!motion.value) return
  if (props.status?.qglApplied && !confirmMotors.value) {
    confirmMotors.value = true
    clearTimeout(confirmMotorsTimer)
    confirmMotorsTimer = setTimeout(resetMotorsConfirm, 5000)
    return
  }
  resetMotorsConfirm()
  emit('command', { action: 'motors_off' })
}

const presets = ref([])
const presetError = ref('')
const presetRequest = new AbortController()

onMounted(async () => {
  try {
    const response = await fetch('/api/presets', {
      signal: AbortSignal.any([presetRequest.signal, AbortSignal.timeout(7000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    presets.value = data.presets
    if (!data.presets.length) presetError.value = 'Keine ABS-, PLA- oder PETG-Presets in Voyager gespeichert.'
  } catch (error) {
    if (error.name !== 'AbortError') presetError.value = 'Voyager-Presets gerade nicht erreichbar.'
  }
})

onBeforeUnmount(() => {
  presetRequest.abort()
  resetMotorsConfirm()
})

const busy = computed(() => props.pending || !!props.status?.control?.job)
const enabled = computed(() => props.online && props.status?.klipperState === 'ready' && !busy.value)
const isPrinting = computed(() => props.status?.printState === 'printing')
const canCooldown = computed(() => enabled.value && !isPrinting.value)
const moving = computed(
  () => ['printing', 'paused'].includes(props.status?.printState) || props.status?.idleState === 'Printing' || props.status?.loadWatchActive,
)
const motion = computed(() => enabled.value && !moving.value && !props.status?.detectionMismatch)
const homing = computed(
  () => enabled.value && !moving.value && (!props.status?.detectionMismatch || props.status?.homingCanInitialize),
)
const homed = axis => props.status?.homedAxes?.includes(axis) === true
const allHomed = computed(() => [...'xyz'].every(homed))

const position = axis => {
  const index = ['x', 'y', 'z'].indexOf(axis)
  const value = props.status?.position?.[index]
  return homed(axis) && value != null ? value.toLocaleString(locale.value, { maximumFractionDigits: 2 }) : '—'
}

const temperature = value => (value == null ? '—' : Math.round(value))

function canJog(axis, direction) {
  if (!motion.value || !homed(axis)) return false
  const i = ['x', 'y', 'z'].indexOf(axis)
  const pos = props.status?.position?.[i]
  const min = props.status?.axisMinimum?.[i]
  const max = props.status?.axisMaximum?.[i]
  return [pos, min, max].every(Number.isFinite) && pos + step.value * direction >= min && pos + step.value * direction <= max
}

const jog = (axis, sign) => emit('command', { action: 'jog', axis, distance: step.value * sign })

const restriction = computed(() => {
  if (!props.online) return 'Bedienung gesperrt: keine aktuellen Druckerdaten.'
  if (props.status?.klipperState !== 'ready') return 'Klipper ist nicht bereit.'
  if (busy.value) return props.status?.control?.job?.label ?? 'Befehl läuft …'
  if (props.status?.loadWatchActive) return 'Einlegehilfe ist scharf. Unter Werkzeuge mit Fertig beenden.'
  if (moving.value) return 'Bewegungen sind während eines Drucks, einer Pause oder laufender Befehle gesperrt.'
  if (props.status?.homingCanInitialize) return 'Homen ist bereit. Dein Beacon-Makro initialisiert das erkannte Tool vor dem Z-Homen.'
  if (props.status?.detectionMismatch) return 'Werkzeugerkennung prüfen, bevor du bewegst.'
  if (!allHomed.value) return 'Noch nicht alle Achsen referenziert. Zuerst homen, dann bewegen.'
  return 'Achsen referenziert. Bewegungsschritte werden in Millimetern ausgeführt.'
})

watch(restriction, value => emit('context', value), { immediate: true })
watch(motion, allowed => {
  if (!allowed) resetMotorsConfirm()
})
</script>

<template>
  <section class="operation-layout" :aria-label="t('Drucker bedienen')">
    <div class="controls-layout">
      <article class="control-panel motion-panel">
        <h2><Move :size="20" />{{ t('Achsen & Bewegung') }}</h2>
        <div class="axis-readings">
          <div v-for="axis in ['x', 'y', 'z']" :key="axis">
            <span>{{ axis.toUpperCase() }}</span>
            <strong>{{ position(axis) }} <small>mm</small></strong>
            <span :class="{ 'text-lime': homed(axis) }">
              {{ homed(axis) ? t('Referenziert') : t('Nicht referenziert') }}
            </span>
          </div>
        </div>

        <div class="homing-buttons">
          <button
            class="primary-control"
            type="button"
            :disabled="!homing"
            @click="emit('command', { action: 'home', axis: 'all' })"
          >
            <Home :size="17" />{{ t('Alle homen') }}
          </button>
          <button
            v-for="axis in ['x', 'y', 'z']"
            :key="axis"
            class="subtle-button"
            type="button"
            :disabled="!homing || (axis === 'z' && !(homed('x') && homed('y')))"
            @click="emit('command', { action: 'home', axis })"
          >
            {{ t('{0} homen', [axis.toUpperCase()]) }}
          </button>
        </div>

        <div class="jog-heading">
          <h3>{{ t('Bewegen') }}</h3>
          <div class="segmented" :aria-label="t('Schrittweite')">
            <button
              v-for="value in [0.1, 1, 10, 25, 50, 100]"
              :key="value"
              type="button"
              :aria-pressed="step === value"
              @click="step = value"
            >
              {{ value.toLocaleString(locale) }} mm
            </button>
          </div>
        </div>

        <div class="jog-controls">
          <div class="xy-pad">
            <button class="jog y-plus" type="button" :disabled="!canJog('y', 1)" @click="jog('y', 1)">
              <ArrowUp :size="18" />Y+
            </button>
            <button class="jog x-minus" type="button" :disabled="!canJog('x', -1)" @click="jog('x', -1)">
              <ArrowLeft :size="18" />X−
            </button>
            <span class="pad-center">XY</span>
            <button class="jog x-plus" type="button" :disabled="!canJog('x', 1)" @click="jog('x', 1)">
              X+<ArrowRight :size="18" />
            </button>
            <button class="jog y-minus" type="button" :disabled="!canJog('y', -1)" @click="jog('y', -1)">
              <ArrowDown :size="18" />Y−
            </button>
          </div>

          <div class="z-pad">
            <button class="jog" type="button" :disabled="!canJog('z', 1)" @click="jog('z', 1)">
              <ArrowUp :size="18" />Z+
            </button>
            <span class="pad-center">Z</span>
            <button class="jog" type="button" :disabled="!canJog('z', -1)" @click="jog('z', -1)">
              <ArrowDown :size="18" />Z−
            </button>
          </div>

          <div class="motion-actions">
            <button
              class="subtle-button"
              :class="{ 'confirm-danger': confirmMotors }"
              type="button"
              :disabled="!motion"
              :title="
                confirmMotors
                  ? t('Erneut klicken zum Bestätigen · QGL muss danach erneut ausgeführt werden')
                  : status?.qglApplied
                    ? t('Motoren lösen · Gantry senkt sich ab (QGL geht verloren)')
                    : t('Motoren lösen')
              "
              @click="releaseMotors"
              @blur="resetMotorsConfirm"
              @keydown.esc="resetMotorsConfirm"
            >
              <Power :size="16" />{{ confirmMotors ? t('Wirklich lösen?') : t('Motoren lösen') }}
            </button>
            <button
              class="subtle-button"
              :class="{ calibrated: status?.qglApplied }"
              type="button"
              :disabled="!motion || !allHomed || !status?.capabilities?.qgl"
              :title="
                status?.qglApplied ? t('Bereits ausgerichtet · QGL erneut ausführen') : t('Gantry ausrichten')
              "
              :aria-label="
                status?.qglApplied
                  ? t('Gantry bereits ausgerichtet. QGL erneut ausführen')
                  : t('Gantry ausrichten · QGL')
              "
              @click="emit('command', { action: 'qgl' })"
            >
              QGL<Check v-if="status?.qglApplied" :size="13" />
            </button>
            <button
              class="subtle-button"
              type="button"
              :disabled="!motion || !allHomed || !status?.capabilities?.mesh"
              :title="t('Bett vermessen')"
              :aria-label="t('Bett vermessen')"
              @click="emit('command', { action: 'mesh' })"
            >
              Bed Mesh
            </button>
          </div>
        </div>
      </article>

      <article class="control-panel heat-panel">
        <div class="heat-toolbar">
          <h2><Thermometer :size="18" />{{ t('Werkzeuge') }}</h2>
          <button
            type="button"
            class="subtle-button all-tools-control"
            :aria-pressed="allTools"
            @click="toggleAllTools"
          >
            {{ t('Alle Tools') }}
          </button>
          <button
            class="subtle-button cooldown-control"
            type="button"
            :disabled="!canCooldown"
            :aria-label="t('Cooldown · alle Heizungen aus')"
            :title="
              isPrinting
                ? t('Cooldown ist während eines laufenden Drucks gesperrt. Bei einer Druckpause ist Cooldown verfügbar.')
                : t('Alle Heizungen ausschalten')
            "
            @click="coolAll"
          >
            <Snowflake :size="15" />Cooldown
          </button>
        </div>

        <p
          v-if="online && !status?.detectionMismatch && (!status?.hasDetection || status?.detected == null)"
          class="tool-detection-note"
        >
          {{ !status?.hasDetection ? t('Werkzeugerkennung nicht verfügbar.') : t('Kein Werkzeug verbunden.') }}
        </p>

        <div class="temperature-list" :aria-label="t('Werkzeug zum Heizen auswählen')">
          <div class="temperature-list-label">
            <span>{{ allTools ? t('Alle sechs ausgewählt') : t('Einzelnes Werkzeug wählen') }}</span>
            <span>{{ t('Ist / Ziel') }}</span>
          </div>
          <form
            v-for="id in [0, 1, 2, 3, 4, 5]"
            :key="id"
            class="temperature-row editable-temperature"
            :class="{ selected: allTools || selected === id, dirty: dirty(id) }"
            @submit.prevent="applyTarget(id)"
          >
            <button
              type="button"
              class="temperature-tool-name"
              :aria-pressed="allTools || selected === id"
              @click="selectHeater(id)"
            >
              {{ t('Werkzeug T') }}{{ id }}
              <small
                v-if="online && status?.hasDetection && !status?.detectionConflict && status?.detected === id"
                class="connected-tool-label"
              >
                {{ t('Verbunden') }}
              </small>
            </button>
            <span class="temperature-reading">{{ temperature(status?.tools?.[id]?.temperature) }}<small> / </small></span>
            <input
              :aria-label="t('Zieltemperatur für Werkzeug T{0} in Grad Celsius', [id])"
              :title="t('Aktuelles Ziel: {0} °C · Enter übernimmt, Escape verwirft', [temperature(liveTarget(id))])"
              type="number"
              :value="draftValue(id)"
              min="0"
              :max="limitFor(id)"
              step="1"
              required
              inputmode="numeric"
              :disabled="!enabled || limitFor(id) == null"
              placeholder="—"
              @input="editTarget(id, $event.target.value)"
              @keydown.esc="delete drafts[id]"
            />
            <small class="temperature-unit">°C</small>
            <button
              class="apply-temperature"
              type="submit"
              :disabled="!enabled || !valid(id) || !dirty(id)"
              :aria-label="t('Zieltemperatur für T{0} übernehmen', [id])"
              :title="t('Zieltemperatur übernehmen')"
            >
              <Check :size="14" />
            </button>
          </form>
        </div>

        <form class="heater-editor" @submit.prevent="heatTools">
          <p class="preset-selection">{{ t(heaterName) }}</p>
          <div class="temperature-presets tool-presets" :aria-label="t('{0}-Presets', [t(heaterName)])">
            <button
              v-for="preset in presets"
              :key="preset.name"
              type="button"
              :disabled="presetTarget(preset) == null || heaterMax == null || presetTarget(preset) > heaterMax"
              @click="stagePreset(presetTarget(preset))"
            >
              {{ preset.name }}<span>{{ presetTarget(preset) ?? '—' }} °C</span>
            </button>
            <button type="button" :disabled="heaterMax == null || heaterMax < 140" @click="stagePreset(140)">
              Preheat<span>140 °C</span>
            </button>
          </div>
          <button class="subtle-button preset-apply" :disabled="!enabled || !groupReady || (allTools && moving)">
            {{ allTools ? t('Alle übernehmen') : t('T{0} übernehmen', [selected]) }}
          </button>
        </form>

        <form class="bed-editor" @submit.prevent="applyTarget('bed')">
          <div class="heat-heading">
            <h3>{{ t('Druckbett') }}</h3>
            <div class="bed-temperature-entry">
              <span>{{ temperature(status?.bed?.temperature) }} /</span>
              <input
                :aria-label="t('Zieltemperatur für das Druckbett in Grad Celsius')"
                :title="t('Aktuelles Ziel: {0} °C', [temperature(liveTarget('bed'))])"
                :value="draftValue('bed')"
                type="number"
                min="0"
                :max="limitFor('bed')"
                step="1"
                required
                inputmode="numeric"
                :disabled="!enabled || limitFor('bed') == null"
                placeholder="—"
                @input="editTarget('bed', $event.target.value)"
                @keydown.esc="delete drafts.bed"
              />
              <small>°C</small>
              <button
                class="apply-temperature"
                type="submit"
                :disabled="!enabled || !valid('bed') || !dirty('bed')"
                :aria-label="t('Zieltemperatur für das Druckbett übernehmen')"
                :title="t('Zieltemperatur übernehmen')"
              >
                <Check :size="14" />
              </button>
            </div>
          </div>

          <div class="bed-preset-actions">
            <div class="temperature-presets" :aria-label="t('Druckbett-Presets')">
              <button
                v-for="preset in presets"
                :key="preset.name"
                type="button"
                :disabled="preset.bed == null || limitFor('bed') == null || preset.bed > limitFor('bed')"
                @click="drafts.bed = String(preset.bed)"
              >
                {{ preset.name }}<span>{{ preset.bed ?? '—' }} °C</span>
              </button>
            </div>
            <button
              type="button"
              class="subtle-button"
              :disabled="!enabled || limitFor('bed') == null"
              :title="t('Nur das Druckbett ausschalten')"
              :aria-label="t('Cooldown nur für das Druckbett')"
              @click="coolBed"
            >
              <Snowflake :size="14" />Cooldown
            </button>
          </div>
        </form>

        <p v-if="presetError" class="preset-note">{{ t(presetError) }}</p>
      </article>

      <TemperatureGraph :online="online" :status="status" />
    </div>

    <aside class="control-cameras" :aria-label="t('Livekameras während der Bedienung')">
      <CameraView id="tophat" name="Tophat" description="Bauraum" />
      <CameraView id="heatbed" name="Druckbett" description="Druckfläche" />
      <FanControl :status="status" :online="online" :pending="pending" :send="send" />
    </aside>
  </section>
</template>
