import { normalizePrintMetadata, validateGcodeFilename } from './gcode-mesh.mjs'

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function normalizeHistoryTotals(raw) {
  const totals = raw?.job_totals ?? raw
  if (!totals || typeof totals !== 'object') return null
  return {
    totalJobs: finite(totals.total_jobs),
    totalTime: finite(totals.total_time),
    totalPrintTime: finite(totals.total_print_time),
    totalFilamentMm: finite(totals.total_filament_used),
    longestJob: finite(totals.longest_job),
    longestPrint: finite(totals.longest_print),
  }
}

export function normalizeHistoryStatus(rawStatus) {
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : ''
  if (status === 'completed') return 'completed'
  if (status === 'in_progress') return 'in_progress'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'klippy_shutdown' || status === 'server_exit' || status === 'interrupted') return 'interrupted'
  if (status === 'error') return 'error'
  return 'unknown'
}

export function normalizeHistoryJob(job, existingFiles = null) {
  if (!job || typeof job !== 'object') return null
  const filename = typeof job.filename === 'string' ? job.filename : ''
  const validFilename = validateGcodeFilename(filename)
  const meta = normalizePrintMetadata(job.metadata ?? {}, filename)
  const usedTools = meta.tools.filter(tool => tool.used)

  return {
    jobId: typeof job.job_id === 'string' ? job.job_id : null,
    filename: filename || null,
    name: filename ? filename.split('/').pop() : null,
    status: normalizeHistoryStatus(job.status),
    rawStatus: typeof job.status === 'string' ? job.status : null,
    startTime: finite(job.start_time),
    endTime: finite(job.end_time),
    printDuration: finite(job.print_duration),
    totalDuration: finite(job.total_duration),
    filamentUsedMm: finite(job.filament_used),
    slicer: meta.slicer,
    slicerVersion: meta.slicerVersion,
    layerCount: meta.layerCount,
    objectHeight: meta.objectHeight,
    layerHeight: meta.layerHeight,
    estimatedTime: meta.estimatedTime,
    filamentWeightTotal: meta.filamentWeightTotal,
    firstLayerBedTemp: meta.firstLayerBedTemp,
    firstLayerExtrTemp: meta.firstLayerExtrTemp,
    chamberTemp: meta.chamberTemp,
    thumbnail: meta.thumbnail,
    tools: usedTools,
    fileExists: validFilename != null && (existingFiles instanceof Set ? existingFiles.has(validFilename) : false),
  }
}
