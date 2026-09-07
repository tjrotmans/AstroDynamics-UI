import { AlertTriangle } from "lucide-react"

import { MgaScanHeatmap } from "@/components/DesignPanel/MgaScanHeatmap"
import { pickBestMgaRecord } from "@/lib/mgaScanCost"
import { epochStringToJd } from "@/lib/utils"
import { useMissionStore } from "@/stores/missionStore"
import type { BestArcApiResult, MgaScanApiResult } from "@/api/client"

// Backend defaults (config.rs) -- mirrored here so the grid-density check
// below still works when the user hasn't touched a field (undefined in the
// store, backend applies its own default at request time).
const DEFAULT_SCAN_DEPARTURE_STEP_DAYS = 5
const DEFAULT_SCAN_TOF_GRID_POINTS_PER_LEG = 40
const DEFAULT_SURVEY_GRID_RESOLUTION = 30
const DEFAULT_SURVEY_DEPARTURE_WINDOW_DAYS = 60

// Paper-native stat, matching ResultsSection.tsx's own private "Stat" --
// deliberately NOT the dark shadcn StatField (src/components/StatField.tsx),
// which is styled for the app's dark result cards and would read wrong
// against this light paper background.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-[#dedbd2] py-1.5 pr-3.5 last:border-r-0 [&:not(:first-child)]:pl-3.5">
      <div className="text-[9px] font-bold tracking-[0.13em] text-[#8b877d] uppercase">{label}</div>
      <div className="mt-0.5 text-[15px] font-extrabold tracking-tight text-[#171512] tabular-nums">{value}</div>
    </div>
  )
}

