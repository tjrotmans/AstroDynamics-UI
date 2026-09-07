// Shared Three.js scene primitives used by OptimizeStage's trajectory views
// (OptimizeTrajectoryView, OverviewTrajectoryView, MgaTopDownView) and by
// the Landing/ living-sky scene. Relocated out of OptimizeStage/
// once the landing scene needed PlanetBody/EclipticGrid/ringPositions too --
// none of those depend on trajectory state, only the API-dependent pieces
// (PerturberBodyFromState, liveVecFromState) are Optimize-specific in spirit,
// and even those just take a body name, not an OptimizeApiResult.

import { Suspense, useState, useEffect, useMemo, useRef, useCallback } from "react"
import { useFrame, type ThreeEvent } from "@react-three/fiber"
import { Html, Line, useTexture } from "@react-three/drei"
import * as THREE from "three"

import { planetTexturePathFor } from "@/lib/planetTextures"
import { trackPositionAt } from "@/lib/bodyTrackFetch"
import type { BodyTrackConfig } from "@/api/client"
import { useBodyState } from "@/hooks/useApi"
import { propagateCircular } from "@/lib/orbitExtrapolation"
import type { Vec3 } from "@/lib/lambert"
import { keplerOrbitRingPointsM, PLANET_ELEMENTS } from "@/lib/keplerEphemeris"

// WebGL float32 precision: one Three.js unit = 1e9 m. 1 AU ≈ 150 units.
export const SCENE_SCALE = 1 / 1e9
export const AU_M = 1.495978707e11
export const AU_SCENE = AU_M * SCENE_SCALE

// Grid: bright enough to read, dark enough to not dominate. Dimmed further
// - was still
// reading as fairly strong against the dark background even at the
// original "not dominate" intent.
export const GRID_COLOR = "#9090cc"
export const GRID_OPACITY = 0.32
export const GRID_TICK_COLOR = "#b8b8dd"

// ΔV event markers: warm amber.
export const BURN_COLOR = "#ffae42"

// Burn marker visual size, found to be a real bug for small
// target bodies (Mercury preset
// ridiculously large"). Two wrong fixes were tried and reverted before this
// one, worth recording so the reasoning isn't lost:
// 1. First cut: a fixed absolute scene-unit size (0.045), tuned back when
//    only Earth-scale-or-larger bodies had been tested. Broke immediately
//    for Mercury (~19x smaller than Earth).
// 2. Second cut: scaled the marker to a fixed RATIO of the nearby body's own
//    true radius, calibrated against Saturn (0.045 / Saturn's real radius
//    ~= 0.75x) on the theory that Saturn was the one body this marker's
//    visible shape had actually been verified against. Still wrong, and the
//    user caught it immediately with a screenshot: 0.75x a SMALL body's own
//    radius is a huge fraction of its visible disc (Mercury's marker
//    covered roughly half the planet). The real reason 0.045 "looked fine"
//    for Saturn was never really about Saturn's RADIUS -- it's that Saturn's
//    own close-framing CAMERA DISTANCE (closeDistArrival, itself already
//    radius-relative) is proportionally large too, so a fixed marker size
//    happened to read as small on SCREEN. Tying marker size to body radius
//    directly skips that camera-distance step entirely and just reproduces
//    the same bug at one remove.
// The actual fix: scale the marker off CAMERA DISTANCE, the same
// constant-apparent-screen-size idiom every hit-sphere/hover-target in this
// file already uses (HIT_SPHERE_DISTANCE_FRACTION etc.) -- this
// automatically shrinks the marker near a small, close-framed body and
// keeps it comfortably visible from far away, with no per-body ratio to get
// wrong. BURN_MARKER_MAX_RADIUS_SCENE is now purely a ceiling (never grow
// past the old, already-accepted 0.045 look at any distance).
export const BURN_MARKER_MAX_RADIUS_SCENE = 0.045
// Exported for reuse by CruiseReplay/VehicleMesh.tsx's own
// distance-scaled sizing fix -- same constant-apparent-screen-size idiom,
// same visual weight class as a burn marker, see that file's own comment.
export const BURN_MARKER_DISTANCE_FRACTION = 0.006
export const BURN_MARKER_MIN_RADIUS_SCENE = 0.0004

// SOI entry/exit annotation colour (kept for reference, no longer rendered).
export const SOI_ANNOTATION_COLOR = "#c084fc"

// Spin speedup so rotation is visible during playback.
export const ROTATION_VISUAL_SPEEDUP = 50_000

// 3D sphere exaggeration - used for close-up detail.
// Bumped 10 -> 18 -> 30 -> 90 across three rounds (
// the planets to be larger", then "enlarge the planet sizes further", then
// "enlarge the size of the planets even 3x further") -- the true/
// exaggerated-scale handoff below is unaffected (still governed purely by
// camera distance in body-radii, not this constant), only how big
// "exaggerated" itself is.
export const PLANET_SIZE_EXAGGERATION = 90

// The Sun's real radius (6.957e8 m) is already ~10x Jupiter's and ~100x
// Earth's -- applying the SAME exaggeration multiplier every other body
// uses made it balloon to an absurd size once that multiplier got large
// (
// looks ridiculous now"). Passed as PlanetBody's `sizeExaggeration` prop
// specifically for the Sun's own render call, everywhere it's rendered.
export const SUN_SIZE_EXAGGERATION = 3

// "1-body mode": a body's rendered size used to be
// a FIXED PLANET_SIZE_EXAGGERATION (10x) always, real physical scale never
// shown at all -- fine at interplanetary range (a true-scale planet is
// sub-pixel from a light-minute away), but wrong the moment the camera is
// actually close to one body (a flyby, a parking/capture orbit, orbit
// insertion): the body visibly ballooned past its own true-scale capture
// ring, making the trajectory geometry read as wrong even when the real
// numbers were correct. Fixed by making the exaggeration factor itself a
// smooth function of camera distance measured in body-radii (not absolute
// scene units, so it works the same for the Sun and for Earth): true scale
// (1x) within EXAGGERATION_NEAR_RATIOS body-radii, ramping smoothly up to
// the full 10x by EXAGGERATION_FAR_RATIO body-radii, unchanged beyond that
// -- so a body shrinks to true, geometrically-correct scale exactly while
// the camera is close enough for it to matter, and grows back to
// comfortably-visible as soon as the camera (or the playback auto-zoom)
// pulls back out. Applied as a per-frame mesh `.scale` multiplier (see
// PlanetBody's useFrame below), the same mechanism the existing hover
// enlarge already uses -- the sphere GEOMETRY itself is now always built at
// true physical radius, never rebuilt.
// Narrowed sharply 20 -> 3.5 (
// change size a bit inconsistently. Just keep them enlarged always, unless
// we get really really close") -- the smooth true/exaggerated ramp between
// NEAR and FAR ratio is the whole "1-body mode" mechanism, so a wide ramp
// zone (the original 20-300 body-radii range) meant the visible size kept
// drifting across ordinary interactive camera movement, reading as
// "inconsistent" rather than as a deliberate close-up behavior.
// Widened back out, 3.5 -> 15 (same day
// correct... the earth is still much larger"). Real tension found between
// this and the narrowing above: the close-framing distance
// (`closeDistDeparture`/`closeDistArrival` in OptimizeTrajectoryView.tsx)
// is deliberately floored just inside EXAGGERATION_NEAR_RATIO so a body
// renders at genuinely TRUE physical scale there -- but true scale AT ONLY
// 3.5 body radii away is, correctly, enormous (real astronaut photos from
// low orbit show Earth filling most of the sky; 3.5 radii is even closer
// than that). The planet wasn't rendering wrong -- the close-framing
// distance itself was too tight to give a comfortable, "whole planet with
// margin" establishing shot while still qualifying as "true scale." Since
// the close-framing formula ties directly to this constant, widening it
// widens the framing distance right along with it (still exactly true
// scale, just from farther out) -- 15 body radii gives a real, physically
// accurate ~7.6 degree apparent diameter, in the neighborhood of Apollo-
// style whole-Earth photography rather than an ISS-altitude view. Does NOT
// meaningfully affect the earlier "keep enlarged during cruise" goal --
// interplanetary cruise framing sits at thousands to tens of thousands of
// body-radii, vastly beyond either ratio either way.
export const EXAGGERATION_NEAR_RATIO = 15
// Widened proportionally alongside the near ratio above, same reasoning --
// still a comfortably tight ramp relative to real interplanetary cruise
// distances (thousands+ of body-radii), just no longer tight relative to
// the close-encounter framing distances that turned out to sit inside the
// old 3.5-9 range.
export const EXAGGERATION_FAR_RATIO = 45

