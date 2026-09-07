import { useEffect, useRef, useState } from "react"

import { ConvergenceFigure } from "./ConvergenceFigure"
import { GncHandoffBand } from "./GncHandoffBand"
import { MgaScanFigure } from "./MgaScanFigure"
import { MgaScanSection } from "./MgaScanSection"
import { MissionMarginTable } from "./MissionMarginTable"
import { OptimizerSection } from "./OptimizerSection"
import { PorkchopExplorer } from "@/components/PorkchopExplorer/PorkchopExplorer"
import { ResultsSection } from "./ResultsSection"
import { StageCard, StageSubSection } from "./StageCard"
import { SurveyFigure } from "./SurveyFigure"
import { SurveySection } from "./SurveySection"
import { ValidationPanel } from "@/components/MissionEditor"
import { useDesignGnc, useDesignTrajectory } from "@/hooks/useApi"
import { useMgaScan } from "@/hooks/useMgaScan"
import { useOptimizeStream } from "@/hooks/useOptimizeStream"
import { jdToEpochString } from "@/lib/utils"
import { useDesignStore } from "@/stores/designStore"
import { useMgaScanStore } from "@/stores/mgaScanStore"
import { useMissionStore } from "@/stores/missionStore"
import { useOptimizeStore } from "@/stores/optimizeStore"
import { useUiStore } from "@/stores/uiStore"

