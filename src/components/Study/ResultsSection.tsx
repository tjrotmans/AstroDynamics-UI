import { useState } from "react"
import { AlertTriangle } from "lucide-react"
import { isNoSolutionFitness } from "@/components/OptimizeStage/sentinel"
import { useDesignStore } from "@/stores/designStore"
import { useMissionStore } from "@/stores/missionStore"
import { useUiStore } from "@/stores/uiStore"
import type { OptimizeApiResult } from "@/api/client"

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border-r border-[#dedbd2] py-2.5 pr-3.5 last:border-r-0 [&:not(:first-child)]:pl-3.5">
      <div className="text-[9px] font-bold tracking-[0.13em] text-[#8b877d] uppercase">{label}</div>
      <div className="mt-0.5 text-[22px] font-extrabold tracking-tight text-[#171512] tabular-nums">{value}</div>
      {note && <div className="text-[10.5px] text-[#55524b]">{note}</div>}
    </div>
  )
}

// "Fig. 3" continuation -- the results block, appearing once an
// optimization job has produced a real OptimizeApiResult. Same field paths
// OptimizeResultCard used to read (that component is retired -- its role is
// now this section, restyled to the mockup's .stats/.dtable markup rather
// than a Card). This is also the ONLY place a trajectory can be adopted in
// Phase B -- the survey's analytical best point (SurveyFigure) is reference
// only, matching the mockup (Adopt only appears after the real optimizer
// converges).
export function ResultsSection({ result, onFullscreen }: { result: OptimizeApiResult; onFullscreen: () => void }) {
  const setSelectedTrajectory = useDesignStore((s) => s.setSelectedTrajectory)
  // the launcher check is only on the survey's best arc (not on
  // OptimizeApiResult -- planned backend-side); same mission/vehicle, so it is
  // the honest stand-in for "does a launcher cover departure".
  const surveyLaunchCheck = useDesignStore((s) => s.trajectoryResult?.best_arc?.launch_vehicle_check ?? null)
  const setStudyPhase = useUiStore((s) => s.setStudyPhase)
  const fullConfig = useMissionStore((s) => s.config)
  // Save-as-example capture status (
  // page state and make it the standard one when clicking on the landing
  // page on mercury orbit... make a toml for it") -- POSTs the FULL current
  // config + this result to the local dev capture endpoint, which writes
  // the landing chip's snapshot files (result + wholesale config) AND a
  // permanent TOML in the backend's config/ directory. Local dev tooling;
  // requires a dev-server rebuild/reload to see the new snapshot baked in.
  const [captureStatus, setCaptureStatus] = useState<string | null>(null)
  const captureAsExample = async () => {
    setCaptureStatus("saving…")
    try {
      const res = await fetch("/api/dev/capture-preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "mercury", config: fullConfig, optimize_result: result }),
      })
      const bodyJson = (await res.json()) as { written?: string[]; error?: string }
      setCaptureStatus(
        res.ok
          ? `saved: ${(bodyJson.written ?? []).length} files (restart the frontend dev server to bake it into the chip)`
          : `failed: ${bodyJson.error ?? res.status}`,
      )
    } catch (err) {
      setCaptureStatus(`failed: ${err instanceof Error ? err.message : "network error"}`)
    }
  }
  const captureRadiusM = useMissionStore((s) => s.config.trajectory.capture?.target_orbit_radius_m ?? null)
  const missionObjective = useMissionStore((s) => s.config.mission.objective)

  if (isNoSolutionFitness(result.fitness)) {
    return (
      <p className="mt-4 text-[12px] text-[#55524b]">
        No valid candidate found - try a larger population/generation count or a wider TOF range.
      </p>
    )
  }

  const isMga = result.method === "MGA"
  const dsmTotalMs = (result.mga_dv_dsms_ms ?? []).reduce((sum, dv) => sum + dv, 0)
  const totalDvMs = result.dv_departure_ms + dsmTotalMs + result.dv_arrival_ms

  const legs: { label: string; tofDays: number; dvMs: number }[] = isMga
    ? (result.mga_body_sequence ?? []).slice(0, -1).map((body, i) => ({
        label: `${body} → ${result.mga_body_sequence![i + 1]}`,
        tofDays: result.mga_leg_tofs_days?.[i] ?? 0,
        dvMs: result.mga_dv_dsms_ms?.[i] ?? 0,
      }))
    : [{ label: `${result.method_display}`, tofDays: result.achieved_tof_days, dvMs: result.dv_departure_ms }]

  const adopt = () => {
    setSelectedTrajectory({
      kind: "optimizer",
      label: `${result.method_display} (real dynamics)`,
      dv_total_ms: isMga ? totalDvMs : result.dv_departure_ms + result.dv_arrival_ms,
      arc: result.arc,
      // Real Phase 01 burn/orbit data (the design notes "Phase 01's real output
      // contract" and Phase 03 "STANDING REQUIREMENT" sections) -- carried
      // through so Phase 03 shows/fires the SAME complete trajectory Phase
      // 01 actually computed, not a reconstruction. `arc` alone is only
      // the middle transfer segment -- these two are the other two-thirds.
      preDepartureOrbitArc: result.pre_departure_orbit_arc,
      postCaptureOrbitArc: result.post_capture_orbit_arc,
      achievedTofDays: result.achieved_tof_days,
      depJd: result.dep_jd,
      captureTimeS: result.capture_time_s,
      captureDvInertialMps: result.capture_dv_inertial_mps,
      departureDvInertialMps: result.departure_dv_inertial_mps,
      // Backend Phase 14d: the result carries its OWN launch
      // check at the optimizer's real C3; the survey's check is only the
      // fallback for a cached pre-14d result. Phase 14e: the two-pool
      // ledger + who pays departure, so Phase 03 sets external_stage from
      // the real pool instead of the survey's feasible flag.
      launchVehicleFeasible: result.launch_vehicle_check?.feasible ?? surveyLaunchCheck?.feasible ?? null,
      launchVehicleCheck: result.launch_vehicle_check ?? surveyLaunchCheck,
      dvLedger: result.dv_ledger ?? null,
      dvLedgerVehicle: {
        massKg: fullConfig.spacecraft.mass_kg,
        propellantMassKg: fullConfig.spacecraft.propellant_mass_kg,
        ispS: fullConfig.spacecraft.propulsion?.isp_s ?? null,
      },
      departureDvPool: result.departure_dv_pool ?? result.dv_ledger?.departure_dv_pool ?? null,
      departureMode: result.departure_mode,
      launchGeometry: result.launch_geometry ?? null,
      injectionEpochJd: result.injection_epoch_jd,
      dvDepartureMs: result.dv_departure_ms,
      dvArrivalMs: result.dv_arrival_ms,
      mgaDvDsmsMs: result.mga_dv_dsms_ms,
      mgaDvDsmsInertialMps: result.mga_dv_dsms_inertial_mps,
      mgaDsmPositionsM: result.mga_dsm_positions_m as [number, number, number][] | null | undefined,
      mgaLegTofsDays: result.mga_leg_tofs_days,
    })
    // One button, one flow (adopting and continuing to
    // GNC "are doing the same thing... maybe we dont need seperate
    // buttons"): adopting also navigates straight into phase 02, so the
    // click has an immediately visible effect instead of only revealing
    // a band further down the page.
    setStudyPhase("02")
  }

  return (
    <div className="mt-4">
      <div className="grid grid-cols-4 border-t-[3px] border-b border-t-[#171512] border-b-[#171512]">
        <Stat
          label="Total ΔV"
          value={`${((isMga ? totalDvMs : result.dv_departure_ms + result.dv_arrival_ms) / 1000).toFixed(3)}`}
          note="km/s"
        />
        <Stat label="Time of flight" value={`${result.achieved_tof_days.toFixed(0)}`} note="days" />
        {/* "Arrival miss" replaced (direct):
            show the RESULT orbit's own perigee (or the flyby distance) with
            the error against the configured target inline, instead of a
            bare closest-approach number that needed a separate caption line
            to interpret. post_capture_orbit_periapsis_m is always present
            for a capture-type result since the same-day backend change
            (closest-approach-fitted arrival). */}
        {result.post_capture_orbit_periapsis_m != null ? (
          <Stat
            label="Capture perigee"
            value={`${(result.post_capture_orbit_periapsis_m / 1000).toFixed(0)}`}
            note={
              captureRadiusM != null
                ? `km · target ${(captureRadiusM / 1000).toFixed(0)} km (Δ ${((result.post_capture_orbit_periapsis_m - captureRadiusM) / 1000).toFixed(0)} km)`
                : "km"
            }
          />
        ) : (
          <Stat
            label="Flyby distance"
            value={`${result.miss_km.toFixed(1)}`}
            note={
              captureRadiusM != null
                ? `km · target ${(captureRadiusM / 1000).toFixed(0)} km (Δ ${(result.miss_km - captureRadiusM / 1000).toFixed(1)} km)`
                : "km"
            }
          />
        )}
        {isMga ? (
          <Stat
            label="Mult. shooting"
            value={result.mga_ms_converged ? "conv." : result.mga_ms_converged === false ? "best-effort" : "-"}
          />
        ) : (
          <Stat label="Objective" value={result.objective} />
        )}
      </div>

      {isMga && result.mga_ms_converged === false && (
        <p className="mt-2 flex items-start gap-1.5 border-[1.5px] border-[#f24d00] bg-[#f24d00]/8 px-3 py-2 text-[11px] text-[#171512]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#f24d00]" />
          <span>
            <b className="text-[#f24d00]">Multiple-shooting refinement did not converge.</b> This is the analytic
            MGA search&apos;s best-effort arc, re-propagated only partway - it has real position/velocity
            discontinuities at the leg boundaries (flyby nodes), not a smooth, flyable trajectory. Treat the ΔV and
            arc shown here as approximate; do not adopt for GNC design without re-running with different bounds or
            seeds.
          </span>
        </p>
      )}

      {/* Loud no-capture warning (: "in
          such cases, the optimizer should clearly show it failed to find
          an orbit within the given bounds") -- an Orbit/Landing mission
          whose best point never achieved a feasible capture (inside the
          target's SOI) now says so plainly instead of quietly showing
          flyby numbers. */}
      {(missionObjective === "Orbit" || missionObjective === "Landing") &&
        !isMga &&
        result.capture_time_s == null && (
          <p className="mt-2 flex items-start gap-1.5 border-[1.5px] border-[#f24d00] bg-[#f24d00]/8 px-3 py-2 text-[11px] text-[#171512]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#f24d00]" />
            <span>
              <b className="text-[#f24d00]">No orbit found.</b> The mission objective is {missionObjective},
              but the best candidate&apos;s closest approach ({result.miss_km.toFixed(0)} km) never entered the
              target&apos;s sphere of influence, so no physically meaningful capture exists - this result is a
              flyby. Widen the ΔV/angle/departure-window bounds, raise the generation budget, or extend the max
              coast time, then re-run.
            </span>
          </p>
        )}

      {/* Final-orbit Kepler elements (:
          "show the final orbit around mercury kepler parameters in the
          output (at least SMA, eccentricity, inclination)") -- all three
          derived backend-side from the REAL post-burn state the ring was
          propagated from. */}
      {/* SMA falls back to (periapsis+apoapsis)/2 for results produced
 before the dedicated field existed (-- also why "the
          final kepler elements are not showing" could happen on a result
          from a mid-day server build). Inclination has no equivalent
          fallback (it needs the plane normal, not radii). */}
      {(result.post_capture_orbit_sma_m != null ||
        (result.post_capture_orbit_periapsis_m != null && result.post_capture_orbit_apoapsis_m != null)) && (
        <p className="mt-1.5 text-[11px] text-[#55524b]">
          Final orbit: a ={" "}
          {(
            (result.post_capture_orbit_sma_m ??
              (result.post_capture_orbit_periapsis_m! + result.post_capture_orbit_apoapsis_m!) / 2) / 1000
          ).toFixed(0)}{" "}
          km · e = {(result.post_capture_orbit_eccentricity ?? 0).toFixed(4)}
          {result.post_capture_orbit_inclination_deg != null &&
            ` · i = ${result.post_capture_orbit_inclination_deg.toFixed(2)}°`}
          {result.post_capture_orbit_period_s != null &&
            ` · T = ${(result.post_capture_orbit_period_s / 3600).toFixed(2)} h`}
        </p>
      )}

      {/* Table 2 is MGA-only since (direct user feedback: "i
          think its useless for Direct transfers, as it shows per leg info.
          Its more for MGA optims") -- a single-leg result's TOF/ΔV are
          already in the stats grid above, and the lone table row only ever
          restated the departure burn under a label that read as a total. */}
      {isMga && (
      <table className="mt-4 w-full border-collapse text-[12px]">
        <caption className="mb-1 text-left font-serif text-[11.5px] text-[#55524b] italic">
          <b className="mr-1.5 font-sans text-[10px] font-extrabold tracking-[0.08em] text-[#171512] uppercase not-italic">
            Table 2
          </b>
          Converged legs and manoeuvres.
        </caption>
        <thead>
          <tr>
            <th className="border-t-2 border-b border-t-[#171512] border-b-[#171512] py-1 pr-2 text-left text-[9.5px] font-bold tracking-[0.12em] text-[#55524b] uppercase">
              Leg
            </th>
            <th className="border-t-2 border-b border-t-[#171512] border-b-[#171512] py-1 pr-2 text-right text-[9.5px] font-bold tracking-[0.12em] text-[#55524b] uppercase">
              TOF [d]
            </th>
            <th className="border-t-2 border-b border-t-[#171512] border-b-[#171512] py-1 text-right text-[9.5px] font-bold tracking-[0.12em] text-[#55524b] uppercase">
              ΔV [km/s]
            </th>
          </tr>
        </thead>
        <tbody>
          {legs.map((leg, i) => (
            <tr key={leg.label + i}>
              <td className="border-b border-[#dedbd2] py-1.5 pr-2 text-[#171512]">{leg.label}</td>
              <td className="border-b border-[#dedbd2] py-1.5 pr-2 text-right tabular-nums text-[#171512]">
                {leg.tofDays.toFixed(1)}
              </td>
              <td className="border-b border-[#dedbd2] py-1.5 text-right tabular-nums text-[#171512]">
                {(leg.dvMs / 1000).toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}

      <p className="mt-4 max-w-[62ch] font-serif text-[12px] text-[#55524b] italic">
        Adopting this trajectory freezes phase 01 and opens 02 Vehicle &amp; GNC design.
      </p>
      <div className="mt-3 flex items-center gap-2.5">
        <button
          type="button"
          onClick={adopt}
          className="border-[1.5px] border-[#171512] bg-[#171512] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#fbfaf6] uppercase hover:border-[#f24d00] hover:bg-[#f24d00]"
        >
          Adopt trajectory → 02
        </button>
        <button
          type="button"
          onClick={onFullscreen}
          className="border-[1.5px] border-[#171512] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#171512] uppercase hover:border-[#f24d00] hover:text-[#f24d00]"
        >
          ⛶ Fullscreen playback
        </button>
        <button
          type="button"
          onClick={captureAsExample}
          className="border-[1.5px] border-[#dedbd2] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#8b877d] uppercase hover:border-[#f24d00] hover:text-[#f24d00]"
          title="Write this result + the full current mission config as the Mercury Orbiter landing example (snapshot JSONs + a permanent backend TOML)"
        >
          ⬇ Save as example
        </button>
      </div>
      {captureStatus && <p className="mt-1.5 text-[10.5px] text-[#8b877d]">{captureStatus}</p>}
    </div>
  )
}
