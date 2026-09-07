// A schematic preview trajectory in the (otherwise empty) result viewport,
// seeded from whatever departure/target/flyby route is already in the
// mission store -- including a route sketched on the landing sky's route
// builder, which writes straight into these same fields (see
// LandingView.openStudy).
//
// Roadmap item 3 (the design notes "Landing->Study connection & viewport realism
// roadmap"), revised after review
//: the preview belongs in the SAME cinematic 3D views
// (OptimizeTrajectoryView/OverviewTrajectoryView) the app uses for a real
// converged result -- not a separate flat 2D schematic map. So this
// component builds a synthetic `OptimizeApiResult` from a schematic
// Lambert-per-leg arc and hands it to the real views unmodified, rather
// than drawing its own renderer. Hard requirement, unchanged from the
// original agreement: this must never be confusable with a real result --
// a persistent "PREVIEW" banner + dashed amber border wrap the real view
// (the cinematic renderer's own internals are NOT touched -- restyling its
// tuned arc/camera work for one caller wasn't worth the risk), and it only
// renders in the empty-viewport state (ResultViewport already stops
// rendering this the instant a run starts or a result exists).
//
// Reuses the same per-leg Lambert solver `lib/lambert.ts` already provides
// (the live MGA search animation's sanctioned exception) rather than a
// second solver. Body positions come from `lib/keplerEphemeris.ts` (also a
// sanctioned exception, real elliptical elements for the 8 major planets,
// no network call) -- the landing sky's route builder can only chain those
// 8 bodies today, so this never needs to cover anything else. Per-leg time
// of flight is a rough Hohmann-transfer estimate (pi * sqrt(a_transfer^3 /
// mu), a_transfer = mean of the two bodies' real semi-major axes) -- not a
// real search result, just enough to pick a plausible arc shape/duration.
//
// Frame note: `lib/keplerEphemeris.ts` positions are already ecliptic (real
// Kepler elements are defined w.r.t. the ecliptic), but
// OptimizeTrajectoryView/OverviewTrajectoryView convert every `ArcApiPoint`
// through `sceneShared.tsx`'s `sceneVecFromMeters`, which assumes raw
// ANISE heliocentric-EQUATORIAL input and applies its own -OBLIQUITY_RAD
// leveling rotation. Feeding it already-ecliptic coordinates directly would
// double-rotate them off the level plane every other body in the same view
// sits on -- `toAniseFrameM` below applies the exact inverse rotation
// first, so the two cancel out and this arc lands exactly where a real
// ecliptic-frame arc would. The departure/target/flyby body meshes and
// orbit rings the two views render around this arc are NOT part of this
// schematic -- they come from the views' own real `/api/bodies/{name}/
// state` fetches, so everything except the connecting arc/burn numbers in
// this preview is real ephemeris.
import { useMemo, useState } from "react"

import { OptimizeTrajectoryView } from "@/components/OptimizeStage/OptimizeTrajectoryView"
import { OverviewTrajectoryView } from "@/components/OptimizeStage/OverviewTrajectoryView"
import { OBLIQUITY_RAD } from "@/components/scene/sceneShared"
import type { ArcApiPoint, OptimizeApiResult } from "@/api/client"
import { MU_SUN_M3S2, lambertArcPoints, type Vec3 } from "@/lib/lambert"
import { PLANET_ELEMENTS, keplerPositionM, type KeplerElements } from "@/lib/keplerEphemeris"
import { epochStringToJd } from "@/lib/utils"
import { useMissionStore } from "@/stores/missionStore"

const SAMPLES_PER_LEG = 40

function hohmannTofS(aAu1: number, aAu2: number): number {
  const AU_M = 1.495978707e11
  const aTransferM = ((aAu1 + aAu2) / 2) * AU_M
  return Math.PI * Math.sqrt(Math.pow(aTransferM, 3) / MU_SUN_M3S2)
}

