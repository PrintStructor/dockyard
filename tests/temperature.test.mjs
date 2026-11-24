import test from 'node:test'
import assert from 'node:assert/strict'
import { temperatureHistory } from '../server/temperature.mjs'

test('temperature history aligns tools and targets to newest sample and limits history to ten minutes', () => {
  const result = temperatureHistory({ extruder: { temperatures: Array.from({length:1200}, (_, i) => i), targets: Array(1200).fill(210) }, heater_bed: { temperatures: [28,29,30], targets: [60,60,60] } }, '2026-11-24T12:00:00Z')
  assert.equal(result.series.length, 7)
  const tool = result.series[0]
  assert.equal(tool.points.length, 121)
  assert.deepEqual(tool.points[0], { seconds:-600, temperature:599, target:210 })
  assert.deepEqual(tool.points.at(-1), { seconds:0, temperature:1199, target:210 })
  assert.deepEqual(result.series[6].points, [{ seconds:0, temperature:30, target:60 }])
})
test('missing sensors and invalid measurements remain unknown, never zero', () => {
  const result = temperatureHistory({ extruder: { temperatures: [null, 20, 21, 22, 23, NaN], targets: [undefined] }, unrelated_sensor: { temperatures: [100] } })
  assert.deepEqual(result.series[0].points, [{seconds:-5,temperature:null,target:null},{seconds:0,temperature:null,target:null}])
  assert.deepEqual(result.series[1].points, [])
  assert.throws(() => temperatureHistory(null), /Kein/)
})
