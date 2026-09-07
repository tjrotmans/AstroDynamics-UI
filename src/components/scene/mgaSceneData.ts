import * as THREE from "three"

import { sampleArcPosition, sceneVecFromEclipticMeters, sceneVecFromMeters } from "./sceneShared"
import { keplerPositionM, PLANET_ELEMENTS } from "@/lib/keplerEphemeris"
import type { OptimizeApiResult } from "@/api/client"

const EMPTY_STRINGS: string[] = []
const EMPTY_NUMBERS: number[] = []
const EMPTY_NUMBER_ARRAYS: number[][] = []

export interface MgaLegSegment {
  points: THREE.Vector3[]
  legIdx: number
}

export interface MgaSceneData {
  isMga: boolean
  bodySequence: string[]
  dsmDvs: number[]
  dsmPositionsM: number[][]
  /** Cosmetic-only: each DSM's real position (`dsmPositionsM`) projected
   * onto the closest point of its own leg's rendered line. Use this for
   * where the MARKER is drawn; `dsmPositionsM` (converted via
   * sceneVecFromMeters) remains the real backend value for anything that
   * needs the actual reported position. See this field's own derivation
   * comment below for why the two can legitimately differ. */
  dsmDisplayPositions: THREE.Vector3[]
  /** Times (t_s) where the arc's leg_idx increments -- one per flyby encounter. */
  legBoundaryTimes: number[]
  /** [0, ...legBoundaryTimes] -- one per leg, its start time. */
  legStartTimes: number[]
  /** Intermediate flyby positions -- the arc's REAL closest approach to the
   * flyby body within a window around the leg boundary, not just the raw
   * leg-boundary sample (see computeFlybyClosestApproach's own comment).
   * Falls back to the raw leg-boundary sample for a body with no known
   * orbital elements (a moon/small-body flyby target). */
  flybyPositions: THREE.Vector3[]
  /** Real t_s of each flyby's actual closest-approach point (see
   * flybyPositions above) -- NOT always identical to the raw leg-boundary
   * time anymore, since the search can shift it a little either way. */
  flybyClosestTimes: number[]
  /** A short run of real arc points bracketing each flyby's closest
   * approach -- the "closest approach area," for highlighting a stretch of
   * the trajectory rather than a single point. Empty for a flyby body with
   * no known orbital elements (nothing to search against). */
  flybyHighlightSegments: THREE.Vector3[][]
  /** [startT_s, endT_s] real time bounds of each flybyHighlightSegments
   * entry -- lets a caller (the altitude-line densifier, currently) sample
   * MORE points across the exact same real window the highlight itself
   * covers, instead of re-deriving its own (differently-calibrated) notion
   * of "the flyby area." [0, 0] for a flyby with no highlight segment. */
  flybyHighlightTimeRanges: [number, number][]
  /** The arc split into one polyline per leg, colour-cycled by legIdx. */
  legSegments: MgaLegSegment[]
}

// How far (in arc SAMPLE INDICES, not real time) to search around a leg
// boundary for the true closest approach, and how many points on either
// side of the found minimum to expose as the "highlight" stretch. Bounded
// per-flyby by the midpoint to the previous/next boundary too (see below)
// so a search window can never bleed into a neighbouring flyby's own
// territory -- real for this app: Cassini's VEEGA-style route has two
// Venus flybys only ~10 samples apart, well inside a naive fixed window.
// HIGHLIGHT_RADIUS widened 4 -> 12 (user, live review: "The
// highlighting of the flyby area can also be a bit wider even").
// A real regression, found and reverted - flagged here so a
// future reader doesn't reintroduce it. The round right before this one
// switched this SEARCH window from an index radius to a fixed real-time
// radius (CLOSEST_APPROACH_SEARCH_TIME_S, +-30 days), reasoning that the
// old +-60-sample window's huge real-time span for Jupiter's coarse
// sampling (~619 days) could let a spurious distant sample win the
// "closest" search. That reasoning was never actually verified against the
// real data, and it was wrong: measured directly (a throwaway script
// comparing the OLD +-60-sample search, an UNRESTRICTED full scan of the
// whole neighbour-bounded region, and the +-30-day search side by side),
// Jupiter's TRUE closest approach sits ~63 days AFTER the raw leg
// boundary -- both the old +-60-sample search and the full unrestricted
// scan agree exactly (same index, ~5.08 million km miss distance), while
// the +-30-day window is too narrow to even contain that point, so it
// settled for a worse in-window sample (~27.8 million km miss distance,
// over 5x further from Jupiter) -- exactly what ed as "the
// highlighted part of the trajectory is now completely wrong... it was
// correct before." The old index-based window was never actually the bug;
// reverted back to it. (HIGHLIGHT_TIME_RADIUS_S right below is a
// DIFFERENT, correctly-time-bounded quantity -- it only controls how WIDE
// the rendered highlight/glow stretch is around whatever index this search
// finds, not which index the search finds; that fix from two rounds ago
// stands unchanged.)
const CLOSEST_APPROACH_SEARCH_RADIUS = 60
// Real bug, found (
// jupiter flyby so much larger than for the others?"). Root cause,
// confirmed by directly measuring raw arc sample spacing against the real
// Cassini snapshot: the OLD highlight window was a fixed INDEX radius
// (+-12 raw arc samples either side of the closest-approach point), not a
// fixed real-TIME radius -- and the backend's own arc sampling density
// varies enormously by leg (presumably finer integration steps where the
// real dynamics are more extreme). Cassini's Venus/Earth flybys measured
// ~24-29 hours between consecutive raw samples near the encounter; Jupiter
// measured ~305 hours (~13x sparser) -- so the exact same +-12-sample
// window that gave Venus/Earth a ~24-29 day highlighted stretch gave
// Jupiter a ~306 day one, for no physical reason at all. Fixed by
// switching to a fixed real-TIME radius instead (HIGHLIGHT_TIME_RADIUS_S,
// 24h either side -- the same window already used for the timeline
// slider's own peak boost, a deliberate reuse for consistency), sampling
// a fixed HIGHLIGHT_POINT_COUNT of INTERPOLATED points across it via
// sampleArcPosition (same interpolation the seek slider/altitude lines
// already rely on) rather than however many raw samples happen to exist
// in that stretch -- every flyby's highlighted area is now the same real
// size and the same point density, regardless of how densely the backend
// happened to sample around it.
const HIGHLIGHT_TIME_RADIUS_S = 24 * 3600
const HIGHLIGHT_POINT_COUNT = 20

