import { ControlError } from './control.mjs'
import { normalizeStatus, detectToolCount } from './status.mjs'

const CALIBRATION_TIMEOUT_MS = 2_700_000

export const calibrationActions = [
  'calibrate_nudge_ring',
  'calibrate_nudge_all',
  'calibrate_nudge_restore',
  'calibrate_beacon_z',
  'calibrate_beacon_all_z',
  'calibrate_beacon_abort',
  'calibrate_nozzle_expansion',
  'calibrate_reset_z_adjust',
  'calibrate_fine_qgl',
  'calibrate_gantry_twist',
  'calibrate_beacon_poke',
  'calibrate_shaper_foc',
  'mesh_profile_load',
  'mesh_profile_save',
  'mesh_profile_remove',
  'mesh_clear',
  'bed_screws_start',
  'bed_screws_accept',
  'bed_screws_adjusted',
  'bed_screws_abort',
  'screws_tilt_calculate',
  'calibrate_pid',
  'calibrate_shaper',
  'shaketune_shaper',
  'shaketune_belts',
  'shaketune_vibrations',
  'probe_accuracy',
  'probe_calibrate_start',
  'z_endstop_calibrate_start',
  'manual_probe_testz',
  'manual_probe_accept',
  'manual_probe_abort',
]

export const calibrationActionKeys = {
  calibrate_beacon_z: ['action', 'tool'],
  calibrate_beacon_all_z: ['action', 'probeTemp'],
  calibrate_nozzle_expansion: ['action', 'tool'],
  calibrate_shaper_foc: ['action', 'axis'],
  mesh_profile_load: ['action', 'profile'],
  mesh_profile_save: ['action', 'profile'],
  mesh_profile_remove: ['action', 'profile'],
  calibrate_pid: ['action', 'heater', 'target'],
  calibrate_shaper: ['action', 'axis'],
  manual_probe_testz: ['action', 'delta'],
}

export function calibrationCapabilities(config = {}) {
  const keys = new Set(Object.keys(config).map(k => k.toLowerCase()))
  const has = macro => keys.has(`gcode_macro ${macro.toLowerCase()}`)
  const hasProbe =
    keys.has('probe') ||
    keys.has('beacon') ||
    keys.has('bltouch') ||
    keys.has('scanner') ||
    keys.has('cartographer') ||
    [...keys].some(k => k.startsWith('probe_eddy_current'))
  return {
    nudgeRing: has('NUDGE_CALIBRATE_RING_XY'),
    nudgeAll: has('NUDGE_CALIBRATE_ALL_TOOLS_XY'),
    nudgeRestore: has('NUDGE_RESTORE_OFFSETS'),
    beaconZ: has('BEACON_CALIBRATE_Z'),
    beaconAllZ: has('BEACON_CALIBRATE_ALL_TOOLS_Z'),
    beaconAbort: has('BEACON_BATCH_ABORT'),
    nozzleExpansion: has('BEACON_CALIBRATE_NOZZLE_TEMP_OFFSET'),
    resetZAdjust: has('RESET_ALL_TOOL_Z_ADJUSTMENTS'),
    fineQgl: has('FINE_QUAD_GANTRY_LEVEL'),
    gantryTwist: has('BEACON_MEASURE_GANTRY_TWIST'),
    beaconPoke: has('BEACON_POKE_TEST'),
    shaperFoc: has('SHAPER_CALIBRATE_FOC'),
    bedScrews: keys.has('bed_screws'),
    screwsTilt: keys.has('screws_tilt_adjust'),
    resonanceTester: keys.has('resonance_tester'),
    shaketuneShaper: has('AXES_SHAPER_CALIBRATION'),
    shaketuneBelts: has('COMPARE_BELTS_RESPONSES'),
    shaketuneVibrations: has('CREATE_VIBRATIONS_PROFILE'),
    probeAccuracy: hasProbe,
    probeCalibrate: hasProbe,
    zEndstopCalibrate: keys.has('stepper_z'),
    pidExtruder: keys.has('extruder'),
    pidBed: keys.has('heater_bed'),
  }
}

