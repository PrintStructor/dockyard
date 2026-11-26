import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_PRESETS,
  DEFAULT_ACCENT_COLOR,
  ACCENT_SWATCHES,
  TEMPLATE_URLS,
  normalizeAccentColor,
  resolveSceneConfig,
} from '../src/model-config.mjs'

const printerMeta = {
  filename: 'voron24-350.glb',
  bytes: 3_500_000,
  updatedAt: '2026-11-26T10:32:00.000Z',
  etag: '"abc123"',
}
const toolheadMeta = {
  filename: 'crucible-head.glb',
  bytes: 420_000,
  updatedAt: '2026-11-26T10:35:00.000Z',
  etag: '"def456"',
}

test('constants and normalizeAccentColor match spec', () => {
  assert.deepEqual(MODEL_PRESETS, ['auto', 'stormtrooper-6tc', 'stealthburner', 'mini-stealthburner', 'custom', 'none'])
  assert.equal(DEFAULT_ACCENT_COLOR, '#c5f76b')
  assert.equal(ACCENT_SWATCHES.length, 7)
  assert.equal(TEMPLATE_URLS.stealthburner, '/models/templates/stealthburner.glb')
  assert.equal(TEMPLATE_URLS['mini-stealthburner'], '/models/templates/mini-stealthburner.glb')
  assert.equal(normalizeAccentColor('#D62828'), '#d62828')
  assert.equal(normalizeAccentColor('invalid'), '#c5f76b')
  assert.equal(normalizeAccentColor(null), '#c5f76b')
})

test('resolveSceneConfig suppresses scene before settings load and on preset none', () => {
  assert.deepEqual(
    resolveSceneConfig({ id: 'v24', model: { preset: 'stealthburner' } }, null, { settingsLoaded: false }),
    { kind: 'none' },
  )
  assert.deepEqual(
    resolveSceneConfig(
      { id: 'v24', model: { preset: 'none' }, customModels: { printer: printerMeta, toolhead: null } },
      { isToolchanger: false, toolCount: 1, bedSize: { width: 350, depth: 350 } },
    ),
    { kind: 'none' },
  )
})

test('resolveSceneConfig handles stormtrooper-6tc preset', () => {
  const profile = { id: 'st', model: { preset: 'stormtrooper-6tc' } }
  assert.deepEqual(resolveSceneConfig(profile, null), { kind: 'stormtrooper-6tc' })
  assert.deepEqual(resolveSceneConfig(profile, { isToolchanger: true, toolCount: 6 }), { kind: 'stormtrooper-6tc' })
  assert.deepEqual(resolveSceneConfig(profile, { isToolchanger: false, toolCount: 1 }), { kind: 'none' })
  assert.deepEqual(resolveSceneConfig(profile, { isToolchanger: true, toolCount: 2 }), { kind: 'none' })
})

test('resolveSceneConfig resolves auto across offline, 6-TC, single-tool bed sizes, and multi-tool printers', () => {
  const baseProfile = {
    id: 'p1',
    model: { preset: 'auto', accentColor: '#d62828' },
    customModels: { toolhead: toolheadMeta, printer: printerMeta },
  }

  // Offline under auto stays none even when customModels exist (no connect flip)
  assert.deepEqual(resolveSceneConfig(baseProfile, null), { kind: 'none' })

  // 6-TC resolves to stormtrooper-6tc
  assert.deepEqual(resolveSceneConfig(baseProfile, { isToolchanger: true, toolCount: 6 }), {
    kind: 'stormtrooper-6tc',
  })

  // Small single-tool beds (<= 165 mm) select mini-stealthburner + optional custom printer (ignoring custom toolhead)
  for (const width of [120, 150, 165]) {
    const res = resolveSceneConfig(baseProfile, {
      isToolchanger: false,
      toolCount: 1,
      bedSize: { width, depth: width },
    })
    assert.equal(res.kind, 'printer-scene')
    assert.equal(res.effectivePreset, 'mini-stealthburner')
    assert.equal(res.accentColor, '#d62828')
    assert.equal(res.defaultView, 'toolhead')
    assert.equal(res.emptyCustom, false)
    assert.equal(res.views.toolhead.url, '/models/templates/mini-stealthburner.glb')
    assert.equal(res.views.toolhead.sourceKind, 'template')
    assert.equal(res.views.printer.url, `/api/models/p1/printer?v=${encodeURIComponent(printerMeta.updatedAt)}`)
    assert.equal(res.views.printer.sourceKind, 'custom')
  }

  // Larger beds (> 165 mm) and unknown bedSize select stealthburner
  for (const bedSize of [{ width: 300, depth: 300 }, { width: 350, depth: 350 }, null]) {
    const res = resolveSceneConfig(
      { id: 'v24', model: { preset: 'auto' }, customModels: { toolhead: null, printer: null } },
      { isToolchanger: false, toolCount: 1, bedSize },
    )
    assert.equal(res.kind, 'printer-scene')
    assert.equal(res.effectivePreset, 'stealthburner')
    assert.equal(res.views.toolhead.url, '/models/templates/stealthburner.glb')
    assert.equal(res.views.printer, null)
  }

  // Non-6-TC multi-toolchanger & multi-extruder IDEX without custom files -> none; with custom -> printer-scene
  for (const st of [
    { isToolchanger: true, toolCount: 4 },
    { isToolchanger: false, toolCount: 2 },
  ]) {
    assert.deepEqual(
      resolveSceneConfig({ id: 'idex', model: { preset: 'auto' }, customModels: { toolhead: null, printer: null } }, st),
      { kind: 'none' },
    )
    const withCustom = resolveSceneConfig(baseProfile, st)
    assert.equal(withCustom.kind, 'printer-scene')
    assert.equal(withCustom.defaultView, 'toolhead')
    assert.equal(withCustom.views.toolhead.sourceKind, 'custom')
    assert.equal(withCustom.views.printer.sourceKind, 'custom')
  }
})

