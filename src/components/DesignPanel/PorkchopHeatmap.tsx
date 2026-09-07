import { useEffect, useMemo, useState } from "react"

import { buildContourTrace, clampMaxDv, gridRange, jdToIsoDate, numberInputClass, selectClass } from "./porkchopShared"
import { DARK_LAYOUT, Plot } from "@/lib/plot"
import { epochStringToJd } from "@/lib/utils"
import { useMissionStore } from "@/stores/missionStore"
import type { PorkchopApiPoint } from "@/api/client"

type XMode = "offset" | "date"
type YMode = "tof" | "arrival"

function buildGrid(points: PorkchopApiPoint[], xs: number[], ys: number[]) {
  const byKey = new Map<string, number | null>()
  for (const p of points) {
    if (p.dep_offset_days === undefined || p.tof_days === undefined) continue
    byKey.set(`${p.dep_offset_days}:${p.tof_days}`, p.dv_total_ms ?? null)
  }
  return ys.map((y) => xs.map((x) => byKey.get(`${x}:${y}`) ?? null))
}

function uniqSorted(points: PorkchopApiPoint[], key: "dep_offset_days" | "tof_days"): number[] {
  return Array.from(new Set(points.map((p) => p[key]).filter((v): v is number => v !== undefined))).sort((a, b) => a - b)
}

// Resample the (departure offset, TOF) grid onto a uniform (departure
// offset, arrival offset) grid, added on ("I need it to
// work in arrival date mode too" + "I need the plot to be rectangular, not
// this diamond shape" + "run data in parts for which we dont have data yet").
// Arrival offset = departure offset + TOF, so a regular TOF grid is a
// *sheared* region in arrival-offset space -- plotting it directly produces
// a parallelogram, and Plotly's heatmap/contour traces can't do anything
// useful with an irregular point cloud.
//
// Two things had to be true together to actually fill the rectangle, not
// just draw one: (1) the backend survey request is widened well beyond the
// user's chosen TOF window (see StudyPaper's `runSurvey`) so real data
// exists for departure/arrival combinations the original window wouldn't
// have covered; (2) the arrival AXIS RANGE resampled onto here must be the
// user's original *absolute* arrival window, anchored at the nominal
// departure epoch (offset zero) -- exactly `targetTofRange` on its own, NOT
// widened further by each column's own offset. An earlier cut of this
// function added `offset + targetTofMin/Max` per column when computing the
// row range, which double-counts the departure window's width on top of
// the request-side widening (`runSurvey`'s ± half-window buffer is already
// sized against *this* absolute target range, derived from: for every
// departure offset in [-W/2, W/2] and every arrival in
// [targetTofMin, targetTofMax], impliedTof = arrival - offset must land
// inside the widened TOF request -- worst case is offset at ±W/2, which is
// exactly what `runSurvey`'s ± W/2 buffer covers) -- adding the offset a
// second time here shrank the reachable margin back down and reintroduced
// the same unfilled corners one level up. Every column now targets the
// identical, offset-independent row range.
function buildArrivalGrid(
  offsets: number[],
  tofs: number[],
  tofGrid: (number | null)[][],
  targetTofRange: [number, number],
): { arrivalOffsets: number[]; grid: (number | null)[][] } | null {
  if (offsets.length === 0 || tofs.length === 0) return null
  const tofMin = tofs[0]
  const tofMax = tofs[tofs.length - 1]
  const [globalMin, globalMax] = targetTofRange
  if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) return null

  const rowCount = tofs.length
  const arrivalOffsets = Array.from({ length: rowCount }, (_, i) =>
    globalMin + ((globalMax - globalMin) * i) / (rowCount - 1 || 1),
  )

  const grid = arrivalOffsets.map((arrival) =>
    offsets.map((dep, colIdx) => {
      const impliedTof = arrival - dep
      if (impliedTof < tofMin || impliedTof > tofMax) return null
      let k = 0
      while (k < tofs.length - 2 && tofs[k + 1] < impliedTof) k++
      const t0 = tofs[k]
      const t1 = tofs[k + 1] ?? t0
      const v0 = tofGrid[k]?.[colIdx] ?? null
      const v1 = tofGrid[k + 1]?.[colIdx] ?? v0
      if (v0 == null || v1 == null) return null
      const frac = t1 === t0 ? 0 : (impliedTof - t0) / (t1 - t0)
      return v0 + (v1 - v0) * frac
    }),
  )
  return { arrivalOffsets, grid }
}

