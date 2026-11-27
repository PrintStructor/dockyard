import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateGcodeFilename,
  validateThumbnailPath,
  normalizePrintMetadata,
  parseGcodeText,
  encodeGcodeMeshBinary,
} from '../server/gcode-mesh.mjs'

test('validateGcodeFilename and validateThumbnailPath reject traversal and invalid extensions', () => {
  assert.equal(validateGcodeFilename('ghost_cats.gcode'), 'ghost_cats.gcode')
  assert.equal(validateGcodeFilename('sub/part.gco'), 'sub/part.gco')
  for (const bad of ['', '../secret.gcode', '/etc/passwd.gcode', 'file.txt', 'a\nb.gcode', null]) {
    assert.equal(validateGcodeFilename(bad), null)
  }

  assert.equal(validateThumbnailPath('.thumbs/test-300x300.png'), '.thumbs/test-300x300.png')
  for (const bad of ['', '../x.png', '/root.png', 'model.gcode', null]) {
    assert.equal(validateThumbnailPath(bad), null)
  }
})

test('normalizePrintMetadata parses OrcaSlicer multi-tool weights, colors, and best thumbnail', () => {
  const meta = normalizePrintMetadata(
    {
      slicer: 'OrcaSlicer',
      slicer_version: '2.4.2',
      layer_count: 160,
      object_height: 32,
      estimated_time: 47326,
      filament_type: '["ABS","ASA","ABS","ABS","ABS","PLA"]',
      filament_name: '["White","Burnt","Bronze","Yellow","Glow","PLA"]',
      filament_colors: ['#FFFFFE', '#000080', '#DA9900', '#FFF10B', '#FFFFFF', '#66FFFF'],
      filament_temps: [260, 230, 260, 260, 230, 220],
      filament_weights: [0, 15.15, 0, 0, 236.34, 0],
      thumbnails: [
        { width: 32, height: 32, relative_path: '.thumbs/small.png' },
        { width: 300, height: 300, relative_path: '.thumbs/big.png' },
      ],
    },
    'cats.gcode',
  )

  assert.equal(meta.thumbnail, '.thumbs/big.png')
  assert.equal(meta.tools[1].used, true)
  assert.equal(meta.tools[1].weight, 15.15)
  assert.equal(meta.tools[1].color, '#000080')
  assert.equal(meta.tools[4].used, true)
  assert.equal(meta.tools[0].used, false)
})

test('normalizePrintMetadata parses single-tool plain string metadata and total weight fallback', () => {
  const single = normalizePrintMetadata(
    {
      slicer: 'OrcaSlicer',
      filament_type: 'ABS',
      filament_name: 'eSUN ABS+ White',
      filament_colors: '#d62828',
      filament_weight_total: 42.5,
      first_layer_extr_temp: 255,
    },
    'crucible_part.gcode',
  )
  assert.equal(single.tools[0].used, true)
  assert.equal(single.tools[0].type, 'ABS')
  assert.equal(single.tools[0].name, 'eSUN ABS+ White')
  assert.equal(single.tools[0].color, '#d62828')
  assert.equal(single.tools[0].weight, 42.5)
  assert.equal(single.tools[0].temp, 255)
  assert.equal(single.tools[1].used, false)
})

test('parseGcodeText extracts multi-tool surface walls, flags supports, skips sparse infill, and encodes binary', () => {
  const sample = `
M83
G90
T1
;LAYER_CHANGE
;Z:0.2
;HEIGHT:0.2
G1 Z0.2
G1 X10 Y10
;TYPE:Outer wall
;WIDTH:0.45
G1 X30 Y10 E1.0
G1 X30 Y30 E1.0
;TYPE:Sparse infill
G1 X10 Y30 E1.0
;TYPE:Support
G1 X40 Y40 E0.5
T4
;LAYER_CHANGE
;Z:0.4
G1 Z0.4
;TYPE:Top surface
G1 X10 Y10
G1 X30 Y10 E1.0
`
  const parsed = parseGcodeText(sample, { filename: 'sample.gcode' })
  assert.equal(parsed.header.layerCount, 2)
  assert.equal(parsed.header.hasSupport, true)
  assert.deepEqual(parsed.header.usedTools, [1, 4])
  // Outer wall (2) + Support (1) + Top surface (1) = 4 segments (Sparse infill skipped!)
  assert.equal(parsed.header.segmentCount, 4)
  assert.equal(parsed.header.bounds.minX, 10)
  assert.equal(parsed.header.bounds.maxX, 40)
  assert.equal(parsed.header.bounds.maxZ, 0.4)

  // Verify binary round-trip layout
  const bin = encodeGcodeMeshBinary(parsed)
  const headerLen = bin.readUInt32LE(0)
  assert.equal(headerLen % 4, 0)
  const decodedHeader = JSON.parse(bin.subarray(4, 4 + headerLen).toString('utf8'))
  assert.equal(decodedHeader.segmentCount, 4)
  const floats = new Float32Array(bin.buffer, bin.byteOffset + 4 + headerLen, decodedHeader.segmentCount * 8)
  // Segment 0: layer=1, tool=1, support=0 -> meta = 1*16 + 1*2 + 0 = 18
  assert.equal(floats[7], 18)
  // Segment 2 (support): layer=1, tool=1, support=1 -> meta = 1*16 + 1*2 + 1 = 19
  assert.equal(floats[2 * 8 + 7], 19)
  // Segment 3 (T4 layer 2): layer=2, tool=4, support=0 -> meta = 2*16 + 4*2 + 0 = 40
  assert.equal(floats[3 * 8 + 7], 40)
})
