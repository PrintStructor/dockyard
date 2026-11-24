import test from 'node:test'
import assert from 'node:assert/strict'
import { thermalDisplay } from '../src/thermal.mjs'

test('thermal instrument uses temperature and real heater power, not invented time progress', () => {
  const display = values => thermalDisplay({online:true,maxTemperature:300,...values})
  const heating = display({temperature:75,target:150,power:.4})
  assert.equal(heating.mode,'heating'); assert.equal(heating.fraction,.25); assert.equal(heating.marker,.5)
  assert.equal(display({temperature:150,target:150,power:.1}).mode,'holding')
  assert.equal(display({temperature:90,target:0,power:0}).mode,'cooling')
  assert.equal(display({temperature:28,target:0,power:0}).mode,'idle')
  assert.equal(display({temperature:75,target:150,power:0}).mode,'waiting')
})
test('thermal instrument suppresses stale and unknown readings', () => {
  for (const values of [{online:false,temperature:100,target:150},{online:true,temperature:null,target:150},{online:true,temperature:100,target:null}]) {
    const result = thermalDisplay(values)
    assert.equal(result.mode,'unknown'); assert.equal(result.scale,null); assert.equal(result.marker,null)
  }
})

test('unknown heater power is not reported as off or heating',()=>{
 for (const temperature of [20,120,210]) assert.equal(thermalDisplay({temperature,target:210,power:null,maxTemperature:295,online:true}).label,'Heizstatus unbekannt')
})
