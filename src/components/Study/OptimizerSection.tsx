import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"

import { ForceModelFields } from "./ForceModelFields"
import { GaParamsFields } from "./GaParamsFields"
import { MgaParamsFields } from "./MgaParamsFields"
import { PhysicsFields } from "./PhysicsFields"
import { PsoParamsFields } from "./PsoParamsFields"
import { PaperDisclosure, PaperField, PaperInput, PaperSelect } from "./paperForm"
import { useMissionStore } from "@/stores/missionStore"
import type { OptimizationConfig } from "@/api/client"

const OBJECTIVES: { value: OptimizationConfig["objective"]; label: string }[] = [
  { value: "MatchTargetDistance", label: "Match target distance (Flyby/Orbit)" },
  { value: "MinDeltaV", label: "Minimize ΔV" },
  { value: "MinTof", label: "Minimize time of flight" },
]
// "Multiple Shooting" removed from this list entirely (direct
//) -- it isn't a real standalone method choice, backend or
// product-wise: multiple shooting is the real-dynamics refinement MGA's
// own converged closed-form solution already gets automatically (see
// mga_ms_converged), never something a user picks in place of GA/PSO/MGA.
// It used to be listed here (disabled) as if it were a fourth upcoming
// option, which was misleading -- removed rather than left disabled.
const METHODS: { value: OptimizationConfig["method"]; label: string }[] = [
  { value: "GA", label: "Genetic Algorithm (direct transfer)" },
  { value: "PSO", label: "Particle Swarm (direct transfer)" },
  { value: "MGA", label: "Multi-Gravity-Assist (MGA)" },
]