// Real bug, found (user, from a screenshot: "i can see in this
// case the flyby location is not actually the place where the s/c is
// closest to the planet"). Root cause: the old flybyPositions was simply
// `sampleArcPosition(arc, legBoundaryTime)` -- the spacecraft's own arc
// sample at the exact t_s where the backend's leg_idx increments, with NO
// reference to the flyby body's position at all. That's a reasonable
// stand-in when the leg boundary genuinely coincides with periapsis, but
// nothing guarantees it does -- the boundary is just where the multi-leg
// solver's segmentation happens to fall, and this view's OWN rendered body
// position is itself a Kepler-ephemeris approximation (lib/keplerEphemeris.ts,
// not the backend's real state), so even a boundary that IS the backend's
// true periapsis can still visually miss this view's own approximate body
// position. Fixed by actually searching: for each flyby with known orbital
// elements, sample a window of real arc points around the leg boundary,
// compute THIS view's own body position (same Kepler approximation
// flybyLivePositions already uses, so marker and moving body agree) at
// each sample's real epoch, and take the real minimum-distance point --
// consistent with what's actually drawn, not just what the backend
// happened to segment on. User's explicit preferred fix (not "just move
// the dot," the alternative considered): also expose a short bracketing
// run of arc points as `flybyHighlightSegments`, so the caller can render
// the whole close-approach AREA of the trajectory, not one isolated point.
function computeFlybyClosestApproach(
  result: OptimizeApiResult,
  linePoints: THREE.Vector3[],
  bodySequence: string[],
  legBoundaryTimes: number[],
): {
  positions: THREE.Vector3[]
  times: number[]
  highlightSegments: THREE.Vector3[][]
  highlightTimeRanges: [number, number][]
} {
  const sunPos = new THREE.Vector3(0, 0, 0)
  const boundaryIndices = legBoundaryTimes.map((t) => result.arc.findIndex((p) => p.t_s === t))
  const positions: THREE.Vector3[] = []
  const times: number[] = []
  const highlightSegments: THREE.Vector3[][] = []
  const highlightTimeRanges: [number, number][] = []
  legBoundaryTimes.forEach((t, i) => {
    const name = bodySequence[i + 1]
    const elements = name ? PLANET_ELEMENTS[name] : undefined
    const centerIdx = boundaryIndices[i]
    if (!elements || centerIdx < 0) {
      // No known orbital elements (moon/small body) -- nothing to search
      // a real position against, keep the old leg-boundary-sample behavior.
      positions.push(sampleArcPosition(result.arc, t))
      times.push(t)
      highlightSegments.push([])
      highlightTimeRanges.push([0, 0])
      return
    }
    const prevBoundaryIdx = i > 0 ? boundaryIndices[i - 1] : 0
    const nextBoundaryIdx = i < legBoundaryTimes.length - 1 ? boundaryIndices[i + 1] : result.arc.length - 1
    const left = Math.max(centerIdx - CLOSEST_APPROACH_SEARCH_RADIUS, Math.ceil((prevBoundaryIdx + centerIdx) / 2))
    const right = Math.min(centerIdx + CLOSEST_APPROACH_SEARCH_RADIUS, Math.floor((centerIdx + nextBoundaryIdx) / 2))
    let bestIdx = centerIdx
    let bestDist = Infinity
    for (let j = left; j <= right; j++) {
      const p = result.arc[j]
      if (!p || !linePoints[j]) continue
      const [xM, yM, zM] = keplerPositionM(elements, result.dep_jd + p.t_s / 86_400)
      const bodyPos = sceneVecFromEclipticMeters(xM, yM, zM).add(sunPos)
      const d = linePoints[j].distanceTo(bodyPos)
      if (d < bestDist) {
        bestDist = d
        bestIdx = j
      }
    }
    positions.push(linePoints[bestIdx])
    const bestT = result.arc[bestIdx].t_s
    times.push(bestT)
    // Fixed real-time window, clamped to the search bounds (never bleeds
    // into a neighbouring flyby's own territory) -- see
    // HIGHLIGHT_TIME_RADIUS_S's own comment above for why this replaced a
    // fixed index radius.
    const segStartT = Math.max(bestT - HIGHLIGHT_TIME_RADIUS_S, result.arc[left].t_s)
    const segEndT = Math.min(bestT + HIGHLIGHT_TIME_RADIUS_S, result.arc[right].t_s)
    const segPoints: THREE.Vector3[] = []
    for (let k = 0; k < HIGHLIGHT_POINT_COUNT; k++) {
      const t = segEndT > segStartT ? segStartT + ((segEndT - segStartT) * k) / (HIGHLIGHT_POINT_COUNT - 1) : bestT
      segPoints.push(sampleArcPosition(result.arc, t))
    }
    highlightSegments.push(segPoints)
    highlightTimeRanges.push([segStartT, segEndT])
  })
  return { positions, times, highlightSegments, highlightTimeRanges }
}

