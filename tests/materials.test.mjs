import test from 'node:test'
import assert from 'node:assert/strict'
import { materialsFromMetadata,createMaterialsReader } from '../server/materials.mjs'
import {heatState} from '../server/status.mjs'
const metadata={slicer:'OrcaSlicer',filament_type:JSON.stringify(['ABS','ASA','ABS','ABS','ABS','PLA']),filament_colors:['#ffffff','#000080','#da9900','#fff10b','#ffffff','#66ffff']}
test('Orca six-slot metadata maps to T0–T5; ambiguous and invalid metadata stays unknown',()=>{
 const materials=materialsFromMetadata(metadata,'example.gcode');assert.equal(materials[1].type,'ASA');assert.equal(materials[4].color,'#ffffff')
 assert.deepEqual(materialsFromMetadata({...metadata,filament_type:['PLA']},'x'),Array(6).fill(null))
 assert.equal(materialsFromMetadata({...metadata,filament_colors:['bad',...metadata.filament_colors.slice(1)]},'x')[0].color,null)
})
test('a completed or absent job never establishes loaded material; filename changes clear stale metadata',async()=>{
 let calls=0
 const read=createMaterialsReader('http://test',async()=>{calls++;return{ok:true,json:async()=>({result:metadata})}})
 assert.deepEqual(read({print_stats:{state:'complete',filename:'old'}}),Array(6).fill(null));assert.equal(calls,0)
 read({print_stats:{state:'printing',filename:'new'}});await new Promise(r=>setImmediate(r))
 assert.equal(read({print_stats:{state:'printing',filename:'new'}})[1].type,'ASA')
 assert.deepEqual(read({print_stats:{state:'standby',filename:'new'}}),Array(6).fill(null))
})
test('single-tool slicer metadata maps OrcaSlicer, PrusaSlicer and semicolon formats into slot 0', () => {
  const orca = materialsFromMetadata(
    { slicer: 'OrcaSlicer', filament_type: ['ABS'], filament_name: ['Voron Red'], filament_colors: ['#d62828'] },
    'benchy.gcode',
    1,
  )
  assert.equal(orca.length, 1)
  assert.equal(orca[0].type, 'ABS')
  assert.equal(orca[0].name, 'Voron Red')
  assert.equal(orca[0].color, '#d62828')

  const prusa = materialsFromMetadata(
    { slicer: 'PrusaSlicer', filament_type: 'PETG', filament_colors: '#3b82f6' },
    'part.gcode',
    1,
  )
  assert.equal(prusa[0].type, 'PETG')
  assert.equal(prusa[0].color, '#3b82f6')

  const semi = materialsFromMetadata(
    { slicer: 'SuperSlicer', filament_type: 'PLA;PLA', filament_colors: '#c5f76b;#000000' },
    'test.gcode',
    1,
  )
  assert.equal(semi[0].type, 'PLA')
  assert.equal(semi[0].color, '#c5f76b')
})

test('heating requires an actual target and power; hot with heater off is not reported as heating',()=>{
 assert.equal(heatState({temperature:180,target:220,power:.8}),'Heizt auf')
 assert.equal(heatState({temperature:180,target:220,power:0}),'Unter Solltemperatur')
 assert.equal(heatState({temperature:180,target:0,power:0}),'Heizung aus · heiß')
 assert.equal(heatState({temperature:220,target:220,power:.3}),'Auf Solltemperatur')
})
