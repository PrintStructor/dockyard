import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHistoryTotals, normalizeHistoryStatus, normalizeHistoryJob } from '../server/history.mjs'

test('normalizeHistoryTotals extracts numeric aggregates and keeps missing values null', () => {
  const totals = normalizeHistoryTotals({
    job_totals: {
      total_jobs: 1626,
      total_time: 6846078.6,
      total_print_time: 5959493.7,
      total_filament_used: 12032891.3,
      longest_job: 84880.9,
      longest_print: 83070.6,
    },
  })
  assert.equal(totals.totalJobs, 1626)
  assert.equal(totals.longestPrint, 83070.6)
  assert.equal(normalizeHistoryTotals(null), null)
  assert.equal(normalizeHistoryTotals({ job_totals: {} }).totalJobs, null)
})

test('normalizeHistoryStatus maps Moonraker statuses cleanly', () => {
  assert.equal(normalizeHistoryStatus('completed'), 'completed')
  assert.equal(normalizeHistoryStatus('cancelled'), 'cancelled')
  assert.equal(normalizeHistoryStatus('server_exit'), 'interrupted')
  assert.equal(normalizeHistoryStatus('klippy_shutdown'), 'interrupted')
  assert.equal(normalizeHistoryStatus('error'), 'error')
  assert.equal(normalizeHistoryStatus('in_progress'), 'in_progress')
  assert.equal(normalizeHistoryStatus(null), 'unknown')
})

test('normalizeHistoryJob attaches tool weights, thumbnail, and file existence check', () => {
  const existing = new Set(['cats_ABS_13h9m.gcode'])
  const job = normalizeHistoryJob(
    {
      job_id: '00065F',
      filename: 'cats_ABS_13h9m.gcode',
      status: 'completed',
      start_time: 1791560023,
      end_time: 1791604183,
      print_duration: 40917.8,
      total_duration: 44159.9,
      filament_used: 97002.2,
      metadata: {
        slicer: 'OrcaSlicer',
        slicer_version: '2.4.2',
        layer_count: 160,
        object_height: 32,
        layer_height: 0.2,
        filament_type: '["ABS","ASA","ABS","ABS","ABS","PLA"]',
        filament_colors: ['#FFFFFE', '#000080', '#DA9900', '#FFF10B', '#FFFFFF', '#66FFFF'],
        filament_weights: [0, 15.15, 0, 0, 236.34, 0],
        thumbnails: [{ width: 300, height: 300, relative_path: '.thumbs/cats-300x300.png' }],
      },
    },
    existing,
  )

  assert.equal(job.jobId, '00065F')
  assert.equal(job.fileExists, true)
  assert.equal(job.thumbnail, '.thumbs/cats-300x300.png')
  assert.deepEqual(
    job.tools.map(t => t.id),
    [1, 4],
  )

  const deletedJob = normalizeHistoryJob({ job_id: '0001', filename: 'old.gcode', status: 'cancelled' }, existing)
  assert.equal(deletedJob.fileExists, false)
})