// Only appears once a survey (porkchop) exists -- "when we have the
// porkchop we can open the optimizer settings below it" -- and only shows
// controls not already asked for elsewhere: no departure epoch (Table 1),
// no departure/target body or flyby sequence (Table 1's Route), no
// departure window (Survey section, mirrored automatically into
// optimization.departure_window_days by missionStore's setTrajectoryCruise).
export function OptimizerSection({
  onRun,
  onCancel,
  running,
  cancelRequested,
  done,
  error,
}: {
  onRun: () => void
  onCancel: () => void
  running: boolean
  cancelRequested: boolean
  done: boolean
  error?: string
}) {
  const optimization = useMissionStore((s) => s.config.optimization)
  const setOptimizationObjective = useMissionStore((s) => s.setOptimizationObjective)
  const setOptimizationMethod = useMissionStore((s) => s.setOptimizationMethod)
  const setOptimizationDvRange = useMissionStore((s) => s.setOptimizationDvRange)
  const setOptimizationMaxCoastDays = useMissionStore((s) => s.setOptimizationMaxCoastDays)
  const setOptimizationDepartureWindow = useMissionStore((s) => s.setOptimizationDepartureWindow)
  const missionObjective = useMissionStore((s) => s.config.mission.objective)
  const captureRadiusM = useMissionStore((s) => s.config.trajectory.capture?.target_orbit_radius_m ?? 0)
  const setCaptureRadius = useMissionStore((s) => s.setCaptureRadius)
  const setOptimizationAngleRanges = useMissionStore((s) => s.setOptimizationAngleRanges)

  if (!optimization) return null
  const isMga = optimization.method === "MGA"

  // Capture radius moved here from Mission Definition (direct
  //), with a mission-contextual label: it's the ORBIT
  // insertion perigee for a capture mission, the requested FLYBY distance
  // for a flyby -- one backend field (trajectory.capture.
  // target_orbit_radius_m), two meanings. Hidden entirely under MinDeltaV
  // for a capture mission, which is radius-free since the same-day backend
  // redefinition (total ΔV into any bound orbit at the achieved approach):
  // showing an inert control there would violate the parity rule.
  const isFlyby = missionObjective === "Flyby"
  const radiusUsed = isFlyby || optimization.objective === "MatchTargetDistance"
  const radiusLabel = isFlyby ? "Flyby distance (km)" : "Capture perigee (km)"

  return (
    <div>
      <p className="max-w-[62ch] text-[12px] text-[#55524b]">
        Search under real propagated dynamics - slower than the survey above, but the result is a real
        trajectory, not a Lambert approximation. Convergence streams live; the finished trajectory renders in
        the viewport.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <PaperField label="Optimization objective" htmlFor="opt-objective">
          <PaperSelect
            id="opt-objective"
            value={optimization.objective}
            options={OBJECTIVES.map((o) => ({ value: o.value, label: o.label }))}
            onChange={setOptimizationObjective}
          />
        </PaperField>
        <PaperField label="Method" htmlFor="opt-method">
          <PaperSelect
            id="opt-method"
            value={optimization.method}
            options={METHODS.map((m) => ({ value: m.value, label: m.label }))}
            onChange={setOptimizationMethod}
          />
        </PaperField>
      </div>
      {!isMga && (
        <p className="mt-1.5 max-w-[62ch] text-[10.5px] text-[#8b877d]">
          GA/PSO search a single direct Earth-to-target transfer only -- no flyby sequence. Add a flyby to Table 1's
          Route (or switch to MGA below) for a gravity-assisted search.
        </p>
      )}

      {/* dv_min_ms/dv_max_ms/max_coast_days/force_model are real required
          fields but MGA's own optimizer never reads them -- see
          ForceModelFields' header comment, carried over unchanged. */}
      {!isMga && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <PaperField label="Departure ΔV min (m/s)" htmlFor="opt-dv-min">
              <PaperInput id="opt-dv-min" value={optimization.dv_min_ms} onChange={(v) => setOptimizationDvRange(Number(v), optimization.dv_max_ms)} />
            </PaperField>
            <PaperField label="Departure ΔV max (m/s)" htmlFor="opt-dv-max">
              <PaperInput id="opt-dv-max" value={optimization.dv_max_ms} onChange={(v) => setOptimizationDvRange(optimization.dv_min_ms, Number(v))} />
            </PaperField>
          </div>
          {/*: these bounds are auto-widened from the survey's own
              best departure v∞ the first time Run optimization is pressed
              (see StudyPaper.tsx's runOptimize) -- but only once a survey
              has actually run, and never overriding a later manual edit.
              Left as generic defaults otherwise, which can silently exclude
              the real departure burn a distant/deep-gravity-well target
              needs (confirmed for Mercury: the default 4,500 m/s ceiling
              sat below its own real ~5,500 m/s minimum injection burn). */}
          <p className="max-w-[62ch] text-[10.5px] text-[#8b877d]">
            Auto-widened from the survey&apos;s best departure v∞ the first time you run this (unless you have
            edited either bound yourself -- a manual edit is never overridden). If you skip the survey, these
            stay at generic defaults that may not bracket the real departure burn this target needs -- check
            against Fig. 1&apos;s best-arc departure ΔV if the optimizer converges to something worse than the
            survey found.
          </p>
          {/* Real discoverability gap, (
              departure window now... Does it mean the departure date is
              fixed?", then "its not clear that the same departure window is
              taken as in the scan, so maybe just add the departure window
              to the optimizer part as input") -- this used to have NO
              control at all (the Survey's departure-window field mirrors
              into optimization.departure_window_days one-way), which made
              the departure date look silently fixed. A read-only status
              line was tried first and explicitly rejected in favor of a
              real input. The Survey mirror still works (editing the
              Survey's field updates this too); this input just also allows
              setting it directly. */}
          <PaperField label="Departure window (days)" htmlFor="opt-dep-window">
            <PaperInput
              id="opt-dep-window"
              value={optimization.departure_window_days ?? 0}
              onChange={(v) => setOptimizationDepartureWindow(Number(v))}
            />
          </PaperField>
          <p className="max-w-[62ch] text-[10.5px] text-[#8b877d]">
            The departure date is searched over ±half this window around{" "}
            {optimization.departure_epoch ?? "the mission departure epoch"}
            {(optimization.departure_window_days ?? 0) <= 0 && " - currently 0, so the departure date is FIXED"}.
            Pre-filled from the Survey&apos;s own departure window; the first run re-centers the epoch on the
            survey&apos;s best departure date.
          </p>
          {radiusUsed && (
            <PaperField label={radiusLabel} htmlFor="opt-capture-radius">
              <PaperInput
                id="opt-capture-radius"
                value={(captureRadiusM / 1000).toFixed(0)}
                onChange={(v) => setCaptureRadius(Number(v) * 1000)}
              />
            </PaperField>
          )}
          {radiusUsed && (
            <p className="max-w-[62ch] text-[10.5px] text-[#8b877d]">
              {isFlyby
                ? "The closest-approach distance the search drives toward."
                : "The insertion perigee radius the Match-target-distance search drives toward."}{" "}
              Under Minimize ΔV this field is not used at all - that objective finds its own optimal capture
              radius (total ΔV into any bound orbit).
            </p>
          )}
          {/* Configurable angle search ranges (direct user
              request: "all the inputs/search variables should be
              configurable by the user, the ranges i mean") -- the last two
              chromosome dimensions that had hardcoded bounds. Defaults
              shown are the backend's own (theta full circle, phi ±45°). */}
          <div className="grid grid-cols-2 gap-3">
            <PaperField label="Burn angle θ min (deg)" htmlFor="opt-theta-min">
              <PaperInput
                id="opt-theta-min"
                value={optimization.theta_min_deg ?? 0}
                onChange={(v) => setOptimizationAngleRanges({ theta_min_deg: Number(v) })}
              />
            </PaperField>
            <PaperField label="Burn angle θ max (deg)" htmlFor="opt-theta-max">
              <PaperInput
                id="opt-theta-max"
                value={optimization.theta_max_deg ?? 360}
                onChange={(v) => setOptimizationAngleRanges({ theta_max_deg: Number(v) })}
              />
            </PaperField>
            <PaperField label="Out-of-plane φ min (deg)" htmlFor="opt-phi-min">
              <PaperInput
                id="opt-phi-min"
                value={optimization.phi_min_deg ?? -45}
                onChange={(v) => setOptimizationAngleRanges({ phi_min_deg: Number(v) })}
              />
            </PaperField>
            <PaperField label="Out-of-plane φ max (deg)" htmlFor="opt-phi-max">
              <PaperInput
                id="opt-phi-max"
                value={optimization.phi_max_deg ?? 45}
                onChange={(v) => setOptimizationAngleRanges({ phi_max_deg: Number(v) })}
              />
            </PaperField>
          </div>
          <PaperField label="Max coast time (days)" htmlFor="opt-max-coast">
            <PaperInput id="opt-max-coast" value={optimization.max_coast_days} onChange={(v) => setOptimizationMaxCoastDays(Number(v))} />
          </PaperField>
          <ForceModelFields />
        </div>
      )}

      <div className="mt-3">
        {optimization.method === "GA" && <GaParamsFields />}
        {optimization.method === "PSO" && <PsoParamsFields />}
        {optimization.method === "MGA" && <MgaParamsFields />}
      </div>

      <PaperDisclosure title="Advanced (physics)">
        <PhysicsFields />
      </PaperDisclosure>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={running || !optimization.target_body}
          className="flex items-center gap-1.5 border-[1.5px] border-[#171512] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#171512] uppercase hover:border-[#f24d00] hover:text-[#f24d00] disabled:opacity-40"
        >
          {running && <Loader2 className="size-3.5 animate-spin" />}
          Run optimization
        </button>
        {running && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelRequested}
            className="text-[10.5px] font-bold tracking-[0.1em] text-[#8b877d] uppercase hover:text-[#f24d00]"
          >
            {cancelRequested ? "Stop requested…" : "Stop"}
          </button>
        )}
        {!optimization.target_body && (
          <span className="text-[10.5px] text-[#8b877d]">Pick a target body in the Route above.</span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-[#f24d00]">
            <AlertCircle className="size-3.5" /> {error}
          </span>
        )}
        {done && !running && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-[#2e9e53]">
            <CheckCircle2 className="size-3.5" /> Converged
          </span>
        )}
      </div>
    </div>
  )
}