// Real bug found (: Jupiter/Saturn/Uranus rendered
// well off their own orbit rings): a full two-body Hohmann half-period is
// only a reasonable per-leg estimate for the FIRST leg (no prior boost) --
// every leg after a real flyby carries forward the previous encounter's
// hyperbolic excess velocity, so it's genuinely much faster than a naive
// minimum-energy transfer between the same two semi-major axes (that's the
// entire point of a gravity-assist tour). Summing unscaled Hohmann
// half-periods for a real 4-leg outer-planet chain (Jupiter->Saturn->
// Uranus->Neptune) came out to ~100 real years, 50+ years past
// keplerEphemeris.ts's stated Standish-1992 validity window (1800-2050) --
// the linear per-century element rates just keep extrapolating with no
// cutoff, so the resulting position silently drifts off the (still
// correctly J2000-shaped) ring the farther out-of-range the date goes.
//
// First fix attempt (uniformly scaling every leg down to fit a fixed total
// budget) was wrong and made it worse: it also compressed leg 0 (which has
// no prior boost and needs close to its real Hohmann time) down below what
// a real transfer to that distance needs, handing the Lambert solver a
// leg 0 arc that's actually LESS realistic, not more.
//
// Real fix: only legs AFTER the first carry a prior encounter's boost, so
// only those shrink, geometrically (each subsequent leg assumed
// increasingly boosted) -- leg 0 keeps its own real Hohmann estimate
// unchanged. LEG_DECAY chosen by matching this app's own Voyager 2 preset
// (Earth-Jupiter-Saturn-Uranus-Neptune, real Earth-Neptune flight time
// ~12.4 years): 0.35 lands leg-by-leg within ~1-1.5 years of the real
// mission's actual timeline (2.7/3.5/3.3/2.6 modeled vs. 1.7/2.0/4.6/3.2
// real, summing to ~12.1 vs. ~12.4 real years) -- not a fit to real
// gravity-assist mechanics, just a schematic that stays plausible and
// (the actual bug this fixes) keeps every leg's date within a couple
// decades of "now," comfortably inside the elements' valid range.
const LEG_DECAY = 0.35

function scaledLegTofsS(chain: string[]): number[] {
  return chain.slice(0, -1).map((name, i) => {
    const raw = hohmannTofS(PLANET_ELEMENTS[name].a0, PLANET_ELEMENTS[chain[i + 1]].a0)
    return i === 0 ? raw : raw * Math.pow(LEG_DECAY, i)
  })
}

// Central-difference orbital velocity from the same Kepler position
// function used for the arc itself -- cheap, no network call, plenty
// accurate for a rough departure/arrival v-infinity display estimate.
function keplerVelocityM(el: KeplerElements, jd: number): Vec3 {
  const dtDays = 0.5
  const rPlus = keplerPositionM(el, jd + dtDays)
  const rMinus = keplerPositionM(el, jd - dtDays)
  const dtS = dtDays * 2 * 86_400
  return [(rPlus[0] - rMinus[0]) / dtS, (rPlus[1] - rMinus[1]) / dtS, (rPlus[2] - rMinus[2]) / dtS]
}

function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function vNorm(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
}

// Inverse of sceneShared.tsx's ECLIPTIC_LEVEL_QUATERNION (a -OBLIQUITY_RAD
// rotation about the scene X axis) -- see file header.
function toAniseFrameM([x, y, z]: Vec3): Vec3 {
  const c = Math.cos(OBLIQUITY_RAD)
  const s = Math.sin(OBLIQUITY_RAD)
  return [x, y * c - z * s, y * s + z * c]
}

interface BuiltPreview {
  result: OptimizeApiResult
  departure: string
  target: string
}