// Hover/click hit-sphere sizing (feedback, item 6): the old
// `displayRadiusScene * 25` formula was meant to make small, hard-to-click
// bodies easier to hit at typical interplanetary zoom, but it scales with
// the body's OWN size -- for the Sun (already large before the 10x display
// exaggeration) it produced a ~174-scene-unit invisible sphere, easily large
// enough to intercept clicks/hovers meant for nearby bodies or empty space
// (the reported "camera zooms into the Sun without clicking it" bug), while
// still leaving genuinely small bodies (Earth et al.) hard to hit at a wide
// camera distance since a *fixed* world-space radius subtends fewer and
// fewer screen pixels the farther the camera is. Fixed by sizing the hit
// sphere as a small fraction of camera *distance* instead (a standard
// constant-apparent-size picking pattern), clamped so it's never smaller
// than the visible body and never larger than a sane cap. Widened
// (
// improved, so its easier to find the planet") -- 0.015/8.0 was still tuned
// conservatively toward avoiding the Sun-swallows-everything regression
// above; upped to give real headroom for finding a small/distant body
// without reintroducing that problem (the Sun's own hit-sphere is still
// capped by HIT_SPHERE_MAX_RADIUS_SUN regardless of how far out the camera
// is -- see that constant's own comment for how this cap later turned out
// to be too aggressively shared with every other body too).
export const HIT_SPHERE_DISTANCE_FRACTION = 0.024
export const HIT_SPHERE_MIN_RADIUS = 1.3
// The Sun's OWN hit-sphere stays capped at the original, small value --
// this is the constant that actually prevents "Sun swallows everything"
// when the camera is far away. Every OTHER body now defaults to a much
// larger cap (see HIT_SPHERE_MAX_RADIUS_DEFAULT below, and PlanetBody's
// hitSphereMaxRadius prop) so their own hit-spheres can keep growing with
// camera distance instead of flattening out at a fixed world-space size.
export const HIT_SPHERE_MAX_RADIUS_SUN = 11.0
// 
// works for mercury and mars now" -- Uranus/Neptune's real orbits sit
// thousands of scene units from the Sun, requiring a camera distance far
// beyond where the OLD shared 11.0 cap (chosen for the Sun specifically)
// would flatten every OTHER body's hit-sphere too. 350 comfortably covers
// a reasonable framing of even Neptune's ~4508-unit orbit
// (4508 * HIT_SPHERE_DISTANCE_FRACTION ≈ 108, well under this) while still
// bounded (not literally unbounded, in case some future mission scale is
// even larger than expected).
export const HIT_SPHERE_MAX_RADIUS_DEFAULT = 350.0

// Body-vs-marker hover priority (found,: hover works
// reliably on the Sun but not on Earth). Root cause: at mission start the
// departure PlanetBody, the "Departure burn" BurnMarker, and the spacecraft
// model all sit at the EXACT same point (arcStartPos) -- the Sun has no burn
// marker or spacecraft coincident with it, so it never hits this. PlanetBody
// and BurnMarker size their invisible hit-spheres with the identical
// dist*HIT_SPHERE_DISTANCE_FRACTION formula, so at a shared centre the two
// spheres are perfectly concentric and same-radius -- which one wins the
// raycast becomes a floating-point coin flip, reproducing "sometimes hovers,
// sometimes doesn't." Fixed by breaking the tie deterministically: bodies are
// the more useful hover target when co-located with a marker (the marker's
// dv label is already always visible without needing hover), so PlanetBody's
// hit-sphere gets a small priority bias making it consistently win.
export const HIT_SPHERE_BODY_PRIORITY = 1.2

// Hover enlarge/highlight (planets are hard to
// find/click because they're small at typical zoom -- grow the real mesh
// and add a soft additive glow on hover, not just the label).
export const HOVER_SCALE_MULTIPLIER = 1.6
const HOVER_SCALE_VEC = new THREE.Vector3()

// Obliquity between the raw ANISE frame (heliocentric equatorial J2000) and
// the real ecliptic plane the bodies actually orbit in.
export const OBLIQUITY_DEG = 23.439291
export const OBLIQUITY_RAD = (OBLIQUITY_DEG * Math.PI) / 180

// Camera helpers.
// Real bug, found (
// view, but i already showed you the exact focus position i wanted...
// focused on the parking orbit"). This constant drives every SCRIPTED
// fly-in (idle rest position, preroll, fit-all, focus-click, done/arrival)
// -- a genuinely separate code path from the continuous-follow chase
// camera's own velocity-relative offset (fixed earlier the same day, see
// CameraController's rawOffsetDir). Tightening closeDistDeparture's
// DISTANCE (the departure-framing round earlier today) never touched this
// constant's ANGLE -- (0.22, 0.1, 1) is Z-dominant enough to read as
// nearly straight-down regardless of how close the camera sits, which is
// exactly why the idle/starting frame still looked like a top view even
// after the distance fix landed. Brought down to roughly the same
// elevation the continuous-follow chase offset now uses, for the same
// "chase from the side/behind, not from directly overhead" reason.
export const FOLLOW_CAMERA_OFFSET_DIR = new THREE.Vector3(0.55, 0.15, 0.55).normalize()
export const CAMERA_FLY_DURATION_S = 1.1

// "Fit all" camera distance, shared by OptimizeTrajectoryView and
// OverviewTrajectoryView (both use the identical fov=50 camera + fixed fly-
// to-a-point-at-distance-D-from-the-origin framing). Real bug, found
// both views previously multiplied the scene
// bounding box's diagonal (`size.length()`) by an eyeballed 0.35/0.45 --
// looked fine for a compact single-leg mission, but for a wide multi-body
// route (Cassini's Earth-Venus-Venus-Earth-Jupiter-Saturn, box diagonal
// ~9-10 AU) it put the camera roughly 3x too CLOSE to fit the real box in
// frame -- confirmed live: Jupiter/Saturn's own legs rendered correctly but
// sat well outside "Fit all"'s resulting view, and Overview's default
// framing (which uses the same formula for its OWN initial camera, not just
// its button) never showed the departure/target bodies at all for the same
// reason.
//
// Correct derivation: for a symmetric box of half-extent h viewed at
// distance d with vertical half-FOV theta, h/d <= tan(theta) must hold for
// the box to fit -- i.e. d >= h / tan(theta). Using size.length()/2 as a
// conservative (worst-orientation) half-extent and fov=50 deg (theta=25deg,
// tan(25deg)=0.466) gives d >= size.length()/(2*0.466) = size.length()*1.07.
// 1.3 adds real margin so the box doesn't sit edge-to-edge against the
// frame.
export const FIT_ALL_DISTANCE_FACTOR = 1.3

// Grid rings. GRID_RING_INTERVALS_AU is now only the fallback used by the
// idle/no-mission-scale case (EclipticGrid computes a dynamic set from
// maxRadiusAU when given one -- see that component item 4).
export const GRID_RING_INTERVALS_AU = [0.5, 1, 1.5, 2]
export const GRID_SPOKE_COUNT = 8

// Real per-body orbit rings (bodyOrbitRingPoints) vs. the plain reference
// grid (EclipticGrid) were found visually indistinguishable (
// review round, item 5: "genuinely confusing which is which"). Body orbit
// rings get their own distinctly-hued style so they read as "this is a real
// body's path" versus the grid's neutral scale reference. Round 3
//,
// after round 2's muted tan/grey also didn't land: a dark, fairly
// desaturated steel blue -- distinct from both the grid's cooler
// blue-purple (GRID_COLOR) and from the warm amber/pink used for
// burns/bodies elsewhere in the scene, dark enough to read as a real line
// rather than a highlight.
export const BODY_ORBIT_RING_COLOR = "#3d6a94"
export const BODY_ORBIT_RING_OPACITY = 0.55
export const BODY_ORBIT_RING_WIDTH = 1.2

// Label lift above the ecliptic for planet labels and burn labels.
// 30 scene units ≈ 0.2 AU - clearly visible at any interplanetary view.
export const LABEL_LIFT = 30

// Burn markers get a SMALLER lift than planet labels (found, UX
// review): a burn can sit anywhere along the arc, including right near the
// top edge of the current framing during Follow-mode playback -- lifting
// its label the full LABEL_LIFT further up than the marker itself pushed
// the label clean off the visible panel with nothing else to keep it in
// view (drei's Html has no built-in "clamp to viewport" behavior). Half the
// lift roughly halves how often this happens without making the label sit
// on top of the marker's own octahedron.
export const BURN_LABEL_LIFT = 15

// Levels the real ecliptic plane onto scene z=0 (locking the
// view to ecliptic-only left the real orbital plane visibly tilted 23.44° in
// the viewport, since raw ANISE (x_m,y_m,z_m) is heliocentric-equatorial,
// NOT ecliptic -- the old camera framing was tuned assuming a level z=0
// "floor", which used to be literally true only under the removed J2000
// grid mode). Applied as a data-level transform, not a Three.js `<group>`
// rotation: the camera-follow logic (spacecraft tracking, body/burn focus)
// computes its target points directly in JS from these same raw vectors,
// outside the scene graph -- a group-level rotation would move the visual
// meshes without moving what the camera aims at, desyncing the two. Instead,
// `sceneVecFromMeters` below is the ONE place raw meters become a scene
// position; every conversion in this view must go through it (or
// `sampleArcPosition`, which does internally) so meshes and camera math
// always agree.
// Exported for CruiseReplay/AttitudePip.tsx -- the streamed
// attitude quaternion (CruiseStepMsg.q/q_cmd) is raw J2000/ICRF-equatorial,
// same as every other raw ANISE vector this app handles, and needs the same
// leveling rotation applied to read consistently against the main scene's
// (already-leveled) axes. See that file's own comment for the full story.
export const ECLIPTIC_LEVEL_QUATERNION = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -OBLIQUITY_RAD,
)

