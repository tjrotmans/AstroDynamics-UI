import { useEffect, useMemo, useState } from "react"

import { buildContourTrace, clampMaxDv, gridRange, jdToIsoDate, numberInputClass } from "./porkchopShared"
import { DARK_LAYOUT, Plot } from "@/lib/plot"
import { buildMgaGrid, MJD2000_TO_JD, pickBestMgaRecord } from "@/lib/mgaScanCost"
import { useMissionStore } from "@/stores/missionStore"
import type { MgaScanRecordApi } from "@/api/client"

export function MgaScanHeatmap({
  records,
  horizonYears,
  departureEpochJd,
}: {
  records: MgaScanRecordApi[]
  /** The scan's configured [optimization.mga.scan].horizon_years, if known -- used to draw the x-axis over the
   *  FULL configured window rather than just the extent of departure dates that happened to produce a feasible
 * branch. Found (feedback): the axis autoscaled to the data, so a 10-year horizon with
   *  feasible branches only in its first 6-7 years silently LOOKED like a 6-7 year scan -- the same class of
   *  "autoscaled to a narrower-than-configured window" gotcha PorkchopHeatmap.tsx already hit and fixed for
   *  the direct survey's own arrival-date axis. */
  horizonYears?: number
  /** The scan's configured optimization.departure_epoch as a JD -- horizon is centered on this (MgaScanConfig's
   *  own doc comment: "spanning ± horizon_years/2 years"). */
  departureEpochJd?: number | null
}) {
  const objective = useMissionStore((s) => s.config.mission.objective)
  const [maxDvInput, setMaxDvInput] = useState("")
  const [showContours, setShowContours] = useState(false)

  const gridResult = useMemo(() => buildMgaGrid(records, objective), [records, objective])
  const xDates = useMemo(() => gridResult?.xs.map((depMjd2000) => jdToIsoDate(depMjd2000 + MJD2000_TO_JD)) ?? [], [gridResult])
  const range = useMemo(() => (gridResult ? gridRange(gridResult.grid) : null), [gridResult])

  const [debouncedMaxDvInput, setDebouncedMaxDvInput] = useState(maxDvInput)
  useEffect(() => {
    const id = setTimeout(() => setDebouncedMaxDvInput(maxDvInput), 400)
    return () => clearTimeout(id)
  }, [maxDvInput])
  const rawMaxDv = debouncedMaxDvInput === "" ? null : Number(debouncedMaxDvInput)
  const maxDv = clampMaxDv(rawMaxDv, range)

  const bestRecord = useMemo(() => pickBestMgaRecord(records, objective), [records, objective])
  const bestX = bestRecord ? jdToIsoDate(bestRecord.dep_mjd2000 + MJD2000_TO_JD) : null
  const bestY = bestRecord?.total_tof_days ?? null

  const fullHorizonRange = useMemo(() => {
    if (horizonYears == null || departureEpochJd == null) return undefined
    const halfSpanDays = (horizonYears / 2) * 365.25
    return [jdToIsoDate(departureEpochJd - halfSpanDays), jdToIsoDate(departureEpochJd + halfSpanDays)]
  }, [horizonYears, departureEpochJd])

  if (!gridResult || !range) {
    return <p className="text-[11px] text-muted-foreground">No feasible MGA branches found in this scan window.</p>
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5">
          Max ΔV (m/s)
          <input
            type="number"
            className={numberInputClass}
            value={maxDvInput}
            placeholder={range[1].toFixed(0)}
            onChange={(e) => setMaxDvInput(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showContours}
            onChange={(e) => setShowContours(e.target.checked)}
            className="accent-primary"
          />
          ΔV contour lines
        </label>
      </div>
      <Plot
        data={[
          {
            type: "heatmap",
            x: xDates,
            y: gridResult.ys,
            z: gridResult.grid,
            zmin: maxDv != null ? range[0] : undefined,
            zmax: maxDv ?? undefined,
            colorscale: "Viridis",
            colorbar: { title: { text: "MGA ΔV (m/s)" } },
            hoverongaps: false,
          },
          ...(showContours ? [buildContourTrace({ x: xDates, y: gridResult.ys, z: gridResult.grid, range, maxDv })] : []),
          ...(bestX != null && bestY != null
            ? [
                {
                  type: "scatter" as const,
                  mode: "markers" as const,
                  x: [bestX],
                  y: [bestY],
                  marker: { symbol: "star", size: 16, color: "#f24d00", line: { color: "white", width: 1 } },
                  name: "Best MGA point",
                  hoverinfo: "skip" as const,
                },
              ]
            : []),
        ]}
        layout={{
          ...DARK_LAYOUT,
          margin: { t: 24, r: 24, b: 48, l: 56 },
          xaxis: { title: { text: "Departure date" }, type: "date", range: fullHorizonRange },
          yaxis: { title: { text: "Total time of flight (days)" } },
        }}
        style={{ width: "100%", height: "360px" }}
        useResizeHandler
      />
    </div>
  )
}
