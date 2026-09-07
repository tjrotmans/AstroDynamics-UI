import { useEffect, useMemo, useRef, useState } from "react"
import { Canvas } from "@react-three/fiber"
import { Html, Line } from "@react-three/drei"
import * as THREE from "three"

import type { BodyTrackConfig, CruiseStepMsg, HardwareItem } from "@/api/client"
import { useBodies } from "@/hooks/useApi"
import {
  EclipticGrid,
  sceneVecFromMeters,
  PlanetBody,
  BodyFromTrack,
  BurnMarker,
  SUN_SIZE_EXAGGERATION,
  HIT_SPHERE_MAX_RADIUS_SUN,
  SCENE_SCALE,
  ringPositions,
  GRID_COLOR,
} from "@/components/scene/sceneShared"
import { trackPositionAt } from "@/lib/bodyTrackFetch"
import { FreeCameraControls } from "@/components/scene/FreeCameraControls"
import { PauseWhenHidden } from "@/components/scene/PauseWhenHidden"
import { VehicleMesh } from "./VehicleMesh"
import { VehicleVectorLegendEntries } from "./vehicleVectorLegend"

// Real request: "I think we can remove the Follow functionality
// from the Mission Validation page... it doesn't add much and is buggy...
// since we already have the attitude plot, its not necessary anyway." This
// view used to have a full chase-camera mechanism (FollowCamera, mirroring
// OptimizeTrajectoryView's proven pattern) toggled by a `follow` prop --
// removed entirely, NOT just disabled, per the explicit "not from phase 01"
// scoping (OptimizeTrajectoryView keeps its own Follow untouched). What's
// left is exactly what Overview mode already was: free OrbitControls,
// click-to-focus on a body, double-click-empty-space to reset framing --
// the whole camera is now always in that one mode, all the time.
//
// Review finding F1: this used to be a bespoke SceneCamera
// component reimplementing Phase 01's free-camera mode from scratch, with
// its own drifted minDistance/maxDistance formulas, no useClickNotDrag
// protection, and a plain onDoubleClick (which can fight PlanetBody's own
// click-to-focus on the same double-click). Replaced with the real shared
// `FreeCameraControls` (components/scene/FreeCameraControls.tsx), built from
// the exact same primitives (CAMERA_FLY_DURATION_S/FOLLOW_CAMERA_OFFSET_DIR/
// smoothstep) OptimizeTrajectoryView's own camera already uses, so the two
// views' free-camera behavior can't drift apart again the way two
// independent reimplementations already had.

// Body-specific apsis names (
// perihelion for sun, perilune for moon... but only if you guarantee it's
// always correct"): the frame body name comes verbatim from the /api/bodies
// catalog, so an exact-name match is guaranteed; everything else gets the
// universally-correct generic pair rather than an obscure body-specific
// coinage.
function apsisNames(body: string | null | undefined): { pe: string; ap: string } {
  switch (body) {
    case "Earth":
      return { pe: "perigee", ap: "apogee" }
    case "Moon":
      return { pe: "perilune", ap: "apolune" }
    case "Sun":
      return { pe: "perihelion", ap: "aphelion" }
    default:
      return { pe: "periapsis", ap: "apoapsis" }
  }
}

function findTickAt(steps: CruiseStepMsg[], playheadS: number): CruiseStepMsg | null {
  if (steps.length === 0) return null
  let lo = 0
  let hi = steps.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (steps[mid].t_s < playheadS) lo = mid + 1
    else hi = mid
  }
  return steps[lo]
}