/** Raw ANISE meters -> scene position, leveled so the ecliptic plane sits at scene z=0. */
export function sceneVecFromMeters(xM: number, yM: number, zM: number): THREE.Vector3 {
  return new THREE.Vector3(xM, yM, zM).multiplyScalar(SCENE_SCALE).applyQuaternion(ECLIPTIC_LEVEL_QUATERNION)
}

/** Ecliptic-frame meters (e.g. from lib/keplerEphemeris.ts) -> scene position.
 *  No obliquity rotation -- unlike sceneVecFromMeters, these coordinates are
 *  already ecliptic by construction (real Kepler orbital elements are
 *  defined w.r.t. the ecliptic), so applying ECLIPTIC_LEVEL_QUATERNION again
 *  would tilt them off the level plane every other position in this view
 *  already sits on. */
export function sceneVecFromEclipticMeters(xM: number, yM: number, zM: number): THREE.Vector3 {
  return new THREE.Vector3(xM, yM, zM).multiplyScalar(SCENE_SCALE)
}

// --- Utility functions ---

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export function julianDateToUtcString(jd: number): string {
  const millis = (jd - 2440587.5) * 86_400_000
  return new Date(millis).toISOString().replace(/\.\d{3}Z$/, " UTC")
}

/** Current Julian date -- only ever used to pick a shape-epoch for a
 *  decorative Kepler orbit ellipse (bodyOrbitRingPoints), never a real
 *  mission calculation. */
export function jNowForRing(): number {
  return Date.now() / 86_400_000 + 2440587.5
}

export function sampleArcPosition(
  arc: { t_s: number; x_m: number; y_m: number; z_m: number }[],
  tS: number,
): THREE.Vector3 {
  if (arc.length === 0) return new THREE.Vector3()
  if (tS <= arc[0].t_s) return sceneVecFromMeters(arc[0].x_m, arc[0].y_m, arc[0].z_m)
  const last = arc[arc.length - 1]
  if (tS >= last.t_s) return sceneVecFromMeters(last.x_m, last.y_m, last.z_m)
  let lo = 0
  let hi = arc.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (arc[mid].t_s <= tS) lo = mid
    else hi = mid
  }
  const a = arc[lo]
  const b = arc[hi]
  const f = b.t_s === a.t_s ? 0 : (tS - a.t_s) / (b.t_s - a.t_s)
  // Leveling is a pure rotation (linear), so rotating the lerp of two raw
  // points equals lerping the two already-rotated points -- safe to lerp
  // first, then convert once via sceneVecFromMeters.
  return sceneVecFromMeters(
    THREE.MathUtils.lerp(a.x_m, b.x_m, f),
    THREE.MathUtils.lerp(a.y_m, b.y_m, f),
    THREE.MathUtils.lerp(a.z_m, b.z_m, f),
  )
}

// Altitude-above-ecliptic reference lines (moved here - see
// this function's own history for why). Since sceneVecFromMeters already
// levels the real ecliptic onto scene z=0, a vertical tick is just each
// point's own z coordinate -- (x,y,z) -> (x,y,0) -- nothing fabricated.
// Sampled at ALTITUDE_LINE_COUNT fixed, evenly-spaced REAL TIME steps
// (not evenly-spaced array indices -- the arc's own sampling density is
// non-uniform, denser near flybys, and index-based sampling inherited
// that clustering) via sampleArcPosition's own interpolation. Near-zero-
// altitude points are filtered out (a threshold relative to this
// trajectory's OWN max excursion, not a fixed number or the whole
// mission's global max -- a single dominant leg, like an outer-planet
// approach, would otherwise wash out every other leg's real but smaller
// excursions) so a point right where the arc crosses the ecliptic plane
// doesn't draw a near-invisible stub.
//
// Originally lived in OptimizeTrajectoryView (the cinematic Follow view),
// toggleable there. Moved to OverviewTrajectoryView (more
// useful and fitting there: in the Follow animation they cause too
// much clutter alongside the moving chase camera. In the animation they cause too
// much buggyness anyway") -- Overview's static, always-fully-visible,
// user-controlled-camera framing is a better fit for a reference grid than
// a view whose camera is busy chasing a moving spacecraft.
export function computeAltitudeLinePoints(
  arc: { t_s: number; x_m: number; y_m: number; z_m: number }[],
  count = 1200,
): THREE.Vector3[] {
  if (arc.length === 0) return []
  const t0 = arc[0].t_s
  const t1 = arc[arc.length - 1].t_s
  if (t1 <= t0) return []
  const raw = Array.from({ length: count }, (_, i) => sampleArcPosition(arc, t0 + ((t1 - t0) * i) / (count - 1)))
  const maxAbsZ = raw.reduce((m, p) => Math.max(m, Math.abs(p.z)), 0)
  const threshold = Math.max(maxAbsZ * 0.01, 0.02)
  return raw.filter((p) => Math.abs(p.z) >= threshold)
}

// Real arc samples from the backend can be sparse (denser near real
// dynamical events, sparser during long straight cruise) -- a `<Line>`
// drawn straight through them can look visibly faceted/kinked at close
// zoom, purely a rendering artifact of piecewise-linear segments, not a
// real trajectory feature (
// in the animation... finer stepsizes... by simply interpolating"). This
// is a DISPLAY-only smoothing pass over ALREADY-real backend points --
// nothing here recomputes physics or invents a new curve shape, it just
// fits a smooth spline through the exact same real points and resamples it
// more densely, the same category of sanctioned display-only interpolation
// `sampleArcPosition` above already does for the moving spacecraft
// position (just applied to the whole rendered polyline, not one point at
// a time). Capped so a very long/dense input can't blow up the point count.
// "catmullrom" (uniform) parameterization -> "centripetal" (
//
// trajectory... is it because of interpolation?"). Yes, and this is the
// textbook cause: uniform Catmull-Rom parameterization is well-known to
// produce loops/cusps/overshoot when the input points are NOT evenly
// spaced along the curve -- exactly this app's real arc data, which is
// deliberately non-uniform (dense near a flyby/escape leg, sparse during
// plain cruise, see the seventeenth round). The spacecraft DOT
// (spacecraftPos, from sampleArcPosition -- plain linear interpolation
// between real points, never smoothed) always stays on the true path; only
// the RENDERED line here was overshooting away from it, worst right at a
// leg's start/end where the real point spacing changes most abruptly (a
// flyby, or -- the original repro -- arrival). Centripetal
// parameterization is the standard fix for unevenly-spaced Catmull-Rom
// input and guarantees no such overshoot regardless of spacing, so this is
// a straight swap, not a workaround -- no per-region special-casing needed
// (a suggested alternative, "do it mainly in areas around
// flybys," turned out unnecessary once the actual bug was fixed properly).
export function densifyCurvePoints(points: THREE.Vector3[], pointsPerSegment = 8): THREE.Vector3[] {
  if (points.length < 3) return points
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5)
  const total = Math.min((points.length - 1) * pointsPerSegment, 6000)
  return curve.getPoints(total)
}

// A real (position, velocity) state, extrapolated forward by dtS seconds via
// the same circular-orbit approximation lib/orbitExtrapolation.ts already
// uses for the live MGA search replay -- same sanctioned-exception scoping
// (see that file's header): pixels only, so a body reads as moving during
// cinematic playback (feedback: "the bodies... should move
// through time... I thought that was obvious"), never a number fed back to
// the backend or shown as a physics result. dtS === 0 skips the rotation
// entirely (used by the static Overview view, which has no playback clock).
export function liveVecFromState(
  state: { x_m: number; y_m: number; z_m: number; vx_mps: number; vy_mps: number; vz_mps: number },
  dtS: number,
): THREE.Vector3 {
  if (dtS === 0) return sceneVecFromMeters(state.x_m, state.y_m, state.z_m)
  const r0: Vec3 = [state.x_m, state.y_m, state.z_m]
  const v0: Vec3 = [state.vx_mps, state.vy_mps, state.vz_mps]
  const r = propagateCircular(r0, v0, dtS)
  return sceneVecFromMeters(r[0], r[1], r[2])
}

