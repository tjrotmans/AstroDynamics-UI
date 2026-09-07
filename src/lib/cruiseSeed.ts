import type {
  ArcApiPoint,
  BodyTrackConfig,
  CruiseReferencePointConfig,
  CruiseSeedConfig,
  GncModeConfig,
  HardwareItem,
  ModeScheduleEntryConfig,
  PlannedBurnConfig,
} from "@/api/client"
type Vec3 = [number, number, number]

// Shifts a set of points sampled on their OWN local t_s scale (both
// pre_departure_orbit_arc and post_capture_orbit_arc are built via a
// SEPARATE `propagate(..., t0_abs_s: 0.0, ...)` call server-side -- their
// own doc comments confirm this -- so their t_s always starts near 0,
// unrelated to `arc`'s absolute mission timeline) onto a real absolute
// epoch, by aligning ONE known point (`anchorLocalTs`) to where it
// actually belongs (`anchorAbsoluteTs`).
function shiftArcPoints(points: ArcApiPoint[], anchorLocalTs: number, anchorAbsoluteTs: number): ArcApiPoint[] {
  const delta = anchorAbsoluteTs - anchorLocalTs
  return points.map((p) => ({ ...p, t_s: p.t_s + delta }))
}

// `arc` alone runs past the real encounter -- it spans the full configured
// max_coast_days budget, not just the achieved transfer (see the design notes
// "Phase 01's real output contract"). Clamping to the real achieved
// encounter time is shared by both builders below.
function clampArcToEncounter(arc: ArcApiPoint[], achievedTofDays?: number | null): ArcApiPoint[] {
  if (achievedTofDays == null) return arc
  const cutoffS = achievedTofDays * 86_400
  return arc.filter((p) => p.t_s <= cutoffS)
}

// FROZEN-ORIGIN NOTE (measured against the real Mercury
// snapshot): `pre_departure_orbit_arc`/`post_capture_orbit_arc` are served
// as a closed orbit around the body's state at ONE single epoch (the
// injection/capture instant -- `captured_orbit_to_api`'s single
// `origin_m`/`origin_v_mps` translation), not a time-resolved trajectory:
// the pre arc spans 2.95 h over which the real Earth moves ~316,000 km,
// yet its points form a fixed ~7,000 km ellipse. A first attempt at
// client-side re-anchoring onto the moving ephemeris was REJECTED by the
// user the same day ("unphysical and not coming from our data") -- these
// pieces are used exactly as served, the departure/target body is instead
// HELD at the frozen epoch's position while the orbit piece is active
// (holdBodyTrackOutside, lib/bodyTrackFetch.ts -- Phase 01's own
// convention: Earth waits in place until the mission leaves it), and the
// proper fix (backend serves time-resolved arcs) is planned backend-side.

interface FullArcParams {
  arc: ArcApiPoint[]
  preDepartureOrbitArc?: ArcApiPoint[] | null
  postCaptureOrbitArc?: ArcApiPoint[] | null
  achievedTofDays?: number | null
}

// Shared assembly for `buildFullCruiseReference` and `missionT0S` -- both
// must agree on exactly what reference[0] is (D3 prepends
// pre_departure_orbit_arc when present, moving reference[0] off `arc[0]`),
// so this is computed once, not re-derived in two places that could drift.
function assembleFullArc(params: FullArcParams): ArcApiPoint[] {
  const { arc, preDepartureOrbitArc, postCaptureOrbitArc, achievedTofDays } = params
  let fullArc: ArcApiPoint[] = clampArcToEncounter(arc, achievedTofDays)
  if (preDepartureOrbitArc && preDepartureOrbitArc.length > 0 && arc.length > 0) {
    const last = preDepartureOrbitArc[preDepartureOrbitArc.length - 1]
    fullArc = [...shiftArcPoints(preDepartureOrbitArc, last.t_s, arc[0].t_s), ...fullArc]
  }
  if (postCaptureOrbitArc && postCaptureOrbitArc.length > 0 && achievedTofDays != null) {
    fullArc = [...fullArc, ...shiftArcPoints(postCaptureOrbitArc, postCaptureOrbitArc[0].t_s, achievedTofDays * 86_400)]
  }
  return fullArc
}

