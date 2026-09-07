import type { MgaScanRecordApi, MissionConfig } from "@/api/client"

type MissionObjective = MissionConfig["mission"]["objective"]

// Shared between MgaScanHeatmap (per-cell min-reduction) and MgaScanFigure
// (the comparison strip's "Best MGA" stat) so both agree on exactly the
// same number. Deliberately mirrors the direct porkchop's own ΔV
// convention (see the design notes): dv_total_ms there is the raw sum of two v∞
// magnitudes, not a parking-orbit-priced burn, and is zeroed for Flyby
// client-side (BestArcCard.tsx/DvWaterfall.tsx) since the backend's
// PorkchopGrid::evaluate has no knowledge of mission.objective. The MGA
// scan's own `capture_dv_ms` (a real vis-viva capture burn) is NOT used
// here -- mixing a real capture burn into one side of the comparison while
// the direct side still uses raw v∞ would bias the whole comparison this
// feature exists to make. Surfaced separately, outside the comparison, in
// MgaScanFigure instead.
export function mgaRecordCostMs(record: MgaScanRecordApi, objective: MissionObjective): number {
  const base = record.vinf_dep_ms + record.sum_flyby_dv_ms
  return objective === "Flyby" ? base : base + record.vinf_arr_ms
}

export function pickBestMgaRecord(records: MgaScanRecordApi[], objective: MissionObjective): MgaScanRecordApi | null {
  let best: MgaScanRecordApi | null = null
  let bestCost = Infinity
  for (const r of records) {
    const cost = mgaRecordCostMs(r, objective)
    if (cost < bestCost) {
      bestCost = cost
      best = r
    }
  }
  return best
}

// MJD2000 epoch, per MgaScanRecordApi.dep_mjd2000's doc comment.
export const MJD2000_TO_JD = 2451544.5
export const TOF_BIN_COUNT = 40

// Extracted from MgaScanHeatmap.tsx so PorkchopExplorer's own
// MGA-scan-driven heatmap can share the exact same binning instead of a
// second copy -- unlike porkchopShared.ts's "each heatmap owns its own grid"
// precedent (which applies when the underlying DATA SHAPES genuinely
// differ), this is the literal same MgaScanRecordApi[] and the same real
// need to reduce it onto a grid, so duplicating it would just be two copies
// of the same bug surface.
//
// Unlike the direct survey's PorkchopHeatmap (an exact, regular
// (departure offset, TOF) grid straight from the backend), the scan
// returns *feasible branches only* -- a sparse, irregular cloud with many
// records at the same departure date (one per per-leg TOF split). This has
// to be reduced onto a grid to plot as a heatmap: departure date is
// already discrete (the scan walks a fixed departure_step_days grid, so
// exact-match works), but total_tof_days is a sum over independent
// per-leg grids and is not discrete -- it's binned into TOF_BIN_COUNT
// uniform bins instead. Each cell takes the MINIMUM cost among the
// records that land in it: "the best MGA branch achieving roughly this
// departure date and total TOF". Empty cells stay null (no feasible
// branch there), rendered transparent -- same convention the direct
// porkchop already uses for its own infeasible regions.
export function buildMgaGrid(records: MgaScanRecordApi[], objective: MissionObjective) {
  if (records.length === 0) return null
  const xs = Array.from(new Set(records.map((r) => r.dep_mjd2000))).sort((a, b) => a - b)
  const xIndex = new Map(xs.map((v, i) => [v, i]))

  let tofMin = Infinity
  let tofMax = -Infinity
  for (const r of records) {
    if (r.total_tof_days < tofMin) tofMin = r.total_tof_days
    if (r.total_tof_days > tofMax) tofMax = r.total_tof_days
  }
  const rowCount = TOF_BIN_COUNT
  const tofSpan = tofMax - tofMin
  const ys = Array.from({ length: rowCount }, (_, i) => tofMin + (tofSpan * i) / (rowCount - 1 || 1))

  const grid: (number | null)[][] = Array.from({ length: rowCount }, () => Array(xs.length).fill(null))
  for (const r of records) {
    const xi = xIndex.get(r.dep_mjd2000)
    if (xi === undefined) continue
    const yi = tofSpan > 0 ? Math.min(rowCount - 1, Math.max(0, Math.round(((r.total_tof_days - tofMin) / tofSpan) * (rowCount - 1)))) : 0
    const cost = mgaRecordCostMs(r, objective)
    const cur = grid[yi][xi]
    if (cur == null || cost < cur) grid[yi][xi] = cost
  }
  return { xs, ys, grid }
}