// Interpolates between two REAL (already-leveled, already-scene-scaled)
// positions -- not an extrapolation from one anchor, an interpolation
// bounded by two known-true endpoints (e.g. a body's real position at
// departure and its real position at its own mission event, such as
// target_r_arr_m). Slerps the direction from the Sun so the path arcs
// around the Sun the way a real orbit would, rather than cutting a
// straight line through space; lerps the radius separately. Fixes a real
// bug found: a single-anchor liveVecFromState extrapolation for
// the whole mission duration visibly diverged from the target's true
// arrival position for long/outer-planet transfers ("the purple dot is
// much higher than the rendered planet"). Same sanctioned-exception status
// as liveVecFromState -- decorative only, never fed back as a physics
// result.
export function interpolateHeliocentric(a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
  const tc = THREE.MathUtils.clamp(t, 0, 1)
  const ra = a.length()
  const rb = b.length()
  if (ra < 1e-9 || rb < 1e-9) return a.clone().lerp(b, tc)
  const dirA = a.clone().normalize()
  const dirB = b.clone().normalize()
  const rotation = new THREE.Quaternion().setFromUnitVectors(dirA, dirB)
  const q = new THREE.Quaternion().slerp(rotation, tc)
  const dir = dirA.applyQuaternion(q)
  const radius = THREE.MathUtils.lerp(ra, rb, tc)
  return dir.multiplyScalar(radius)
}

// Like interpolateHeliocentric (still lands EXACTLY on `a`/`b` at t=0/t=1),
// but always sweeps in the direction given by `axis` (right-hand rule)
// rather than whichever way is geometrically shorter, and can wind more
// than one full revolution when `estimatedTotalAngleRad` implies it.
//
// Real bug this fixes (
// direction"): `interpolateHeliocentric`'s SLERP always takes the SHORTER
// of the two possible rotations between the anchor directions
// (Quaternion.setFromUnitVectors never exceeds 180 deg) -- silently wrong
// whenever the body's real sweep over the mission exceeds 180 deg, which a
// slow target essentially never does over a realistic transfer, but a fast
// one (Mercury, ~88-day period) very much can. The complementary short-way
// rotation reads as motion in the opposite (retrograde) sense.
//
// `axis`/`estimatedTotalAngleRad` only need to be approximately right --
// they come from a low-precision decorative ephemeris model (see
// OptimizeTrajectoryView.tsx's targetLivePos), not the real propagated
// trajectory -- this function still guarantees exact real positions at
// both ends regardless, so the low-precision-model's own error can never
// make the rendered body visibly miss its own capture ring/burn markers
// the way naively rendering the ephemeris model's raw position directly
// would (a real regression caught the same day this function was added:
// the target body drifted tens of thousands of km from target_r_arr_m,
// which everything else -- the capture ring, burn markers -- stays
// anchored to).
export function interpolateAroundAxis(
  a: THREE.Vector3,
  b: THREE.Vector3,
  t: number,
  axis: THREE.Vector3,
  estimatedTotalAngleRad: number,
): THREE.Vector3 {
  const tc = THREE.MathUtils.clamp(t, 0, 1)
  const ra = a.length()
  const rb = b.length()
  if (ra < 1e-9 || rb < 1e-9 || axis.lengthSq() < 1e-12) return a.clone().lerp(b, tc)
  const k = axis.clone().normalize()
  const e1 = a.clone().normalize()
  const e2raw = k.clone().cross(e1)
  if (e2raw.lengthSq() < 1e-12) return a.clone().lerp(b, tc) // a parallel to axis -- degenerate, no plane to rotate in
  const e2 = e2raw.normalize()
  const dirB = b.clone().normalize()
  const x = dirB.dot(e1)
  const y = dirB.dot(e2)
  let baseAngle = Math.atan2(y, x)
  if (baseAngle < 0) baseAngle += Math.PI * 2
  const totalAngle = baseAngle + Math.PI * 2 * Math.round((estimatedTotalAngleRad - baseAngle) / (Math.PI * 2))
  const angle = totalAngle * tc
  const radius = THREE.MathUtils.lerp(ra, rb, tc)
  return e1.clone().multiplyScalar(Math.cos(angle)).addScaledVector(e2, Math.sin(angle)).multiplyScalar(radius)
}

// Ring in the XY plane (AU grid rings, and body orbit rings -- correct for
// real orbits since sceneVecFromMeters already leveled their centers).
export function ringPositions(center: THREE.Vector3, radiusScene: number, segments = 128): THREE.Vector3[] {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI
    pts.push(new THREE.Vector3(
      center.x + radiusScene * Math.cos(angle),
      center.y + radiusScene * Math.sin(angle),
      center.z,
    ))
  }
  return pts
}

// Real orbit ellipse (lib/keplerEphemeris.ts) for the 8 major planets --
// falls back to the existing circular approximation for any other body
// (Moon, asteroids, the Sun itself, custom bodies), which have no
// catalogued orbital elements. User request "for every planet
// look up their Kepler elements, and from this draw their ephemeris...
// will not be perfect but at least better than the circular assumption."
// `sunPosScene` only needs to be the Sun's own scene position (always the
// origin today, but not hardcoded here) since Kepler positions are already
// heliocentric.
export function bodyOrbitRingPoints(
  name: string,
  sunPosScene: THREE.Vector3,
  fallbackRadiusScene: number,
  jd: number,
  segments = 128,
): THREE.Vector3[] {
  const elements = PLANET_ELEMENTS[name]
  if (!elements) return ringPositions(sunPosScene, fallbackRadiusScene, segments)
  return keplerOrbitRingPointsM(elements, jd, segments).map(([x, y, z]) =>
    sceneVecFromEclipticMeters(x, y, z).add(sunPosScene),
  )
}

// --- Internal helpers ---

// Textured sphere in its own Suspense so one body's texture failure or slow
// load doesn't blank the whole scene. Falls back to a solid-colour sphere.
// `color` stays in the props type (every caller passes it, and the
// ColoredSphere fallback needs it) but isn't destructured here -- the
// textured materials below never use it, and the unused binding was a real
// TS6133 build error.
function TexturedSphere({
  texturePath,
  radiusScene,
  emissive,
  meshRef,
}: {
  texturePath: string
  radiusScene: number
  color: string
  emissive?: boolean
  meshRef?: React.Ref<THREE.Mesh>
}) {
  const texture = useTexture(texturePath)
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[radiusScene, 48, 48]} />
      {emissive ? (
        // The Sun can't light itself -- meshStandardMaterial left it a dim
        // grey disc (only the weak ambient light + a 0.18 emissive term were
        // visible). meshBasicMaterial + toneMapped=false renders the texture
        // unlit and at full brightness, same fix as ColoredSphere's below
        // (found too dark).
        <meshBasicMaterial map={texture} toneMapped={false} />
      ) : (
        <meshStandardMaterial
          map={texture}
          roughness={0.9}
          metalness={0}
          emissiveMap={texture}
          emissiveIntensity={0.18}   // base self-glow so dark hemisphere is not invisible
        />
      )}
    </mesh>
  )
}

function ColoredSphere({
  radiusScene,
  color,
  emissive,
  meshRef,
}: {
  radiusScene: number
  color: string
  emissive?: boolean
  meshRef?: React.Ref<THREE.Mesh>
}) {
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[radiusScene, 32, 32]} />
      {emissive ? (
        // toneMapped=false skips R3F's default ACES tone mapping for this
        // material, so the Sun reads as a genuinely bright light source
        // instead of a muted gold disc (found too dark).
        <meshBasicMaterial color={color} toneMapped={false} />
      ) : (
        <meshStandardMaterial color={color} roughness={0.9} metalness={0} emissive={color} emissiveIntensity={0.18} />
      )}
    </mesh>
  )
}

// --- Scene components ---

// Distinguishes a real click from a drag-rotate that happens to start AND
// end over the same hit-sphere (
// specific situation, it sometimes bounces back when i try to rotate...
// only do that when i double click"). Real root cause: react-three-fiber
// synthesizes its own `onClick` whenever the SAME object receives both
// pointerdown and pointerup, with no drag-distance check of its own (unlike
// a DOM `click`, which the browser suppresses after a real drag) -- so
// rotating the camera via OrbitControls while zoomed in close (where a
// body/burn marker's hit-sphere fills much of the view, making it likely
// the mouse starts AND ends the drag over the same mesh) fired this
// component's own onFocus fly-in on every such rotate, snapping the camera
// back to a scripted close-up mid-drag. Fixed generically here rather than
// per-callsite: track the pointerdown screen position, and only treat the
// subsequent click as real if the pointerup landed within
// CLICK_DRAG_THRESHOLD_PX of it.
const CLICK_DRAG_THRESHOLD_PX = 6

export function useClickNotDrag(onClick: () => void) {
  const downPos = useRef<{ x: number; y: number } | null>(null)
  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    downPos.current = { x: e.clientX, y: e.clientY }
  }, [])
  const handleClick = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const down = downPos.current
    if (down) {
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_PX * CLICK_DRAG_THRESHOLD_PX) return
    }
    onClick()
  }, [onClick])
  return { onPointerDown: handlePointerDown, onClick: handleClick }
}

