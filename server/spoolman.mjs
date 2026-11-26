import { ControlError } from './control.mjs'

const STATUS_TTL_MS = 15_000
const DETAIL_TTL_MS = 30_000
const UNAVAILABLE_BACKOFF_MS = 60_000

function normalizeHex(raw) {
  if (typeof raw !== 'string') return null
  const clean = raw.trim().replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(clean)) return `#${clean.toLowerCase()}`
  return null
}

function extractSpoolColor(filament) {
  const primary = normalizeHex(filament?.color_hex)
  if (primary) return primary
  const multi = filament?.multi_color_hexes
  if (typeof multi === 'string' && multi.trim()) {
    for (const part of multi.split(/[,;]/)) {
      const candidate = normalizeHex(part)
      if (candidate) return candidate
    }
  } else if (Array.isArray(multi)) {
    for (const part of multi) {
      const candidate = normalizeHex(part)
      if (candidate) return candidate
    }
  }
  return null
}

function roundWeight(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return null
  return Math.round(num * 10) / 10
}

export function normalizeSpool(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = Number(raw.id)
  if (!Number.isInteger(id) || id < 1) return null

  const filament = raw.filament && typeof raw.filament === 'object' ? raw.filament : {}
  const vendorName = typeof filament.vendor?.name === 'string' ? filament.vendor.name.trim().slice(0, 80) : ''
  const filamentName = typeof filament.name === 'string' ? filament.name.trim().slice(0, 120) : ''
  const material = typeof filament.material === 'string' ? filament.material.trim().slice(0, 40) : ''
  const lotNr = typeof raw.lot_nr === 'string' && raw.lot_nr.trim() ? raw.lot_nr.trim().slice(0, 60) : null

  return {
    id,
    name: filamentName || `#${id}`,
    vendor: vendorName || null,
    material: material || null,
    color: extractSpoolColor(filament),
    remainingWeight: roundWeight(raw.remaining_weight),
    initialWeight: roundWeight(raw.initial_weight),
    lotNr,
    archived: Boolean(raw.archived),
  }
}

export function spoolToToolMaterial(spool) {
  if (!spool || typeof spool !== 'object' || !Number.isInteger(spool.id)) return null
  const displayName = spool.vendor ? `${spool.vendor} ${spool.name}` : spool.name
  return {
    type: spool.material || 'Filament',
    name: displayName.slice(0, 160),
    color: spool.color ?? null,
    source: 'Spoolman',
    spoolId: spool.id,
    remainingWeight: spool.remainingWeight ?? null,
  }
}

function emptyState() {
  return { available: false, connected: false, spoolId: null, activeSpool: null }
}

async function fetchSpoolById(baseUrl, spoolId, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/server/spoolman/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_method: 'GET', path: `/v1/spool/${spoolId}` }),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  })
  if (!response.ok) return null
  const data = await response.json().catch(() => null)
  return normalizeSpool(data?.result ?? data)
}

export function createSpoolmanReader(printerOrGetter, fetchImpl = fetch, onUpdate = null) {
  const resolvePrinter = () => (typeof printerOrGetter === 'function' ? printerOrGetter() : printerOrGetter)
  let state = emptyState()
  let signature = JSON.stringify(state)
  let nextPollAt = 0
  let detailFetchedAt = 0
  let detailSpoolId = null
  let pending = false
  let version = 0

  function apply(next) {
    state = next
    const nextSig = JSON.stringify(next)
    if (nextSig !== signature) {
      signature = nextSig
      onUpdate?.()
    }
  }

  function reset() {
    version++
    pending = false
    nextPollAt = 0
    detailFetchedAt = 0
    detailSpoolId = null
    state = emptyState()
    signature = JSON.stringify(state)
  }

  function invalidate() {
    nextPollAt = 0
    detailFetchedAt = 0
  }

  async function poll(requestVersion) {
    const base = resolvePrinter()
    const now = Date.now()
    try {
      const statusRes = await fetchImpl(`${base}/server/spoolman/status`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      })
      if (requestVersion !== version) return
      if (statusRes.status === 404 || statusRes.status === 400 || statusRes.status === 501) {
        nextPollAt = now + UNAVAILABLE_BACKOFF_MS
        detailSpoolId = null
        detailFetchedAt = 0
        apply(emptyState())
        return
      }
      if (!statusRes.ok) {
        nextPollAt = now + STATUS_TTL_MS
        apply({ available: state.available, connected: false, spoolId: null, activeSpool: null })
        return
      }
      const data = await statusRes.json().catch(() => null)
      const result = data?.result ?? {}
      const connected = Boolean(result.spoolman_connected)
      const rawId = result.spool_id
      const spoolId = Number.isInteger(rawId) && rawId > 0 ? rawId : null

      if (!connected) {
        nextPollAt = now + STATUS_TTL_MS
        detailSpoolId = null
        detailFetchedAt = 0
        apply({ available: true, connected: false, spoolId: null, activeSpool: null })
        return
      }

      if (spoolId == null) {
        nextPollAt = now + STATUS_TTL_MS
        detailSpoolId = null
        detailFetchedAt = 0
        apply({ available: true, connected: true, spoolId: null, activeSpool: null })
        return
      }

      let activeSpool = state.activeSpool
      const needsDetail = detailSpoolId !== spoolId || now - detailFetchedAt >= DETAIL_TTL_MS || !activeSpool
      if (needsDetail) {
        activeSpool = await fetchSpoolById(base, spoolId, fetchImpl)
        if (requestVersion !== version) return
        detailSpoolId = spoolId
        detailFetchedAt = Date.now()
      }
      nextPollAt = Date.now() + STATUS_TTL_MS
      apply({ available: true, connected: true, spoolId, activeSpool })
    } catch {
      if (requestVersion !== version) return
      nextPollAt = Date.now() + STATUS_TTL_MS
    } finally {
      if (requestVersion === version) pending = false
    }
  }

  function read() {
    const now = Date.now()
    if (!pending && now >= nextPollAt) {
      pending = true
      const reqVersion = version
      void poll(reqVersion)
    }
    return state
  }

  return { read, invalidate, reset }
}

