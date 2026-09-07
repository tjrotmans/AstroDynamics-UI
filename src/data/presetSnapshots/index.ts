// Pre-baked analytical/search results for the landing sky's 3 preset chips
// (Cassini-Huygens/Galileo/Voyager 2) -- Landing->Study roadmap item 1
//), revised same day after:
// "yes this is the idea but the idea is to have everything, including mga
// scan and an optimization run too, not only the direct scan." Each preset
// now carries three real, separately-captured pieces (not just the direct
// survey from the first cut):
//
// 1. `survey` -- a real `TrajectoryApiResult` from `POST /api/design/
//    trajectory` (closed-form Lambert GridSearch), Earth -> the preset's
//    target body.
// 2. `mgaScan` -- a real `MgaScanApiResult` from `POST /api/mga-scan` (the
//    ballistic no-DSM powered-flyby grid scan), captured against each
//    preset's real flyby sequence. Cassini/Galileo came back with real
//    feasible branches (937/401 records after reduction, see below);
//    Voyager 2's E-J-S-U-N grand tour came back with zero feasible
//    branches at the scan resolution tried -- a real, honest "no assist
//    window found here" result, not an error, and the app's own scan UI
//    already renders an empty state correctly for this case.
// 3. `optimizeResult`/`optimizeError` -- a full MGA optimizer attempt for
//    each preset. **Cassini now has a real, converged `OptimizeApiResult`**
// (revised after the backend investigated and fixed the
//    search-robustness gap behind the original "always infeasible" result
// -- see the design notes
//    solution"): tight bounds around the published GTOP Cassini-2 decision
//    vector, a small (not default-sized) pruning config for real seed
//    diversity, and -- a real config bug caught only by re-reading the
//    actual GTOP problem spec -- `mission.objective: "Orbit"` with a real
//    elliptical capture (`target_orbit_radius_m: 108_950_000,
//    capture_eccentricity: 0.98`, GTOP's own r_p/e), not "Flyby" (the
//    first several attempts used Flyby, which is why `dv_arrival_ms` came
//    back nonsensical -- GTOP's own published 8.383 km/s already includes
//    this exact capture burn, confirmed by `gtop_cassini2_check.rs`'s own
//    comment).
// **Replaced again ** with a re-run at moderately higher
//    search effort (450 MBH hops, wider pruning: 80/12/18/7 vs. the
//    original 60/8/12/6), after the backend landed a real fix
//    (`ms_final_target_point`, `mga.rs`) for a genuine correctness bug: the
//    multiple-shooting refinement's final-leg constraint used to target the
//    target body's literal CENTER for every objective, unconditionally --
//    now it targets a real offset point (the same effective radius
//    `arrival_dv_ms` already prices for the capture burn) instead. Result:
//    total ΔV improved to 6068 m/s (departure 3920 + DSMs 1679 + capture
//    470, all lower than the previous 6186 m/s figure), and — the real
//    payoff of the `ms_final_target_point` fix — the arc's actual final
//    point now lands 109,853 km from Saturn's real center, essentially
//    exactly the requested 108,950 km capture periapsis (previously: a
//    lower-effort re-run at the OLD search budget landed at only 21,044 km,
//    ~19% of the target, before this same moderate effort bump was tried).
//    `mga_ms_converged` is STILL `false` on this result — the Newton/LM
//    solve didn't fully close every constraint to formal tolerance — but
//    unlike before `ms_final_target_point` existed, "unconverged" no longer
//    means "landed on the body's center": the fix is doing real, verified
//    work even on a best-effort (non-fully-converged) result. Also newly
//    present: `pre_departure_orbit_arc` (219 real points, a genuine
//    propagated Earth parking-orbit/escape trajectory — a separate backend
//    feature, `optimize.rs`, landed the same day) — not yet consumed by any
//    frontend rendering, a real follow-up if picked up. This pushed the
//    snapshot file from ~929 KB to ~2.96 MB (more hops means a longer
//    `population_log`/`convergence` history, plus the new escape-arc
//    array) — flagged here in case bundle size becomes a real concern
//    later; not trimmed this pass since the extra data is genuine and the
//    file is still only loaded for this one preset chip.
//    Galileo/Voyager 2 still only have the honest infeasible error from the
//    original attempt (`optimizeError`) -- not yet retried with the same
//    corrected recipe (right objective/capture config + small pruning).
//    `optimizeStore.setResult`/`setError` are seeded accordingly per preset
//    in `LandingView.openStudy` below; `ResultViewport` shows the real
//    cinematic view immediately for Cassini, and keeps showing
//    `PlaceholderPreviewArc`'s schematic for Galileo/Voyager 2 until a real
//    run exists (either the user's own, or a future backend-side retry).
//
// `mgaScan` records were reduced from the raw scan output before being
// committed here (Cassini alone returned 82,924 raw records, ~43 MB) via a
// (departure date x 30 TOF bins) min-cost reduction -- the same shape
// `MgaScanHeatmap.buildMgaGrid` already reduces to at render time, so
// nothing about the heatmap's own appearance changes, only the amount of
// redundant data shipped in the bundle (937/401/0 records after reduction).
//
// Wired from `LandingView.openStudy()`: clicking a preset chip seeds
// `designStore.setTrajectoryResult`, `mgaScanStore.setResult`+`setState
// ("done")`, and `optimizeStore.setError` all at once. Every one of these
// setters is the exact same setter the real `StudyPaper`/`useMgaScan`/
// `useOptimizeStream` call on a real run's success/failure, so clicking
// any real run button naturally overwrites the corresponding piece with
// live data -- no separate "is this fake" flag needed anywhere else in the
// app (`useOptimizeStream.start()` and `useMgaScan`'s start both call
// their store's `reset()` before starting, which clears the seeded
// error/result unconditionally).
import type { MgaScanApiResult, OptimizeApiResult, TrajectoryApiResult } from "@/api/client"