// Planet body: textured sphere for close-up, an oversized invisible hit-sphere
// so hover/click works reliably at any view scale, and a label with pointer
// line above the ecliptic so the body is always identifiable.
//
// The pointer line goes from the body's local origin straight up (+Z) to
// LABEL_LIFT scene units, where the Html label sits - same visual idiom as
// BurnMarker so the scene reads consistently.
//
// alwaysShowLabel=true: label and pointer line always visible (for few bodies
// in the cinematic view). alwaysShowLabel=false: only on hover (overview mode
// where many bodies would create visual noise).
export function PlanetBody({
  name,
  position,
  radiusM,
  spinRateRadS,
  color,
  emissive,
  poleRaDeg,
  poleDecDeg,
  alwaysShowLabel = true,
  ringPoints,
  ringColor = BODY_ORBIT_RING_COLOR,
  ringOpacity = BODY_ORBIT_RING_OPACITY,
  ringWidth = BODY_ORBIT_RING_WIDTH,
  sizeExaggeration = PLANET_SIZE_EXAGGERATION,
  hitSphereMaxRadius = HIT_SPHERE_MAX_RADIUS_DEFAULT,
  hoverEnlarge = true,
  onFocus,
}: {
  name: string
  position: THREE.Vector3
  radiusM: number
  spinRateRadS?: number | null
  color: string
  emissive?: boolean
  poleRaDeg?: number | null
  poleDecDeg?: number | null
  alwaysShowLabel?: boolean
  /** When given, PlanetBody also renders this body's real orbit ring AND
   * makes the whole ring (not just the tiny body) a hover/click target --
   * see the ring-hover block below for why. Absolute (Sun-centered) scene
   * coordinates, same as bodyOrbitRingPoints' output. */
  ringPoints?: THREE.Vector3[]
  ringColor?: string
  ringOpacity?: number
  ringWidth?: number
  /** Overrides PLANET_SIZE_EXAGGERATION for this one body -- the Sun's real
   * radius (6.957e8 m) is already enormous next to a planet's, so applying
   * the SAME exaggeration multiplier every other body uses made it look
 * absurdly oversized once that multiplier got large
   * (visibly ridiculous). Callers pass a much smaller value for
   * the Sun; every other body keeps the shared default. */
  sizeExaggeration?: number
  /** Overrides HIT_SPHERE_MAX_RADIUS_DEFAULT for this one body (
 *
   * for mercury and mars"). Root cause: the shared HIT_SPHERE_MAX_RADIUS
   * cap exists specifically to stop the SUN's hit-sphere from swallowing
   * nearby clicks when the camera is far away (see that constant's own
   * comment) -- but applying the SAME small cap to every body breaks the
   * whole "constant apparent size" point of the distance*fraction formula
   * once camera distance exceeds cap/fraction (~458 scene units at the old
   * 11.0 cap). Mercury/Mars's own orbits (comfortably under that distance
   * even at a fairly wide framing) never hit the cap; Uranus/Neptune's
   * (thousands of scene units out) always did, capping their hit-spheres
   * to the same tiny 11-unit radius regardless of how far the camera
   * actually was. Callers pass a much smaller value for the Sun
   * specifically (preserving the original fix where it's actually
   * needed); every other body gets a far more generous default. */
  hitSphereMaxRadius?: number
  /** Disable the hover-enlarge growth (Phase 03 PCI views: the
   * frame body is already screen-filling at local zoom, so growing it on
   * hover is pointless there). Hover glow/label behavior is unchanged. */
  hoverEnlarge?: boolean
  /** Second arg is this body's own true scene-space radius (
 *
   * way, but too far so that the planet disappears... you then need to
   * zoom out"). Root cause: the focus-click fly-in distance used to be
   * whatever generic `flyToDistance` happened to be active for the CURRENT
   * playback context (departure/current-leg framing), completely
   * unrelated to the size of whatever body was actually clicked -- click a
   * large body while a small one's close distance was active (or vice
   * versa) and the camera flies to a distance tuned for the wrong body
   * entirely, landing too close (or too far) for the one actually in
   * frame. Passing the real radius lets the caller compute a
   * body-appropriate distance instead of trusting the ambient context. */
  onFocus?: (pos: THREE.Vector3, radiusScene?: number) => void
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const glowMeshRef = useRef<THREE.Mesh>(null)
  const hitMeshRef = useRef<THREE.Mesh>(null)
  const poleQuatRef = useRef(new THREE.Quaternion())
  const spinQuatRef = useRef(new THREE.Quaternion())
  const spinAxisRef = useRef(new THREE.Vector3(0, 1, 0))
  const spinAngleRef = useRef(0)
  const [hovered, setHovered] = useState(false)

  const texturePath = planetTexturePathFor(name)
  const trueRadiusScene = Math.max(radiusM * SCENE_SCALE, 1e-5)
  const clickNotDrag = useClickNotDrag(() => onFocus?.(position, trueRadiusScene))
  // Hit-sphere and glow sizing still use the FULL exaggeration as their
  // baseline -- those are about clickability/visibility, not the
  // geometric-accuracy ask "1-body mode" addresses (see
  // EXAGGERATION_NEAR_RATIO's comment), so they're deliberately unaffected
  // by the mesh's own dynamic true/exaggerated scale below.
  const displayRadiusScene = trueRadiusScene * sizeExaggeration
  const minHitRadiusScene = Math.max(displayRadiusScene * 2.0, HIT_SPHERE_MIN_RADIUS)

  // Hit sphere is a unit sphere rescaled every frame to a small, roughly
  // constant-apparent-size fraction of camera distance (see
  // HIT_SPHERE_DISTANCE_FRACTION's comment above) -- keeps small/far bodies
  // easy to hit without letting a large nearby body (the Sun) swallow clicks
  // meant for its neighbors.
  useFrame(({ camera }) => {
    if (!hitMeshRef.current) return
    const dist = camera.position.distanceTo(position)
    const radius = THREE.MathUtils.clamp(
      dist * HIT_SPHERE_DISTANCE_FRACTION,
      minHitRadiusScene,
      hitSphereMaxRadius,
    )
    // See HIT_SPHERE_BODY_PRIORITY's comment: biased slightly larger than a
    // BurnMarker/SpacecraftModel's own hit-sphere so a body deterministically
    // wins the raycast when they sit at the same point (departure, t=0).
    hitMeshRef.current.scale.setScalar(radius * HIT_SPHERE_BODY_PRIORITY)
  })

  useEffect(() => {
    const yAxis = new THREE.Vector3(0, 1, 0)
    if (poleRaDeg != null && poleDecDeg != null) {
      const ra = (poleRaDeg * Math.PI) / 180
      const dec = (poleDecDeg * Math.PI) / 180
      // Real bug, found (
      // the true 3 degrees tilt it has"). pole_ra_deg/pole_dec_deg are real
      // IAU pole coordinates in the raw EQUATORIAL J2000 frame -- the exact
      // same input frame sceneVecFromMeters always rotates through
      // ECLIPTIC_LEVEL_QUATERNION before anything is placed in the scene.
      // This computed the pole direction correctly in that raw frame, then
      // used it DIRECTLY as a scene-space direction with no such rotation
      // applied -- every body's rendered tilt was systematically off by
      // (approximately) the full obliquity angle relative to its real
      // value, not just visually approximate. Fixed by applying the same
      // rotation every other position in this scene already goes through.
      const poleDir = new THREE.Vector3(
        Math.cos(dec) * Math.cos(ra),
        Math.cos(dec) * Math.sin(ra),
        Math.sin(dec),
      ).normalize().applyQuaternion(ECLIPTIC_LEVEL_QUATERNION)
      if (poleDir.lengthSq() > 0.5) {
        poleQuatRef.current.setFromUnitVectors(yAxis, poleDir)
      }
    } else {
      poleQuatRef.current.setFromUnitVectors(yAxis, new THREE.Vector3(0, 0, 1))
    }
  }, [poleRaDeg, poleDecDeg])

  useFrame(({ camera }, delta) => {
    if (meshRef.current && spinRateRadS) {
      spinAngleRef.current += spinRateRadS * ROTATION_VISUAL_SPEEDUP * delta
      spinQuatRef.current.setFromAxisAngle(spinAxisRef.current, spinAngleRef.current)
      meshRef.current.quaternion.multiplyQuaternions(poleQuatRef.current, spinQuatRef.current)
    }
    // "1-body mode"'s distance-based exaggeration ramp is GONE (
    //
    // them, then they become larger") -- superseding the whole
    // EXAGGERATION_NEAR_RATIO/_FAR_RATIO ramp this file spent several
    // rounds tuning earlier the same day. A body's baseline mesh scale is
    // now always exactly 1x (true physical radius), regardless of camera
    // distance -- at real interplanetary range this means most bodies are
    // genuinely sub-pixel/invisible until hovered, which is the explicit
    // point: no more guessing at a "comfortably visible but not
    // oversized" compromise size.
    //
    // Hover enlarge + glow (revised):
    // grows to a real, DISTANCE-APPROPRIATE visible size on hover, not a
    // flat multiplier -- a fixed multiplier (the old HOVER_SCALE_MULTIPLIER)
    // would be meaningless against an often-sub-pixel true-scale baseline
    // from interplanetary range (1.6x of "invisible" is still invisible).
    // Reuses the SAME constant-apparent-size formula the hit-sphere above
    // already computes (HIT_SPHERE_DISTANCE_FRACTION), so a body that's
    // hoverable at all is guaranteed to become clearly visible on hover, at
    // any camera distance -- the hover TARGET and the hover TRIGGER area
    // are now derived from the same real number, not independently tuned.
    const lerpAlpha = 1 - Math.pow(0.001, delta)
    const dist = camera.position.distanceTo(position)
    // Real bug, found (Mercury preset: clicking the body to focus
    // -- or "Zoom to S/C" landing near it -- flew the camera in close, then
    // this SAME body's own hover-enlarge (cursor still sits over it after
    // the fly-in) puffed it up past the camera's own position, reading as
    // "the camera is now inside/underneath the planet's surface" with no
    // texture visible, just a flat close-up blob). HIT_SPHERE_MIN_RADIUS
    // (1.3 scene units) is tuned for FAR-AWAY findability -- fine at typical
    // interplanetary camera distances (tens of scene units), but for a small
    // body (Mercury's true radius is ~0.0024) viewed from a scripted close-up
    // fly-in (as little as ~0.05 scene units away), that same floor would
    // hover-enlarge the body to ~300x its own true radius -- many times
    // BIGGER than the camera's own distance from it. Capped at a fraction of
    // the actual camera distance so the enlarged body can never grow past
    // roughly a third of the way to the camera, regardless of how small the
    // body or how close the camera currently is; harmless at normal
    // interplanetary range, where this cap is far looser than the other one.
    const hoverRadiusScene = Math.min(
      THREE.MathUtils.clamp(dist * HIT_SPHERE_DISTANCE_FRACTION, HIT_SPHERE_MIN_RADIUS, hitSphereMaxRadius) * 0.6,
      dist * 0.3,
    )
    const hoverScale = Math.max(1, hoverRadiusScene / trueRadiusScene)
    if (meshRef.current) {
      const targetScale = hovered && hoverEnlarge ? hoverScale : 1
      meshRef.current.scale.lerp(HOVER_SCALE_VEC.setScalar(targetScale), lerpAlpha)
    }
    if (glowMeshRef.current) {
      const mat = glowMeshRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, hovered ? 0.4 : 0, lerpAlpha)
      // Track the real mesh's own dynamic scale so the glow halo never
      // looks mismatched against the body it's supposed to be surrounding.
      const glowTarget = trueRadiusScene * (hovered && hoverEnlarge ? hoverScale : 1) * 1.35
      glowMeshRef.current.scale.lerp(HOVER_SCALE_VEC.setScalar(glowTarget), lerpAlpha)
    }
  })

  const showLabel = alwaysShowLabel || hovered
  const dotColor = emissive ? "#FFD700" : color

  // Ring-hover beads (
  // included in flybys... i need to find the right location and hover
  // above it... can we [instead] hover above the ring, anywhere above the
  // ring"). A thin `Line` has a poor raycast hit area by default, and
  // building a real tubular hover geometry along the ellipse would mean
  // rebuilding a custom BufferGeometry every time ringPoints changes --
  // which, for a decorative planet, is EVERY render during playback (its
  // position updates every frame). Cheaper and simpler: a modest number of
  // small invisible hit-spheres strung along the already-computed
  // ringPoints array (no extra geometry math), each wired to the SAME
  // `hovered` state as the body itself -- hovering any bead along the ring
  // shows the body's label exactly like hovering the tiny body mesh does.
  const RING_HOVER_BEAD_COUNT = 24
  const ringHoverBeadPositions = useMemo(() => {
    if (!ringPoints || ringPoints.length === 0) return []
    if (ringPoints.length <= RING_HOVER_BEAD_COUNT) return ringPoints
    const stride = ringPoints.length / RING_HOVER_BEAD_COUNT
    return Array.from({ length: RING_HOVER_BEAD_COUNT }, (_, i) => ringPoints[Math.floor(i * stride)])
  }, [ringPoints])

  return (
    <>
      {ringPoints && (
        <>
          <Line points={ringPoints} color={ringColor} opacity={ringOpacity} transparent lineWidth={ringWidth} />
          {ringHoverBeadPositions.map((p, i) => (
            <RingHoverBead key={i} position={p} onHoverChange={setHovered} onClick={() => onFocus?.(position)} />
          ))}
        </>
      )}
    <group position={position}>
      {/* Invisible hit sphere - a unit sphere rescaled per-frame (see the
          useFrame above) to a roughly constant apparent size at any view
          scale. This is the ONLY mesh that receives pointer events. */}
      <mesh
        ref={hitMeshRef}
        visible={false}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
        onPointerOut={() => setHovered(false)}
        onPointerDown={clickNotDrag.onPointerDown}
        onClick={clickNotDrag.onClick}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Visible textured sphere - shows real detail when zoomed in. Built
          at TRUE physical radius now ("1-body mode", see
          EXAGGERATION_NEAR_RATIO's comment) -- the per-frame mesh `.scale`
          in the useFrame above supplies the whole (distance-dependent)
          exaggeration factor on top of this real geometry, not a second
          bake-in. */}
      {texturePath ? (
        <Suspense fallback={<ColoredSphere radiusScene={trueRadiusScene} color={color} emissive={emissive} meshRef={meshRef} />}>
          <TexturedSphere texturePath={texturePath} radiusScene={trueRadiusScene} color={color} emissive={emissive} meshRef={meshRef} />
        </Suspense>
      ) : (
        <ColoredSphere radiusScene={trueRadiusScene} color={color} emissive={emissive} meshRef={meshRef} />
      )}

      {/* Soft additive glow on hover -- "lighten up" half of the hover
          request above; the mesh scale-up in the useFrame is the "enlarge"
          half. A separate slightly-larger sphere rather than mutating the
          real material, so texture load / spin logic above stays untouched. */}
      <mesh ref={glowMeshRef} scale={trueRadiusScene * sizeExaggeration * 1.35}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial color={dotColor} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* Label: plain text anchored exactly at the body's real 3D position
 -- reworked (
          the planets ... are not really aligned with the orbit rings, which
          makes it confusing ... get rid of those dots/pointers and just add
          text labels, maybe that's sufficient"). The previous design lifted
          a small dot LABEL_LIFT scene units above the ecliptic, joined to
          the body by a pointer line -- an off-plane point does not stay
          visually coincident with its own (in-plane) orbit ring once the
          camera views from any oblique angle, which read as "these floating
          dots ARE the planets," and separately as visibly detached from the
          ring the body actually orbits on. Real orbit-visualization tools
          (GMAT, STK, and similar) label a body directly at its own rendered
          position rather than on a separate lifted marker -- this does the
          same now: Html anchored at the body's exact 3D position (so it's
          pixel-correct relative to the body AND its ring at any camera
          angle), nudged a few CSS pixels via a `transform` (a screen-space
          offset, not a world-space one, so it reads as "next to the body"
          from every angle instead of drifting the way the old lifted dot
          did). No separate dot marker at all now, in the hover-only case or
          otherwise -- the real mesh (small but real, per "1-body mode"
          above) already marks the body's position; the name, colour-coded
          the same way the old dot was, is enough on its own. */}
      <Html center style={{ pointerEvents: "none" }}>
        {showLabel && (
          <span style={{
            display: "block",
            transform: "translate(9px, -9px)",
            color: dotColor,
            fontSize: hovered ? 13 : 11,
            fontWeight: hovered ? 700 : 500,
            whiteSpace: "nowrap",
            textShadow: "0 1px 3px #000, 0 0 6px #000",
            letterSpacing: "0.03em",
            transition: "all 0.15s ease",
            pointerEvents: "none",
            userSelect: "none",
          }}>
            {name}
          </span>
        )}
      </Html>
    </group>
    </>
  )
}