function assertToolIndex(value, maxTool = 5) {
  if (!Number.isInteger(value) || value < 0 || value > maxTool) {
    throw new ControlError(`Ungültiges Werkzeug (erlaubt: T0 bis T${maxTool}).`, 400)
  }
  return value
}

function assertHomedXyz(raw) {
  const homed = raw?.toolhead?.homed_axes ?? ''
  if (![...'xyz'].every(axis => homed.includes(axis))) {
    throw new ControlError('Zuerst alle Achsen homen.', 409)
  }
}

function isBatchRunning(raw) {
  return Number(raw?.['gcode_macro _BEACON_BATCH_STATE']?.running) === 1
}

function assertMeshProfileName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,48}$/.test(value)) {
    throw new ControlError('Ungültiger Bed-Mesh-Profilname (erlaubt: Buchstaben, Ziffern, . _ -).', 400)
  }
  return value
}

export function calibrationCommand(input, raw, caps) {
  const { action } = input
  const printState = raw?.print_stats?.state
  if (['printing', 'paused'].includes(printState)) {
    throw new ControlError('Kalibrierung ist während eines aktiven oder pausierten Drucks gesperrt.', 409)
  }

  if (action === 'calibrate_beacon_abort') {
    if (!caps?.beaconAbort) throw new ControlError('Makro BEACON_BATCH_ABORT ist nicht konfiguriert.', 409)
    if (!isBatchRunning(raw)) throw new ControlError('Aktuell läuft keine Beacon-Batch-Kalibrierung.', 409)
    return {
      endpoint: '/printer/gcode/script',
      body: { script: 'BEACON_BATCH_ABORT' },
      label: 'Beacon-Batch abbrechen',
      async: true,
      timeoutMs: 60_000,
    }
  }

  if (['bed_screws_accept', 'bed_screws_adjusted', 'bed_screws_abort'].includes(action)) {
    if (raw?.bed_screws?.is_active !== true) {
      throw new ControlError('Aktuell läuft keine manuelle Bett-Schrauben-Kalibrierung.', 409)
    }
    const map = {
      bed_screws_accept: { script: 'ACCEPT', label: 'Schraube akzeptieren' },
      bed_screws_adjusted: { script: 'ADJUSTED', label: 'Schraube nachgestellt' },
      bed_screws_abort: { script: 'ABORT', label: 'Bett-Schrauben-Kalibrierung abbrechen' },
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: map[action].script },
      label: map[action].label,
      async: true,
      timeoutMs: 60_000,
    }
  }

  if (['manual_probe_testz', 'manual_probe_accept', 'manual_probe_abort'].includes(action)) {
    if (raw?.manual_probe?.is_active !== true) {
      throw new ControlError('Aktuell läuft keine manuelle Z-Offset-Kalibrierung (PROBE_CALIBRATE / Z_ENDSTOP_CALIBRATE).', 409)
    }
    if (action === 'manual_probe_testz') {
      const allowedDeltas = [-5, -1, -0.5, -0.1, -0.05, -0.025, -0.01, -0.005, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5]
      const rawDelta = input.delta
      let zArg = null
      if (rawDelta === '+' || rawDelta === '-') {
        zArg = rawDelta
      } else if (typeof rawDelta === 'number' && Number.isFinite(rawDelta)) {
        const matched = allowedDeltas.find(v => Math.abs(v - rawDelta) < 1e-6)
        if (matched != null) zArg = `${matched > 0 ? '+' : ''}${matched}`
      }
      if (!zArg) throw new ControlError('Ungültiger TESTZ-Schritt.', 400)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `TESTZ Z=${zArg}` },
        label: `TESTZ Z=${zArg}`,
        async: true,
        timeoutMs: 60_000,
      }
    }
    return {
      endpoint: '/printer/gcode/script',
      body: { script: action === 'manual_probe_accept' ? 'ACCEPT' : 'ABORT' },
      label: action === 'manual_probe_accept' ? 'Z-Offset übernehmen (ACCEPT)' : 'Z-Kalibrierung abbrechen',
      async: true,
      timeoutMs: 60_000,
    }
  }

  if (raw?.idle_timeout?.state === 'Printing') {
    throw new ControlError('Drucker führt gerade einen Befehl aus.', 409)
  }

  const requireCap = (flag, name) => {
    if (!caps?.[flag]) throw new ControlError(`Kalibriermakro ${name} ist nicht konfiguriert.`, 409)
  }

  switch (action) {
    case 'calibrate_nudge_ring':
      requireCap('nudgeRing', 'NUDGE_CALIBRATE_RING_XY')
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'NUDGE_CALIBRATE_RING_XY' },
        label: 'Nudge Ring XY-Kalibrierung',
        async: true,
        timeoutMs: CALIBRATION_TIMEOUT_MS,
        restartsKlipper: true,
      }

    case 'calibrate_nudge_all':
      requireCap('nudgeAll', 'NUDGE_CALIBRATE_ALL_TOOLS_XY')
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'NUDGE_CALIBRATE_ALL_TOOLS_XY' },
        label: 'Nudge Voll-XY-Kalibrierung',
        async: true,
        timeoutMs: CALIBRATION_TIMEOUT_MS,
        restartsKlipper: true,
      }

    case 'calibrate_nudge_restore':
      requireCap('nudgeRestore', 'NUDGE_RESTORE_OFFSETS')
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'NUDGE_RESTORE_OFFSETS' },
        label: 'Nudge-Offsets wiederherstellen',
        async: true,
        timeoutMs: 120_000,
      }

    case 'calibrate_beacon_z': {
      requireCap('beaconZ', 'BEACON_CALIBRATE_Z')
      const maxTool = Math.max(0, Math.min(7, (caps?.toolCount ?? detectToolCount(raw)) - 1))
      const tool = assertToolIndex(input.tool, maxTool)
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `BEACON_CALIBRATE_Z INITIAL_TOOL=${tool}` },
        label: `Beacon Z-Kalibrierung (Referenz T${tool})`,
        async: true,
        timeoutMs: CALIBRATION_TIMEOUT_MS,
      }
    }

    case 'calibrate_beacon_all_z': {
      requireCap('beaconAllZ', 'BEACON_CALIBRATE_ALL_TOOLS_Z')
      if (isBatchRunning(raw)) throw new ControlError('Beacon-Batch-Kalibrierung läuft bereits.', 409)
      assertHomedXyz(raw)
      const temp = input.probeTemp === undefined ? 150 : input.probeTemp
      if (!Number.isInteger(temp) || temp < 100 || temp > 220) {
        throw new ControlError('Messtemperatur muss zwischen 100 und 220 °C liegen.', 400)
      }
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `BEACON_CALIBRATE_ALL_TOOLS_Z PROBE_TEMP=${temp}` },
        label: `Beacon Z alle Tools (${temp} °C)`,
        async: true,
        timeoutMs: CALIBRATION_TIMEOUT_MS,
      }
    }

    case 'calibrate_nozzle_expansion': {
      requireCap('nozzleExpansion', 'BEACON_CALIBRATE_NOZZLE_TEMP_OFFSET')
      const maxTool = Math.max(0, Math.min(7, (caps?.toolCount ?? detectToolCount(raw)) - 1))
      const tool = assertToolIndex(input.tool, maxTool)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `BEACON_CALIBRATE_NOZZLE_TEMP_OFFSET INITIAL_TOOL=${tool}` },
        label: `Düsen-Ausdehnung T${tool}`,
        async: true,
        timeoutMs: CALIBRATION_TIMEOUT_MS,
      }
    }

    case 'calibrate_reset_z_adjust':
      requireCap('resetZAdjust', 'RESET_ALL_TOOL_Z_ADJUSTMENTS')
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'RESET_ALL_TOOL_Z_ADJUSTMENTS' },
        label: 'Z-Anpassungen zurücksetzen',
        async: true,
        timeoutMs: 60_000,
      }

    case 'calibrate_fine_qgl':
      requireCap('fineQgl', 'FINE_QUAD_GANTRY_LEVEL')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'FINE_QUAD_GANTRY_LEVEL' },
        label: 'Fein-QGL',
        async: true,
        timeoutMs: 600_000,
      }

    case 'calibrate_gantry_twist':
      requireCap('gantryTwist', 'BEACON_MEASURE_GANTRY_TWIST')
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'BEACON_MEASURE_GANTRY_TWIST' },
        label: 'Gantry-Twist messen',
        async: true,
        timeoutMs: 600_000,
      }

    case 'calibrate_beacon_poke':
      requireCap('beaconPoke', 'BEACON_POKE_TEST')
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'BEACON_POKE_TEST' },
        label: 'Beacon Poke-Test',
        async: true,
        timeoutMs: 300_000,
      }

    case 'calibrate_shaper_foc': {
      requireCap('shaperFoc', 'SHAPER_CALIBRATE_FOC')
      assertHomedXyz(raw)
      const axis = input.axis ?? 'ALL'
      if (!['X', 'Y', 'ALL'].includes(axis)) {
        throw new ControlError('Ungültige Achse (erlaubt: X, Y oder ALL).', 400)
      }
      const script = axis === 'ALL' ? 'SHAPER_CALIBRATE_FOC' : `SHAPER_CALIBRATE_FOC AXIS=${axis}`
      const axisLabel = axis === 'ALL' ? 'X + Y' : axis
      return {
        endpoint: '/printer/gcode/script',
        body: { script },
        label: `Input Shaper FOC (${axisLabel})`,
        async: true,
        timeoutMs: 900_000,
      }
    }

    case 'mesh_profile_load': {
      if (!caps?.mesh) throw new ControlError('Bed Mesh ist nicht konfiguriert.', 409)
      const profile = assertMeshProfileName(input.profile)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `BED_MESH_PROFILE LOAD="${profile}"` },
        label: `Bed Mesh laden · ${profile}`,
      }
    }

    case 'mesh_profile_save': {
      if (!caps?.mesh) throw new ControlError('Bed Mesh ist nicht konfiguriert.', 409)
      const profile = assertMeshProfileName(input.profile)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `BED_MESH_PROFILE SAVE="${profile}"` },
        label: `Bed Mesh speichern · ${profile}`,
      }
    }

    case 'mesh_profile_remove': {
      if (!caps?.mesh) throw new ControlError('Bed Mesh ist nicht konfiguriert.', 409)
      const profile = assertMeshProfileName(input.profile)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `BED_MESH_PROFILE REMOVE="${profile}"` },
        label: `Bed Mesh entfernen · ${profile}`,
      }
    }

    case 'mesh_clear':
      if (!caps?.mesh) throw new ControlError('Bed Mesh ist nicht konfiguriert.', 409)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'BED_MESH_CLEAR' },
        label: 'Aktives Bed Mesh entladen',
      }

    case 'bed_screws_start':
      requireCap('bedScrews', 'BED_SCREWS_ADJUST')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'BED_SCREWS_ADJUST' },
        label: 'Manuelle Bett-Schrauben-Kalibrierung',
        async: true,
        timeoutMs: 120_000,
      }

    case 'screws_tilt_calculate':
      requireCap('screwsTilt', 'SCREWS_TILT_CALCULATE')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'SCREWS_TILT_CALCULATE' },
        label: 'Schrauben-Neigung berechnen',
        async: true,
        timeoutMs: 300_000,
      }

    case 'calibrate_pid': {
      const heater = input.heater
      if (heater !== 'heater_bed' && !/^extruder([1-7])?$/.test(String(heater))) {
        throw new ControlError('Ungültiger Heizer für PID-Kalibrierung (erlaubt: extruder oder heater_bed).', 400)
      }
      const isBed = heater === 'heater_bed'
      const toolIdx = isBed ? -1 : heater === 'extruder' ? 0 : Number(heater.slice(8))
      if (isBed && !caps?.pidBed) throw new ControlError('Druckbett-Heizer ist nicht konfiguriert.', 409)
      if (!isBed) {
        const count = caps?.toolCount ?? detectToolCount(raw)
        if (!caps?.pidExtruder || toolIdx < 0 || toolIdx >= count) {
          throw new ControlError('Extruder ist auf diesem Drucker nicht konfiguriert.', 409)
        }
      }
      const max = isBed ? caps?.bedMax : caps?.toolMax?.[toolIdx]
      if (max == null) throw new ControlError('Temperaturgrenze ist unbekannt.', 409)
      const target = input.target
      if (!Number.isInteger(target) || target < 40 || target > max) {
        throw new ControlError(`PID-Zieltemperatur muss zwischen 40 und ${max} °C liegen.`, 400)
      }
      return {
        endpoint: '/printer/gcode/script',
        body: { script: `PID_CALIBRATE HEATER=${heater} TARGET=${target}` },
        label: `PID-Kalibrierung ${isBed ? 'Druckbett' : toolIdx === 0 ? 'Extruder' : `T${toolIdx}`} (${target} °C)`,
        async: true,
        timeoutMs: 900_000,
      }
    }

    case 'calibrate_shaper': {
      requireCap('resonanceTester', 'SHAPER_CALIBRATE')
      assertHomedXyz(raw)
      const axis = input.axis ?? 'ALL'
      if (!['X', 'Y', 'ALL'].includes(axis)) {
        throw new ControlError('Ungültige Achse (erlaubt: X, Y oder ALL).', 400)
      }
      const script = axis === 'ALL' ? 'SHAPER_CALIBRATE' : `SHAPER_CALIBRATE AXIS=${axis}`
      const axisLabel = axis === 'ALL' ? 'X + Y' : axis
      return {
        endpoint: '/printer/gcode/script',
        body: { script },
        label: `Input Shaper (${axisLabel})`,
        async: true,
        timeoutMs: 900_000,
      }
    }

    case 'shaketune_shaper':
      requireCap('shaketuneShaper', 'AXES_SHAPER_CALIBRATION')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'AXES_SHAPER_CALIBRATION' },
        label: 'ShakeTune · Achsen-Shaper',
        async: true,
        timeoutMs: 900_000,
      }

    case 'shaketune_belts':
      requireCap('shaketuneBelts', 'COMPARE_BELTS_RESPONSES')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'COMPARE_BELTS_RESPONSES' },
        label: 'ShakeTune · Riemen-Vergleich',
        async: true,
        timeoutMs: 900_000,
      }

    case 'shaketune_vibrations':
      requireCap('shaketuneVibrations', 'CREATE_VIBRATIONS_PROFILE')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'CREATE_VIBRATIONS_PROFILE' },
        label: 'ShakeTune · Vibrationsprofil',
        async: true,
        timeoutMs: 1_200_000,
      }

    case 'probe_accuracy':
      requireCap('probeAccuracy', 'PROBE_ACCURACY')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'PROBE_ACCURACY' },
        label: 'Probe-Genauigkeit testen',
        async: true,
        timeoutMs: 300_000,
      }

    case 'probe_calibrate_start':
      requireCap('probeCalibrate', 'PROBE_CALIBRATE')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'PROBE_CALIBRATE' },
        label: 'Probe-Z-Offset kalibrieren',
        async: true,
        timeoutMs: 120_000,
      }

    case 'z_endstop_calibrate_start':
      requireCap('zEndstopCalibrate', 'Z_ENDSTOP_CALIBRATE')
      assertHomedXyz(raw)
      return {
        endpoint: '/printer/gcode/script',
        body: { script: 'Z_ENDSTOP_CALIBRATE' },
        label: 'Z-Endstop kalibrieren',
        async: true,
        timeoutMs: 120_000,
      }

    default:
      throw new ControlError('Unbekannte Kalibrierungsaktion.', 400)
  }
}

