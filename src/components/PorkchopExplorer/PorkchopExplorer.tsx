// "Explore mode" from the design notes Porkchop & Planetary-Alignment Explorer
// design note -- a departure-date slider that simultaneously moves a
// crosshair on a heatmap and redraws the 2D planetary-alignment view
// (SolarSystemMap2D) to that date's real body positions, with the
// selected date's best-found route traced as a schematic (not propagated)
// arc.
//
// Rebuilt to run entirely off the MGA
// scan's own data instead of the direct-transfer porkchop -- Explore now
// lives ONLY inside the MGA scan sub-section (only visible once an MGA scan
// has actually run), tracing the FULL multi-leg route (departure -> each
// flyby -> target) at the selected date's best-found branch, not just a
// single direct leg. The direct-porkchop-driven version this replaced is
// gone, not kept as a fallback -- see StudyPaper.tsx for where this mounts.
import { useMemo, useState } from "react"
import type { Data } from "plotly.js"

import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import { gridRange, jdToIsoDate } from "@/components/DesignPanel/porkchopShared"
import { buildMgaGrid, MJD2000_TO_JD, pickBestMgaRecord } from "@/lib/mgaScanCost"
import { SolarSystemMap2D, type MapBody, type OrbitRing } from "./SolarSystemMap2D"
import { PLANET_ELEMENTS, keplerPositionM } from "@/lib/keplerEphemeris"
import { lambertArcPoints } from "@/lib/lambert"
import { AU_M } from "@/components/scene/sceneShared"
import { useMissionStore } from "@/stores/missionStore"
import type { MgaScanRecordApi } from "@/api/client"

const DEP_COLOR = "#f59e0b"
const TARGET_COLOR = "#f472b6"
const FLYBY_COLOR = "#c084fc"

// Distinct per-planet colors for the alignment view's background bodies --
// see PorkchopExplorer's earlier note: all non-mission planets
// used to share one flat grey, indistinguishable once the legend (too large
// for the plot area) was removed. Chosen for contrast, not astronomically
// meaningful.
const PLANET_COLORS: Record<string, string> = {
  Mercury: "#a8a29e",
  Venus: "#eab308",
  Mars: "#ef4444",
  Jupiter: "#fb923c",
  Saturn: "#facc15",
  Uranus: "#67e8f9",
  Neptune: "#60a5fa",
}
const FALLBACK_COLOR = "#8899bb"