// One invisible, distance-scaled hit target strung along a PlanetBody's
// ring (see ringHoverBeadPositions' comment above) -- its own tiny
// component so each bead gets its own useFrame without re-deriving camera
// distance math inline in a .map().
function RingHoverBead({
  position,
  onHoverChange,
  onClick,
}: {
  position: THREE.Vector3
  onHoverChange: (hovered: boolean) => void
  onClick: () => void
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const clickNotDrag = useClickNotDrag(onClick)
  useFrame(({ camera }) => {
    if (!meshRef.current) return
    const dist = camera.position.distanceTo(position)
    // RingHoverBead only ever exists on a decorative planet's own ring
    // (never the Sun), so it always uses the general, more generous cap --
    // see HIT_SPHERE_MAX_RADIUS_DEFAULT's own comment.
    const radius = THREE.MathUtils.clamp(dist * HIT_SPHERE_DISTANCE_FRACTION, HIT_SPHERE_MIN_RADIUS, HIT_SPHERE_MAX_RADIUS_DEFAULT)
    meshRef.current.scale.setScalar(radius)
  })
  return (
    <mesh
      ref={meshRef}
      position={position}
      visible={false}
      onPointerOver={(e) => { e.stopPropagation(); onHoverChange(true) }}
      onPointerOut={() => onHoverChange(false)}
      onPointerDown={clickNotDrag.onPointerDown}
      onClick={clickNotDrag.onClick}
    >
      <sphereGeometry args={[1, 6, 6]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

// Octahedron at a ΔV event, with a vertical pointer line to a label.
// showLabel is externally gated (e.g. capture burn only shows once triggered).
// Hover highlights the marker + label (same idiom as PlanetBody); click
// focuses/zooms the camera on it (- previously click toggled the
// label instead, which is now always shown whenever showLabel is true).
export function BurnMarker({
  position,
  label,
  dvMs,
  showLabel = true,
  hideMarkerShape,
  onFocus,
}: {
  position: THREE.Vector3
  label: string
  dvMs: number
  showLabel?: boolean
  /** Skips the visible octahedron (
   * marker (the yellow one) and only use the blue dot") -- the departure
   * burn sits right at the ship's own starting position, and its amber
   * diamond read as a second, competing spacecraft marker right next to the
   * real one. The hit-sphere/hover/label all stay functional; only the
   * visible shape is dropped. */
  hideMarkerShape?: boolean
  onFocus?: (pos: THREE.Vector3) => void
}) {
  const [hovered, setHovered] = useState(false)
  const hitMeshRef = useRef<THREE.Mesh>(null)
  const visibleMeshRef = useRef<THREE.Mesh>(null)
  const clickNotDrag = useClickNotDrag(() => onFocus?.(position))
  const labelPos = useMemo(
    () => position.clone().add(new THREE.Vector3(0, 0, BURN_LABEL_LIFT)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [position.x, position.y, position.z],
  )
  // Real bug, found (
  // randomly through the background at the end of the animation").
  // Root cause: drei's `<Html>` (non-`occlude` mode) projects a 3D point
  // to screen space via a plain `vector.project(camera)` call with no
  // behind-camera clipping -- if the label's anchor point ends up BEHIND
  // the camera plane, the projected coordinates are mathematically valid
  // but meaningless (often mirrored/flung to an arbitrary screen
  // location), rendering the label "flying" across the view. Ordinarily
  // never hit, since the old chase camera only ever looked roughly along
  // the spacecraft's own direction of travel -- but the new arrival
  // look-back rotation (CameraController's lookBackBlend) sweeps the
  // camera through a genuine ~180-degree arc, so during that sweep a burn
  // marker sitting further back along the trajectory (a DSM from an
  // earlier leg, still `showLabel`-visible once its own leg has started)
  // can transiently pass behind the camera. Fixed with a manual
  // in-front-of-camera check (dot product against the camera's own
  // forward vector) -- cheap, and only updates React state on an actual
  // front/back TRANSITION (rare), not every frame, to avoid a per-frame
  // re-render cost for something that's visually static almost all the
  // time.
  const [labelInFront, setLabelInFront] = useState(true)
  const labelInFrontRef = useRef(true)
  const camForwardVec = useMemo(() => new THREE.Vector3(), [])
  const toLabelVec = useMemo(() => new THREE.Vector3(), [])

  // Same distance-scaled hit-sphere pattern as PlanetBody -- the visible
  // octahedron (radius 0.08 scene units) was found too small to reliably
  // hover/click at typical zoom (feedback, item 6), far
  // smaller than PlanetBody's own hit target.
  useFrame(({ camera }) => {
    if (!hitMeshRef.current) return
    const dist = camera.position.distanceTo(position)
    const radius = THREE.MathUtils.clamp(dist * HIT_SPHERE_DISTANCE_FRACTION, HIT_SPHERE_MIN_RADIUS, HIT_SPHERE_MAX_RADIUS_DEFAULT)
    hitMeshRef.current.scale.setScalar(radius)
    // Visible marker size (fix, see BURN_MARKER_MAX_RADIUS_SCENE's
    // own comment) -- constant-apparent-screen-size, same idiom as the hit
    // sphere just above, not tied to any body's radius.
    if (visibleMeshRef.current) {
      const markerRadius = THREE.MathUtils.clamp(dist * BURN_MARKER_DISTANCE_FRACTION, BURN_MARKER_MIN_RADIUS_SCENE, BURN_MARKER_MAX_RADIUS_SCENE)
      visibleMeshRef.current.scale.setScalar(markerRadius * (hovered ? 1.4 : 1))
    }
    camera.getWorldDirection(camForwardVec)
    toLabelVec.copy(labelPos).sub(camera.position)
    const inFront = toLabelVec.dot(camForwardVec) > 0
    if (inFront !== labelInFrontRef.current) {
      labelInFrontRef.current = inFront
      setLabelInFront(inFront)
    }
  })

  return (
    <group>
      {/* Octahedron marker at the exact burn point -- visual only, no
          pointer handlers (see the invisible hit sphere below). */}
      <group position={position}>
        {/* Base geometry is a unit octahedron (radius 1); the useFrame above
            rescales it every frame to a constant-apparent-screen-size,
            camera-distance-relative radius -- see
            BURN_MARKER_MAX_RADIUS_SCENE's own comment for why this replaced
            both the original fixed size and the body-radius-ratio attempt
            that came after it. */}
        {!hideMarkerShape && (
          <mesh ref={visibleMeshRef} rotation={[Math.PI / 4, Math.PI / 4, 0]}>
            <octahedronGeometry args={[1, 0]} />
            <meshBasicMaterial color={BURN_COLOR} />
          </mesh>
        )}
        {/* Invisible hit sphere, rescaled per-frame -- the only mesh that
            receives pointer events for this marker. */}
        <mesh
          ref={hitMeshRef}
          visible={false}
          onPointerDown={clickNotDrag.onPointerDown}
          onClick={clickNotDrag.onClick}
          onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
          onPointerOut={() => setHovered(false)}
        >
          <sphereGeometry args={[1, 8, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>

      {showLabel && labelInFront && (
        <>
          <Line points={[position, labelPos]} color={BURN_COLOR} opacity={hovered ? 0.9 : 0.55} transparent lineWidth={1} />
          <group position={labelPos}>
            <Html center style={{ pointerEvents: "none" }}>
              <div style={{
                color: BURN_COLOR,
                fontSize: hovered ? 13 : 11,
                fontWeight: hovered ? 700 : 600,
                whiteSpace: "nowrap",
                pointerEvents: "none",
                textShadow: hovered ? "0 1px 3px #000, 0 0 10px #000" : "0 1px 3px #000, 0 0 6px #000",
                textAlign: "center",
                transition: "all 0.15s ease",
              }}>
                {label}
                <br />
                {dvMs.toFixed(0)} m/s
              </div>
            </Html>
          </group>
        </>
      )}
    </group>
  )
}

// Radial reference grid: concentric AU rings + radial spokes in the
// (already-leveled) ecliptic plane at scene z=0.
//
// Found genuinely tilted this component
// used to carry its own `+OBLIQUITY_RAD` group rotation, documented (here,
// now corrected) as canceling an outer `-OBLIQUITY_RAD` wrapper supposedly
// applied by its caller -- but no such wrapper exists anywhere in either
// OptimizeTrajectoryView or OverviewTrajectoryView (grepped both, confirmed
// absent), and hasn't since the switch to leveling via
// `sceneVecFromMeters` at the data level instead of a scene-graph rotation
// (see that function's header). This grid's own tilt was never removed when
// that outer wrapper was, leaving the reference grid alone rendering 23.44°
// off the real (correctly leveled) body/arc data. Removed -- `ringPositions`
// already produces a flat ring at z=0, which is exactly the leveled ecliptic
// plane now that nothing else here is rotated.
export function EclipticGrid({ origin, maxRadiusAU }: { origin: THREE.Vector3; maxRadiusAU?: number }) {
  // Real bug, found (review round item 4): the grid was fixed at
  // [0.5, 1, 1.5, 2] AU regardless of mission scale, so an outer-planet
  // mission (Saturn ~9.5 AU) rendered with no reference rings at all past
  // 2 AU. Dynamic ring set: when maxRadiusAU is given, rings run all the way
  // out to the scene's real outer extent instead of stopping short -- the
  // caller (OptimizeTrajectoryView) now always floors maxRadiusAU at
  // Neptune's own orbit, so this reaches the outer planets regardless of
  // mission scale (
  // the outer planets, always"). Spacing itself is adaptive, not a flat
  // 1 AU (same user round: "change the number of axes... from 1AU to maybe
  // 5AU" when zoomed out) -- coarser steps at a wider extent keep the ring
  // count reasonable (7 rings at Neptune's ~30 AU with a 5 AU step, versus
  // 30 rings at a flat 1 AU step) without losing resolution on an
  // inner-planet mission, which still gets 1 AU (or the original fine
  // fallback below 2 AU).
  const ringIntervalsAU = useMemo(() => {
    if (maxRadiusAU == null || maxRadiusAU <= GRID_RING_INTERVALS_AU[GRID_RING_INTERVALS_AU.length - 1]) {
      return GRID_RING_INTERVALS_AU
    }
    const step = maxRadiusAU > 12 ? 5 : maxRadiusAU > 4 ? 2 : 1
    const rings: number[] = []
    for (let au = step; au <= Math.ceil(maxRadiusAU / step) * step; au += step) rings.push(au)
    return rings
  }, [maxRadiusAU])
  const outermostRadius = ringIntervalsAU[ringIntervalsAU.length - 1] * AU_SCENE
  const spokeAngles = useMemo(
    () => Array.from({ length: GRID_SPOKE_COUNT }, (_, i) => (i / GRID_SPOKE_COUNT) * 2 * Math.PI),
    [],
  )
  const zLabelText = "ecl. north"

  return (
    <group>
      {ringIntervalsAU.map((au) => {
        const radiusScene = au * AU_SCENE
        const ringPts = ringPositions(origin, radiusScene)
        const labelPos = new THREE.Vector3(origin.x + radiusScene, origin.y, origin.z)
        return (
          <group key={au}>
            <Line points={ringPts} color={GRID_COLOR} opacity={GRID_OPACITY} transparent lineWidth={1} />
            <Html position={labelPos} style={{ pointerEvents: "none" }}>
              <div style={{ color: GRID_TICK_COLOR, fontSize: 10, opacity: 0.9, whiteSpace: "nowrap", pointerEvents: "none" }}>{au} AU</div>
            </Html>
          </group>
        )
      })}
      {spokeAngles.map((angle) => {
        const tip = new THREE.Vector3(
          origin.x + outermostRadius * Math.cos(angle),
          origin.y + outermostRadius * Math.sin(angle),
          origin.z,
        )
        return <Line key={angle} points={[origin, tip]} color={GRID_COLOR} opacity={GRID_OPACITY * 0.6} transparent lineWidth={1} />
      })}
      <Line
        points={[origin, new THREE.Vector3(origin.x, origin.y, origin.z + outermostRadius * 0.08)]}
        color={GRID_COLOR}
        opacity={GRID_OPACITY * 1.5}
        transparent
        lineWidth={1}
      />
      <Html position={new THREE.Vector3(origin.x, origin.y, origin.z + outermostRadius * 0.08)} style={{ pointerEvents: "none" }}>
        <div style={{ color: GRID_TICK_COLOR, fontSize: 10, opacity: 0.9, whiteSpace: "nowrap", pointerEvents: "none" }}>{zLabelText}</div>
      </Html>
    </group>
  )
}

// Perturber body: orbit ring in the ecliptic plane + PlanetBody.
//
// alwaysShowLabel is forced true (feedback: "dots that i
// think are connected to planets that are not in the visualization for some
// reason... we will always visualize at least all planets in the
// simulation"). This body IS a real physics perturber in the mission's own
// force model -- it used to render hover-only (a tiny unlabeled 5px dot at
// typical zoom, indistinguishable from the decorative background planets
// that are NOT part of the simulation), which read as an unexplained orphan
// dot. Decorative planets (sceneShared consumers passing alwaysShowLabel
// explicitly to a plain PlanetBody, not through this wrapper) are correctly
// still hover-only -- the distinction that matters is "part of the
// simulation" vs "visual context only", not just "not the departure/target".
export function PerturberBody({
  name,
  position,
  sunPosition,
  radiusM,
  spinRateRadS,
  poleRaDeg,
  poleDecDeg,
  onFocus,
}: {
  name: string
  position: THREE.Vector3
  sunPosition: THREE.Vector3
  radiusM: number
  spinRateRadS?: number | null
  poleRaDeg?: number | null
  poleDecDeg?: number | null
  onFocus?: (pos: THREE.Vector3) => void
}) {
  const orbitRadiusScene = useMemo(() => position.distanceTo(sunPosition), [position, sunPosition])
  // Real orbit ellipse for the 8 major planets (falls back to the circular
  // approximation for anything else) -- see bodyOrbitRingPoints' own doc
  // comment. jNowForRing: this perturber has no per-mission epoch handy
  // here, so it uses "now" for the ring's shape -- fine, since the shape
  // itself barely changes year to year (only the body's own moving dot,
  // computed elsewhere from a real fetched state, needs to be epoch-exact).
  const ringPts = useMemo(
    () => bodyOrbitRingPoints(name, sunPosition, orbitRadiusScene, jNowForRing()),
    [name, sunPosition, orbitRadiusScene],
  )
  return (
    <>
      <Line points={ringPts} color={BODY_ORBIT_RING_COLOR} opacity={BODY_ORBIT_RING_OPACITY} transparent lineWidth={BODY_ORBIT_RING_WIDTH} />
      <PlanetBody
        name={name}
        position={position}
        radiusM={radiusM}
        spinRateRadS={spinRateRadS}
        color="#8899bb"
        poleRaDeg={poleRaDeg}
        poleDecDeg={poleDecDeg}
        onFocus={onFocus}
      />
    </>
  )
}

// Fetches a perturber's heliocentric state from /api/bodies/{name}/state,
// ONCE at `epoch` (not per frame -- see the kernel-caching backend note in
// the design notes), then displays it extrapolated `elapsedS` seconds forward via
// `liveVecFromState` so it visibly moves during playback instead of sitting
// frozen at its departure-epoch position. 422 (no ANISE coverage, e.g. small
// bodies) renders nothing - expected. `onPositionResolved` reports the fixed
// anchor position (not the live one) since it only feeds the "Fit all"
// bounding box, which shouldn't recompute every frame during playback.
// Real request (
// planets"): PerturberBodyFromState below fetches ONE real state then
// extrapolates motion via propagateCircular (orbitExtrapolation.ts's
// decorative circular approximation) -- for a real eccentric orbit
// (Mercury, e~0.21), that visibly drifts from the truth over a real
// mission's playback, which is exactly what made the departure/target
// body markers look wrong in the mission-validation replay even after the
// underlying reference-trajectory data itself was fixed to be real.
// BodyFromTrack instead interpolates a REAL multi-sample track (the same
// fetchBodyTrack(...) call this app already uses to build cruise_seed.
// body_tracks -- reused here for rendering too, not a second fetch
// mechanism) via sampleArcPosition's real linear interpolation between
// real ANISE samples -- same fidelity class as the spacecraft's own arc
// rendering, not a physics approximation.
export function BodyFromTrack({
  name,
  track,
  elapsedS = 0,
  sunPosition,
  radiusM,
  spinRateRadS,
  poleRaDeg,
  poleDecDeg,
  onFocus,
}: {
  name: string
  track: { t_s: number; r_m: number[] }[]
  elapsedS?: number
  sunPosition: THREE.Vector3
  radiusM: number
  spinRateRadS?: number | null
  poleRaDeg?: number | null
  poleDecDeg?: number | null
  onFocus?: (pos: THREE.Vector3) => void
}) {
  if (track.length === 0) return null
  // Hermite, not linear (the re-anchored parking orbit
  // rendered as a distorted/jagged ring): at the fetched 1-sample/day
  // density, linear interpolation puts Earth up to ~5,600 km off its real
  // path mid-segment (the chord error bodyTrackFetch.ts's own header
  // documents) -- the same magnitude as a parking orbit. trackPositionAt
  // uses the track's real velocities for a cubic Hermite fit (~km error),
  // and the CruiseReplayView ring/trail anchors use the SAME function on
  // the SAME track, so body and orbit stay consistent by construction.
  const position = sceneVecFromMeters(
    ...trackPositionAt({ name, track: track as BodyTrackConfig["track"], soi_capture: false }, elapsedS),
  )
  return (
    <PerturberBody
      name={name}
      position={position}
      sunPosition={sunPosition}
      radiusM={radiusM}
      spinRateRadS={spinRateRadS}
      poleRaDeg={poleRaDeg}
      poleDecDeg={poleDecDeg}
      onFocus={onFocus}
    />
  )
}

export function PerturberBodyFromState({
  name,
  epoch,
  elapsedS = 0,
  sunPosition,
  radiusM,
  spinRateRadS,
  poleRaDeg,
  poleDecDeg,
  onPositionResolved,
  onFocus,
}: {
  name: string
  epoch: string
  elapsedS?: number
  sunPosition: THREE.Vector3
  radiusM: number
  spinRateRadS?: number | null
  poleRaDeg?: number | null
  poleDecDeg?: number | null
  onPositionResolved?: (name: string, pos: THREE.Vector3) => void
  onFocus?: (pos: THREE.Vector3) => void
}) {
  const { data, isError } = useBodyState(name, epoch)
  useEffect(() => {
    if (data && onPositionResolved) {
      onPositionResolved(name, sceneVecFromMeters(data.x_m, data.y_m, data.z_m))
    }
  }, [data, name, onPositionResolved])
  if (isError || !data) return null
  const position = liveVecFromState(data, elapsedS)
  return (
    <PerturberBody
      name={name}
      position={position}
      sunPosition={sunPosition}
      radiusM={radiusM}
      spinRateRadS={spinRateRadS}
      poleRaDeg={poleRaDeg}
      poleDecDeg={poleDecDeg}
      onFocus={onFocus}
    />
  )
}