// Pure, scene-independent: just the real t_s values where the arc's
// leg_idx increments (one per flyby encounter). Extracted so the
// timeline slider's own event-aware mapping (OptimizeTrajectoryView.tsx)
// can get the same real leg-boundary times deriveMgaSceneData already
// computes, without needing the scene-space `linePoints` conversion that
// function requires (the slider only needs the raw t_s numbers).
export function extractLegBoundaryTimes(result: OptimizeApiResult): number[] {
  const isMga = result.method === "MGA" && !!result.mga_body_sequence && result.mga_body_sequence.length > 1
  if (!isMga) return []
  const times: number[] = []
  for (let i = 1; i < result.arc.length; i++) {
    const prevLeg = result.arc[i - 1].leg_idx ?? 0
    const curLeg = result.arc[i].leg_idx ?? 0
    if (curLeg !== prevLeg) times.push(result.arc[i].t_s)
  }
  return times
}

// A first attempt at closing the DSM/trajectory gap was tried and
// REVERTED (
// possible the dsm is not on the original trajectory?") -- it spliced the
// DSM's real position into the leg's own point array as a control point,
// on the theory that the raw arc was just too sparsely sampled near the
// burn to include it. That produced a visible, sharp artificial "V" kink
// in the rendered line right at the DSM, because the real explanation is
// different (see `dsmPositionsM`'s own comment at its use site below):
// splicing a point the real converged trajectory may never actually reach
// forces the curve THROUGH a location the physics doesn't support, which
// is a worse lie than a small visual gap.
//
// This is the real fix the user asked for next ("is it possible to
// artificially put the dsm on the real trajectory (just for appearance)?"),
// and it's a materially different, safer operation than the splice above:
// instead of bending the TRAJECTORY to reach the marker, this moves the
// MARKER to the trajectory's own closest point -- the real arc/curve is
// completely untouched, only where the burn's icon is DRAWN changes.
// `dsmDvs`/`dsmPositionsM` (the real reported ΔV and position) are still
// exposed unchanged for anything that needs the actual backend value; this
// is purely a second, cosmetic position for the marker's on-screen icon.
function closestPointOnPolyline(points: THREE.Vector3[], target: THREE.Vector3): THREE.Vector3 {
  if (points.length === 0) return target.clone()
  if (points.length === 1) return points[0].clone()
  let best = points[0]
  let bestDist = Infinity
  const line = new THREE.Line3()
  const closest = new THREE.Vector3()
  for (let i = 0; i < points.length - 1; i++) {
    line.set(points[i], points[i + 1])
    line.closestPointToPoint(target, true, closest)
    const d = closest.distanceTo(target)
    if (d < bestDist) {
      bestDist = d
      best = closest.clone()
    }
  }
  return best
}

