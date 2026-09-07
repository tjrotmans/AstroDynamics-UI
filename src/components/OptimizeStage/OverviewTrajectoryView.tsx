// Overview trajectory view - same Three.js engine as OptimizeTrajectoryView
// but static: OrbitControls live from start, bounding-box initial framing,
// no scripted fly-ins or spacecraft animation.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { PauseWhenHidden } from "@/components/scene/PauseWhenHidden"
import { Line, OrbitControls } from "@react-three/drei"
import * as THREE from "three"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"
import { ArrowUpDown, Expand } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useBodies, useBodyState } from "@/hooks/useApi"
import type { OptimizeApiResult } from "@/api/client"
import {
  SCENE_SCALE,
  CAMERA_FLY_DURATION_S,
  FOLLOW_CAMERA_OFFSET_DIR,
  FIT_ALL_DISTANCE_FACTOR,
  SUN_SIZE_EXAGGERATION,
  HIT_SPHERE_MAX_RADIUS_SUN,
  smoothstep,
  julianDateToUtcString,
  sampleArcPosition,
  sceneVecFromMeters,
  computeAltitudeLinePoints,
  ringPositions,
  bodyOrbitRingPoints,
  PlanetBody,
  BurnMarker,
  EclipticGrid,
  PerturberBodyFromState,
} from "@/components/scene/sceneShared"
import { deriveMgaSceneData } from "@/components/scene/mgaSceneData"

// Same purple used for MGA flyby markers in the cinematic view -- kept
// visually consistent across both views.
const FLYBY_COLOR = "#c084fc"
const LEG_COLORS = ["#00d4ff", "#34d399", "#f472b6", "#facc15", "#a78bfa", "#fb923c"]

// Close-up distance for a click-to-zoom focus request -- Overview has no
// per-body distances the way OptimizeTrajectoryView's cinematic camera does
// (no departure/arrival framing math here), so this is a flat fraction of
// the full-scene fit distance, close enough to clearly separate a body from
// its neighbors without needing to know its physical size.
const OVERVIEW_FOCUS_DISTANCE_FRACTION = 0.08
const OVERVIEW_MIN_FOCUS_DISTANCE = 3

function OverviewCamera({
  fitDist,
  fitAllTrigger,
  focusRequest,
  controlsRef,
}: {
  fitDist: number
  fitAllTrigger: number
  focusRequest?: { pos: THREE.Vector3; version: number }
  controlsRef: React.RefObject<OrbitControlsImpl | null>
}) {
  const { camera } = useThree()
  const initializedRef = useRef(false)
  const prevTriggerRef = useRef(fitAllTrigger)
  const flyElapsedRef = useRef(Infinity)
  const flyStartPosRef = useRef(new THREE.Vector3())
  const flyStartTargetRef = useRef(new THREE.Vector3())
  const prevFocusVersionRef = useRef<number | undefined>(undefined)
  const focusFlyElapsedRef = useRef(Infinity)
  const focusFlyStartPosRef = useRef(new THREE.Vector3())
  const focusFlyStartTargetRef = useRef(new THREE.Vector3())
  const SUN_POS = useMemo(() => new THREE.Vector3(0, 0, 0), [])

  useFrame((state, delta) => {
    if (!initializedRef.current) {
      initializedRef.current = true
      camera.position.copy(FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(fitDist))
      camera.up.set(0, 0, 1)
      camera.lookAt(0, 0, 0)
      if (controlsRef.current) { controlsRef.current.target.copy(SUN_POS); controlsRef.current.update() }
    }

    // Click-to-zoom fly-in, same idiom as OptimizeTrajectoryView's
    // CameraController (clicking a body/burn
    // marker should actually move the camera closer, not just re-center the
    // orbit pivot at the same distance).
    if (focusRequest && focusRequest.version !== prevFocusVersionRef.current) {
      prevFocusVersionRef.current = focusRequest.version
      focusFlyElapsedRef.current = 0
      focusFlyStartPosRef.current.copy(state.camera.position)
      focusFlyStartTargetRef.current.copy(controlsRef.current?.target ?? focusRequest.pos)
    }
    if (focusFlyElapsedRef.current < CAMERA_FLY_DURATION_S && focusRequest) {
      focusFlyElapsedRef.current += delta
      const t = smoothstep(0, CAMERA_FLY_DURATION_S, focusFlyElapsedRef.current)
      const closeDist = Math.max(fitDist * OVERVIEW_FOCUS_DISTANCE_FRACTION, OVERVIEW_MIN_FOCUS_DISTANCE)
      const closeup = focusRequest.pos.clone().add(FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(closeDist))
      state.camera.position.lerpVectors(focusFlyStartPosRef.current, closeup, t)
      state.camera.up.set(0, 0, 1)
      const tgt = focusFlyStartTargetRef.current.clone().lerp(focusRequest.pos, t)
      state.camera.lookAt(tgt)
      if (controlsRef.current) controlsRef.current.target.copy(tgt)
      return
    }

    if (fitAllTrigger !== prevTriggerRef.current) {
      prevTriggerRef.current = fitAllTrigger
      flyElapsedRef.current = 0
      flyStartPosRef.current.copy(state.camera.position)
      flyStartTargetRef.current.copy(controlsRef.current?.target ?? SUN_POS)
    }

    if (flyElapsedRef.current < CAMERA_FLY_DURATION_S) {
      flyElapsedRef.current += delta
      const t = smoothstep(0, CAMERA_FLY_DURATION_S, flyElapsedRef.current)
      state.camera.position.lerpVectors(flyStartPosRef.current, FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(fitDist), t)
      state.camera.up.set(0, 0, 1)
      const tgt = flyStartTargetRef.current.clone().lerp(SUN_POS, t)
      state.camera.lookAt(tgt)
      if (controlsRef.current) controlsRef.current.target.copy(tgt)
    }
  })
  return null
}