// Is this served orbit piece FROZEN-ORIGIN (a closed loop around the body's
// state at one epoch -- backend before) or genuinely time-
// resolved (the backend now serves the orbit around the MOVING body)? A
// data-driven test, since an adoption carries no version: a frozen parking
// orbit has a spatial extent of a few body radii (~7,000 km for the Mercury
// preset), while the same 2-3 h resolved in the heliocentric frame spans
// the body's own travel (~300,000 km). The "hold the body in place" display
// stopgap (bodyTrackFetch.holdBodyTrack) is only correct for the former --
// applying it to a time-resolved arc would freeze Earth while the served
// orbit moves away from it.
export function isFrozenOriginOrbit(points: { x_m: number; y_m: number; z_m: number; t_s: number }[]): boolean {
  if (points.length < 3) return false
  let cx = 0
  let cy = 0
  let cz = 0
  for (const p of points) {
    cx += p.x_m / points.length
    cy += p.y_m / points.length
    cz += p.z_m / points.length
  }
  let extent = 0
  for (const p of points) extent = Math.max(extent, Math.hypot(p.x_m - cx, p.y_m - cy, p.z_m - cz))
  const spanS = points[points.length - 1].t_s - points[0].t_s
  // A body moving at even 10 km/s covers 36,000 km/h; a frozen loop of a
  // few planetary radii cannot. 50,000 km is a robust separator for every
  // major body's parking/capture orbit at any realistic span.
  return spanS > 600 && extent < 5e7
}

// The assembled mission's total duration [s] -- lets callers size body-track
// fetches without building the full reference first.
export function missionDurationS(params: FullArcParams): number {
  const fullArc = assembleFullArc(params)
  if (fullArc.length === 0) return 0
  return fullArc[fullArc.length - 1].t_s - fullArc[0].t_s
}

// design review finding D-ii / D1: every t_s inside cruise_seed
// (planned burns, mode schedule, body-track anchoring) must agree on ONE
// timeline -- seconds since `reference[0]` (whatever `buildFullCruiseReference`
// actually puts there -- `pre_departure_orbit_arc[0]` when D3's parking-orbit
// prepend applies, `arc[0]` otherwise). Anything computed from the raw arc
// (planned-burn epochs, the departure epoch used to anchor body tracks) must
// be rebased by this SAME value or it silently drifts onto the wrong
// timeline (the capture burn used to fire `|arc[0].t_s|` early -- typically
// days -- because it was never rebased at all).
export function missionT0S(params: FullArcParams): number {
  const fullArc = assembleFullArc(params)
  return fullArc[0]?.t_s ?? 0
}