function buildPreviewResult(chain: string[], startJd: number): BuiltPreview | null {
  const arc: ArcApiPoint[] = []
  const legTofDays: number[] = []
  let jd = startJd
  let tGlobalS = 0
  let firstLegPoints: Vec3[] | null = null
  let firstLegDtS = 0
  let lastLegPoints: Vec3[] | null = null
  let lastLegDtS = 0

  const legTofsS = scaledLegTofsS(chain)
  for (let i = 0; i < chain.length - 1; i++) {
    const elA = PLANET_ELEMENTS[chain[i]]
    const elB = PLANET_ELEMENTS[chain[i + 1]]
    const rA = keplerPositionM(elA, jd)
    const tofS = legTofsS[i]
    const jdB = jd + tofS / 86_400
    const rB = keplerPositionM(elB, jdB)

    const legPoints = lambertArcPoints(rA, rB, tofS, SAMPLES_PER_LEG) ?? [rA, rB]
    const dtS = tofS / (legPoints.length - 1)
    if (i === 0) {
      firstLegPoints = legPoints
      firstLegDtS = dtS
    }
    if (i === chain.length - 2) {
      lastLegPoints = legPoints
      lastLegDtS = dtS
    }

    // Real bug found (: the flyby marker sat visibly
    // off the arc's actual turn, further along the outgoing leg): this used
    // to skip re-emitting leg i's own idx=0 sample (equal in position to
    // the previous leg's last sample, body B's position) to avoid a
    // duplicate point. But sceneShared.tsx's deriveMgaSceneData (shared by
    // the real cinematic views) finds each flyby's position by locating the
    // FIRST arc point whose leg_idx differs from the one before it --
    // skipping the duplicate meant that first new-leg_idx point was
    // idx=1 (one full sample step into the outgoing leg), not idx=0 (the
    // true flyby position). Real backend results apparently DO emit this
    // duplicate boundary point (that's what deriveMgaSceneData assumes), so
    // the fix here is to match that convention instead of "optimizing" it
    // away -- the harmless cost is two arc points at the same position/time
    // at each boundary, not a real duplicate-data problem.
    legPoints.forEach((p, idx) => {
      const [xM, yM, zM] = toAniseFrameM(p)
      arc.push({ t_s: tGlobalS + idx * dtS, x_m: xM, y_m: yM, z_m: zM, central_body: "Sun", leg_idx: chain.length > 2 ? i : null })
    })
    tGlobalS += tofS
    legTofDays.push(tofS / 86_400)
    jd = jdB
  }
  if (!firstLegPoints || !lastLegPoints || arc.length === 0) return null

  const vScDep = [
    (firstLegPoints[1][0] - firstLegPoints[0][0]) / firstLegDtS,
    (firstLegPoints[1][1] - firstLegPoints[0][1]) / firstLegDtS,
    (firstLegPoints[1][2] - firstLegPoints[0][2]) / firstLegDtS,
  ] as Vec3
  const vBodyDep = keplerVelocityM(PLANET_ELEMENTS[chain[0]], startJd)
  const dvDepartureMs = vNorm(vSub(vScDep, vBodyDep))

  const n = lastLegPoints.length
  const vScArr = [
    (lastLegPoints[n - 1][0] - lastLegPoints[n - 2][0]) / lastLegDtS,
    (lastLegPoints[n - 1][1] - lastLegPoints[n - 2][1]) / lastLegDtS,
    (lastLegPoints[n - 1][2] - lastLegPoints[n - 2][2]) / lastLegDtS,
  ] as Vec3
  const vBodyArr = keplerVelocityM(PLANET_ELEMENTS[chain[chain.length - 1]], jd)
  const dvArrivalMs = vNorm(vSub(vScArr, vBodyArr))

  const isMga = chain.length > 2
  const targetRArrM = toAniseFrameM(keplerPositionM(PLANET_ELEMENTS[chain[chain.length - 1]], jd))

  const result: OptimizeApiResult = {
    method: isMga ? "MGA" : "GA",
    method_display: isMga ? "Gravity-assist (schematic preview)" : "Direct transfer (schematic preview)",
    objective: "Preview",
    dep_offset_days: 0,
    dep_jd: startJd,
    theta_burn_rad: 0,
    dv_departure_ms: dvDepartureMs,
    phi_out_of_plane_rad: 0,
    escape_duration_s: 0,
    achieved_tof_days: legTofDays.reduce((a, b) => a + b, 0),
    dv_arrival_ms: dvArrivalMs,
    capture_time_s: null,
    theta_arr_rad: null,
    phi_arr_rad: null,
    fitness: 0,
    miss_km: 0,
    target_r_arr_m: targetRArrM,
    convergence: [],
    phase1_convergence_km: [],
    population_log: [],
    arc,
    mga_body_sequence: isMga ? chain : null,
    mga_dv_dsms_ms: null,
    mga_dsm_positions_m: null,
    mga_leg_tofs_days: isMga ? legTofDays : null,
    mga_phase1_history: null,
    mga_ms_converged: null,
  }
  return { result, departure: chain[0], target: chain[chain.length - 1] }
}

