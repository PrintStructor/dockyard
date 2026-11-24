import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStatus, toolState } from '../server/status.mjs'

test('fehlende Werte bleiben unbekannt und werden nicht als 0 angezeigt', () => {
  const data = normalizeStatus({})
  assert.equal(data.tools[0].temperature, null)
  assert.equal(data.tools[0].filamentDetected, null)
  assert.equal(data.active, null)
  assert.equal(data.bed.temperature, null)
})

test('aktive Werkzeugnummer und erkannte Werkzeugnummer werden getrennt behandelt', () => {
  const data = normalizeStatus({ toolchanger: { tool_number: 1, detected_tool_number: 2, has_detection: true } })
  assert.equal(data.detectionMismatch, true)
  assert.equal(data.tools[1].active, true)
  assert.equal(data.tools[2].detected, true)
  assert.equal(toolState(data.tools[1], data), 'Erkennung abweichend')
})

test('nicht erkannt bedeutet nicht automatisch im Dock', () => {
  const data = normalizeStatus({ toolchanger: { tool_number: 1, detected_tool_number: 1, has_detection: true } })
  assert.equal(toolState(data.tools[0], data), 'Nicht aufgenommen')
  assert.equal(toolState(data.tools[1], data), 'Aufgenommen')
})

test('Hotend, separater Sensor und deaktivierte Filamenterkennung bleiben unterscheidbar', () => {
  const data = normalizeStatus({ extruder1: { temperature: 220, target: 225 }, 'temperature_sensor T1': { temperature: 42 }, 'filament_switch_sensor T1_filament_sensor': { enabled: false, filament_detected: false } })
  assert.equal(data.tools[1].temperature, 220)
  assert.equal(data.tools[1].sensorTemperature, 42)
  assert.equal(data.tools[1].filamentEnabled, false)
})

test('LED colors and effects are per-tool; RGBW is retained and missing LEDs unknown',()=>{
 const data=normalizeStatus({'neopixel et1_leds':{color_data:[[.2,.3,.4,.5],[1,0,0,0],[0,1,0,0]]},'led_effect rainbow_nature':{enabled:true},configfile:{settings:{'led_effect rainbow_nature':{leds:'neopixel:et1_leds\nneopixel:et2_leds'}}}})
 assert.deepEqual(data.tools[1].leds.number,[.2,.3,.4,.5]);assert.equal(data.tools[0].leds.number,null)
 assert.deepEqual(data.tools[1].effects,['rainbow_nature']);assert.deepEqual(data.tools[0].effects,[])
})

test('relative Z uses the initial tool matrix row, not the active tool or global offset',()=>{
 const data=normalizeStatus({toolchanger:{tool_number:2,initial_tool_number:1},'tool T1':{z_offsets:{0:-.1187,2:-.1219}},'tool T2':{z_offsets:{1:.1113}},'gcode_macro globals':{global_z_offset:.04}})
 assert.equal(data.initialTool,1);assert.equal(data.tools[0].relativeZ,-.1187);assert.equal(data.tools[1].relativeZ,0);assert.equal(data.tools[2].relativeZ,-.1219);assert.equal(data.tools[3].relativeZ,null)
 assert.equal(normalizeStatus({toolchanger:{tool_number:1},'tool T0':{z_offsets:{1:.1269}}}).tools[1].relativeZ,null)
})

test('initial-tool availability distinguishes unsupported status from not set',()=>{
 assert.equal(normalizeStatus({toolchanger:{}}).initialToolAvailable,false)
 const data=normalizeStatus({toolchanger:{initial_tool_number:-1,initial_tool:null}})
 assert.equal(data.initialToolAvailable,true);assert.equal(data.initialTool,null)
})
test('multiple positive detection pins are a conflict even when controller identities match none',()=>{
 const data=normalizeStatus({toolchanger:{has_detection:true,tool_number:-1,detected_tool_number:-1},'tool T0':{detect_state:1},'tool T1':{detect_state:1}})
 assert.equal(data.detectionConflict,true);assert.equal(data.detectionMismatch,true)
})