export function validateShakeTuneImagePath(rawPath) {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed !== rawPath || trimmed.length > 300) return null
  if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return null
  if (/%2e|%2f|%5c|%00/i.test(trimmed)) return null
  if (!trimmed.startsWith('ShakeTune_results/')) return null
  if (!trimmed.toLowerCase().endsWith('.png')) return null
  const segments = trimmed.split('/')
  if (segments.some(seg => !seg || seg === '.' || seg === '..')) return null
  return trimmed
}

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const parseNum = value => {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}
const finitePair = pair =>
  Array.isArray(pair) && pair.length >= 2 && parseNum(pair[0]) != null && parseNum(pair[1]) != null
    ? [parseNum(pair[0]), parseNum(pair[1])]
    : null

function extractBedScrewNames(cfg) {
  if (!cfg || typeof cfg !== 'object') return []
  const names = []
  for (let i = 1; i <= 12; i++) {
    const coord = cfg[`screw${i}`]
    if (!coord) break
    const name = cfg[`screw${i}_name`]
    names.push({
      index: i,
      name: typeof name === 'string' && name.trim() ? name.trim() : `Screw ${i}`,
    })
  }
  return names
}

function normalizeBedMesh(mesh, meshConfig = null, allSettings = {}) {
  const cfg = meshConfig && typeof meshConfig === 'object'
    ? {
        probeCount: finitePair(meshConfig.probe_count),
        meshMin: finitePair(meshConfig.mesh_min),
        meshMax: finitePair(meshConfig.mesh_max),
        zeroReference: finitePair(meshConfig.zero_reference_position),
        algorithm: typeof meshConfig.algorithm === 'string' ? meshConfig.algorithm : null,
        fadeStart: parseNum(meshConfig.fade_start),
        fadeEnd: parseNum(meshConfig.fade_end),
      }
    : null

  const profileSet = new Set()
  if (mesh?.profiles && typeof mesh.profiles === 'object') {
    for (const name of Object.keys(mesh.profiles)) {
      if (typeof name === 'string' && name.trim()) profileSet.add(name.trim())
    }
  }
  if (allSettings && typeof allSettings === 'object') {
    for (const key of Object.keys(allSettings)) {
      if (key.toLowerCase().startsWith('bed_mesh ')) {
        const name = key.slice(9).trim()
        if (name) profileSet.add(name)
      }
    }
  }
  const profiles = [...profileSet].sort((a, b) => a.localeCompare(b))

  const profileName = typeof mesh?.profile_name === 'string' ? mesh.profile_name.trim() : ''
  const rawMatrix = Array.isArray(mesh?.probed_matrix) && mesh.probed_matrix.length > 0
    ? mesh.probed_matrix
    : Array.isArray(mesh?.mesh_matrix)
      ? mesh.mesh_matrix
      : []

  const matrix = rawMatrix
    .filter(row => Array.isArray(row) && row.length > 0)
    .map(row => row.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)))

  const values = matrix.flat().filter(v => v !== null)
  if (!profileName || values.length === 0) {
    return {
      active: false,
      profileName: '',
      profiles,
      min: null,
      max: null,
      range: null,
      meshMin: Array.isArray(mesh?.mesh_min) ? mesh.mesh_min : null,
      meshMax: Array.isArray(mesh?.mesh_max) ? mesh.mesh_max : null,
      matrix: [],
      config: cfg,
    }
  }

  let min = Infinity
  let max = -Infinity
  for (const val of values) {
    if (val < min) min = val
    if (val > max) max = val
  }

  return {
    active: true,
    profileName,
    profiles,
    min,
    max,
    range: max - min,
    meshMin: Array.isArray(mesh?.mesh_min) ? mesh.mesh_min : null,
    meshMax: Array.isArray(mesh?.mesh_max) ? mesh.mesh_max : null,
    matrix,
    config: cfg,
  }
}