export function PlaceholderPreviewArc() {
  const trajectory = useMissionStore((s) => s.config.trajectory)
  const targetBodyName = useMissionStore((s) => s.config.target_body.name)
  const optimization = useMissionStore((s) => s.config.optimization)
  const objective = useMissionStore((s) => s.config.mission.objective)
  const captureRadiusM = useMissionStore((s) => s.config.trajectory.capture?.target_orbit_radius_m)
  const [camMode, setCamMode] = useState<"follow" | "overview">("follow")

  const preview = useMemo(() => {
    const departure = trajectory.departure_body
    const target = targetBodyName
    if (!departure || !target) return null

    const flybyBodies =
      optimization?.method === "MGA" && optimization.mga?.sequence_search == null ? (optimization.mga?.flyby_bodies ?? []) : []
    const chain = [departure, ...flybyBodies, target]
    if (chain.some((name) => !PLANET_ELEMENTS[name])) return null // only the 8 major planets are ephemeris-covered here

    const startJd = epochStringToJd(trajectory.departure_epoch ?? "")
    if (!Number.isFinite(startJd)) return null

    return buildPreviewResult(chain, startJd)
  }, [trajectory.departure_body, trajectory.departure_epoch, targetBodyName, optimization])

  if (!preview) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-[11.5px] tracking-wide text-[#8b93a6]">
        <div className="mb-2 text-[10px] font-bold tracking-[0.2em] text-[#dbe0ea] uppercase">Viewport</div>
        <p className="max-w-[300px] leading-relaxed">
          This half of the screen belongs to the result. It opens by itself the moment a run starts - live search
          first, then the full-quality cinematic playback of the converged trajectory.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-center gap-3">
        <div className="flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] text-amber-400 uppercase">
          <span className="inline-block h-px w-4 border-t border-dashed border-amber-400" />
          Preview -- not a computed result
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCamMode("follow")}
            className={
              "rounded-full border px-2.5 py-0.5 text-[9.5px] font-bold tracking-[0.08em] uppercase " +
              (camMode === "follow" ? "border-amber-400/50 bg-amber-400/15 text-amber-400" : "border-border text-muted-foreground")
            }
          >
            Trajectory
          </button>
          <button
            type="button"
            onClick={() => setCamMode("overview")}
            className={
              "rounded-full border px-2.5 py-0.5 text-[9.5px] font-bold tracking-[0.08em] uppercase " +
              (camMode === "overview" ? "border-amber-400/50 bg-amber-400/15 text-amber-400" : "border-border text-muted-foreground")
            }
          >
            Overview
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 rounded-md border border-dashed border-amber-400/40 p-1">
        {camMode === "follow" ? (
          <OptimizeTrajectoryView
            result={preview.result}
            departureBodyName={preview.departure}
            targetBodyName={preview.target}
            captureRadiusM={captureRadiusM}
          />
        ) : (
          <OverviewTrajectoryView
            result={preview.result}
            departureBodyName={preview.departure}
            targetBodyName={preview.target}
            captureRadiusM={captureRadiusM}
          />
        )}
      </div>
      <p className="text-center text-[10.5px] leading-relaxed text-muted-foreground">
        A schematic ballistic sketch of {trajectory.departure_body} → {targetBodyName}
        {objective !== "Flyby" ? ` (${objective})` : ""} using rough Hohmann-transfer timing, not a real search. Run a survey or
        optimization below to replace it with an actual result.
      </p>
    </div>
  )
}
