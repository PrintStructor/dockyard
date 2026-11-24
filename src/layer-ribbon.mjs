export function computeLayerToolBands(segments, maxLayer) {
  if (!segments?.length || !Number.isFinite(maxLayer) || maxLayer < 1) {
    return { bands: [], toolsUsed: [], toolChanges: 0 }
  }

  const totalLayers = Math.max(1, Math.round(maxLayer))
  // Accumulate extruded length per [layer, tool] separately for model walls vs supports.
  const modelWeights = new Float32Array((totalLayers + 1) * 6)
  const supportWeights = new Float32Array((totalLayers + 1) * 6)

  for (let i = 0; i + 7 < segments.length; i += 8) {
    const meta = segments[i + 7]
    const isSupport = meta % 2 >= 0.5
    const tool = Math.floor(meta / 2) % 8
    const layer = Math.floor(meta / 16)
    if (tool < 0 || tool > 5 || layer < 1 || layer > totalLayers) continue
    const dx = segments[i + 2] - segments[i]
    const dy = segments[i + 3] - segments[i + 1]
    const len = Math.hypot(dx, dy)
    if (!Number.isFinite(len) || len <= 0) continue
    const idx = layer * 6 + tool
    if (isSupport) supportWeights[idx] += len
    else modelWeights[idx] += len
  }

  const bands = []
  const usedSet = new Set()

  for (let layer = 1; layer <= totalLayers; layer++) {
    const base = layer * 6
    let bestTool = -1
    let bestWeight = 0
    for (let t = 0; t < 6; t++) {
      if (modelWeights[base + t] > bestWeight) {
        bestWeight = modelWeights[base + t]
        bestTool = t
      }
    }
    if (bestTool < 0) {
      for (let t = 0; t < 6; t++) {
        if (supportWeights[base + t] > bestWeight) {
          bestWeight = supportWeights[base + t]
          bestTool = t
        }
      }
    }
    if (bestTool < 0) continue

    usedSet.add(bestTool)
    const prev = bands[bands.length - 1]
    if (prev && prev.tool === bestTool && prev.endLayer === layer - 1) {
      prev.endLayer = layer
    } else {
      bands.push({ startLayer: layer, endLayer: layer, tool: bestTool })
    }
  }

  let toolChanges = 0
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].tool !== bands[i - 1].tool) toolChanges++
  }

  return {
    bands,
    toolsUsed: [...usedSet].sort((a, b) => a - b),
    toolChanges,
  }
}