export function normalizeCalibrationData({ rawStatus = {}, configFiles = [] } = {}) {
  const status = normalizeStatus(rawStatus)
  const vars = rawStatus?.save_variables?.variables ?? {}
  const settings = rawStatus?.configfile?.settings ?? rawStatus?.configfile?.config ?? {}
  const shaper = settings.input_shaper ?? {}

  const toolCount = status.toolCount ?? 6
  const tools = Array.from({ length: toolCount }, (_, id) => {
    const t = status.tools[id] ?? {}
    return {
      id,
      offsets: t.offsets ?? { x: null, y: null, z: null },
      relativeZ: t.relativeZ ?? null,
      zAdjust: finite(vars[`tool_z_adjust_t${id}`]),
      expansionCoeff: finite(vars[`nozzle_expansion_coefficient_t${id}`]),
      pressureAdvance: t.pressureAdvance ?? null,
    }
  })

  const closureRaw = vars.nudge_ring_closure
  const nudgeRingClosure =
    Array.isArray(closureRaw) && finite(closureRaw[0]) !== null && finite(closureRaw[1]) !== null
      ? { x: closureRaw[0], y: closureRaw[1] }
      : null

  const nudgeXy = Array.from({ length: toolCount }, (_, i) =>
    Array.from({ length: toolCount }, (_, j) => {
      if (i === j) return null
      const pair = vars[`nudge_xy_${i}_${j}`]
      return Array.isArray(pair) && finite(pair[0]) !== null && finite(pair[1]) !== null ? [pair[0], pair[1]] : null
    }),
  )

  const beaconZ = Array.from({ length: toolCount }, (_, i) =>
    Array.from({ length: toolCount }, (_, j) => {
      if (i === j) return 0
      return finite(vars[`tool_z_offset_t${i}_t${j}`])
    }),
  )

  const batch = rawStatus?.['gcode_macro _BEACON_BATCH_STATE'] ?? {}
  const beaconBatch = {
    running: Number(batch.running) === 1,
    currentInitial: Number.isFinite(Number(batch.current_initial)) ? Number(batch.current_initial) : 0,
    currentMeasure: Number.isFinite(Number(batch.current_measure)) ? Number(batch.current_measure) : 0,
    totalMeasurements: Number.isFinite(Number(batch.total_measurements)) ? Number(batch.total_measurements) : 0,
    totalTarget: 30,
  }

  const shakeTune = (Array.isArray(configFiles) ? configFiles : [])
    .map(file => {
      const valid = validateShakeTuneImagePath(file?.path)
      if (!valid) return null
      const parts = valid.split('/')
      const folder = parts[1] ?? 'other'
      const category = ['input_shaper', 'belts', 'vibrations'].includes(folder) ? folder : 'other'
      return {
        path: valid,
        name: parts.at(-1),
        category,
        size: Number.isFinite(file.size) ? file.size : null,
        modified: Number.isFinite(file.modified) ? file.modified : null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))

  const extruderMaxRaw = parseNum(settings.extruder?.max_temp)
  const bedMaxRaw = parseNum(settings.heater_bed?.max_temp)

  return {
    isToolchanger: status.isToolchanger,
    toolCount,
    initialTool: status.initialTool,
    zReferenceTool: Number.isInteger(vars.z_offset_reference_tool) ? vars.z_offset_reference_tool : null,
    saveConfigPending: rawStatus?.configfile?.save_config_pending === true,
    pidLimits: {
      extruderMax: extruderMaxRaw != null ? Math.max(0, Math.floor(extruderMaxRaw) - 5) : null,
      bedMax: bedMaxRaw != null ? Math.max(0, Math.floor(bedMaxRaw) - 5) : null,
    },
    tools,
    nudgeRingClosure,
    nudgeXy,
    beaconZ,
    beaconBatch,
    bedMesh: normalizeBedMesh(rawStatus?.bed_mesh, settings.bed_mesh, settings),
    bedScrews: {
      configured: Boolean(settings.bed_screws || rawStatus?.bed_screws),
      isActive: rawStatus?.bed_screws?.is_active === true,
      state: typeof rawStatus?.bed_screws?.state === 'string' ? rawStatus.bed_screws.state : null,
      currentStage: Number.isInteger(rawStatus?.bed_screws?.current_stage) ? rawStatus.bed_screws.current_stage : null,
      acceptedScrews: Number.isInteger(rawStatus?.bed_screws?.accepted_screws)
        ? rawStatus.bed_screws.accepted_screws
        : 0,
      screws: extractBedScrewNames(settings.bed_screws),
    },
    screwsTilt: {
      configured: Boolean(settings.screws_tilt_adjust || rawStatus?.screws_tilt_adjust),
      error: rawStatus?.screws_tilt_adjust?.error === true,
      maxDeviation: finite(rawStatus?.screws_tilt_adjust?.max_deviation),
      results:
        rawStatus?.screws_tilt_adjust?.results && typeof rawStatus.screws_tilt_adjust.results === 'object'
          ? rawStatus.screws_tilt_adjust.results
          : null,
    },
    manualProbe: {
      isActive: rawStatus?.manual_probe?.is_active === true,
      zPosition: finite(rawStatus?.manual_probe?.z_position),
      zPositionLower: finite(rawStatus?.manual_probe?.z_position_lower),
      zPositionUpper: finite(rawStatus?.manual_probe?.z_position_upper),
    },
    qgl: {
      configured: !!settings.quad_gantry_level,
      applied: rawStatus?.quad_gantry_level?.applied === true,
      retries: parseNum(settings.quad_gantry_level?.retries),
      retryTolerance: parseNum(settings.quad_gantry_level?.retry_tolerance),
      horizontalMoveZ: parseNum(settings.quad_gantry_level?.horizontal_move_z),
    },
    zTilt: {
      configured: !!settings.z_tilt,
      applied: rawStatus?.z_tilt?.applied === true,
      retries: parseNum(settings.z_tilt?.retries),
      retryTolerance: parseNum(settings.z_tilt?.retry_tolerance),
      horizontalMoveZ: parseNum(settings.z_tilt?.horizontal_move_z),
    },
    beacon: {
      model: typeof rawStatus?.beacon?.model === 'string' ? rawStatus.beacon.model : null,
      coilTemp: finite(rawStatus?.['temperature_sensor beacon_coil']?.temperature)
        ?? finite(rawStatus?.beacon?.last_received_sample?.temp),
      lastFreq: finite(rawStatus?.beacon?.last_received_sample?.freq),
    },
    inputShaper: {
      x: {
        type: typeof shaper.shaper_type_x === 'string' ? shaper.shaper_type_x : (shaper.shaper_type ?? null),
        freq: parseNum(shaper.shaper_freq_x),
        damping: parseNum(shaper.damping_ratio_x),
      },
      y: {
        type: typeof shaper.shaper_type_y === 'string' ? shaper.shaper_type_y : (shaper.shaper_type ?? null),
        freq: parseNum(shaper.shaper_freq_y),
        damping: parseNum(shaper.damping_ratio_y),
      },
    },
    capabilities: {
      qgl: !!settings.quad_gantry_level,
      zTilt: !!settings.z_tilt,
      mesh: !!settings.bed_mesh,
      ...calibrationCapabilities(settings),
    },
    shakeTune,
  }
}