// The REAL reference builder (2026-08-19/20, the design notes "Phase 01's real
// output contract" and Phase 03 "STANDING REQUIREMENT" -- read both before
// touching this function). Concatenates `arc` (clamped to the real
// achieved encounter) with `post_capture_orbit_arc` (the real orbit AFTER
// the capture burn, time-shifted onto the real capture epoch) into ONE
// continuous heliocentric reference -- this is what `cruise_seed.reference`
// and (via `buildCruiseSeed`'s `first = reference[0]`) the simulated
// truth's own initial state get built from, so a mission with a real
// capture now ALSO genuinely flies into and stays in the real captured
// orbit, not just shows it as a static ring.
//
// `pre_departure_orbit_arc` (D3, design review): now prepended
// when supplied, so the simulated truth genuinely STARTS in the real
// parking orbit instead of at the post-injection escape-leg state. This
// only became flyable once A1 (the departure body registered as a real
// soi_capture body_track) gave the truth propagator something to hold the
// s/c in orbit around before departure, and once buildPlannedBurns (below)
// had an interim departure ΔV to fire at the boundary -- until then this
// field was deliberately excluded (see git history), since a parking orbit
// with no matching burn just coasts forever.
//
// Real bug found and fixed building the first cut of this
// function: it ADDED the departure/target body's own real heliocentric
// position to every non-"Sun" `arc` point, on the assumption
// ArcApiPoint.x_m/y_m/z_m was body-RELATIVE whenever central_body wasn't
// "Sun" -- live-verified WRONG (a real run started at ~2 AU, exactly
// double Earth's real ~1 AU distance). Traced directly to
// `trajectory_solver::propagate`'s own source (not the PropagatedPoint doc
// comment, which describes an internal-only per-leg state and is
// misleading about the FINAL output): every leg's points are explicitly
// re-based into ONE consistent reference frame before being returned. So
// `ArcApiPoint.x_m/y_m/z_m` is ALREADY heliocentric for every point,
// unconditionally -- `central_body` is a pure bookkeeping tag (which
// body's gravity was dominant there), never a frame indicator. Same is
// true of `post_capture_orbit_arc` as of backend Phase 12k --
// no conversion needed for either.
//
// Real velocity, not an approximation, as of `ArcApiPoint`
// used to carry position only, forcing this function to finite-difference
// adjacent samples to guess a velocity -- a real, avoidable inaccuracy,
// since the propagator (`PropagatedPoint::v_mps`) already computes the
// exact value at every sample and was simply discarding it before
// serializing. `vx_mps`/`vy_mps`/`vz_mps` now carry that real value for
// GA/PSO's `arc` and for every `pre_departure_orbit_arc`/
// `post_capture_orbit_arc` (both search methods) -- used directly here
// when present. Finite-differencing remains ONLY as a fallback for MGA's
// own multi-leg `arc` (whose internal sampling genuinely has no velocity
// yet -- a real, separate, documented backend gap) or stale cached data
// from before this field existed.
export function buildFullCruiseReference(params: {
  arc: ArcApiPoint[]
  preDepartureOrbitArc?: ArcApiPoint[] | null
  postCaptureOrbitArc?: ArcApiPoint[] | null
  achievedTofDays?: number | null
  // Real burn epoch(s), on `arc`'s own RAW (non-rebased) timescale, to avoid
  // finite-differencing velocity ACROSS -- a burn is a real, instantaneous
  // velocity discontinuity; blending across it with a central difference
  // would silently average the pre-/post-burn velocity into something
  // neither real state actually had. Only matters for the fallback path --
  // a real vx_mps/vy_mps/vz_mps sample is never blended across anything.
  burnEpochsS?: number[]
}): CruiseReferencePointConfig[] {
  const { arc, preDepartureOrbitArc, postCaptureOrbitArc, achievedTofDays, burnEpochsS = [] } = params
  if (arc.length < 2) {
    throw new Error("This trajectory has fewer than 2 samples -- cannot build a cruise reference from it.")
  }
  const fullArc = assembleFullArc({ arc, preDepartureOrbitArc, postCaptureOrbitArc, achievedTofDays })
  const t0 = fullArc[0].t_s
  const rAt = (p: ArcApiPoint): Vec3 => [p.x_m, p.y_m, p.z_m]
  const realVAt = (p: ArcApiPoint): Vec3 | null =>
    p.vx_mps != null && p.vy_mps != null && p.vz_mps != null ? [p.vx_mps, p.vy_mps, p.vz_mps] : null

  return fullArc.map((p, i) => {
    const real = realVAt(p)
    if (real) return { t_s: p.t_s - t0, r_m: rAt(p) as number[], v_mps: real as number[] }

    // Fallback: finite-difference, only reached for MGA's own `arc` or
    // stale cached data missing the real field -- see this function's own
    // header. Near a real burn epoch, use a one-sided difference (only the
    // side that doesn't cross the discontinuity) instead of the usual
    // central difference.
    const prevCrossesBurn = i > 0 && burnEpochsS.some((b) => fullArc[i - 1].t_s < b && b <= p.t_s)
    const nextCrossesBurn = i < fullArc.length - 1 && burnEpochsS.some((b) => p.t_s < b && b <= fullArc[i + 1].t_s)
    const prev = prevCrossesBurn ? p : fullArc[Math.max(0, i - 1)]
    const next = nextCrossesBurn ? p : fullArc[Math.min(fullArc.length - 1, i + 1)]
    const dt = next.t_s - prev.t_s
    const rPrev = rAt(prev)
    const rNext = rAt(next)
    const v_mps: number[] =
      dt > 0 ? [(rNext[0] - rPrev[0]) / dt, (rNext[1] - rPrev[1]) / dt, (rNext[2] - rPrev[2]) / dt] : [0, 0, 0]
    return { t_s: p.t_s - t0, r_m: rAt(p) as number[], v_mps }
  })
}