export async function fetchSpoolmanList(printerUrl, fetchImpl = fetch) {
  const statusRes = await fetchImpl(`${printerUrl}/server/spoolman/status`, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  })
  if (statusRes.status === 404 || statusRes.status === 400 || statusRes.status === 501) {
    throw new ControlError('Spoolman ist auf diesem Drucker in Moonraker nicht konfiguriert.', 404)
  }
  if (!statusRes.ok) {
    throw new ControlError(`Spoolman-Status konnte nicht geladen werden (HTTP ${statusRes.status}).`, 502)
  }
  const statusData = await statusRes.json().catch(() => ({}))
  const connected = Boolean(statusData?.result?.spoolman_connected)
  const rawActiveId = statusData?.result?.spool_id
  const activeSpoolId = Number.isInteger(rawActiveId) && rawActiveId > 0 ? rawActiveId : null

  if (!connected) {
    throw new ControlError('Spoolman-Server ist derzeit nicht mit Moonraker verbunden.', 503)
  }

  const proxyRes = await fetchImpl(`${printerUrl}/server/spoolman/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_method: 'GET',
      path: '/v1/spool',
      query: 'allow_archived=false',
    }),
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
  })
  if (!proxyRes.ok) {
    throw new ControlError(`Spoolman-Spulenliste konnte nicht geladen werden (HTTP ${proxyRes.status}).`, 502)
  }
  const proxyData = await proxyRes.json().catch(() => ({}))
  const rawList = Array.isArray(proxyData?.result) ? proxyData.result : Array.isArray(proxyData) ? proxyData : []
  const spools = rawList
    .map(normalizeSpool)
    .filter(spool => spool && !spool.archived)
    .sort((a, b) => {
      if (a.id === activeSpoolId) return -1
      if (b.id === activeSpoolId) return 1
      const keyA = `${a.vendor ?? ''}|${a.material ?? ''}|${a.name}`.toLowerCase()
      const keyB = `${b.vendor ?? ''}|${b.material ?? ''}|${b.name}`.toLowerCase()
      return keyA.localeCompare(keyB) || a.id - b.id
    })

  return {
    available: true,
    connected: true,
    activeSpoolId,
    spools,
  }
}

export async function setActiveSpoolmanSpool(printerUrl, spoolId, fetchImpl = fetch) {
  let cleanId = null
  if (spoolId !== null && spoolId !== undefined && spoolId !== '') {
    const parsed = Number(spoolId)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new ControlError('Ungültige Spulen-ID (positive Ganzzahl oder null erwartet).', 400)
    }
    cleanId = parsed
  }

  const response = await fetchImpl(`${printerUrl}/server/spoolman/spool_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spool_id: cleanId }),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  })
  if (response.status === 404 || response.status === 400 || response.status === 501) {
    throw new ControlError('Spoolman ist auf diesem Drucker in Moonraker nicht konfiguriert.', 404)
  }
  if (!response.ok) {
    throw new ControlError(`Aktive Spule konnte nicht gesetzt werden (HTTP ${response.status}).`, 502)
  }

  const activeSpool = cleanId != null ? await fetchSpoolById(printerUrl, cleanId, fetchImpl) : null
  return { spoolId: cleanId, activeSpool }
}
