import test from 'node:test'
import assert from 'node:assert/strict'
import { useControls } from '../src/useControls.js'

test('control client confirms accepted commands and preserves error feedback without retry', async t => {
  let calls=0, refreshed=0, fail=false
  t.mock.method(globalThis,'fetch', async () => { calls++; return { ok:!fail, json:async()=> fail ? {error:'Abgewiesen'} : {message:'Gesetzt'} } })
  const controls = useControls(() => { refreshed++ })
  assert.equal(await controls.send({action:'temperature',heater:'extruder',target:140}),true)
  fail=true
  assert.equal(await controls.send({action:'temperature',heater:'heater_bed',target:0}),false)
  assert.equal(controls.feedback.value.ok,false); assert.equal(controls.feedback.value.message,'Abgewiesen')
  assert.equal(controls.pending.value,false); assert.equal(calls,2); assert.equal(refreshed,2)
})