// The "sheet" -- masthead, phase rail, and the 01 Trajectory design document
// that writes itself as the user works. Phase B revision (direct
// user feedback): Survey and Optimizer are now two genuinely separate
// sections built on the paper itself (SurveySection/OptimizerSection,
// paper-native controls) instead of one shared dark-styled disclosure --
// Survey is always visible right after Mission Definition; Optimizer only
// appears once a survey result exists ("when we have the porkchop we can
// open the optimizer settings below it").
export function StudyPaper({ onFullscreen }: { onFullscreen: () => void }) {
  const config = useMissionStore((s) => s.config)
  const departureBody = config.trajectory.departure_body
  const targetBody = config.target_body.name
  const flybyBodies = config.optimization?.mga?.flyby_bodies ?? []
  const candidateBodies = config.optimization?.mga?.sequence_search?.candidate_bodies ?? []
  const enableOptimization = useMissionStore((s) => s.enableOptimization)
  const seedOptimizationDeparture = useMissionStore((s) => s.seedOptimizationDeparture)
  const seedOptimizationDvRange = useMissionStore((s) => s.seedOptimizationDvRange)
  const optimization = config.optimization

  const backToLanding = useUiStore((s) => s.backToLanding)
  const setStudyPhase = useUiStore((s) => s.setStudyPhase)

  const trajectoryResult = useDesignStore((s) => s.trajectoryResult)
  const setTrajectoryResult = useDesignStore((s) => s.setTrajectoryResult)
  const setGncResult = useDesignStore((s) => s.setGncResult)
  const selectedTrajectory = useDesignStore((s) => s.selectedTrajectory)

  const trajectoryMutation = useDesignTrajectory()
  const gncMutation = useDesignGnc()
  const surveyRunning = trajectoryMutation.isPending || gncMutation.isPending
  const surveyError = trajectoryMutation.error ?? gncMutation.error

  const { start: startMgaScan } = useMgaScan()
  const mgaScanState = useMgaScanStore((s) => s.state)
  const mgaScanResult = useMgaScanStore((s) => s.result)
  const mgaScanError = useMgaScanStore((s) => s.error)
  const mgaScanRunning = mgaScanState === "starting" || mgaScanState === "running"

  const { start, cancel } = useOptimizeStream()
  const connectionState = useOptimizeStore((s) => s.connectionState)
  const steps = useOptimizeStore((s) => s.steps)
  const result = useOptimizeStore((s) => s.result)
  const optimizeError = useOptimizeStore((s) => s.error)
  const isOptimizing = connectionState === "starting" || connectionState === "streaming"
  const [cancelRequested, setCancelRequested] = useState(false)

  // Direct and MGA are two independent, explicitly user-controlled
  // enable/disable checkboxes in Mission Definition (direct
  // user feedback). MGA auto-checks itself once the mission already has a
  // real sequence configured (a preset or a landing-page sky route) --
  // this genuinely needs a render-time latch, not a lazy useState
  // initializer: this component mounts once, CSS-hidden, before the user
  // ever picks a mission (the app's documented "always mounted" shell
  // pattern), so a lazy initializer's one-time check always sees an empty
  // config and locks in `false` forever -- confirmed live (the header route
  // breadcrumb correctly showed "Earth → Jupiter → Saturn → Uranus →
  // Neptune" from the exact same `flybyBodies` value the lazy initializer
  // had already permanently missed). `mgaTouched` distinguishes "never
  // touched, keep auto-latching" from "user made an explicit choice, stop"
  // -- the auto-latch only fires before the user's first manual toggle, so
  // explicitly unchecking it while data still exists doesn't get silently
  // overridden back on (the actual bug the previous, now-removed
  // reveal-button version of this hit). Plain state, not a ref -- this
  // repo's stricter react-hooks lint config forbids reading a ref during
  // render at all.
  const [directEnabled, setDirectEnabled] = useState(true)
  const [mgaEnabled, setMgaEnabled] = useState(false)
  const [mgaTouched, setMgaTouched] = useState(false)
  if (!mgaTouched && !mgaEnabled && (flybyBodies.length > 0 || candidateBodies.length > 0)) {
    setMgaEnabled(true)
  }
  const handleToggleMga = (enabled: boolean) => {
    setMgaTouched(true)
    setMgaEnabled(enabled)
  }

  // Whole page IS optimization once entered, same rationale the old
  // OptimizeStage effect had -- gated so it only fires once, not on every
  // render while this component stays mounted (CSS-hidden) after the tool
  // switches away.
  useEffect(() => {
    if (!optimization) enableOptimization()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimization])

  // Folds the old "Refine in Optimize" hand-off into a single document: the
  // first time Run optimization is pressed after a survey exists, seed the
  // optimizer's departure window from the survey's best analytical point,
  // same REFINE_WINDOW_DAYS the old hand-off button used.
  //
  // Also seeds the departure ΔV bounds themselves (real user
  // report: a 1-second survey found ~17 km/s total ΔV to Mercury, but a
  // MinDeltaV GA run against the SAME mission converged to ~23 km/s despite
  // minutes of search -- worse than the closed-form solve it was supposed
  // to beat). Root-caused, not guessed: GA's departure burn is a genuinely
  // free search parameter (dv_min_ms..dv_max_ms), completely independent of
  // the Lambert solution the survey already found -- and the STATIC
  // defaults (2,500-4,500 m/s, tuned for a generic inner-solar-system
  // transfer) don't scale with the target body at all. Verified against the
  // real numbers: Mercury's own real vis-viva parking-orbit injection burn
  // for the survey's ~7,465 m/s departure v∞ works out to ~5,500 m/s
  // (Oberth-reduced, but still real) -- ABOVE the default 4,500 m/s
  // ceiling, so the GA's search space silently excluded the one departure
  // geometry the survey had already shown was good, and could only ever
  // find something worse. Same one-shot seeding pattern as the departure
  // window above (respects a later manual edit, never re-overrides): a
  // generous [0.3x, 1.5x] bracket around the survey's raw departure v∞
  // comfortably contains the true Oberth-reduced burn (always somewhat
  // below v∞) with headroom for the GA to actually search, without trying
  // to replicate the exact vis-viva formula here just to seed a starting
  // range.
  // Real bug fixed (
  // are automatically set... despite my own input sometimes before
  // running"): this ref resets on every mount/reload, so the seed below
  // fired on the FIRST run of every session and silently clobbered
  // manually-entered dv bounds. The dv seed now goes through the store's
  // own `seedOptimizationDvRange`, which is a permanent no-op once the
  // user has ever edited either bound (persisted `dvRangeTouched` flag) --
  // the ref only still gates the departure-window seed and same-session
  // re-seeding.
  const hasSeededRef = useRef(false)
  const runOptimize = () => {
    const depJd = trajectoryResult?.best_arc?.dep_jd ?? trajectoryResult?.optimizer?.dep_jd
    if (!hasSeededRef.current && depJd !== undefined) {
      hasSeededRef.current = true
      seedOptimizationDeparture(jdToEpochString(depJd), 30)
      const surveyVinfMs = trajectoryResult?.best_arc?.dv_dep_ms
      if (surveyVinfMs != null && surveyVinfMs > 0) {
        seedOptimizationDvRange(Math.max(200, surveyVinfMs * 0.3), surveyVinfMs * 1.5)
      }
    }
    setCancelRequested(false)
    start(config)
  }

  // Widen the actual survey request's TOF window by ± half the departure
  // window,: viewing the porkchop by arrival date
  // instead of TOF showed a sheared diamond, not a rectangle, because the
  // backend only ever computed one fixed TOF range shared across every
  // departure offset -- the corners of the (departure date, arrival date)
  // rectangle correspond to TOF values outside that range and were simply
  // never solved for. `departure_window_days` is the *total* sweep width
  // centered on the departure epoch (backend doc comment on CruiseConfig),
  // so offsets range over ±half of it -- that half-width is exactly the
  // margin needed on each side of the TOF window for every (departure,
  // arrival) combination inside the user's original window to have a real,
  // actually-computed TOF neighbor to interpolate from (see
  // PorkchopHeatmap's buildArrivalGrid, which resamples back down onto the
  // user's *original* window, not this widened one -- widening beyond what
  // the target window needs is just wasted grid density, not wrong).
  // Only the request sent to the backend is widened -- the stored
  // `config.trajectory.cruise` (what the user actually typed, and what the
  // optimizer below shares) is untouched; PorkchopHeatmap filters back down
  // to the user's real TOF window for the TOF-axis view. Free in terms of
  // backend cost: total grid points stays `grid_resolution^2` either way,
  // just spread over a wider TOF span (coarser per-day density) -- the
  // user's own "Grid resolution" field is still the cost dial.
  const runSurvey = () => {
    const cruise = config.trajectory.cruise
    // Match the backend's own CruiseConfig defaults (100/400/60, per its
    // doc comment) when the user hasn't typed explicit values -- the UI
    // only ever showed those as placeholders, so `cruise` fields are
    // commonly still null/undefined even though a real 100-400/60 request
    // is what's actually about to be sent either way.
    const tofMin = cruise?.tof_days_min ?? 100
    const tofMax = cruise?.tof_days_max ?? 400
    const halfWindowDays = (cruise?.departure_window_days ?? 60) / 2
    const surveyConfig = {
      ...config,
      trajectory: {
        ...config.trajectory,
        // Real bug (found, TODO "Presets can load a config
        // Explore can't run"): SurveySection has no solver picker (this
        // section always runs GridSearch, per its own header comment), but
        // nothing previously enforced that -- a preset carrying a
        // different solver (e.g. apophis_orbit.toml's "Hohmann", a Phase 2
        // GNC-sizing test case never meant to hit this endpoint at all)
        // silently sent that solver instead, either 422ing on fields
        // GridSearch needs or running the wrong analysis with no
        // indication why. Force it here so "the survey always runs
        // GridSearch" is actually true, not just the UI's intent.
        solver: "GridSearch" as const,
        cruise:
          halfWindowDays > 0
            ? { ...cruise, tof_days_min: tofMin - halfWindowDays, tof_days_max: tofMax + halfWindowDays }
            : cruise,
      },
    }
    trajectoryMutation.mutate(surveyConfig, { onSuccess: setTrajectoryResult })
    gncMutation.mutate(config, { onSuccess: setGncResult })
  }

  const runMgaScan = () => startMgaScan(config)

  const route = [departureBody, ...flybyBodies, targetBody].filter(Boolean).join(" → ")
  const adopted = selectedTrajectory != null

  return (
    <div className="h-full overflow-y-auto bg-[#fbfaf6] text-[#171512]">
      <div className="px-7 pt-4.5">
        <div className="flex items-baseline justify-between">
          <h1 className="text-[17px] font-extrabold tracking-[0.05em] uppercase">
            AstroDynamics <span className="text-[#f24d00]">Mission Planner</span>
          </h1>
          <div className="font-mono text-[10px] tracking-[0.1em] text-[#55524b]">TM-2026-07 · REV A</div>
        </div>
        <div className="mt-0.5 flex justify-between pb-2 text-[11.5px] text-[#55524b]">
          <span>{route || "-"}</span>
          <button type="button" onClick={backToLanding} className="font-bold text-[#f24d00]">
            ← back to the sky
          </button>
        </div>
        <div className="h-[5px] border-t-[3px] border-b border-t-[#171512] border-b-[#171512]" />
      </div>

      {/* Real UX finding (audit): this used to repeat the full
          01/02/03 phase-and-lock-state listing that the floating PhaseDock
          (bottom-right, the actual interactive navigation) already shows --
          two different visual styles for the identical information on the
          same screen, plus a second, differently-styled way to jump to GNC
          (this rail's "02 GNC" was its own clickable button, duplicating
          the dock's Enter action). The big "01 TRAJECTORY DESIGN" banner
          right below already anchors "you're in phase 01" on its own, so
          this rail was a single current-status line -- no repeated phase
          list, no second click target.
 Superseded (Spacecraft Configuration Builder design):
          "02" is no longer a separate top-level tool, it's a second view of
          THIS SAME paper (StudyView swaps StudyPaper for VehiclePaper based
          on uiStore.studyPhase) -- so a real click target here is the
          correct navigation now, not a duplicate of PhaseDock's. */}
      <div className="flex items-center gap-4 border-b border-[#dedbd2] px-7 py-2.5">
        <span className="text-[10px] font-bold tracking-[0.1em] text-[#8b877d] uppercase">
          Phase 01 of 03 &middot; {adopted ? "trajectory adopted, GNC unlocked below" : "trajectory in progress"}
        </span>
        {adopted && (
          <button
            type="button"
            onClick={() => setStudyPhase("02")}
            className="text-[10px] font-bold tracking-[0.1em] text-[#f24d00] uppercase hover:underline"
          >
            02 Vehicle & GNC design →
          </button>
        )}
      </div>

      <div className="px-7 pt-5 pb-20">
        <div className="flex items-baseline gap-3.5 bg-[#f24d00] px-3.5 py-2 text-white">
          <span className="text-[21px] font-extrabold">01</span>
          <span className="text-[13px] font-bold tracking-[0.14em] uppercase">Trajectory design</span>
        </div>

        <div className="mt-4 grid grid-cols-[196px_1fr] gap-7">
          <MissionMarginTable
            directEnabled={directEnabled}
            onToggleDirect={setDirectEnabled}
            mgaEnabled={mgaEnabled}
            onToggleMga={handleToggleMga}
          />

          <main>
            <p className="max-w-[62ch] text-[12px] text-[#55524b]">
              The study begins empty and writes itself as you work. Results are appended below as they're
              produced.
            </p>

            {(directEnabled || mgaEnabled) && (
              <StageCard label="Survey">
                {directEnabled && (
                  <StageSubSection label="Direct transfer">
                    <SurveySection onRun={runSurvey} running={surveyRunning} error={surveyError?.message} />
                    {trajectoryResult && <SurveyFigure result={trajectoryResult} />}
                  </StageSubSection>
                )}
                {mgaEnabled && (
                  <div className={directEnabled ? "mt-6 border-t border-[#dedbd2] pt-6" : ""}>
                    <StageSubSection label="Multi-gravity-assist transfer">
                      <MgaScanSection onRun={runMgaScan} running={mgaScanRunning} error={mgaScanError ?? undefined} />
                      {mgaScanResult && (
                        <MgaScanFigure scanResult={mgaScanResult} bestArc={trajectoryResult?.best_arc ?? null} />
                      )}
                      {/* Explore moved here (direct):
                          it's now purely an MGA-scan feature -- only visible
                          once a real scan has real feasible branches to
                          explore, using the scan's own departure-date x
                          total-TOF grid and the full multi-leg route instead
                          of the direct porkchop's single-leg one. */}
                      {mgaScanResult && mgaScanResult.records.length > 0 && (
                        <div className="mt-6 border-t border-[#dedbd2] pt-6">
                          <div className="mb-2 text-[9.5px] font-bold tracking-[0.14em] text-[#8b877d] uppercase">Explore</div>
                          <PorkchopExplorer records={mgaScanResult.records} bodySequence={mgaScanResult.body_sequence} />
                        </div>
                      )}
                    </StageSubSection>
                  </div>
                )}
              </StageCard>
            )}

            {(trajectoryResult || mgaScanResult) && optimization && (
              <StageCard label="Optimizer">
                <OptimizerSection
                  onRun={runOptimize}
                  onCancel={() => {
                    cancel()
                    setCancelRequested(true)
                  }}
                  running={isOptimizing}
                  cancelRequested={cancelRequested}
                  done={connectionState === "done"}
                  error={optimizeError ?? undefined}
                />
                {/* `|| result`: steps are deliberately not
                    persisted (transient WS stream), but the finished result
                    IS -- gating this figure on steps alone made every
                    convergence/search-space panel vanish on reload even
                    though the full population_log/convergence history was
                    sitting right there in the persisted result. */}
                {(steps.length > 0 || result != null) && <ConvergenceFigure />}
                {result && <ResultsSection result={result} onFullscreen={onFullscreen} />}
              </StageCard>
            )}
            {adopted && <GncHandoffBand />}

            <div className="mt-6 max-w-[62ch] text-[11px]">
              <ValidationPanel />
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