// Shared MGA-derivation math, extracted so OverviewTrajectoryView
// doesn't duplicate the ~100 lines OptimizeTrajectoryView already had for
// this (per-leg colour segments, flyby positions, DSM burn data) -- both
// views render the same real per-leg/DSM structure now, cinematic
// (animated, playback-gated labels) and Overview (static, always visible)
// alike. Pure function of `result` + the already-converted scene-space
// `linePoints` -- callers wrap it in their own `useMemo`.
export function deriveMgaSceneData(result: OptimizeApiResult, linePoints: THREE.Vector3[]): MgaSceneData {
  const isMga = result.method === "MGA" && !!result.mga_body_sequence && result.mga_body_sequence.length > 1
  const bodySequence = result.mga_body_sequence ?? EMPTY_STRINGS
  const dsmDvs = result.mga_dv_dsms_ms ?? EMPTY_NUMBERS
  // Real gap, investigated (
  // go through the leg 5 burn... how is it possible the dsm is not on the
  // original trajectory?"). NOT sparse sampling (that was this file's
  // first, wrong guess, tried and reverted -- see the deleted
  // insertDsmIntoLegPoints's own history above). The real explanation:
  // `dsmPositionsM` and `result.arc` can come from genuinely DIFFERENT
  // physics. MGA's multiple-shooting refinement (mga.rs, backend) starts
  // from an idealized per-leg two-body/Lambert patched-conic solution and
  // tries to correct it into one continuous, N-body-consistent trajectory
  // -- `result.arc` is that refined (or best-effort, if refinement didn't
  // finish) trajectory. `mga_ms_converged` reports whether it actually
  // finished; for this exact Cassini snapshot it's `false` (confirmed by
  // reading the real preset JSON directly, not assumed) -- meaning the
  // correction genuinely never fully closed the gap between the idealized
  // per-leg model and a single consistent real trajectory. A DSM position
  // computed from the (possibly still-idealized) per-leg solution is not
  // guaranteed to sit exactly on an arc that a non-converged correction
  // pass produced. This is the SAME real backend numerical question
  // already flagged, unresolved, in the "second viewport review
  // round" above (item 2, "visible kinks/discontinuities... a genuine
  // backend numerical question, not frontend-actionable") -- not a new
  // finding, just hit again from a different angle. Rendering the DSM
  // marker at its own real reported position (not moved, not used to bend
  // the line) is the honest choice: it shows exactly what the backend
  // returned, including the fact that the two don't perfectly agree for
  // this particular non-converged result.
  //
  // Follow-up, same day (user, once they understood why: "is it possible
  // to artificially put the dsm on the real trajectory (just for
  // appearance)?"): yes, safely, as long as it's the MARKER that moves and
  // not the line -- see `dsmDisplayPositions` below, computed by
  // projecting this real value onto the closest point of its own leg's
  // real rendered line. Both values are kept: `dsmPositionsM` (this field)
  // stays the exact backend-reported position and ΔV for anything that
  // needs ground truth; `dsmDisplayPositions` is purely where the marker
  // ICON is drawn.
  const dsmPositionsM = result.mga_dsm_positions_m ?? EMPTY_NUMBER_ARRAYS

  const legBoundaryTimes = extractLegBoundaryTimes(result)
  const legStartTimes = [0, ...legBoundaryTimes]

  const {
    positions: flybyPositions,
    times: flybyClosestTimes,
    highlightSegments: flybyHighlightSegments,
    highlightTimeRanges: flybyHighlightTimeRanges,
  } = computeFlybyClosestApproach(result, linePoints, bodySequence, legBoundaryTimes)

  const legSegments: MgaLegSegment[] = isMga ? [] : [{ points: linePoints, legIdx: 0 }]
  if (isMga) {
    let currentLeg = result.arc[0]?.leg_idx ?? 0
    let currentPoints: THREE.Vector3[] = []
    result.arc.forEach((p, i) => {
      const leg = p.leg_idx ?? 0
      if (leg !== currentLeg) {
        currentPoints.push(linePoints[i])
        legSegments.push({ points: currentPoints, legIdx: currentLeg })
        currentPoints = [linePoints[i]]
        currentLeg = leg
      } else {
        currentPoints.push(linePoints[i])
      }
    })
    legSegments.push({ points: currentPoints, legIdx: currentLeg })
  }

  const dsmDisplayPositions = dsmPositionsM.map((dsm, i) => {
    const realPos = sceneVecFromMeters(dsm[0], dsm[1], dsm[2])
    const seg = legSegments[i]
    return seg ? closestPointOnPolyline(seg.points, realPos) : realPos
  })

  return {
    isMga,
    bodySequence,
    dsmDvs,
    dsmPositionsM,
    dsmDisplayPositions,
    legBoundaryTimes,
    legStartTimes,
    flybyPositions,
    flybyClosestTimes,
    flybyHighlightSegments,
    flybyHighlightTimeRanges,
    legSegments,
  }
}
