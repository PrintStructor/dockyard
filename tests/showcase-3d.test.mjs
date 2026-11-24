import test from 'node:test'
import assert from 'node:assert/strict'
import { computeLayerToolBands } from '../src/layer-ribbon.mjs'
import { nozzleThermalGlow } from '../src/thermal.mjs'
import { maintenanceRestriction } from '../src/tool-action-state.mjs'

function encodeSegments(list) {
  const arr = new Float32Array(list.length * 8)
  list.forEach(({ layer, tool, support = false, len = 10 }, i) => {
    const o = i * 8
    arr[o] = 0
    arr[o + 1] = 0
    arr[o + 2] = len
    arr[o + 3] = 0
    arr[o + 4] = layer * 0.2
    arr[o + 5] = 0.45
    arr[o + 6] = 0.2
    arr[o + 7] = layer * 16 + tool * 2 + (support ? 1 : 0)
  })
  return arr
}

test('computeLayerToolBands merges contiguous tool runs, prioritizes non-support extrusion, and counts tool changes', () => {
  const segments = encodeSegments([
    { layer: 1, tool: 0, len: 20 },
    { layer: 1, tool: 1, support: true, len: 40 }, // support should not override model wall tool
    { layer: 2, tool: 0, len: 18 },
    { layer: 3, tool: 2, len: 25 },
    { layer: 4, tool: 2, len: 30 },
    { layer: 5, tool: 4, len: 15 },
  ])
  const result = computeLayerToolBands(segments, 5)
  assert.deepEqual(result.bands, [
    { startLayer: 1, endLayer: 2, tool: 0 },
    { startLayer: 3, endLayer: 4, tool: 2 },
    { startLayer: 5, endLayer: 5, tool: 4 },
  ])
  assert.deepEqual(result.toolsUsed, [0, 2, 4])
  assert.equal(result.toolChanges, 2)

  assert.deepEqual(computeLayerToolBands(null, 0), { bands: [], toolsUsed: [], toolChanges: 0 })
})

test('nozzleThermalGlow stays dark below 50 C, quantizes in 5 C buckets, and scales into warm amber', () => {
  assert.equal(nozzleThermalGlow(34, true).active, false)
  assert.equal(nozzleThermalGlow(240, false).active, false)
  assert.equal(nozzleThermalGlow(null, true).active, false)

  const warm = nozzleThermalGlow(63, true)
  const warmSameBucket = nozzleThermalGlow(64.9, true)
  assert.equal(warm.active, true)
  assert.equal(warm.bucket, 60)
  assert.equal(warm.bucket, warmSameBucket.bucket)
  assert.equal(warm.intensity, warmSameBucket.intensity)

  const hot = nozzleThermalGlow(245, true)
  assert.equal(hot.active, true)
  assert.equal(hot.bucket, 245)
  assert.ok(hot.intensity > warm.intensity)
  assert.equal(hot.poolHex, '#f3c67b')
})

test('maintenanceRestriction reports partial filament blockers even when Clean is enabled', () => {
  const baseStatus = {
    klipperState: 'ready',
    printState: 'standby',
    idleState: 'Idle',
    homedAxes: 'xyz',
    hasDetection: true,
    detectionMismatch: false,
    detectionConflict: false,
    toolchangerState: 'ready',
    active: 0,
    detected: 0,
    position: [100, 100, 20],
    loadWatchActive: false,
    tools: Array.from({ length: 6 }, (_, id) => ({
      id,
      filamentEnabled: true,
      filamentDetected: id === 1,
    })),
    capabilities: {
      toolActions: { load: true, unload: true, clean: true, purge: true, park: true, pickup: true, select: true },
      toolSelect: [true, true, true, true, true, true],
      filamentDefaults: { load: 240, unload: 240 },
      extrusionMin: [170, 170, 170, 170, 170, 170],
      toolMax: [300, 300, 300, 300, 300, 300],
    },
  }

  // Tool 0 has no filament -> Clean is enabled, Load/Unload/Purge blocked -> partial restriction surfaced!
  const partial = maintenanceRestriction(baseStatus, 0, true, false)
  assert.deepEqual(partial?.actions, ['Laden', 'Entladen', 'Purge'])
  assert.match(partial?.reason ?? '', /Filament am Eingang/)

  // Tool 1 has filament -> all 4 enabled -> null
  assert.equal(maintenanceRestriction(baseStatus, 1, true, false), null)

  // Unhomed -> all 4 blocked globally
  const unhomed = { ...baseStatus, homedAxes: '' }
  const globalBlock = maintenanceRestriction(unhomed, 1, true, false)
  assert.deepEqual(globalBlock?.actions, [])
  assert.match(globalBlock?.reason ?? '', /alle Achsen homen/)
})