// PURELY VISUAL concatenation for the 3D viewport's "reference (Phase 01
// plan)" dashed line -- unlike buildFullCruiseReference above, this DOES
// include `pre_departure_orbit_arc` (real parking-orbit context, matching
// what Phase 01's own OptimizeTrajectoryView shows), since nothing here
// feeds real backend physics -- it's display-only positions, no velocity,
// no burn-discontinuity handling needed.
export function buildFullVisualArc(params: {
  arc: ArcApiPoint[]
  preDepartureOrbitArc?: ArcApiPoint[] | null
  postCaptureOrbitArc?: ArcApiPoint[] | null
  achievedTofDays?: number | null
}): ArcApiPoint[] {
  // Identical assembly to the real reference -- this used to be a
  // hand-rolled duplicate of assembleFullArc, which is exactly the "two
  // places that could drift" situation that function exists to prevent.
  return assembleFullArc(params)
}

// Real planned burns, straight from the adopted trajectory's own Phase 01
// data) -- never
// reconstructed/approximated client-side, EXCEPT the departure burn below,
// an honest interim (see D-i). MGA DSMs now have real inertial vectors on
// the wire (`mga_dv_dsms_inertial_mps`, landed/20) but wiring
// them as real planned burns still needs a real per-DSM EPOCH, which isn't
// directly exposed (only per-leg TOF sums) -- a real, scoped next step, not
// done here.
//
// Epochs returned here are on `arc`'s own RAW timescale (t=0 at the
// mission-config nominal departure epoch) -- callers MUST rebase every
// entry by `missionT0S(...)` (D1) before sending, to match
// `buildFullCruiseReference`'s own rebased `reference[0].t_s == 0`.
function hasRealV(p: ArcApiPoint): p is ArcApiPoint & { vx_mps: number; vy_mps: number; vz_mps: number } {
  return p.vx_mps != null && p.vy_mps != null && p.vz_mps != null
}

export function buildPlannedBurns(params: {
  arc: ArcApiPoint[]
  preDepartureOrbitArc?: ArcApiPoint[] | null
  captureTimeS?: number | null
  captureDvInertialMps?: number[] | null
  // Real departure ΔV vector (D4, landed backend-side). Preferred
  // over the interim derivation below whenever present.
  departureDvInertialMps?: number[] | null
  // Target body name -- sets `capture_body` on the capture burn so the
  // backend re-solves the capture ΔV at trigger time from the dispersed
  // state (review D5, landed backend-side) instead of firing the
  // nominal vector blind.
  captureBodyName?: string | null
  // Who pays the departure burn -- backend Phase 14e's `departure_dv_pool`
  //: "launcher" → one external-stage burn (impulsive, no slew,
  // no tank draw); "onboard" → the spacecraft engine fires it and it draws
  // on propellant_mass_kg; "split" → TWO entries at the same epoch, the
  // launcher's `launcher_dv_ms` share as an external stage and the
  // `onboard_departure_dv_ms` perigee top-up onboard, both along the real
  // departure_dv_inertial_mps direction (fractions of the vector, so the two
  // sum to the real burn exactly; check_config accepts equal epochs -- its
  // ordering test is `>=`). The pool is a RESULT quantity (depends on the
  // solved C3 at this mass), which is why the backend leaves this gate to
  // the seed assembly (its 14g note). `launchVehicleFeasible` is the pre-
  // 14e all-or-nothing fallback for adoptions without a pool.
  departureDvPool?: "launcher" | "onboard" | "split" | null
  launcherDvMs?: number | null
  onboardDepartureDvMs?: number | null
  launchVehicleFeasible?: boolean | null
}): PlannedBurnConfig[] {
  const {
    arc,
    preDepartureOrbitArc,
    captureTimeS,
    captureDvInertialMps,
    departureDvInertialMps,
    captureBodyName,
    departureDvPool,
    launcherDvMs,
    onboardDepartureDvMs,
    launchVehicleFeasible,
  } = params
  const burns: PlannedBurnConfig[] = []
  const pool: "launcher" | "onboard" | "split" =
    departureDvPool ?? (launchVehicleFeasible === true ? "launcher" : "onboard")
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })

  const pushDeparture = (epochS: number, dv: number[], labelSuffix: string) => {
    const canSplit =
      pool === "split" && launcherDvMs != null && onboardDepartureDvMs != null && launcherDvMs > 0 && onboardDepartureDvMs > 0
    if (canSplit) {
      const fL = launcherDvMs / (launcherDvMs + onboardDepartureDvMs)
      burns.push({
        epoch_s: epochS,
        dv_inertial_mps: dv.map((c) => c * fL),
        external_stage: true,
        label: `departure injection (launch vehicle upper stage, ${fmt(launcherDvMs)} of ${fmt(launcherDvMs + onboardDepartureDvMs)} m/s)${labelSuffix}`,
      })
      burns.push({
        epoch_s: epochS,
        dv_inertial_mps: dv.map((c) => c * (1 - fL)),
        external_stage: false,
        label: `departure top-up (onboard perigee burn, ${fmt(onboardDepartureDvMs)} m/s)${labelSuffix}`,
      })
      return
    }
    const external = pool === "launcher"
    burns.push({
      epoch_s: epochS,
      dv_inertial_mps: dv,
      external_stage: external,
      label: (external ? "departure injection (launch vehicle upper stage)" : "departure burn") + labelSuffix,
    })
  }

  const first = arc[0]
  if (first && departureDvInertialMps && departureDvInertialMps.length === 3) {
    pushDeparture(first.t_s, departureDvInertialMps, "")
  } else {
    // D3/D-i interim departure burn, only for an adoption predating
    // `departure_dv_inertial_mps`: the difference of two REAL propagator
    // velocities at the same physical state (arc[0].v minus
    // pre_departure_orbit_arc's last point's v, verified within 12 km of
    // each other positionally) rather than anything reconstructed from
    // angles/magnitudes. Skipped honestly (no burn sent) when either side
    // lacks the real velocity field.
    const last = preDepartureOrbitArc && preDepartureOrbitArc.length > 0 ? preDepartureOrbitArc[preDepartureOrbitArc.length - 1] : null
    if (first && last && hasRealV(first) && hasRealV(last)) {
      pushDeparture(
        first.t_s,
        [first.vx_mps - last.vx_mps, first.vy_mps - last.vy_mps, first.vz_mps - last.vz_mps],
        " (interim ΔV -- re-adopt in Phase 01 for the real departure_dv_inertial_mps)",
      )
    }
  }

  if (captureTimeS != null && captureDvInertialMps != null) {
    burns.push({
      epoch_s: captureTimeS,
      dv_inertial_mps: captureDvInertialMps,
      external_stage: false,
      label: "arrival/capture burn",
      ...(captureBodyName ? { capture_body: captureBodyName } : {}),
    })
  }

  return burns
}