import cassini from "./cassini.json"
import cassiniOptimize from "./cassini-optimize.json"
import cassiniScan from "./cassini-scan.json"
import galileo from "./galileo.json"
import galileoScan from "./galileo-scan.json"
import mercury from "./mercury.json"
import mercuryConfig from "./mercury-config.json"
import mercuryOptimize from "./mercury-optimize.json"
import mercuryScan from "./mercury-scan.json"
import mars from "./mars.json"
import marsConfig from "./mars-config.json"
import marsOptimize from "./mars-optimize.json"
import marsScan from "./mars-scan.json"
import voyager2 from "./voyager2.json"
import voyager2Scan from "./voyager2-scan.json"

export interface PresetSnapshot {
  survey: TrajectoryApiResult
  mgaScan: MgaScanApiResult
  /** A real converged (or best-effort) MGA optimizer result -- takes priority over optimizeError when both would otherwise apply. */
  optimizeResult?: OptimizeApiResult
  /** Real backend error message from a full MGA optimizer attempt that came back infeasible -- see file header. Ignored when optimizeResult is set. */
  optimizeError?: string
  /** The FULL MissionConfig that produced optimizeResult (one
   * fixed example with its settings) -- captured via POST
   * /api/dev/capture-preset (see ResultsSection's Save-as-example button;
   * the same capture also writes a permanent TOML in the backend's config/
   * directory). When present with a real `mission` key, the landing chip
   * loads it WHOLESALE (missionStore.loadConfig), so every setting -- dv
   * bounds, windows, budgets, capture radius -- is exactly the example's,
   * not whatever was persisted from earlier sessions. A placeholder object
   * (no `mission` key) is ignored. */
  missionConfig?: Record<string, unknown>
}

const INFEASIBLE_MESSAGE = "best chromosome is infeasible after optimisation — try more generations or restarts"

export const PRESET_SNAPSHOTS: Record<string, PresetSnapshot> = {
  cassini: {
    survey: cassini as TrajectoryApiResult,
    mgaScan: cassiniScan as MgaScanApiResult,
    optimizeResult: cassiniOptimize as OptimizeApiResult,
  },
  galileo: { survey: galileo as TrajectoryApiResult, mgaScan: galileoScan as MgaScanApiResult, optimizeError: INFEASIBLE_MESSAGE },
  voyager2: { survey: voyager2 as TrajectoryApiResult, mgaScan: voyager2Scan as MgaScanApiResult, optimizeError: INFEASIBLE_MESSAGE },
  // Direct (non-MGA) transfer, added per ("a
  // fourth example, a direct transfer from earth to mercury... run the
  // optimizer (with GA)... so we can see what it looks like") -- the other
  // three presets are all multi-flyby MGA tours, so this is the first
  // preset exercising the plain single-leg GA cinematic path end to end.
  // `mgaScan` is a real, honestly-empty result (zero legs evaluated, not an
  // error) -- there is no flyby sequence to scan for a 2-body direct route,
  // same "real empty state" category as Voyager 2's zero-feasible-branches
  // scan. `optimizeResult` is a REAL, CONVERGED `POST /api/optimize` run
  // (GA, `MatchTargetDistance` objective, Orbit capture at Mercury radius +
  // 400 km altitude) -- fitness ~5.7e-7, achieved miss distance 2839.4 km
  // matches the requested capture radius almost exactly. Named for what it
  // actually is (a simplified direct GA demo trajectory), not for a real
  // historical Mercury mission (MESSENGER/BepiColombo both flew real
  // multi-flyby routes very different from this one, and the other three
  // presets' names are 1:1 accurate to their real historical sequence --
  // naming this after either real mission would misrepresent it).
  mercury: {
    survey: mercury as TrajectoryApiResult,
    mgaScan: mercuryScan as MgaScanApiResult,
    optimizeResult: mercuryOptimize as OptimizeApiResult,
    missionConfig: mercuryConfig as Record<string, unknown>,
  },
  // Mars Orbiter, added (user, after the backend's Phase 03
  // validation showed the Mercury Orbiter is propellant-INFEASIBLE for a
  // chemical spacecraft -- capture needs 18 km/s on a 481 m/s tank -- and
  // is therefore a poor example for exercising Phase 02/03): a simple
  // direct Earth->Mars transfer sized to be FEASIBLE end to end -- biprop
  // (320 s Isp, 400 N), 270 kg propellant of 500 kg wet (2.4 km/s
  // available), Falcon 9 covering departure (external stage in Phase 03),
  // elliptical capture (e = 0.9, r_p = 3,790 km). Captured with
  // `.scratch/capture_mars_preset_2026-09-01.cjs` (real survey + real GA
  // run against the live backend, same recipe as Mercury). Mercury stays
  // on the landing page deliberately (user, same day) -- it is now the
  // example of what the feasibility gate catches.
  mars: {
    survey: mars as TrajectoryApiResult,
    mgaScan: marsScan as MgaScanApiResult,
    optimizeResult: marsOptimize as OptimizeApiResult,
    missionConfig: marsConfig as Record<string, unknown>,
  },
}
