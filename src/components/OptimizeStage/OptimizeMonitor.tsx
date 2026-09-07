import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import { useMissionStore } from "@/stores/missionStore"
import { useOptimizeStore } from "@/stores/optimizeStore"
import { isMgaInfeasibleGrade, isNoSolutionFitness } from "./sentinel"

const AXIS_LAYOUT = {
  ...DARK_LAYOUT,
  margin: { t: 24, r: 24, b: 48, l: 64 },
  showlegend: false,
} as const

// Keep Plotly responsive on big population logs: evenly sample down to this
// many points (the shape of the explored space survives; individual points
// don't matter at that density). Same idiom as the retired
// OptimizePopulationScatter's own cap.
const MAX_SCATTER_POINTS = 6000
function sampleEvenly<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const stride = rows.length / max
  return Array.from({ length: max }, (_, i) => rows[Math.floor(i * stride)])
}

export function OptimizeMonitor() {
  const steps = useOptimizeStore((state) => state.steps)
  const result = useOptimizeStore((state) => state.result)
  const method = useMissionStore((state) => state.config.optimization?.method)
  const mga = useMissionStore((state) => state.config.optimization?.mga)
  const isMga = method === "MGA"
  // Sentinel-valued steps (no valid candidate found yet) dwarf real fitness
  // values and would squash the y-axis autorange into a flat invisible line
  // -- exclude them from the plotted series entirely. MGA additionally
  // filters mga.rs's own graded infeasibility sentinel (1e8+ m/s, a
  // different magnitude than f64::MAX -- see sentinel.ts) -- GA/PSO's
  // best_fitness is a different unit entirely (km closest-approach in
  // phase 1) where a real bad value can legitimately be this large, so that
  // filter must not apply there.
  const isRealStep = (s: { best_fitness: number }) =>
    isMga ? !isMgaInfeasibleGrade(s.best_fitness) : !isNoSolutionFitness(s.best_fitness)
  const realSteps = steps.filter(isRealStep)

  // Steps are transient (live WS stream, not persisted); the finished
  // result IS persisted and carries everything these panels need
  // (convergence/phase1_convergence_km histories + the full
  // population_log). Only bail when NEITHER exists -- returning null the
  // moment steps were empty made every panel vanish on reload (
  //). MGA's numeric readout is
  // stream-only, so it still needs steps.
  if (steps.length === 0 && (result == null || isMga)) return null
  // MGA-only early bail (fix
  // anymore for the first few generations"): for GA/PSO the early
  // generations legitimately stream the feasible-capture SENTINEL as
  // best_fitness (nobody inside the target's SOI yet in a purely-random
  // generation 0) while still carrying full populations the scatter panels
  // can and should render -- replacing everything with a text line threw
  // that data away. The objective LINE simply stays empty until the first
  // feasible candidate exists (realSteps filtering handles it).
  if (isMga && steps.length > 0 && realSteps.length === 0) {
    return <p className="text-sm text-muted-foreground">No valid candidate found yet…</p>
  }

  // GA: phase 1 tracks closest-approach distance [km]; phase 2 (and PSO,
  // which has no phase 1) tracks the real configured objective's
  // dimensionless normalized fitness -- completely different scales, so
  // they get separate panels rather than one shared y-axis.
  //
  // MGA's phase field means something else entirely (mga.rs::phase1_fitness/
  // phase2_fitness): phase 1 is each of de_restarts independent DE searches
  // minimizing summed deep-space-manoeuvre DV [m/s]; phase 2 re-optimizes
  // total DV (departure + DSM + arrival burns, also m/s) seeded from every
  // restart's best individuals. Both are real DV in m/s, not a km/dimensionless
  // split -- reusing the GA/PSO labels here was actively misleading.
  const phase1 = realSteps.filter((s) => s.phase === 1)
  const phase2 = realSteps.filter((s) => s.phase === 2)

  // MGA gets a numeric status readout, not fitness-vs-generation plots
  //.
  //
  // Honesty rework after the user rightly called the old
  // "generation N" display nonsense. Verified against mga.rs: (a) the
  // stream's step index is a raw cumulative counter -- MBH hops or DE
  // generations, offset by de_restarts*0.6*de_generations even when phase 1
  // never ran, and RESTARTING per resonance-family branch and per candidate
  // sequence (auto mode), none of which is identified in the stream; (b)
  // best_fitness is best-so-far *within the current branch/sequence only*,
  // so it can jump UP when a new branch starts -- the true run-wide best is
  // the min over all received steps, computed here, not the latest value.
  // Streaming branch/sequence/restart context is planned backend-side;
  // until then this shows only what the stream actually supports.
  // No step/generation/hop counter shown at all -- the raw stream index is
  // an offset, per-branch-restarting internal counter (see mga.rs) the user
  // has twice said is useless noise. Just the solver and the best ΔV.
  if (isMga) {
    const searchMethod = (mga as { search_method?: string } | null | undefined)?.search_method ?? "Mbh"
    const solverLabel = searchMethod === "De" ? "DE (SHADE)" : "MBH (basin hopping)"
    const phase2Best = phase2.length > 0 ? Math.min(...phase2.map((s) => s.best_fitness)) : null
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">{solverLabel} - searching</span>
        {phase2Best != null && (
          <div className="flex items-baseline gap-2">
            <span className="font-heading text-3xl font-semibold text-primary tabular-nums">
              {(phase2Best / 1000).toFixed(2)}
            </span>
            <span className="text-sm text-muted-foreground">km/s best total ΔV this run</span>
          </div>
        )}
        {searchMethod === "De" && phase1.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Phase 1 (DSM-only) best: {(Math.min(...phase1.map((s) => s.best_fitness)) / 1000).toFixed(2)} km/s.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          The search runs multiple branches{mga?.sequence_search ? " and candidate sequences" : ""}, so the best
          value can plateau while a new branch explores. The final trajectory appears in Trajectory / Top-down when
          the run completes.
        </p>
      </div>
    )
  }

  // Live-plot redesign (direct user feedback: "axes values/
  // labels are weird, its weird that a second window pops up halfway
  // through, and it doesnt properly show what i need. Ideally we have:
  // objective convergence plot (x-axis properly shows generations), search
  // variable convergence plot"). What changed and why:
  // - ONE objective-convergence panel with dual y-axes instead of two
  //   sequentially-appearing plots -- the phase-2 plot used to mount only
  //   once phase 2 started streaming (the "second window popping up
  //   halfway through"), and its x-axis continued phase 1's cumulative
  //   step counter, so it appeared to start at some arbitrary offset
  //   ("random iterations"). Both traces now live in one panel that exists
  //   from the first streamed step, with a dashed marker where phase 2
  //   takes over. `step` IS the real cumulative generation counter
  //   (verified against run_optimization_with_progress: phase 1 restarts
  //   and phase 2 continue one shared counter; the post-search refinement
  //   appends further phase-2 steps, covered by the caption).
  // - Phase 1's km scale is log -- it legitimately starts at billions of
  //   km for a wide search space and converges many orders of magnitude,
  //   which on a linear axis rendered as a cliff followed by a flat line
  //   with unreadable tick labels.
  // - New search-variable convergence panel: the best candidate's four
  //   decision variables per generation (departure offset, burn angle
  //   theta, burn dv, out-of-plane phi), each normalized to its own search
  //   bounds so they share one 0-1 axis; hover shows the real value with
  //   units. Data comes from OptimizeStepMsg.best_params, which the
  // backend now streams for GA/PSO too (- previously
  //   MGA-only, so this panel degrades to a short note against an older
  //   backend that still sends null).
  // Objective-convergence: ONE series, one unit, x bounded by the user's
  // configured generation budget (rework, direct user feedback:
  // "No one understands the two phases, and no one understands why there
  // are more generations on x axis than given in user inputs... one plot,
  // regardless of what phase, that shows the objective function vs.
  // generation, where generation can only go to the max value given by
  // user input"). Made possible by the backend's same-day stream-contract
  // change: `best_fitness` is now ALWAYS the real configured objective's
  // best-so-far (the internal bootstrap phase re-scores its best under the
  // real objective once per generation), the step index is one unified
  // counter that never exceeds the configured budget, and the post-search
  // refinement no longer streams steps (its polish still lands in the
  // final result). Result fallback for reloads: the result's own
  // `convergence` history.
  // best_fitness is in the objective's NATURAL units since 
  //:
  // MinDeltaV streams m/s (shown as km/s), MinTof days, MTD km.
  //
  // Reload/preset fallback (second fix same day -- user, after
  // a dev-server restart: the plot "has no data beyond 21 (while it was
  // until 30) and it doesnt contain the refined final fitness"): the
  // result now persists `objective_history`, the EXACT [step, phase,
  // value] series the live plot drew, refinement included -- so a saved/
  // preset result renders identically to the live view. The old
  // `convergence` field (internal normalized phase-2-only fitness) remains
  // only as a last-resort for results saved before this field existed,
  // labeled as normalized.
  const liveMode = realSteps.length > 0
  const objectiveNameEarly = useMissionStore.getState().config.optimization?.objective
  const savedHistory = (result?.objective_history ?? []).filter((row) => row.length >= 3 && !isNoSolutionFitness(row[2]))
  const hasSavedHistory = !liveMode && savedHistory.length > 0
  const legacyHistory = (result?.convergence ?? []).filter((v) => !isNoSolutionFitness(v))
  const scaleY = (v: number) => (objectiveNameEarly === "MinDeltaV" ? v / 1000 : v)
  const objX = liveMode
    ? realSteps.map((s) => s.step)
    : hasSavedHistory
      ? savedHistory.filter((r) => r[1] !== 3).map((r) => r[0])
      : legacyHistory.map((_, i) => i)
  const objY = liveMode
    ? realSteps.map((s) => scaleY(s.best_fitness))
    : hasSavedHistory
      ? savedHistory.filter((r) => r[1] !== 3).map((r) => scaleY(r[2]))
      : legacyHistory
  // The red final-value dot, from stream or saved history alike.
  const finalRefined: { x: number; y: number } | null = liveMode
    ? (() => {
        const last = realSteps.filter((s) => s.phase === 3).slice(-1)[0]
        return last ? { x: last.step, y: scaleY(last.best_fitness) } : null
      })()
    : (() => {
        const last = savedHistory.filter((r) => r[1] === 3).slice(-1)[0]
        return last ? { x: last[0], y: scaleY(last[2]) } : null
      })()

  // Search-variable scatters, v2 (direct user feedback on v1's
  // single normalized-lines panel: "no that looks terrible, dont plot them
  // altogether. Better idea: plot a theta vs phi scatter with colorbar the
  // generation count. Do this also for dep offset vs dv"), extended same
  // day ("plot all phi/theta (and dv/offset) data/solutions of each
  // generation, not just a best one"): two 2D scatter panels -- burn
  // DIRECTION (theta vs phi, degrees) and burn TIMING/ENERGY (departure
  // offset vs ΔV) -- each point colored by generation, so the search's walk
  // through the space reads as a color gradient converging on the answer.
  //
  // (The old standalone OptimizePopulationScatter component that once
  // rendered these clouds has been orphaned -- zero importers -- since the
  // Phase B redesign; this supersedes it in the live monitor rather than
  // remounting it.) Chromosome order mirrors the backend's own
  // bounds_from(): [dep_offset_days, theta_rad, dv_ms, phi_rad].
  // Axes v3 (: "i want departure dv vs
  // arrival dv, and then departure offset vs. coast time"): each point now
  // pairs its chromosome's DEPARTURE quantities with its own evaluated
  // OUTCOMES (arrival burn, achieved TOF) -- recorded backend-side as
  // fitness-evaluation side-products (population_outcomes on the stream,
  // dv_arrival_ms/tof_days on population_log rows).
  //
  // Live full-population clouds: the stream carries each GA generation's
  // whole evaluated (feasible) population + outcomes. Data tiers, best
  // available wins: completed run's population_log > live streamed
  // populations > nothing (PSO streams no populations/outcomes -- its
  // panels show the note below until it does).
  const liveCloud: { gen: number; params: number[]; out: [number, number]; refine: boolean }[] = steps.flatMap((s) =>
    (s.population ?? []).flatMap((ind, i) => {
      const out = s.population_outcomes?.[i]
      return ind.length >= 4 && out != null && out.length >= 2
        ? [{ gen: s.step, params: ind, out: [out[0], out[1]] as [number, number], refine: s.phase === 3 }]
        : []
    }),
  )
  const populationLog = !isMga ? result?.population_log : undefined
  const logCloud: { gen: number; params: number[]; out: [number, number]; refine: boolean }[] = (populationLog ?? []).flatMap((r) =>
    !isNoSolutionFitness(r.fitness) && r.params.length >= 4 && r.dv_arrival_ms != null && r.tof_days != null
      ? [{ gen: r.generation, params: r.params, out: [r.dv_arrival_ms, r.tof_days] as [number, number], refine: r.phase === 3 }]
      : [],
  )
  const scatterRows =
    logCloud.length > 0 ? sampleEvenly(logCloud, MAX_SCATTER_POINTS) : sampleEvenly(liveCloud, MAX_SCATTER_POINTS)
  // Refinement probes rendered as their own red trace on every panel
  // (
  // plots... so its clear where the final value came from") -- phase 3 on
  // the wire/log.
  const REFINE_COLOR = "#ff5252"
  const mainRows = scatterRows.filter((r) => !r.refine)
  const refineRows = scatterRows.filter((r) => r.refine)

  const optimization = useMissionStore.getState().config.optimization
  const configuredGenerations = optimization?.ga?.generations ?? optimization?.pso?.iterations
  const objectiveName = optimization?.objective
  const objectiveLabel =
    !liveMode && !hasSavedHistory
      ? "objective fitness (old saved run: normalized)"
      : objectiveName === "MinDeltaV"
        ? "best total ΔV [km/s]"
        : objectiveName === "MinTof"
          ? "best time of flight [days]"
          : "best target-distance error [km]"

  return (
    <div className="flex flex-col gap-4">
      <Plot
        data={[
          // ONE "best solution" line (final simplification per
          // -- the earlier dashed/solid feasibility
          // split was "all a bit confusing"). Made sound by the same-day
          // hard-constraint fitness restore: every feasible capture scores
          // strictly below every infeasible candidate, so the fitness
          // leader plotted here IS the best feasible solution from the
          // moment any exists -- before that moment the line honestly
          // shows the best not-yet-capturing candidate's cost (it can
          // step UP once the first real capture takes over; that step IS
          // the capture being found).
          {
            type: "scatter",
            mode: "lines",
            x: objX,
            y: objY,
            line: { color: CHART_COLORS[0], width: 2 },
          },
          // Refinement's final polished value in red at the axis's
          // committed end (the intermediate probes stay in the scatter
          // panels only -- a column of markers at one x read as "a weird
          // vertical line").
          {
            type: "scatter",
            mode: "markers",
            x: finalRefined ? [finalRefined.x] : [],
            y: finalRefined ? [finalRefined.y] : [],
            marker: { color: "#ff5252", size: 9 },
            hovertemplate: "final (after refinement) · %{y:.3f}<extra></extra>",
          },
        ]}
        layout={{
          ...AXIS_LAYOUT,
          xaxis: {
            title: { text: "generation" },
            // The unified stream counter never exceeds the configured
            // budget, so the axis can honestly commit to it up front --
            // the line grows left-to-right into a fixed frame instead of
            // the axis rescaling every generation.
            ...(configuredGenerations != null && realSteps.length > 0
              ? { range: [0, configuredGenerations] }
              : {}),
          },
          yaxis: {
            title: { text: objectiveLabel },
            automargin: true,
          },
        }}
        style={{ width: "100%", height: "240px" }}
        useResizeHandler
      />
      <p className="text-xs text-muted-foreground">
        Best solution found so far, per generation. Before the first real capture exists the line shows the
        best not-yet-capturing candidate&apos;s cost, so a step UP marks the moment a genuine capture takes
        over. The red dot is the final value after the post-search refinement pass - its probes appear in red
        on the scatter panels below.
      </p>

      {scatterRows.length > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Plot
              data={[
                {
                  type: "scattergl",
                  mode: "markers",
                  x: mainRows.map((r) => r.params[2] / 1000),
                  y: mainRows.map((r) => r.out[0] / 1000),
                  marker: {
                    color: mainRows.map((r) => r.gen),
                    colorscale: "Viridis",
                    // Semi-transparent: a converged GA re-logs
                    // near-identical individuals every generation, so
                    // thousands of points stack on the same few pixels --
                    // opacity makes the stacking read as density.
                    size: 4,
                    opacity: 0.45,
                    colorbar: { title: { text: "gen" }, thickness: 12, len: 0.9 },
                  },
                  hovertemplate:
                    "departure %{x:.3f} · arrival %{y:.3f} km/s<br>generation %{marker.color}<extra></extra>",
                },
                {
                  type: "scattergl",
                  mode: "markers",
                  x: refineRows.map((r) => r.params[2] / 1000),
                  y: refineRows.map((r) => r.out[0] / 1000),
                  marker: { color: REFINE_COLOR, size: 5, opacity: 0.85 },
                  hovertemplate:
                    "refinement · departure %{x:.3f} · arrival %{y:.3f} km/s<extra></extra>",
                },
              ]}
              layout={{
                ...AXIS_LAYOUT,
                xaxis: { title: { text: "departure ΔV [km/s]" } },
                yaxis: { title: { text: "arrival ΔV [km/s]" }, automargin: true },
              }}
              style={{ width: "100%", height: "260px" }}
              useResizeHandler
            />
            <Plot
              data={[
                {
                  type: "scattergl",
                  mode: "markers",
                  x: mainRows.map((r) => r.params[0]),
                  y: mainRows.map((r) => r.out[1]),
                  marker: {
                    color: mainRows.map((r) => r.gen),
                    colorscale: "Viridis",
                    size: 4,
                    opacity: 0.45,
                    colorbar: { title: { text: "gen" }, thickness: 12, len: 0.9 },
                  },
                  hovertemplate:
                    "offset %{x:.2f} d · TOF %{y:.1f} d<br>generation %{marker.color}<extra></extra>",
                },
                {
                  type: "scattergl",
                  mode: "markers",
                  x: refineRows.map((r) => r.params[0]),
                  y: refineRows.map((r) => r.out[1]),
                  marker: { color: REFINE_COLOR, size: 5, opacity: 0.85 },
                  hovertemplate: "refinement · offset %{x:.2f} d · TOF %{y:.1f} d<extra></extra>",
                },
              ]}
              layout={{
                ...AXIS_LAYOUT,
                xaxis: { title: { text: "departure offset [days]" } },
                yaxis: { title: { text: "coast time to arrival [days]" }, automargin: true },
              }}
              style={{ width: "100%", height: "260px" }}
              useResizeHandler
            />
            {/* Third panel restored (
                plot of the search variables, with the two angles plotted
                against each other") -- the burn-DIRECTION view, alongside
                the two outcome views above. */}
            <Plot
              data={[
                {
                  type: "scattergl",
                  mode: "markers",
                  x: mainRows.map((r) => (r.params[1] * 180) / Math.PI),
                  y: mainRows.map((r) => (r.params[3] * 180) / Math.PI),
                  marker: {
                    color: mainRows.map((r) => r.gen),
                    colorscale: "Viridis",
                    size: 4,
                    opacity: 0.45,
                    colorbar: { title: { text: "gen" }, thickness: 12, len: 0.9 },
                  },
                  hovertemplate: "θ %{x:.1f}° · φ %{y:.1f}°<br>generation %{marker.color}<extra></extra>",
                },
                {
                  type: "scattergl",
                  mode: "markers",
                  x: refineRows.map((r) => (r.params[1] * 180) / Math.PI),
                  y: refineRows.map((r) => (r.params[3] * 180) / Math.PI),
                  marker: { color: REFINE_COLOR, size: 5, opacity: 0.85 },
                  hovertemplate: "refinement · θ %{x:.1f}° · φ %{y:.1f}°<extra></extra>",
                },
              ]}
              layout={{
                ...AXIS_LAYOUT,
                xaxis: { title: { text: "burn angle θ [deg]" } },
                yaxis: { title: { text: "out-of-plane φ [deg]" }, automargin: true },
              }}
              style={{ width: "100%", height: "260px" }}
              useResizeHandler
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Every evaluated individual of every generation, colored by generation (dark = early, bright =
            late): departure vs. arrival burn cost (the total-ΔV trade), departure date offset vs. achieved
            coast time, and burn direction (θ vs. φ).
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Outcome scatters (departure vs arrival ΔV, offset vs coast time) need per-individual outcome data:
          GA runs stream it live since 2026-08-20 (restart the mission server if a fresh GA run shows nothing
          here); PSO exposes only its global best per iteration, and results saved before this feature carry
          no outcome fields - re-run to populate.
        </p>
      )}
    </div>
  )
}