function OverviewSceneContents({
  result,
  departureBodyName,
  targetBodyName,
  forceModelBodies,
  captureRadiusM,
  fitAllTrigger,
  focusRequest,
  onRequestFocus,
  controlsRef,
  fitDist,
  onUncoveredBodies,
  showAltitudeLines,
}: {
  result: OptimizeApiResult
  departureBodyName: string
  targetBodyName: string
  forceModelBodies: string[]
  captureRadiusM?: number | null
  fitAllTrigger: number
  focusRequest?: { pos: THREE.Vector3; version: number }
  onRequestFocus: (pos: THREE.Vector3) => void
  controlsRef: React.RefObject<OrbitControlsImpl | null>
  fitDist: number
  onUncoveredBodies: (names: string[]) => void
  showAltitudeLines: boolean
}) {
  const { data: bodiesData } = useBodies()
  const departureBody = bodiesData?.bodies.find((b) => b.name === departureBodyName)
  const targetBody = bodiesData?.bodies.find((b) => b.name === targetBodyName)
  const sunBody = bodiesData?.bodies.find((b) => b.name === "Sun")

  const sunPos = useMemo(() => new THREE.Vector3(0, 0, 0), [])
  // Trimmed to the real achieved capture instant when one happened -- same
  // fix and reasoning as OptimizeTrajectoryView's own linePoints (
  // see that file's comment). result.arc spans the full max_coast_days
  // budget regardless of when the real encounter happens; drawing that whole
  // span as a continuous heliocentric line past a REAL capture misrepresents
  // a mission that's actually now in the bound orbit captureOrbitRingPoints
  // already draws separately.
  const trimmedArc = useMemo(() => {
    const capturedAtS = result.capture_time_s != null ? result.achieved_tof_days * 86_400 : null
    return capturedAtS != null ? result.arc.filter((p) => p.t_s <= capturedAtS) : result.arc
  }, [result.arc, result.capture_time_s, result.achieved_tof_days])
  // Appends the exact real crossing point when trimmed to a real capture --
  // same fix and reasoning as OptimizeTrajectoryView's own linePoints
  // (see that file's comment): the raw arc's last sample before
  // a fast encounter can land a real distance short of the true crossing
  // instant, which otherwise reads as the line meeting the capture ring at
  // a visible angle even though the ring's own plane is built from that
  // same crossing state and is tangent to it by construction.
  // Real bug found and fixed (buckle/"trajectory doesnt
  // stop at the orbit"... "only happens in the Overview not in Follow" --
  // the observation that finally localized it): this stitch point still
  // ADDED target_r_arr_m on top of capArc[0], the pre-Phase-12k
  // body-relative convention -- post_capture_orbit_arc has been
  // heliocentric on its own since so this was a double-add
  // flinging the line's final point roughly the target's own solar
  // distance away (the "buckle", reading as the trajectory continuing past
  // the planet). The IDENTICAL bug was fixed in OptimizeTrajectoryView's
  // linePoints earlier the same day; this second copy in Overview was
  // missed then -- exactly the drift risk duplicated stitching logic
  // carries.
  const linePoints = useMemo(() => {
    const scenePoints = trimmedArc.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m))
    const capArc = result.post_capture_orbit_arc
    if (result.capture_time_s != null && capArc && capArc.length > 0) {
      scenePoints.push(sceneVecFromMeters(capArc[0].x_m, capArc[0].y_m, capArc[0].z_m))
    }
    return scenePoints
  }, [trimmedArc, result.post_capture_orbit_arc, result.capture_time_s])

  // Same MGA per-leg/DSM/flyby derivation OptimizeTrajectoryView uses,
  // shared via deriveMgaSceneData (this view previously had no
  // MGA awareness at all -- one continuous arc line regardless of method,
  // no flyby markers, no DSM burns).
  const mga = useMemo(() => deriveMgaSceneData(result, linePoints), [result, linePoints])
  const { isMga, bodySequence, dsmDvs, dsmDisplayPositions, flybyPositions, flybyHighlightSegments, legSegments } = mga
  // Moved here from OptimizeTrajectoryView - see
  // computeAltitudeLinePoints's own comment (sceneShared.tsx) for why this
  // static, user-controlled view is a better home for it than the
  // cinematic Follow view's moving camera. Sampled over `trimmedArc`, not
  // the raw `result.arc` (fix
  // lines are only drawn for the part of the trajectory that's actually
  // shown") -- the raw arc still spans the full max_coast_days budget past
  // a real capture, same reason `linePoints` above is trimmed; drawing
  // altitude ticks over a stretch the line itself no longer renders left
  // ticks floating with nothing to anchor to.
  const altitudeLineFiltered = useMemo(() => computeAltitudeLinePoints(trimmedArc), [trimmedArc])
  const flybySequenceBodies = useMemo(() => (isMga ? bodySequence.slice(1, -1) : []), [isMga, bodySequence])

  // Filter out bodies with no ANISE ephemeris coverage - fetching their state 422s and React Query
  // retries the failing request on a timer, flooding the network tab. Also
  // exclude flyby-sequence bodies -- they get their own authoritative
  // arc-sampled marker below, same dedup rationale as OptimizeTrajectoryView.
  const perturberBodies = useMemo(
    () =>
      forceModelBodies.filter((n) => {
        if (n === departureBodyName || n === targetBodyName || n === "Sun") return false
        if (flybySequenceBodies.includes(n)) return false
        return bodiesData?.bodies.find((b) => b.name === n)?.anise_covered !== false
      }),
    [forceModelBodies, departureBodyName, targetBodyName, flybySequenceBodies, bodiesData],
  )
  const uncoveredPerturberBodies = useMemo(
    () =>
      forceModelBodies.filter((n) => {
        if (n === departureBodyName || n === targetBodyName || n === "Sun") return false
        if (flybySequenceBodies.includes(n)) return false
        return bodiesData?.bodies.find((b) => b.name === n)?.anise_covered === false
      }),
    [forceModelBodies, departureBodyName, targetBodyName, flybySequenceBodies, bodiesData],
  )

  useEffect(() => {
    onUncoveredBodies(uncoveredPerturberBodies)
  }, [uncoveredPerturberBodies, onUncoveredBodies])

  const arcStartPos = useMemo(() => linePoints[0] ?? new THREE.Vector3(), [linePoints])
  const targetPos = useMemo(
    () => sceneVecFromMeters(result.target_r_arr_m[0], result.target_r_arr_m[1], result.target_r_arr_m[2]),
    [result.target_r_arr_m],
  )

  const effectiveDepartureEpoch = useMemo(() => julianDateToUtcString(result.dep_jd), [result.dep_jd])
  const { data: departureBodyState } = useBodyState(departureBodyName, effectiveDepartureEpoch)
  const departurePos = useMemo(() => {
    if (departureBodyState)
      return sceneVecFromMeters(departureBodyState.x_m, departureBodyState.y_m, departureBodyState.z_m)
    return arcStartPos
  }, [departureBodyState, arcStartPos])

  // Real propagated orbit data over a circular approximation, when the
  // backend result has it (fix -- Overview never got this
  // upgrade when OptimizeTrajectoryView did, which is why the
  // capture ring here never lined up with where the trimmed trajectory line
  // now ends: it was always the plain circle, anchored/sized from the
  // sidebar's configured capture radius, not the real backend arc). Mirrors
  // OptimizeTrajectoryView's preDepartureOrbitPoints/postCaptureOrbitPoints
  // exactly.
  // Backend fix both fields are now
  // returned already in the SAME heliocentric frame `arc` uses -- the
  // body's real position is already added server-side. Do NOT re-add
  // departurePos/targetPos here (required before the fix, when these
  // fields were body-relative; doing it now would double-translate every
  // point).
  const preDepartureOrbitPoints = useMemo(() => {
    const src = result.pre_departure_orbit_arc
    if (!src || src.length === 0) return null
    return src.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m))
  }, [result.pre_departure_orbit_arc])
  const postCaptureOrbitPoints = useMemo(() => {
    const src = result.post_capture_orbit_arc
    if (!src || src.length === 0) return null
    return src.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m))
  }, [result.post_capture_orbit_arc])

  const captureOrbitRadiusScene = captureRadiusM != null ? captureRadiusM * SCENE_SCALE : null
  const captureOrbitRingPoints = useMemo(() => {
    if (postCaptureOrbitPoints) return postCaptureOrbitPoints
    return captureOrbitRadiusScene != null ? ringPositions(targetPos, captureOrbitRadiusScene, 64) : []
  }, [postCaptureOrbitPoints, targetPos, captureOrbitRadiusScene])
  const parkingOrbitRadiusScene = useMemo(
    () => departureBodyState ? arcStartPos.distanceTo(departurePos) : (departureBody?.radius_m ?? 6_378_137) * SCENE_SCALE * 1.05,
    [departureBodyState, arcStartPos, departurePos, departureBody],
  )
  const parkingOrbitRingPoints = useMemo(
    () => preDepartureOrbitPoints ?? ringPositions(departurePos, parkingOrbitRadiusScene, 64),
    [preDepartureOrbitPoints, departurePos, parkingOrbitRadiusScene],
  )

  const captureBurnPos = useMemo(
    () => (result.capture_time_s != null ? sampleArcPosition(result.arc, result.capture_time_s) : null),
    [result.arc, result.capture_time_s],
  )

  // Triggers OverviewCamera's close-up fly-in instead of just snapping the
  // orbit target -- "click to zoom in".
  const handleFocus = useCallback((pos: THREE.Vector3) => {
    onRequestFocus(pos)
  }, [onRequestFocus])

  useEffect(() => {
    if (controlsRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(controlsRef.current as any).zoomToCursor = true
    }
  })

  return (
    <>
      {/* Stars removed entirely, -- see OptimizeTrajectoryView.tsx's
          own removal comment for the full history (two prior real fixes,
          still reported broken by the user, who offered removal as the
          fallback). This view's own <Stars> was never even wrapped in the
          camera-recentering fix the cinematic view got -- a real gap on
          its own, moot now that both views drop it entirely. */}
      <ambientLight intensity={0.15} />
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
      <EclipticGrid origin={sunPos} />

      {/* alwaysShowLabel removed (UX review): these two were
          explicitly hover-only, which meant Overview's default (nothing
          hovered) framing never showed the departure/target body names at
          all -- the picture read as "burns floating in space" instead of a
          real planetary tour. Overview has no playback clock to gate labels
          on the way Follow mode does (see file header), so these should be
          unconditionally visible like everything else here. */}
      {/* Heliocentric orbit rings now passed as PlanetBody's own ringPoints
 prop instead of a separate un-hoverable `<Line>` (so that
          ring hovering works for every rendered body, not only planets
          included in the mission -- same fix as
          OptimizeTrajectoryView, and switched from the old circular
          ringPositions() approximation to the real bodyOrbitRingPoints()
          Kepler ellipse while at it, matching every other ring in this
          scene). */}
      <PlanetBody
        name={departureBodyName}
        position={departurePos}
        radiusM={departureBody?.radius_m ?? 6_378_137}
        spinRateRadS={departureBody?.spin_rate_rads}
        color="#f59e0b"
        poleRaDeg={departureBody?.pole_ra_deg}
        poleDecDeg={departureBody?.pole_dec_deg}
        ringPoints={bodyOrbitRingPoints(departureBodyName, sunPos, departurePos.distanceTo(sunPos), result.dep_jd)}
        onFocus={handleFocus}
      />
      <PlanetBody
        name={targetBodyName}
        position={targetPos}
        radiusM={targetBody?.radius_m ?? 3_396_200}
        spinRateRadS={targetBody?.spin_rate_rads}
        color="#f472b6"
        poleRaDeg={targetBody?.pole_ra_deg}
        poleDecDeg={targetBody?.pole_dec_deg}
        ringPoints={bodyOrbitRingPoints(targetBodyName, sunPos, targetPos.distanceTo(sunPos), result.dep_jd)}
        onFocus={handleFocus}
      />

      {perturberBodies.map((name) => {
        const body = bodiesData?.bodies.find((b) => b.name === name)
        return (
          <PerturberBodyFromState
            key={name}
            name={name}
            epoch={effectiveDepartureEpoch}
            sunPosition={sunPos}
            radiusM={body?.radius_m ?? 6_378_137}
            spinRateRadS={body?.spin_rate_rads}
            poleRaDeg={body?.pole_ra_deg}
            poleDecDeg={body?.pole_dec_deg}
            onFocus={handleFocus}
          />
        )
      })}

      {legSegments.map((seg) => (
        <Line
          key={seg.legIdx}
          points={seg.points}
          color={LEG_COLORS[seg.legIdx % LEG_COLORS.length]}
          opacity={0.85}
          transparent
          lineWidth={2}
        />
      ))}

      {/* Intermediate flyby bodies: positioned straight from the arc, same
          as OptimizeTrajectoryView -- not a separate ephemeris fetch. */}
      {isMga && flybyPositions.map((pos, i) => {
        const flybyName = bodySequence[i + 1] ?? `Flyby ${i + 1}`
        const flybyBody = bodiesData?.bodies.find((b) => b.name === flybyName)
        return (
          <group key={`flyby-${i}`}>
            <PlanetBody
              name={flybyName}
              position={pos}
              radiusM={flybyBody?.radius_m ?? 3_396_200}
              spinRateRadS={flybyBody?.spin_rate_rads}
              color={FLYBY_COLOR}
              poleRaDeg={flybyBody?.pole_ra_deg}
              poleDecDeg={flybyBody?.pole_dec_deg}
              ringPoints={bodyOrbitRingPoints(flybyName, sunPos, pos.distanceTo(sunPos), result.dep_jd)}
              onFocus={handleFocus}
            />
            {/* Same "closest approach area" glow as OptimizeTrajectoryView
                -- see mgaSceneData.ts's computeFlybyClosestApproach and
                that file's own comment on the two-layer fake-glow trick. */}
            {flybyHighlightSegments[i] && flybyHighlightSegments[i].length > 1 && (
              <>
                <Line points={flybyHighlightSegments[i]} color="#e2e8f0" opacity={0.28} transparent lineWidth={10} />
                <Line points={flybyHighlightSegments[i]} color="#ffffff" opacity={0.95} transparent lineWidth={3} />
              </>
            )}
          </group>
        )
      })}

      {/* All burns shown simultaneously in the static overview. BurnMarker's
 own visible size is camera-distance-relative now (fix,
          see BURN_MARKER_MAX_RADIUS_SCENE's comment in sceneShared.tsx) --
          no per-body sizing needed here. */}
      <BurnMarker position={arcStartPos} label="Departure burn" dvMs={result.dv_departure_ms} showLabel onFocus={handleFocus} />
      {isMga && dsmDisplayPositions.map((p, i) => (
        <BurnMarker
          key={`dsm-${i}`}
          position={p}
          label={`DSM ${i + 1} (leg ${i + 1})`}
          dvMs={dsmDvs[i] ?? 0}
          showLabel
          onFocus={handleFocus}
        />
      ))}
      {captureBurnPos && (
        <BurnMarker position={captureBurnPos} label="Capture burn" dvMs={result.dv_arrival_ms} showLabel onFocus={handleFocus} />
      )}

      <Line points={parkingOrbitRingPoints} color="#6b7a99" opacity={preDepartureOrbitPoints ? 0.55 : 0.3} transparent lineWidth={1} />
      {captureOrbitRingPoints.length > 0 && (
        <Line points={captureOrbitRingPoints} color="#6b7a99" opacity={postCaptureOrbitPoints ? 0.55 : 0.3} transparent lineWidth={1} />
      )}

      {/* Altitude-above-ecliptic reference lines -- moved here from
 OptimizeTrajectoryView (
          the Follow part to the Overview part? As it would be more
          useful/fitting there. In the animation they cause too much
          buggyness anyway"). Sign-coded (above vs below the ecliptic) so a
          trajectory weaving across the plane doesn't read as ticks
          alternating direction with no visual anchor. */}
      {showAltitudeLines && altitudeLineFiltered.map((p, i) => (
        <Line
          key={`alt-${i}`}
          points={[p, new THREE.Vector3(p.x, p.y, 0)]}
          color={p.z >= 0 ? "#7dd3fc" : "#fca5a5"}
          opacity={0.75}
          transparent
          lineWidth={1.5}
        />
      ))}

      <OverviewCamera fitDist={fitDist} fitAllTrigger={fitAllTrigger} focusRequest={focusRequest} controlsRef={controlsRef} />
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        makeDefault
        mouseButtons={{
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        }}
      />
    </>
  )
}