// "Fig. 2" -- mirrors SurveyFigure.tsx's <figure>/fig-frame/<figcaption>
// chrome. The actual point of this component is the comparison strip below
// the heatmap: is the gravity-assist route actually worth it for this
// mission? Both sides use the same raw-v∞ ΔV convention as the direct
// porkchop's own dv_total_ms (see the design notes.ts) so the Δ is
// a real, exact comparison, not an approximation -- MGA's own real vis-viva
// capture_dv_ms is shown separately, outside the comparison, since the
// direct side has no equivalent yet (planned backend-side).
export function MgaScanFigure({ scanResult, bestArc }: { scanResult: MgaScanApiResult; bestArc: BestArcApiResult | null }) {
  const objective = useMissionStore((s) => s.config.mission.objective)
  const isFlyby = objective === "Flyby"
  const horizonYears = useMissionStore((s) => s.config.optimization?.mga?.scan?.horizon_years)
  const scanDepartureEpoch = useMissionStore((s) => s.config.optimization?.departure_epoch)
  const scanDepartureEpochJd = scanDepartureEpoch ? epochStringToJd(scanDepartureEpoch) : null
  const departureStepDays = useMissionStore((s) => s.config.optimization?.mga?.scan?.departure_step_days)
  const tofGridPointsPerLeg = useMissionStore((s) => s.config.optimization?.mga?.scan?.tof_grid_points_per_leg)
  const surveyGridResolution = useMissionStore((s) => s.config.trajectory.cruise?.grid_resolution)
  const surveyDepartureWindowDays = useMissionStore((s) => s.config.trajectory.cruise?.departure_window_days)

  const bestRecord = pickBestMgaRecord(scanResult.records, objective)
  const mgaDvMs = bestRecord ? bestRecord.vinf_dep_ms + bestRecord.sum_flyby_dv_ms + (isFlyby ? 0 : bestRecord.vinf_arr_ms) : null

  // Same Flyby-zeroing convention BestArcCard.tsx/DvWaterfall.tsx already
  // apply -- the backend's PorkchopGrid::evaluate has no knowledge of
  // mission.objective, so dv_arr_ms/dv_total_ms still price a real capture
  // burn for a Flyby result unless corrected here too.
  const directArrMs = isFlyby ? 0 : bestArc?.dv_arr_ms
  const directDvMs =
    bestArc?.dv_dep_ms !== undefined && directArrMs !== undefined ? bestArc.dv_dep_ms + directArrMs : bestArc?.dv_total_ms

  const deltaDvMs = directDvMs != null && mgaDvMs != null ? mgaDvMs - directDvMs : null
  const deltaTofDays =
    bestArc?.tof_days != null && bestRecord != null ? bestRecord.total_tof_days - bestArc.tof_days : null

  // this comparison is fundamentally one-sided, found from a
  // (a sequence the real Optimizer later confirmed WAS
  // competitive scanned as a clear loss here). A GOOD scan result (MGA
  // already cheaper even without any deep-space maneuver) is a reliable
  // positive signal -- the real optimizer can only match or beat it. A
  // bad/neutral result is NOT reliably a negative one: this scan is a pure
  // ballistic model (Lambert legs + a powered-flyby correction burn only,
  // capped at flyby_dv_max_ms below), with no mid-leg deep-space maneuver
  // at all -- the exact freedom that lets many real gravity-assist routes
  // actually pay off. `noClearWin` covers both "MGA scan came out worse/tied"
  // and "the scan found zero feasible branches at all" (bestRecord null) --
  // the latter is the most extreme case of the same problem, not a
  // different one.
  const noClearWin = bestRecord == null || (deltaDvMs != null && deltaDvMs >= 0)

  // A repeated body adjacent in the sequence (e.g. VEEGA's Earth -> Earth)
  // is a resonant-return leg -- this scan's N=0-only Lambert solver (see
  // the design notes MGA-scan backend-ask note) can't represent the true
  // resonant transfer for it at all, and silently substitutes a different,
  // usually worse, non-resonant transfer at every TOF grid point instead of
  // just failing outright. Worth calling out specifically since it's a
  // real, separate reason this exact sequence's scan number can undersell
  // it, on top of the general DSM-free limitation.
  const hasResonantLeg = scanResult.body_sequence.some((name, i) => i > 0 && name === scanResult.body_sequence[i - 1])

  // Grid-density mismatch (backend the design notes own 9w-v note:
  // a coarser MGA grid against a finer direct grid produced a misleading
  // "direct always wins" result in a real run once already). Simple,
  // defensible per-axis comparison rather than trying to replicate the
  // backend's exact combinatorial search cost: TOF axis compares
  // tof_grid_points_per_leg directly against the survey's own per-axis
  // grid_resolution (same kind of quantity -- points spanning a TOF
  // range); departure axis compares effective STEP SIZE, since the MGA
  // scan's horizon is typically much wider than the survey's departure
  // window and a raw point-count comparison would be unfair.
  const effectiveTofPoints = tofGridPointsPerLeg ?? DEFAULT_SCAN_TOF_GRID_POINTS_PER_LEG
  const effectiveSurveyResolution = surveyGridResolution ?? DEFAULT_SURVEY_GRID_RESOLUTION
  const mgaDepStepDays = departureStepDays ?? DEFAULT_SCAN_DEPARTURE_STEP_DAYS
  const surveyDepStepDays =
    (surveyDepartureWindowDays ?? DEFAULT_SURVEY_DEPARTURE_WINDOW_DAYS) / effectiveSurveyResolution
  const tofGridCoarser = effectiveTofPoints < effectiveSurveyResolution
  const depGridCoarser = mgaDepStepDays > surveyDepStepDays * 1.5 // some slack -- not a hard science, just a real order-of-magnitude flag
  const gridMismatch = tofGridCoarser || depGridCoarser

  return (
    <figure className="mt-4">
      <div className="border border-[#171512] bg-white p-3 pb-2">
        <MgaScanHeatmap records={scanResult.records} horizonYears={horizonYears} departureEpochJd={scanDepartureEpochJd} />
      </div>
      <figcaption className="mt-1.5 font-serif text-[11.5px] text-[#55524b] italic">
        <b className="mr-1.5 font-sans text-[10px] font-extrabold tracking-[0.08em] text-[#171512] uppercase not-italic">
          Fig. 2
        </b>
        Departure date × total time of flight, best-achievable ΔV per cell - ballistic MGA window scan via{" "}
        {scanResult.body_sequence.join(" → ")}.
      </figcaption>

      <div className="mt-4 grid grid-cols-3 gap-3 border border-[#dedbd2] bg-[#fbfaf6] p-3">
        <Stat label="Best direct ΔV" value={directDvMs != null ? `${(directDvMs / 1000).toFixed(3)} km/s` : "-"} />
        <Stat label="Best MGA ΔV" value={mgaDvMs != null ? `${(mgaDvMs / 1000).toFixed(3)} km/s` : "-"} />
        <Stat
          label="Δ (MGA − direct)"
          value={deltaDvMs != null ? `${deltaDvMs >= 0 ? "+" : ""}${(deltaDvMs / 1000).toFixed(3)} km/s` : "-"}
        />
        <Stat label="Best direct TOF" value={bestArc?.tof_days != null ? `${bestArc.tof_days.toFixed(0)} days` : "-"} />
        <Stat label="Best MGA TOF" value={bestRecord != null ? `${bestRecord.total_tof_days.toFixed(0)} days` : "-"} />
        <Stat
          label="Δ (MGA − direct)"
          value={deltaTofDays != null ? `${deltaTofDays >= 0 ? "+" : ""}${deltaTofDays.toFixed(0)} days` : "-"}
        />
      </div>

      {bestRecord?.capture_dv_ms != null && (
        <p className="mt-2 max-w-[62ch] text-[10.5px] text-[#8b877d]">
          Best MGA branch's real capture burn (vis-viva, honoring the configured capture orbit): {" "}
          {(bestRecord.capture_dv_ms / 1000).toFixed(3)} km/s - shown for reference only, not part of the
          comparison above, since the direct porkchop has no equivalent real capture-burn pricing yet (raw
          arrival v∞ only).
        </p>
      )}

      <p className="mt-1 text-[10.5px] text-[#8b877d]">
        {scanResult.n_legs_evaluated} legs evaluated, {scanResult.records.length} feasible branches found.
      </p>
      {scanResult.n_records_dropped > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-[#f24d00]">
          <AlertTriangle className="size-3.5" />
          {scanResult.n_records_dropped} feasible branches were dropped (max stored records reached) - the
          comparison above may not reflect the true best MGA branch.
        </p>
      )}

      {noClearWin && (
        <p className="mt-2 flex items-start gap-1.5 max-w-[62ch] text-[10.5px] text-[#8b877d]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#c99a2e]" />
          <span>
            {bestRecord == null
              ? "This scan found no feasible branch at all for this sequence."
              : "This scan doesn't show a ΔV advantage over the direct transfer."}{" "}
            That's not conclusive either way: this is a purely ballistic model (Lambert legs plus a
            powered-flyby correction burn only, capped by the flyby ΔV cap above) with no deep-space maneuver
            freedom at all - the real Optimizer below, using the MGA-1DSM model, can find routes this scan
            structurally can't represent.
            {hasResonantLeg && (
              <>
                {" "}This sequence also revisits the same body ({" "}
                {scanResult.body_sequence.find((name, i) => i > 0 && name === scanResult.body_sequence[i - 1])}
                ), a resonant-return leg this scan's Lambert solver can't solve directly either - it silently
                substitutes a different, usually worse, transfer at every grid point instead, which can make
                this specific sequence read as worse than it really is.
              </>
            )}{" "}
            Run the Optimizer with this sequence before ruling MGA out.
          </span>
        </p>
      )}

      {gridMismatch && (
        <p className="mt-2 flex items-start gap-1.5 max-w-[62ch] text-[10.5px] text-[#8b877d]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#c99a2e]" />
          <span>
            This scan&apos;s grid is coarser than the direct survey&apos;s ({effectiveTofPoints} TOF points/leg
            vs. {effectiveSurveyResolution} points/axis on the direct side; a {mgaDepStepDays}-day departure
            step vs. an effective {surveyDepStepDays.toFixed(1)}-day step on the direct side) - the two sides
            aren&apos;t being searched at matched resolution, which can bias this comparison toward direct
            transfer for reasons that have nothing to do with which is actually better. Consider raising TOF
            grid points per leg or lowering the departure step above.
          </span>
        </p>
      )}
    </figure>
  )
}