export function PorkchopExplorer({
  records,
  bodySequence,
}: {
  records: MgaScanRecordApi[]
  /** [departure_body, flyby_bodies..., target_body], in visit order -- MgaScanApiResult's own field. */
  bodySequence: string[]
}) {
  const objective = useMissionStore((s) => s.config.mission.objective)

  const gridResult = useMemo(() => buildMgaGrid(records, objective), [records, objective])
  const range = useMemo(() => (gridResult ? gridRange(gridResult.grid) : null), [gridResult])
  const depDates = useMemo(() => (gridResult ? gridResult.xs : []), [gridResult])

  const [dateIdx, setDateIdx] = useState(0)
  const selectedDepMjd2000 = depDates[Math.min(dateIdx, depDates.length - 1)] ?? 0
  const departureJd = selectedDepMjd2000 + MJD2000_TO_JD

  const recordsAtDate = useMemo(
    () => records.filter((r) => r.dep_mjd2000 === selectedDepMjd2000),
    [records, selectedDepMjd2000],
  )
  const bestRecord = useMemo(() => pickBestMgaRecord(recordsAtDate, objective), [recordsAtDate, objective])

  // Real encounter epoch per body in the sequence -- cumulative sum of
  // leg_tofs_days onto the departure date, same chromosome-decode idiom
  // LiveCandidateReplay.tsx already uses for the optimizer's own live
  // replay (see the design notes).
  const encounterEpochs = useMemo(() => {
    if (!bestRecord) return []
    const epochs = [departureJd]
    for (const legTof of bestRecord.leg_tofs_days) epochs.push(epochs[epochs.length - 1] + legTof)
    return epochs
  }, [bestRecord, departureJd])

  const { bodies, orbitRings, path } = useMemo(() => {
    const bodies: MapBody[] = Object.entries(PLANET_ELEMENTS).map(([name, els]) => {
      const [x, y] = keplerPositionM(els, departureJd)
      const isDeparture = name === bodySequence[0]
      const isTarget = name === bodySequence[bodySequence.length - 1]
      const isFlyby = bodySequence.slice(1, -1).includes(name)
      const color = isDeparture ? DEP_COLOR : isTarget ? TARGET_COLOR : isFlyby ? FLYBY_COLOR : (PLANET_COLORS[name] ?? FALLBACK_COLOR)
      return { name, positionAu: [x / AU_M, y / AU_M], color }
    })

    const orbitRings: OrbitRing[] = Object.entries(PLANET_ELEMENTS).map(([name, els]) => ({
      name,
      radiusAu: els.a0,
    }))

    // Full multi-leg schematic route: one Lambert arc per leg, concatenated
    // into a single dashed path (same "schematic, not propagated" fidelity
    // as the single-leg case this replaces), plus a hollow marker at each
    // intermediate/final body's REAL position at its own encounter epoch --
    // same "filled at departure time / hollow at its real later position"
    // convention added for the direct case (see git history),
    // now doing it once per leg instead of once for a single target.
    const path: [number, number][] = []
    if (bestRecord && encounterEpochs.length === bodySequence.length) {
      for (let i = 0; i < bodySequence.length - 1; i++) {
        const fromEls = PLANET_ELEMENTS[bodySequence[i]]
        const toEls = PLANET_ELEMENTS[bodySequence[i + 1]]
        if (!fromEls || !toEls) continue
        const rFrom = keplerPositionM(fromEls, encounterEpochs[i])
        const rTo = keplerPositionM(toEls, encounterEpochs[i + 1])
        const legTofS = bestRecord.leg_tofs_days[i] * 86_400
        const arcPts = lambertArcPoints(rFrom, rTo, legTofS, 30)
        if (arcPts) path.push(...arcPts.map(([x, y]): [number, number] => [x / AU_M, y / AU_M]))

        const isFinal = i === bodySequence.length - 2
        bodies.push({
          name: `${bodySequence[i + 1]} (${isFinal ? "at arrival" : `leg ${i + 2} encounter`})`,
          positionAu: [rTo[0] / AU_M, rTo[1] / AU_M],
          color: isFinal ? TARGET_COLOR : FLYBY_COLOR,
          style: "open",
        })
      }
    }

    return { bodies, orbitRings, path }
  }, [departureJd, bestRecord, encounterEpochs, bodySequence])

  if (depDates.length === 0 || !gridResult || !range) return null

  const rangeAu = Math.max(...bodies.map((b) => Math.max(Math.abs(b.positionAu[0]), Math.abs(b.positionAu[1]))), 1) * 1.15
  const xDates = depDates.map((d) => jdToIsoDate(d + MJD2000_TO_JD))
  const selectedXDate = jdToIsoDate(departureJd)

  const heatmapData: Data[] = [
    {
      type: "heatmap",
      x: xDates,
      y: gridResult.ys,
      z: gridResult.grid,
      colorscale: "Viridis",
      zmin: range[0],
      zmax: range[1],
      showscale: false,
      hoverongaps: false,
      hoverinfo: "skip",
    },
    {
      type: "scatter",
      mode: "markers",
      x: [selectedXDate],
      y: bestRecord ? [bestRecord.total_tof_days] : [],
      marker: { color: CHART_COLORS[0], size: 14, symbol: "cross", line: { width: 2, color: "#0f0f0f" } },
      name: "Selected",
      hoverinfo: "skip",
    },
  ]

  const routeLabel = bodySequence.join(" → ")

  return (
    <div>
      <p className="max-w-[62ch] text-[12px] text-[#55524b]">
        Drag the slider to see how the scan's own departure-date × total-TOF grid and the real planetary alignment
        change together -- the highlighted column's own best-found MGA branch ({routeLabel}) is traced as a
        schematic (not propagated) multi-leg arc below, same fidelity as the scan itself.
      </p>

      <div className="mt-3 flex flex-col gap-1">
        <label htmlFor="pe-date-slider" className="text-[11.5px] font-semibold text-[#171512]">
          Departure date: {selectedXDate.slice(0, 10)}
          {bestRecord && (
            <span className="ml-2 font-normal text-[#8b877d]">
              best this column: {bestRecord.total_tof_days.toFixed(0)} d total TOF
            </span>
          )}
        </label>
        <input
          id="pe-date-slider"
          type="range"
          min={0}
          max={Math.max(depDates.length - 1, 0)}
          step={1}
          value={dateIdx}
          onChange={(e) => setDateIdx(Number(e.target.value))}
          className="w-full accent-primary"
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="border border-[#171512] bg-white p-3 pb-2">
          <Plot
            data={heatmapData}
            layout={{
              ...DARK_LAYOUT,
              margin: { t: 8, r: 8, b: 40, l: 48 },
              xaxis: { title: { text: "Departure date" }, type: "date" },
              yaxis: { title: { text: "Total time of flight (days)" } },
              showlegend: false,
            }}
            config={{ displayModeBar: false, responsive: true }}
            style={{ width: "100%", height: 320 }}
            useResizeHandler
          />
        </div>
        <div className="border border-[#171512] bg-white p-3 pb-2">
          <SolarSystemMap2D
            bodies={bodies}
            orbitRings={orbitRings}
            path={path}
            rangeAu={rangeAu}
            heightPx={320}
            pathDashed
            pathName={`${routeLabel} (schematic)`}
            showLegend={false}
          />
        </div>
      </div>
      <p className="mt-1.5 font-serif text-[11.5px] text-[#55524b] italic">
        Planet positions from J2000 mean orbital elements (Standish 1992), not real ANISE ephemeris -- decorative
        alignment context only, same fidelity as the rest of this scan.
      </p>
    </div>
  )
}