// D1: rebase every planned-burn epoch onto the SAME timeline
// `buildFullCruiseReference` rebases `reference` onto (t=0 at
// `reference[0]`) -- must be applied to `buildPlannedBurns`' raw output
// before it's sent as `cruise_seed.planned_burns`.
export function rebasePlannedBurns(burns: PlannedBurnConfig[], t0S: number): PlannedBurnConfig[] {
  return burns.map((b) => ({ ...b, epoch_s: b.epoch_s - t0S }))
}

const SUN_TARGET = { type: "Sun" as const }

// Only build modes with real hardware and real timing behind them -- see
// the design notes "kept invisible for casual users" plan and the Phase 03
// mockup-review conversation this implements. hardware_index is computed
// live against the array passed in, never cached (missionStore.ts's
// removeHardwareAt shifts every later index down -- a stale cached index
// would silently point at the wrong item after any later edit).
export function deriveDefaultModes(params: {
  hardware: HardwareItem[]
  targetBodyName: string | null
  legDurationS: number
  approachFractionOfLeg?: number
}): { modes: GncModeConfig[]; mode_schedule: ModeScheduleEntryConfig[]; safe_mode: string | null } {
  const { hardware, targetBodyName, legDurationS } = params
  const approachFraction = params.approachFractionOfLeg ?? 0.9

  const modes: GncModeConfig[] = []
  const schedule: ModeScheduleEntryConfig[] = []

  const panelIndex = hardware.findIndex((h) => h.type === "SolarPanel")
  const hasSunMode = panelIndex >= 0
  if (hasSunMode) {
    modes.push({ name: "SunPointing", rules: [{ hardware_index: panelIndex, target: SUN_TARGET }], pointing_locked: false })
  }

  const sensorIndex = hardware.findIndex((h) => h.type === "StarTracker" || h.type === "OpNavCamera")
  const hasTargetMode = sensorIndex >= 0 && targetBodyName != null
  if (hasTargetMode) {
    modes.push({
      name: "TargetPointing",
      rules: [{ hardware_index: sensorIndex, target: { type: "Body", name: targetBodyName as string } }],
      pointing_locked: false,
    })
  }

  if (hasSunMode && hasTargetMode) {
    const approachStartS = legDurationS * approachFraction
    schedule.push({ start_s: 0, end_s: approachStartS, mode: "SunPointing" })
    schedule.push({ start_s: approachStartS, end_s: legDurationS, mode: "TargetPointing" })
  } else if (hasSunMode) {
    schedule.push({ start_s: 0, end_s: legDurationS, mode: "SunPointing" })
  } else if (hasTargetMode) {
    schedule.push({ start_s: 0, end_s: legDurationS, mode: "TargetPointing" })
  }
  // Neither placed: modes/mode_schedule both stay empty, which per
  // CruiseSeedConfig.modes's own doc comment preserves "the pre-ask-#7
  // behavior exactly: a fixed SunPointing attitude hold for the whole leg" --
  // an honest degrade, not a broken one.

  return { modes, mode_schedule: schedule, safe_mode: hasSunMode ? "SunPointing" : null }
}