export function CruiseReplayView({
  steps,
  playheadS,
  busDimsM,
  hardware,
  departureBodyName,
  targetBodyName,
  departureTrack,
  targetTrack,
  referenceArc,
  referencePreCount = 0,
  referencePostCount = 0,
  burnMarkers,
  cameraDirRef,
  compact = false,
  tick: tickOverride,
}: {
  steps: CruiseStepMsg[]
  playheadS: number
  // Optional display tick (interpolated between reported samples by the
  // page, lib/cruiseInterp.ts) -- when absent, the nearest reported sample.
  tick?: CruiseStepMsg | null
  busDimsM: number[]
  hardware: HardwareItem[]
  // Real gap found (: "surroundings look terrible, no
  // planets") -- this view only ever rendered a plain marker dot for the
  // Sun plus a bare grid, no real Earth/Mercury/etc. for context, unlike
  // every other trajectory view in the app.
  departureBodyName?: string | null
  targetBodyName?: string | null
  // Real ephemeris, not a decorative approximation ("use the
  // correct ephemerese of the planets") -- multi-sample real tracks fetched
  // once per run (fetchBodyTrack, the SAME data cruise_seed.body_tracks is
  // built from), rendered via BodyFromTrack's real interpolation instead of
  // PerturberBodyFromState's one-state-plus-circular-approximation.
  departureTrack?: BodyTrackConfig | null
  targetTrack?: BodyTrackConfig | null
  // Real confusion found (
  // hell is that? Is that estimated trajectory or real one?") -- there was
  // only ever ONE unlabeled line, the actually-simulated arc (from `steps`,
  // real dynamics + real control), with no visual distinction from the
  // Phase 01 planned/reference trajectory it's meant to be flying against
  // (dr_m in Fig. 3 is exactly the gap between these two, but that gap was
  // never drawn anywhere). This is the real Phase-01 adopted arc, rendered
  // as a second, distinct line so the divergence Fig. 3 reports is visible
  // directly in 3D too.
  // t_s is on the SAME rebased mission clock as playheadS/steps/the body
  // tracks (the page rebases before passing) -- required for the
  // parking/capture re-anchoring below.
  referenceArc?: { x_m: number; y_m: number; z_m: number; t_s: number }[]
  // Leading/trailing point counts of referenceArc that are the parking /
  // capture orbit segments (0 = segment absent).
  referencePreCount?: number
  referencePostCount?: number
  // Burn location markers on the reference line, same BurnMarker visual
  // Phase 01 uses (direct user ask: "I also miss the burn
  // location marker that we have in phase 01"). Positions/ΔVs computed by
  // CruiseReplayPage from the adopted trajectory's own planned burns.
  burnMarkers?: { label: string; dvMs: number; x_m: number; y_m: number; z_m: number; t_s: number }[]
  // Real gap: AttitudePip needs to know which direction THIS
  // view's camera is looking from, to mirror it ("ensure that this small
  // plot uses the same axes and view angle as the Trajectory plot"). One
  // ref, created once by the shared parent (CruiseReplayPage), passed to
  // both this view and AttitudePip -- a plain mutable ref rather than React
  // state since it updates every frame and neither consumer needs a
  // re-render from it, just to read the latest value in their own
  // useFrame.
  cameraDirRef: React.RefObject<THREE.Vector3>
  // True when mounted as the small corner thumbnail (pip swapped): the
  // legend is suppressed there -- at 270x210 px it overlapped the burn
  // labels and the planets (screenshot).
  compact?: boolean
}) {
  const { data: bodiesData } = useBodies()
  const departureBody = bodiesData?.bodies.find((b) => b.name === departureBodyName)
  const targetBody = bodiesData?.bodies.find((b) => b.name === targetBodyName)
  const sunBody = bodiesData?.bodies.find((b) => b.name === "Sun")
  const nearestTick = useMemo(() => findTickAt(steps, playheadS), [steps, playheadS])
  const tick = tickOverride !== undefined ? tickOverride : nearestTick

  // NOTE: computed AFTER the frame machinery below defines toFrame -- see
  // vehiclePosFramed near the render for the actual value used.

  // ── Reference frames ─────────
  // The riding-ring/segment transformation this block used to hold is GONE
  // (
  // artificial orbit... the orbit we show here only exists in the mars
  // inertial frame; in heliocentric we would get this wobbly movement").
  // Instead the whole scene renders in ONE of two honest frames:
  //  - "helio": raw heliocentric coordinates for everything. The parking/
  //    capture portions of the reference and trail show as the small
  //    wobbles they really are in this frame -- honest, no synthesis.
  //  - a BODY-CENTERED INERTIAL frame (departure or target body): every
  //    time-parameterized point p(t) renders as p(t) − body(t) (Hermite on
  //    the same fetched track the body itself renders from), the body sits
  //    at the origin, and orbits/hyperbolic approaches appear as their
  //    true shapes. This is where insertion geometry is actually legible
  //    (the arrival velocity RELATIVE to the body is near-opposite to the
  //    heliocentric one -- measured cos = −0.995 for the Mars example --
  //    which is exactly why the flown orbit looked "backwards" in helio).
  // The frame auto-follows the dominant body (within FRAME_SWITCH_M of a
  // tracked body → that body's frame), with manual override chips. On a
  // switch the camera flies to the new frame's origin; local geometry
  // around the body is identical in both frames at the switch instant, so
  // the hand-off reads as a camera move, not a scene jump.
  const hasTrack = (t: typeof departureTrack): t is NonNullable<typeof departureTrack> & { track: NonNullable<NonNullable<typeof departureTrack>["track"]> } =>
    !!t?.track && t.track.length >= 2
  const refPts = useMemo(() => referenceArc ?? [], [referenceArc])
  // Mission-clock end of the parking coast / start of the captured orbit --
  // still used for the PRE-RUN auto frame (no tick to measure distances
  // from yet; the pre-run playhead parks at the injection epoch).
  const preEndS = referencePreCount > 0 && refPts.length > 0 ? refPts[Math.min(referencePreCount, refPts.length) - 1].t_s : null

  // Display threshold, not physics: within ~1.5M km (≈ SOI scale for
  // Earth/Mars) of a tracked body, that body's inertial frame is the view
  // a person expects.
  const FRAME_SWITCH_M = 1.5e9
  const [frameOverride, setFrameOverride] = useState<"auto" | "helio" | "departure" | "target">("auto")
  const autoFrame: "helio" | "departure" | "target" = useMemo(() => {
    if (tick) {
      const dist = (t: typeof departureTrack) => {
        if (!hasTrack(t)) return Infinity
        const b = trackPositionAt(t, tick.t_s)
        return Math.hypot(tick.r_m[0] - b[0], tick.r_m[1] - b[1], tick.r_m[2] - b[2])
      }
      const dDep = dist(departureTrack)
      const dTgt = targetBodyName !== departureBodyName ? dist(targetTrack) : Infinity
      if (dDep < FRAME_SWITCH_M && dDep <= dTgt) return "departure"
      if (dTgt < FRAME_SWITCH_M) return "target"
      return "helio"
    }
    // Pre-run: the playhead parks at the injection epoch -- start the scene
    // in the departure body's frame so the parking orbit reads as an orbit.
    if (preEndS != null && playheadS <= preEndS + 3600 && hasTrack(departureTrack)) return "departure"
    return "helio"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, departureTrack, targetTrack, departureBodyName, targetBodyName, preEndS, playheadS])
  const frame = frameOverride === "auto" ? autoFrame : frameOverride
  const frameTrack =
    frame === "departure" && hasTrack(departureTrack)
      ? departureTrack
      : frame === "target" && hasTrack(targetTrack)
        ? targetTrack
        : null
  const frameBodyName = frame === "departure" ? departureBodyName : frame === "target" ? targetBodyName : null
  // Where the frame body currently sits in HELIO scene coordinates -- the
  // whole helio-coded part of the scene (Sun, bodies, grid) is shifted by
  // the negative of this, which puts the frame body at the origin.
  const worldShift = useMemo(
    () => (frameTrack ? sceneVecFromMeters(...trackPositionAt(frameTrack, playheadS)).negate() : new THREE.Vector3()),
    [frameTrack, playheadS],
  )
  const toFrame = (xM: number, yM: number, zM: number, tS: number): THREE.Vector3 => {
    const v = sceneVecFromMeters(xM, yM, zM)
    return frameTrack ? v.sub(sceneVecFromMeters(...trackPositionAt(frameTrack, tS))) : v
  }

  // In a body frame only the LOCAL content is drawn (user
  // correction of the first cut: re-expressing the WHOLE mission as
  // p(t) − body(t) mixes epochs -- each point in a different snapshot of a
  // moving frame -- and "just warps the trajectory a bit... intuitively
  // doesn't tell us much"). A planet-centered INERTIAL plot only means
  // something for the segment flown near that planet, where the relative
  // curve genuinely is the parking orbit / escape / approach hyperbola /
  // capture orbit. So: keep points within R_LOCAL of the frame body (one
  // contiguous time window near each body by construction), drop the rest.
  const R_LOCAL_SCENE = FRAME_SWITCH_M * SCENE_SCALE
  const referenceLine = useMemo(() => {
    if (!frameTrack) return refPts.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m))
    const pts: THREE.Vector3[] = []
    for (const p of refPts) {
      const v = toFrame(p.x_m, p.y_m, p.z_m, p.t_s)
      if (v.length() < R_LOCAL_SCENE) pts.push(v)
    }
    return pts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refPts, frameTrack])
  // PRE-BURN COAST SMOOTHING (
  // smooth in this pre-burn part... it's artificial anyway, why not the
  // same as the reference?"): the report stride is sized for the WHOLE
  // mission (~1 sample per several hours), but the parking orbit's period
  // is ~1.5 h -- the truth is reported roughly once per 3-4 ORBITS there,
  // so lerping between samples renders the smooth coast as a jagged
  // polygon. Before the first burn nothing has fired and the streamed
  // dispersion is metres (measured: dr 0.5 m @ 79 min), so the display
  // uses the densely-sampled REFERENCE (~50 s spacing) for the vehicle and
  // trail during the coast -- guarded by the real dr_m so any run that
  // genuinely deviates falls back to the true samples. Display-only; every
  // figure/number still reads the real telemetry.
  const COAST_SUBSTITUTE_MAX_DR_M = 1e5
  const coastFromReference =
    preEndS != null && refPts.length > 1 && tick != null && tick.t_s <= preEndS && (tick.dr_m ?? Infinity) < COAST_SUBSTITUTE_MAX_DR_M
  const refPosAt = (tS: number): THREE.Vector3 | null => {
    if (refPts.length < 2 || tS < refPts[0].t_s) return null
    let lo = 0
    let hi = refPts.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (refPts[mid].t_s < tS) lo = mid + 1
      else hi = mid
    }
    const b = refPts[lo]
    const a = refPts[Math.max(0, lo - 1)]
    const dt = b.t_s - a.t_s
    const f = dt > 0 ? Math.min(1, Math.max(0, (tS - a.t_s) / dt)) : 0
    return toFrame(a.x_m + (b.x_m - a.x_m) * f, a.y_m + (b.y_m - a.y_m) * f, a.z_m + (b.z_m - a.z_m) * f, tS)
  }

  // Flown trail: HISTORY only (clipped to the playhead -- "nothing shows
  // before it happens"), ending exactly at the vehicle's
  // interpolated position so the marker always rides its own trail; in a
  // body frame additionally clipped to the local zone like the reference.
  const arcLine = useMemo(() => {
    const pts: THREE.Vector3[] = []
    // Coast portion from the dense reference (see the smoothing note above).
    if (coastFromReference && preEndS != null) {
      for (const p of refPts) {
        if (p.t_s > Math.min(playheadS, preEndS)) break
        const v = toFrame(p.x_m, p.y_m, p.z_m, p.t_s)
        if (!frameTrack || v.length() < R_LOCAL_SCENE) pts.push(v)
      }
    }
    for (let i = 0; i < steps.length; i++) {
      if (i % 2 !== 0) continue
      const s = steps[i]
      if (s.t_s > playheadS) break
      if (coastFromReference && preEndS != null && s.t_s <= preEndS) continue
      const v = toFrame(s.r_m[0], s.r_m[1], s.r_m[2], s.t_s)
      if (!frameTrack || v.length() < R_LOCAL_SCENE) pts.push(v)
    }
    if (tick && pts.length > 0) {
      const v = coastFromReference ? (refPosAt(tick.t_s) ?? toFrame(tick.r_m[0], tick.r_m[1], tick.r_m[2], tick.t_s)) : toFrame(tick.r_m[0], tick.r_m[1], tick.r_m[2], tick.t_s)
      if (!frameTrack || v.length() < R_LOCAL_SCENE * 1.5) pts.push(v)
    }
    return pts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, playheadS, tick, frameTrack, coastFromReference, preEndS, refPts])

  const vehiclePos = useMemo(() => {
    if (!tick) return new THREE.Vector3()
    if (coastFromReference) {
      const p = refPosAt(playheadS)
      if (p) return p
    }
    return toFrame(tick.r_m[0], tick.r_m[1], tick.r_m[2], tick.t_s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, frameTrack, coastFromReference, playheadS])

  // ── PCI-view overlays (
  // looks") — periapsis/apoapsis markers on the local reference orbit, a
  // live altitude/relative-speed readout at the s/c, the frame-boundary
  // circle, the body's equatorial plane + pole axis, and the subsolar
  // point. Display-only geometry from data already in this view; body-frame
  // mode only.
  const frameBodyRadiusM =
    frame === "departure" ? (departureBody?.radius_m ?? null) : frame === "target" ? (targetBody?.radius_m ?? null) : null
  const frameBodyRadiusUnits = frameBodyRadiusM != null ? frameBodyRadiusM * SCENE_SCALE : null
  // #1 Pe/Ap: extreme-radius points of the ORBIT SEGMENT only (the parking
  // orbit in the departure frame, the capture orbit in the target frame --
  // the pre/post point counts the page already passes). The first cut
  // searched the whole local reference, so in the target frame the
  // approach hyperbola's boundary exit became the "max radius" point and
  // the true capture-orbit apoapsis was suppressed with it (user,
  // "I'm still missing the apogee for the final orbit").
  // Searching the bounded orbit segment needs no suppression heuristic.
  const peApMarkers = useMemo(() => {
    const seg =
      frame === "departure" && referencePreCount > 0
        ? refPts.slice(0, Math.min(referencePreCount, refPts.length))
        : frame === "target" && referencePostCount > 0
          ? refPts.slice(Math.max(0, refPts.length - referencePostCount))
          : []
    if (!frameTrack || seg.length < 8) return null
    let pe: THREE.Vector3 | null = null
    let ap: THREE.Vector3 | null = null
    for (const p of seg) {
      const v = toFrame(p.x_m, p.y_m, p.z_m, p.t_s)
      if (!pe || v.length() < pe.length()) pe = v
      if (!ap || v.length() > ap.length()) ap = v
    }
    if (!pe || !ap) return null
    return { pe, ap }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameTrack, frame, refPts, referencePreCount, referencePostCount])
  const altKmOf = (lenSceneUnits: number) =>
    frameBodyRadiusM != null ? (lenSceneUnits / SCENE_SCALE - frameBodyRadiusM) / 1e3 : lenSceneUnits / SCENE_SCALE / 1e3
  // (The separate frame-boundary circle + label were removed on
  // — the ecliptic ring set below now extends to and past that
  // radius, making a second circle redundant.)
  // #4 pole axis + equatorial ring, from the body's real IAU pole (RA/Dec,
  // equatorial J2000 — sceneVecFromMeters applies the same obliquity
  // leveling the rest of the scene uses).
  const poleDir = useMemo(() => {
    if (!frameTrack) return null
    const ra = frame === "departure" ? departureBody?.pole_ra_deg : targetBody?.pole_ra_deg
    const dec = frame === "departure" ? departureBody?.pole_dec_deg : targetBody?.pole_dec_deg
    if (ra == null || dec == null) return null
    const r = (ra * Math.PI) / 180
    const d = (dec * Math.PI) / 180
    return sceneVecFromMeters(Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)).normalize()
  }, [frameTrack, frame, departureBody, targetBody])
  // Local ECLIPTIC-plane grid (
  // ring... add the ecliptic plane back", then "make it a bit larger,
  // clearly highlight it's the ecliptic, make it more obvious"): rings at
  // 0.5M-km steps out to 2M km (past the frame-switch radius) plus four
  // spokes, same leveled z=0 plane and grid color the heliocentric view
  // uses, with an explicit "ecliptic" label on the outer ring. The pole
  // axis line stays -- only the body-equator ring was removed.
  const ECLIPTIC_GRID_OUTER = 2.0 // scene units = 2M km
  const eclipticLocalRings = useMemo(() => {
    if (!frameTrack) return null
    return [0.5, 1.0, 1.5, 2.0].map((r) => ringPositions(new THREE.Vector3(0, 0, 0), r, 96))
     
  }, [frameTrack])
  const eclipticSpokes = useMemo(() => {
    if (!frameTrack) return null
    return [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4].map((th) => [
      new THREE.Vector3(Math.cos(th) * ECLIPTIC_GRID_OUTER, Math.sin(th) * ECLIPTIC_GRID_OUTER, 0),
      new THREE.Vector3(-Math.cos(th) * ECLIPTIC_GRID_OUTER, -Math.sin(th) * ECLIPTIC_GRID_OUTER, 0),
    ])
     
  }, [frameTrack])
  // Real SOI: r_SOI =
  // a·(mu_body/mu_Sun)^(2/5), every input from /api/bodies — no hardcoded
  // physics. Earth ~0.92M km, Mars ~0.58M km, both inside the 1.5M km
  // frame boundary.
  const soiRadiusUnits = useMemo(() => {
    const body = frame === "departure" ? departureBody : frame === "target" ? targetBody : null
    const muSun = sunBody?.mu_m3s2
    if (!frameTrack || !body || body.sma_m == null || muSun == null || !body.mu_m3s2) return null
    return body.sma_m * Math.pow(body.mu_m3s2 / muSun, 0.4) * SCENE_SCALE
  }, [frameTrack, frame, departureBody, targetBody, sunBody])
  const soiCirclePts = useMemo(
    () => (soiRadiusUnits != null ? ringPositions(new THREE.Vector3(0, 0, 0), soiRadiusUnits, 128) : null),
    [soiRadiusUnits],
  )
  // #5 subsolar point — the Sun sits at worldShift in this frame, so the
  // subsolar point is the surface point toward it.
  const subsolarPos = useMemo(() => {
    if (!frameTrack || frameBodyRadiusUnits == null || worldShift.lengthSq() < 1e-12) return null
    return worldShift.clone().normalize().multiplyScalar(frameBodyRadiusUnits * 1.02)
  }, [frameTrack, frameBodyRadiusUnits, worldShift])
  // #2 live altitude + body-relative speed at the vehicle (speed by finite
  // difference of the RELATIVE position across the two reported samples
  // bracketing the playhead — the honest client-side estimate).
  const relReadout = useMemo(() => {
    if (!frameTrack || !tick || frameBodyRadiusUnits == null) return null
    const altKm = altKmOf(vehiclePos.length())
    let speedKms: number | null = null
    if (steps.length >= 2) {
      let lo = 0
      let hi = steps.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (steps[mid].t_s < tick.t_s) lo = mid + 1
        else hi = mid
      }
      const b = steps[Math.min(steps.length - 1, Math.max(1, lo))]
      const a = steps[Math.min(steps.length - 1, Math.max(1, lo)) - 1]
      const dt = b.t_s - a.t_s
      if (dt > 0) {
        const ba = trackPositionAt(frameTrack, a.t_s)
        const bb = trackPositionAt(frameTrack, b.t_s)
        const dx = b.r_m[0] - bb[0] - (a.r_m[0] - ba[0])
        const dy = b.r_m[1] - bb[1] - (a.r_m[1] - ba[1])
        const dz = b.r_m[2] - bb[2] - (a.r_m[2] - ba[2])
        speedKms = Math.hypot(dx, dy, dz) / dt / 1e3
      }
    }
    return `h ${Math.round(altKm).toLocaleString()} km${speedKms != null ? ` · ${speedKms.toFixed(2)} km/s` : ""}`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameTrack, tick, vehiclePos, frameBodyRadiusUnits, steps])

  // Smooth frame hand-off: when the active frame changes, fly the camera to
  // the new frame's origin (the body, or the Sun for helio). Everything
  // near that body has identical relative geometry in both frames at the
  // switch instant, so the transition reads as a deliberate camera move,
  // not a scene jump. Skipped on first mount (no jarring fly-in on load).
  const prevFrameRef = useRef<string | null>(null)
  const frameBodyRadiusScene =
    (frame === "departure" ? departureBody?.radius_m : frame === "target" ? targetBody?.radius_m : null) ?? null
  useEffect(() => {
    if (prevFrameRef.current == null) {
      prevFrameRef.current = frame
      return
    }
    if (prevFrameRef.current === frame) return
    prevFrameRef.current = frame
    if (frame === "helio") setResetTrigger((k) => k + 1)
    else handleFocus(new THREE.Vector3(0, 0, 0), frameBodyRadiusScene != null ? frameBodyRadiusScene * SCENE_SCALE * 30 : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame])

  const sunPos = useMemo(() => new THREE.Vector3(0, 0, 0), [])

  // Real bug found (
  // departure orbit was plotted" -- STILL happening after the earlier
  // mission-span-scaled-floor fix, because this is a SEPARATE bug in the
  // same neighborhood). `busDimsM` is real METERS (VehicleMesh needs it
  // raw -- see its own header comment), but `busDist` here was used
  // DIRECTLY as a scene-space distance, mixed with `bodyRadiusScene`
  // (already SCENE_SCALE'd) in `near`/`fitAllDistance`/the old
  // `minCameraDistance`. For a real ~2 m bus, `busDist` (~3.46, raw
  // meters) is ~600x LARGER than it should be as a scene distance
  // (bodyRadiusScene for Earth is ~6.4e-3) -- so `busDist * 0.5` silently
  // dominated the old minDistance formula's `Math.max`, setting the real
  // OrbitControls floor at ~1.73 SCENE units (~1.73e9 m, ~270 Earth radii)
  // instead of anything body-scale. `busDistScene` is the real fix: every
  // formula below that treats a distance as SCENE-space now uses this,
  // not the raw-meter `busDist` (kept only for VehicleMesh's own prop,
  // which needs real meters).
  const busDist = Math.max(...busDimsM, 0.2) * Math.sqrt(3)
  const busDistScene = busDist * SCENE_SCALE

  // F1: double-click-empty-space reset, now via onPointerMissed (Canvas
  // prop, below) instead of a plain onDoubleClick on the wrapping div --
  // matches OptimizeTrajectoryView's own mechanism exactly (a manual
  // double-click timer gated on a MISSED raycast), so double-clicking a
  // body always reads as click-to-focus (PlanetBody's own onClick, already
  // useClickNotDrag-protected) and never also fights a reset from the same
  // gesture the way the old plain onDoubleClick sometimes could.
  const lastMissedClickRef = useRef(0)
  const [resetTrigger, setResetTrigger] = useState(0)

  // Real gap found (
  // from Phase 01) -- Phase 01's bodies are click-to-focus; this view's
  // Sun/departure/target bodies never had onFocus wired at all. Always
  // active now (used to be gated to Overview-only, back when Follow also
  // existed as a mode).
  const focusVersionRef = useRef(0)
  const [focusRequest, setFocusRequest] = useState<{ pos: THREE.Vector3; version: number; radiusScene?: number } | undefined>(
    undefined,
  )
  function handleFocus(pos: THREE.Vector3, radiusScene?: number) {
    focusVersionRef.current += 1
    setFocusRequest({ pos: pos.clone(), version: focusVersionRef.current, radiusScene })
  }

  // Real bug found (screenshot: "the s/c is inside the
  // sun" -- before a run starts, `tick` is null, so vehiclePos defaulted to
  // the origin, exactly where the Sun sits). Framing distance no longer
  // depends on the vehicle's own tiny scale at all (Follow's busDist-scaled
  // initial camera position is gone with it) -- always a real solar-system-
  // scale distance, sensible whether or not a run has happened yet.
  const fitAllDistance = useMemo(() => {
    // Body frame: frame the LOCAL scene (planet + local orbit/arc), not the
    // solar system -- "fit all" and the double-click reset then behave like
    // a simple planet-centered plot.
    if (frameTrack) {
      let maxR = Math.max(busDistScene * 20, (frameBodyRadiusScene ?? 0.004) * 12, 0.02)
      for (const p of arcLine) maxR = Math.max(maxR, p.length())
      for (const p of referenceLine) maxR = Math.max(maxR, p.length())
      return Math.min(maxR, R_LOCAL_SCENE) * 1.6
    }
    let maxR = Math.max(busDistScene * 20, 220)
    for (const p of arcLine) maxR = Math.max(maxR, p.length())
    for (const p of referenceLine) maxR = Math.max(maxR, p.length())
    return maxR * 1.3
  }, [arcLine, referenceLine, busDistScene, frameTrack, frameBodyRadiusScene, R_LOCAL_SCENE])

  // Real body/vehicle-scale close-up distance, NOT scaled off the whole
  // mission span (fitAllDistance) -- see the fix this preserves
  // (a mission-span-scaled floor put the zoom-in limit FARTHER out than a
  // body's own click-to-focus distance) AND the busDistScene fix just above
  // (a units bug re-introduced the same symptom via a different formula).
  // `FreeCameraControls` derives its actual OrbitControls minDistance as
  // `closeDist * 0.15` (Phase 01's own formula) -- `actualMinDistance` here
  // is that real floor, computed once so `near` (below) can be sized off
  // the SAME value instead of guessing independently.
  const actualMinDistance = useMemo(() => {
    const bodyRadiusScene = Math.min(
      (departureBody?.radius_m ?? 6_378_137) * SCENE_SCALE,
      (targetBody?.radius_m ?? 3_396_200) * SCENE_SCALE,
    )
    return Math.max(bodyRadiusScene * 1.5, busDistScene * 0.5, 1e-4)
  }, [departureBody, targetBody, busDistScene])
  const closeCameraDist = actualMinDistance / 0.15

  return (
    <div className="relative h-full w-full">
    <Canvas
      // Pixel budget (profile): cap at 1.5x device pixels; the
      // corner-thumbnail mount renders at 1x.
      dpr={compact ? 1 : [1, 1.5]}
      camera={{
        position: [fitAllDistance, fitAllDistance * 0.7, fitAllDistance],
        fov: 45,
        // Same busDist-units bug as actualMinDistance above -- sized off
        // the real (now scene-scaled) closest-approach distance instead of
        // the raw-meter busDist, which used to sit ~600x too far out for a
        // real vehicle scale and (harmlessly, since minDistance already
        // dominated) would have clipped nothing useful anyway.
        near: Math.max(actualMinDistance * 0.05, 1e-7),
        far: 20000,
      }}
      onPointerMissed={() => {
        const now = performance.now()
        if (now - lastMissedClickRef.current < 350) setResetTrigger((k) => k + 1)
        lastMissedClickRef.current = now
      }}
    >
      <PauseWhenHidden tool="cruise" />
      <color attach="background" args={["#04060c"]} />
      <ambientLight intensity={0.15} />

      {frameTrack ? (
        /* PLANET-CENTERED INERTIAL plot: a
           deliberately SIMPLE scene -- the frame body at the origin (real
           texture/spin/pole), the local orbit/arc lines, the vehicle, and
           the real Sun far away in its true direction (worldShift =
           −body(now)) for orientation and correct lighting. No solar-system
           grid, no other bodies, no far-field trajectory -- that content
           only means something in the heliocentric frame. */
        <>
          <pointLight position={worldShift} intensity={5} distance={0} decay={0} color="#fff4e0" />
          <PlanetBody
            name="Sun"
            position={worldShift}
            radiusM={6.957e8}
            spinRateRadS={sunBody?.spin_rate_rads}
            color="#FFD700"
            emissive
            sizeExaggeration={SUN_SIZE_EXAGGERATION}
            hitSphereMaxRadius={HIT_SPHERE_MAX_RADIUS_SUN}
          />
          <PlanetBody
            name={frameBodyName ?? ""}
            position={sunPos /* origin vector reused -- (0,0,0) */}
            color={frame === "departure" ? "#6b93d6" : "#c1633f"}
            radiusM={(frame === "departure" ? departureBody?.radius_m : targetBody?.radius_m) ?? 3_396_200}
            spinRateRadS={frame === "departure" ? departureBody?.spin_rate_rads : targetBody?.spin_rate_rads}
            poleRaDeg={frame === "departure" ? departureBody?.pole_ra_deg : targetBody?.pole_ra_deg}
            poleDecDeg={frame === "departure" ? departureBody?.pole_dec_deg : targetBody?.pole_dec_deg}
            hoverEnlarge={false}
            onFocus={handleFocus}
          />
          {/* Real SOI, lightly: a barely-there shell + a faint ecliptic
              circle at the true r_SOI, labeled */}
          {soiRadiusUnits != null && (
            <>
              <mesh>
                <sphereGeometry args={[soiRadiusUnits, 32, 24]} />
                <meshBasicMaterial color="#5b7fd6" transparent opacity={0.04} depthWrite={false} side={THREE.BackSide} />
              </mesh>
              {soiCirclePts && <Line points={soiCirclePts} color="#5b7fd6" transparent opacity={0.22} lineWidth={1} />}
              {!compact && (
                <group position={[soiRadiusUnits * 0.71, -soiRadiusUnits * 0.71, 0]}>
                  <Html center style={{ pointerEvents: "none" }}>
                    <div style={{ color: "rgba(150,170,220,0.55)", fontSize: 10, whiteSpace: "nowrap" }}>
                      SOI · {Math.round(soiRadiusUnits / SCENE_SCALE / 1e3).toLocaleString()} km
                    </div>
                  </Html>
                </group>
              )}
            </>
          )}
          {/* #4 — local ecliptic-plane grid (rings + spokes, labeled) + pole axis */}
          {eclipticLocalRings?.map((pts, i) => (
            <Line key={i} points={pts} color={GRID_COLOR} transparent opacity={0.28} lineWidth={1} />
          ))}
          {eclipticSpokes?.map((pts, i) => (
            <Line key={`s${i}`} points={pts} color={GRID_COLOR} transparent opacity={0.16} lineWidth={1} />
          ))}
          {eclipticLocalRings && !compact && (
            <group position={[ECLIPTIC_GRID_OUTER * 0.74, ECLIPTIC_GRID_OUTER * 0.74, 0]}>
              <Html center style={{ pointerEvents: "none" }}>
                <div style={{ color: GRID_COLOR, opacity: 0.75, fontSize: 10, whiteSpace: "nowrap", fontStyle: "italic" }}>
                  ecliptic plane
                </div>
              </Html>
            </group>
          )}
          {poleDir && frameBodyRadiusUnits != null && (
            <Line
              points={[poleDir.clone().multiplyScalar(-frameBodyRadiusUnits * 2), poleDir.clone().multiplyScalar(frameBodyRadiusUnits * 2)]}
              color="#8890b0"
              transparent
              opacity={0.35}
              lineWidth={1}
            />
          )}
          {/* #5 — subsolar point */}
          {subsolarPos && frameBodyRadiusUnits != null && (
            <mesh position={subsolarPos}>
              <sphereGeometry args={[frameBodyRadiusUnits * 0.05, 8, 8]} />
              <meshBasicMaterial color="#ffe9a8" />
            </mesh>
          )}
          {/* #1 — periapsis/apoapsis of the local planned orbit, labeled with
              real altitudes */}
          {peApMarkers &&
            frameBodyRadiusUnits != null &&
            [
              { p: peApMarkers.pe, tag: apsisNames(frameBodyName).pe },
              ...(peApMarkers.ap ? [{ p: peApMarkers.ap, tag: apsisNames(frameBodyName).ap }] : []),
            ].map(({ p, tag }) => (
              <group key={tag} position={p}>
                <mesh>
                  <sphereGeometry args={[frameBodyRadiusUnits * 0.07, 8, 8]} />
                  <meshBasicMaterial color="#5b7fd6" />
                </mesh>
                {!compact && (
                  <Html center style={{ pointerEvents: "none" }}>
                    <div style={{ color: "rgba(150,170,220,0.8)", fontSize: 10, whiteSpace: "nowrap", transform: "translateY(-14px)" }}>
                      {tag} {Math.round(altKmOf(p.length())).toLocaleString()} km
                    </div>
                  </Html>
                )}
              </group>
            ))}
        </>
      ) : (
        <>
          <pointLight position={sunPos} intensity={5} distance={0} decay={0} color="#fff4e0" />
          <PlanetBody
            name="Sun"
            position={sunPos}
            radiusM={6.957e8}
            spinRateRadS={sunBody?.spin_rate_rads}
            color="#FFD700"
            emissive
            sizeExaggeration={SUN_SIZE_EXAGGERATION}
            hitSphereMaxRadius={HIT_SPHERE_MAX_RADIUS_SUN}
            onFocus={handleFocus}
          />
          {/* `track` became optional backend-side (B2 server-resolved tracks,
); this view still renders client-fetched tracks only. */}
          {departureBodyName && departureTrack?.track && departureTrack.track.length > 0 && (
            <BodyFromTrack
              name={departureBodyName}
              track={departureTrack.track}
              elapsedS={playheadS}
              sunPosition={sunPos}
              radiusM={departureBody?.radius_m ?? 6_378_137}
              spinRateRadS={departureBody?.spin_rate_rads}
              poleRaDeg={departureBody?.pole_ra_deg}
              poleDecDeg={departureBody?.pole_dec_deg}
              onFocus={(pos) => handleFocus(pos)}
            />
          )}
          {targetBodyName && targetBodyName !== departureBodyName && targetTrack?.track && targetTrack.track.length > 0 && (
            <BodyFromTrack
              name={targetBodyName}
              track={targetTrack.track}
              elapsedS={playheadS}
              sunPosition={sunPos}
              radiusM={targetBody?.radius_m ?? 3_396_200}
              spinRateRadS={targetBody?.spin_rate_rads}
              poleRaDeg={targetBody?.pole_ra_deg}
              poleDecDeg={targetBody?.pole_dec_deg}
              onFocus={(pos) => handleFocus(pos)}
            />
          )}
          <EclipticGrid origin={sunPos} maxRadiusAU={2} />
        </>
      )}

      {/* Reference (dashed) and flown trail (solid), both expressed in the
          ACTIVE frame -- raw heliocentric coordinates in the Sun frame,
          true body-relative geometry in a body frame. No synthetic riding
 orbits anymore. */}
      {referenceLine.length > 1 && (
        <Line points={referenceLine} color="#5b7fd6" lineWidth={1.2} dashed dashSize={0.05} gapSize={0.03} transparent opacity={0.6} />
      )}
      {arcLine.length > 1 && <Line points={arcLine} color="#ffd54a" lineWidth={1.5} transparent opacity={0.8} />}

      {(burnMarkers ?? [])
        .map((b) => ({ b, pos: toFrame(b.x_m, b.y_m, b.z_m, b.t_s) }))
        // Body frame: only markers that belong to this planet's local zone.
        .filter(({ pos }) => !frameTrack || pos.length() < R_LOCAL_SCENE)
        .map(({ b, pos }) => (
          <BurnMarker key={b.label} position={pos} label={b.label} dvMs={b.dvMs} onFocus={(p) => handleFocus(p)} />
        ))}

      {/* Real bug found: rendered unconditionally at vehiclePos
          before, which defaults to the origin (same as the Sun) with no
          tick data yet -- "the s/c is inside the sun." Only render once a
          run has actually produced a real position. */}
      {/* showLabels=false: the per-cone Html
          labels ("star tracker boresight", "panel normal", etc.) all
          collapsed onto the same few screen pixels here -- the vehicle in
          this view is always the distance-exaggerated symbolic marker
          (true scale is sub-pixel at any reachable zoom), so cone tips can
          never separate legibly on screen. Identified by color via the
          corner legend below instead, same idiom AttitudePip established. */}
      {tick && (
        <group position={vehiclePos}>
          <VehicleMesh busDimsM={busDimsM} hardware={hardware} quaternion={tick.q} showLabels={false} />
          {/* Fixed-screen-size spacecraft marker (
              zoomed out, we can't see the s/c moving along the trajectory
              cause there's no marker") -- the VehicleMesh above is real
              vehicle scale, sub-pixel at any solar-system zoom, so this is
              the same always-on Html crosshair idiom Phase 01's
              SpacecraftModel uses (fixed pixel size at every zoom by
              Html's nature; filled dot + glow ring, its "moving" style).
              Suppressed in the corner-thumbnail mount to avoid clutter at
              270x210. */}
          {!compact && (
            <Html center style={{ pointerEvents: "none" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", pointerEvents: "none" }}>
                <svg width="20" height="20" viewBox="0 0 20 20" style={{ display: "block", pointerEvents: "none" }}>
                  <circle cx="10" cy="10" r="8" fill="none" stroke="#ffd54a" strokeWidth="1" opacity="0.35" />
                  <circle cx="10" cy="10" r="4" fill="#ffd54a" stroke="#ffffff" strokeWidth="0.75" opacity="0.95" />
                </svg>
                {/* #2 — live altitude + body-relative speed, body frame only */}
                {relReadout && (
                  <div style={{ marginTop: 2, color: "#ffd54a", fontSize: 10, whiteSpace: "nowrap", opacity: 0.85 }}>{relReadout}</div>
                )}
              </div>
            </Html>
          )}
        </group>
      )}

      <FreeCameraControls
        closeDist={closeCameraDist}
        wideDist={fitAllDistance}
        // Reset target: the frame's own origin -- the planet in a body
        // frame, the Sun in helio.
        focusPoint={sunPos}
        focusRequest={focusRequest}
        resetTrigger={resetTrigger}
        cameraDirRef={cameraDirRef}
      />
    </Canvas>
    {/* Reference-frame chips: the active frame auto-follows
        the dominant body; clicking a chip pins it, "auto" resumes
        following. Highlighted chip = the frame the scene is currently in. */}
    {!compact && (
      <div className="pointer-events-auto absolute top-2 right-2 flex items-center gap-1 text-[10px] font-semibold">
        <span className="mr-1 text-white/40 uppercase tracking-wider">frame</span>
        {(
          [
            { id: "helio" as const, label: "☉ Sun" },
            ...(departureBodyName ? [{ id: "departure" as const, label: departureBodyName }] : []),
            ...(targetBodyName && targetBodyName !== departureBodyName ? [{ id: "target" as const, label: targetBodyName }] : []),
          ]
        ).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setFrameOverride(frameOverride === c.id ? "auto" : c.id)}
            className={`rounded border px-1.5 py-0.5 ${
              frame === c.id ? "border-[#ffd54a] bg-[#ffd54a]/15 text-[#ffd54a]" : "border-white/20 text-white/50 hover:border-white/50"
            }`}
            title={
              frameOverride === "auto"
                ? "Frame follows the nearest body automatically — click to pin this frame"
                : frameOverride === c.id
                  ? "Pinned — click again to resume automatic frame"
                  : "Click to pin this frame"
            }
          >
            {c.label}
          </button>
        ))}
        {frameOverride === "auto" && <span className="ml-1 text-white/40">auto</span>}
      </div>
    )}
    {!compact && (
    <div className="pointer-events-none absolute top-2 left-2 flex flex-col gap-0.5 text-[10px] font-semibold">
      <span className="text-white/50">
        {frameBodyName ? `${frameBodyName}-centered inertial frame` : "heliocentric frame"}
      </span>
      <span className="flex items-center gap-1.5 text-[#ffd54a]">
        <i className="inline-block h-0.5 w-3" style={{ background: "#ffd54a" }} />
        actual (simulated)
      </span>
      {referenceLine.length > 1 && (
        <span className="flex items-center gap-1.5 text-[#5b7fd6]">
          <i className="inline-block h-0.5 w-3 border-t border-dashed border-[#5b7fd6]" />
          reference (Phase 01 plan)
        </span>
      )}
      {tick && <VehicleVectorLegendEntries hardware={hardware} />}
    </div>
    )}
    </div>
  )
}