// Axis mode toggle added,. Departure offset
// -> departure date is a pure relabel + uniform shift (the grid stays
// regular either way). TOF -> arrival date is NOT a relabel -- arrival date
// = departure date + TOF, so it depends on the departure axis too. First cut
// rendered this as a colour-mapped scatter (one marker per surveyed point),
// which was correct but produced a sheared parallelogram, not a rectangle,
// and couldn't support contours. Now resampled onto a uniform grid via
// `buildArrivalGrid` instead (see its own comment) -- both Y modes render
// through the same heatmap+contour code path below.
//
// Colour-scale clamp + contour lines added later the same day, also direct
//: a "max ΔV" input caps the colourbar's upper bound (zmax/
// cmax) so the interesting low-ΔV region gets more of the colour range
// instead of a few high-ΔV outliers stretching it thin; contour lines
// overlay a few evenly-spaced ΔV levels as a separate Plotly "contour"
// trace in coloring:"lines" mode on top of the heatmap.
export function PorkchopHeatmap({
  points,
  bestPoint,
}: {
  points: PorkchopApiPoint[]
  bestPoint?: { depOffsetDays: number; tofDays: number } | null
}) {
  const [xMode, setXMode] = useState<XMode>("offset")
  const [yMode, setYMode] = useState<YMode>("tof")
  const [maxDvInput, setMaxDvInput] = useState("")
  const [showContours, setShowContours] = useState(false)
  const departureEpoch = useMissionStore((s) => s.config.trajectory.departure_epoch)
  const cruiseTofMin = useMissionStore((s) => s.config.trajectory.cruise?.tof_days_min ?? null)
  const cruiseTofMax = useMissionStore((s) => s.config.trajectory.cruise?.tof_days_max ?? null)
  const depJd = useMemo(() => (departureEpoch ? epochStringToJd(departureEpoch) : null), [departureEpoch])
  const dateModeAvailable = depJd != null

  const toX = (depOffsetDays: number) => (xMode === "date" && depJd != null ? jdToIsoDate(depJd + depOffsetDays) : depOffsetDays)
  const toY = (depOffsetDays: number, tofDays: number) =>
    yMode === "arrival" && depJd != null ? jdToIsoDate(depJd + depOffsetDays + tofDays) : tofDays

  // Arrival mode needs the FULL survey response (the backend request is
  // widened beyond the user's chosen TOF window -- see StudyPaper's
  // `runSurvey` -- so every arrival-date cell has real, computed
  // neighbors to interpolate from, not just the requested window's
  // corners). TOF mode filters back down to the user's actual configured
  // window, so that extra widened data doesn't silently leak into a plot
  // whose whole point is to show exactly the window they asked for.
  const tofModePoints = useMemo(() => {
    // Same 100/400 defaults `runSurvey` assumes -- the request is always
    // widened now (even when the user never typed explicit TOF bounds), so
    // this filter must always apply too, not just when the fields are set.
    const tofMin = cruiseTofMin ?? 100
    const tofMax = cruiseTofMax ?? 400
    return points.filter((p) => p.tof_days == null || (p.tof_days >= tofMin && p.tof_days <= tofMax))
  }, [points, cruiseTofMin, cruiseTofMax])

  const tofModeOffsets = useMemo(() => uniqSorted(tofModePoints, "dep_offset_days"), [tofModePoints])
  const tofModeTofs = useMemo(() => uniqSorted(tofModePoints, "tof_days"), [tofModePoints])
  const tofGrid = useMemo(
    () => buildGrid(tofModePoints, tofModeOffsets, tofModeTofs),
    [tofModePoints, tofModeOffsets, tofModeTofs],
  )

  const fullOffsets = useMemo(() => uniqSorted(points, "dep_offset_days"), [points])
  const fullTofs = useMemo(() => uniqSorted(points, "tof_days"), [points])
  const fullTofGrid = useMemo(() => buildGrid(points, fullOffsets, fullTofs), [points, fullOffsets, fullTofs])
  const arrivalGridResult = useMemo(() => {
    if (yMode !== "arrival" || depJd == null) return null
    // Same 100/400 backend CruiseConfig defaults StudyPaper's `runSurvey`
    // assumes when widening the request -- must match, or this resamples
    // onto a target window the widened request was never sized to cover.
    const targetRange: [number, number] = [cruiseTofMin ?? 100, cruiseTofMax ?? 400]
    return buildArrivalGrid(fullOffsets, fullTofs, fullTofGrid, targetRange)
  }, [yMode, depJd, fullOffsets, fullTofs, fullTofGrid, cruiseTofMin, cruiseTofMax])

  // Both Y modes render through the same grid path now -- arrival mode's
  // rows are `arrivalGridResult`'s resampled, uniformly-spaced arrival
  // offsets (converted to real dates below); TOF mode's rows are the raw,
  // window-filtered surveyed TOF values directly.
  const activeXOffsets = yMode === "arrival" ? fullOffsets : tofModeOffsets
  const activeYOffsets = yMode === "arrival" ? (arrivalGridResult?.arrivalOffsets ?? []) : tofModeTofs
  const activeGrid = useMemo(
    () => (yMode === "arrival" ? (arrivalGridResult?.grid ?? []) : tofGrid),
    [yMode, arrivalGridResult, tofGrid],
  )
  const yAxisValues = yMode === "arrival" && depJd != null ? activeYOffsets.map((o) => jdToIsoDate(depJd + o)) : activeYOffsets

  const range = useMemo(() => gridRange(activeGrid), [activeGrid])

  // Debounced -- every keystroke otherwise triggered a full Plotly
  // heatmap/contour re-render synchronously, which on a real grid is heavy
  // enough that typing felt laggy and dropped characters (found live: user
  // reported only the up/down spinner felt usable). The typed value still
  // updates the input immediately (so the field itself never feels frozen);
  // only the value actually fed to the plot lags by a short debounce.
  const [debouncedMaxDvInput, setDebouncedMaxDvInput] = useState(maxDvInput)
  useEffect(() => {
    const id = setTimeout(() => setDebouncedMaxDvInput(maxDvInput), 400)
    return () => clearTimeout(id)
  }, [maxDvInput])

  const rawMaxDv = debouncedMaxDvInput === "" ? null : Number(debouncedMaxDvInput)
  const maxDv = clampMaxDv(rawMaxDv, range)

  const bestX = bestPoint ? toX(bestPoint.depOffsetDays) : null
  const bestY = bestPoint ? toY(bestPoint.depOffsetDays, bestPoint.tofDays) : null

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5">
          X axis
          <select className={selectClass} value={xMode} onChange={(e) => setXMode(e.target.value as XMode)}>
            <option value="offset">Departure offset</option>
            <option value="date" disabled={!dateModeAvailable}>Departure date</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Y axis
          <select className={selectClass} value={yMode} onChange={(e) => setYMode(e.target.value as YMode)}>
            <option value="tof">Time of flight</option>
            <option value="arrival" disabled={!dateModeAvailable}>Arrival date</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Max ΔV (m/s)
          <input
            type="number"
            className={numberInputClass}
            value={maxDvInput}
            placeholder={range?.[1]?.toFixed(0) ?? "auto"}
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
        {!dateModeAvailable && <span>Set a departure epoch to enable date axes.</span>}
        {yMode === "arrival" && (
          <span>Resampled onto a uniform arrival-date grid -- cells outside the surveyed TOF window are empty.</span>
        )}
      </div>
      <Plot
        data={[
          {
            type: "heatmap",
            x: activeXOffsets.map(toX),
            y: yAxisValues,
            z: activeGrid,
            // Plotly only honors a manual zmax if zmin is ALSO given --
            // otherwise it silently autoranges and ignores it (real bug,
            // found live: the colorbar kept showing the full 1M-ish
            // range even with a zmax set). Passing both together is what
            // actually clamps it.
            zmin: maxDv != null ? (range?.[0] ?? 0) : undefined,
            zmax: maxDv ?? undefined,
            colorscale: "Viridis",
            colorbar: { title: { text: "ΔV total (m/s)" } },
            hoverongaps: false,
          },
          ...(showContours && range
            ? [buildContourTrace({ x: activeXOffsets.map(toX), y: yAxisValues, z: activeGrid, range, maxDv })]
            : []),
          ...(bestPoint && bestX != null && bestY != null
            ? [
                {
                  type: "scatter" as const,
                  mode: "markers" as const,
                  x: [bestX],
                  y: [bestY],
                  marker: { symbol: "star", size: 16, color: "#f24d00", line: { color: "white", width: 1 } },
                  name: "Best point",
                  hoverinfo: "skip" as const,
                },
              ]
            : []),
        ]}
        layout={{
          ...DARK_LAYOUT,
          margin: { t: 24, r: 24, b: 48, l: 56 },
          xaxis: { title: { text: xMode === "date" ? "Departure date" : "Departure offset (days)" }, type: xMode === "date" ? "date" : undefined },
          yaxis: { title: { text: yMode === "arrival" ? "Arrival date" : "Time of flight (days)" }, type: yMode === "arrival" ? "date" : undefined },
        }}
        style={{ width: "100%", height: "360px" }}
        useResizeHandler
      />
    </div>
  )
}