// decouples
// REPORTING cadence from the real control-loop tick_s -- the control loop
// itself always runs at full tick_s regardless, only how many of those
// ticks actually get relayed over the WS stream / into the /steps history
// changes. Needed because a long leg reported at full tick_s cadence can
// overflow a JSON string's max length client-side (confirmed:
// ERR_STRING_TOO_LONG on a real 129-day/tick_s=30 leg, ~371,500 ticks).
// TARGET_POINT_BUDGET picks a stride that lands near this many reported
// points regardless of mission length -- a short test leg gets stride=1
// (full fidelity, no behavior change), a long interplanetary leg gets
// proportionally coarser reporting instead of a fixed stride that would be
// needlessly coarse for short missions or still too fine for very long
// ones (e.g. an outer-planet transfer).
const TARGET_REPORT_POINT_BUDGET = 20_000

// Real gap found (
// or modes"): this used to always call deriveDefaultModes() internally,
// with no way for a user to actually diverge from the auto-derived
// result. GNC config is now a real caller-supplied parameter -- callers
// that want the old always-auto behavior just pass
// deriveDefaultModes()'s own output straight through; CruiseReplayPage
// passes whatever the user's gncModesStore edits currently hold instead.
export function buildCruiseSeed(params: {
  reference: CruiseReferencePointConfig[]
  durationS: number
  tickS: number
  modes: GncModeConfig[]
  modeSchedule: ModeScheduleEntryConfig[]
  safeMode: string | null
  tcmThresholdM: number | null
  // A1/A2 (design review finding A): every body_track the truth
  // propagator needs -- the departure body (soi_capture:true, since the s/c
  // STARTS inside its SOI), the target body (soi_capture depending on
  // objective), and any other Phase 01 force_model.bodies perturber. Passed
  // as one array so callers own the soi_capture/perturber decisions per
  // body instead of this function guessing them.
  bodyTracks: BodyTrackConfig[]
  // Real planned burns (departure/DSMs/arrival) straight from Phase 01 --
  // see buildPlannedBurns and the design notes Phase 03 "STANDING REQUIREMENT".
  // Callers must pass these already rebased via rebasePlannedBurns (D1).
  plannedBurns?: PlannedBurnConfig[]
}): CruiseSeedConfig {
  const { reference, durationS, tickS, modes, modeSchedule, safeMode, tcmThresholdM, bodyTracks, plannedBurns } = params
  const first = reference[0]

  const nTicks = Math.max(1, Math.ceil(durationS / tickS))
  const reportStride = Math.max(1, Math.ceil(nTicks / TARGET_REPORT_POINT_BUDGET))

  return {
    r0_m: first.r_m,
    v0_m: first.v_mps,
    reference,
    duration_s: durationS,
    tick_s: tickS,
    modes,
    mode_schedule: modeSchedule,
    safe_mode: safeMode,
    body_tracks: bodyTracks,
    report_stride: reportStride,
    tcm_dr_threshold_m: tcmThresholdM,
    planned_burns: plannedBurns ?? [],
  }
}