test('resolveSceneConfig renders explicit templates immediately offline and combines custom printer CAD', () => {
  const sb = resolveSceneConfig(
    { id: 'v24', model: { preset: 'stealthburner', accentColor: '#3b82f6' }, customModels: { toolhead: null, printer: printerMeta } },
    null,
  )
  assert.equal(sb.kind, 'printer-scene')
  assert.equal(sb.effectivePreset, 'stealthburner')
  assert.equal(sb.accentColor, '#3b82f6')
  assert.equal(sb.defaultView, 'toolhead')
  assert.equal(sb.views.toolhead.templateId, 'stealthburner')
  assert.equal(sb.views.printer.filename, 'voron24-350.glb')

  const mini = resolveSceneConfig(
    { id: 'v01', model: { preset: 'mini-stealthburner' }, customModels: { toolhead: null, printer: null } },
    null,
  )
  assert.equal(mini.kind, 'printer-scene')
  assert.equal(mini.effectivePreset, 'mini-stealthburner')
  assert.equal(mini.views.toolhead.templateId, 'mini-stealthburner')
  assert.equal(mini.views.printer, null)
})

test('resolveSceneConfig handles custom preset empty, single-slot, and dual-slot states', () => {
  const empty = resolveSceneConfig(
    { id: 'crucible', model: { preset: 'custom' }, customModels: { toolhead: null, printer: null } },
    null,
  )
  assert.equal(empty.kind, 'printer-scene')
  assert.equal(empty.emptyCustom, true)
  assert.equal(empty.views.toolhead, null)
  assert.equal(empty.views.printer, null)

  const printerOnly = resolveSceneConfig(
    { id: 'crucible', model: { preset: 'custom' }, customModels: { toolhead: null, printer: printerMeta } },
    null,
  )
  assert.equal(printerOnly.emptyCustom, false)
  assert.equal(printerOnly.defaultView, 'printer')
  assert.equal(printerOnly.views.toolhead, null)
  assert.ok(printerOnly.views.printer.url.includes('?v='))

  const headOnly = resolveSceneConfig(
    { id: 'crucible', model: { preset: 'custom' }, customModels: { toolhead: toolheadMeta, printer: null } },
    null,
  )
  assert.equal(headOnly.emptyCustom, false)
  assert.equal(headOnly.defaultView, 'toolhead')
  assert.equal(headOnly.views.printer, null)

  const both = resolveSceneConfig(
    { id: 'crucible', model: { preset: 'custom', accentColor: '#9b5de5' }, customModels: { toolhead: toolheadMeta, printer: printerMeta } },
    null,
  )
  assert.equal(both.emptyCustom, false)
  assert.equal(both.defaultView, 'toolhead')
  assert.equal(both.accentColor, '#9b5de5')
  assert.ok(both.views.toolhead.url.includes('/api/models/crucible/toolhead?v='))
  assert.ok(both.views.printer.url.includes('/api/models/crucible/printer?v='))
})