export function OverviewTrajectoryView({
  result,
  departureBodyName,
  targetBodyName,
  forceModelBodies,
  captureRadiusM,
}: {
  result: OptimizeApiResult
  departureBodyName: string
  targetBodyName: string
  forceModelBodies?: string[]
  captureRadiusM?: number | null
}) {
  const [fitAllTrigger, setFitAllTrigger] = useState(0)
  const [showAltitudeLines, setShowAltitudeLines] = useState(false)
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const [uncoveredBodies, setUncoveredBodies] = useState<string[]>([])
  const handleUncoveredBodies = useCallback((names: string[]) => setUncoveredBodies(names), [])
  const [focusRequest, setFocusRequest] = useState<{ pos: THREE.Vector3; version: number } | undefined>(undefined)
  const handleRequestFocus = useCallback((pos: THREE.Vector3) => setFocusRequest({ pos, version: Date.now() }), [])

  const fitDist = useMemo(() => {
    const box = new THREE.Box3()
    result.arc.forEach((p) => box.expandByPoint(sceneVecFromMeters(p.x_m, p.y_m, p.z_m)))
    box.expandByPoint(new THREE.Vector3())
    const size = new THREE.Vector3(); box.getSize(size)
    return Math.max(size.length() * FIT_ALL_DISTANCE_FACTOR, 5)
  }, [result.arc])

  if (result.arc.length === 0) {
    return (
      <Card><CardHeader><CardTitle>Overview</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No arc in this result to visualize.</p></CardContent>
      </Card>
    )
  }

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Overview</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setFitAllTrigger((k) => k + 1)}>
            <Expand data-icon="inline-start" /> Fit all
          </Button>
          <Button
            size="sm"
            variant={showAltitudeLines ? "secondary" : "ghost"}
            onClick={() => setShowAltitudeLines((v) => !v)}
            title="Altitude-above-ecliptic reference lines"
          >
            <ArrowUpDown data-icon="inline-start" /> Altitude
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        {uncoveredBodies.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {uncoveredBodies.map((n) => (
              <Badge key={n} variant="outline" className="text-xs text-amber-400 border-amber-400/30">⚠ No ephemeris: {n}</Badge>
            ))}
          </div>
        )}
        {/* Same fixed-height fix as OptimizeTrajectoryView -- see its
            comment. Theater mode couldn't use the extra room without this. */}
        <div style={{ flex: 1, minHeight: 480, position: "relative", backgroundColor: "#0a0a0f", overflow: "hidden" }}>
          <Canvas camera={{ fov: 50, near: 0.001, far: 200_000 }}>
            <PauseWhenHidden tool="study" />
            <color attach="background" args={["#0a0a0f"]} />
            <Suspense fallback={null}>
              <OverviewSceneContents
                result={result}
                departureBodyName={departureBodyName}
                targetBodyName={targetBodyName}
                forceModelBodies={forceModelBodies ?? []}
                captureRadiusM={captureRadiusM}
                fitAllTrigger={fitAllTrigger}
                focusRequest={focusRequest}
                onRequestFocus={handleRequestFocus}
                controlsRef={controlsRef}
                fitDist={fitDist}
                onUncoveredBodies={handleUncoveredBodies}
                showAltitudeLines={showAltitudeLines}
              />
            </Suspense>
          </Canvas>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Left-drag to orbit · scroll to zoom toward cursor · right-drag to pan · hover a body or burn marker to
          highlight it, click to zoom in on it. Use "Fit all" to return to the full-transfer view. Ecliptic frame.
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Planet textures: <a href="https://www.solarsystemscope.com/textures/" className="underline" target="_blank" rel="noreferrer">Solar System Scope</a> (CC BY 4.0).
        </p>
      </CardContent>
    </Card>
  )
}
