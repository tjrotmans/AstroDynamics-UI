import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { PauseWhenHidden } from "@/components/scene/PauseWhenHidden"
import { Html, Line, OrbitControls } from "@react-three/drei"
import * as THREE from "three"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"
import { Crosshair, Expand, Pause, Play, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useBodies, useBodyState } from "@/hooks/useApi"
import type { OptimizeApiResult } from "@/api/client"
import {
  SCENE_SCALE,
  AU_SCENE,
  LABEL_LIFT,
  CAMERA_FLY_DURATION_S,
  FOLLOW_CAMERA_OFFSET_DIR,
  FIT_ALL_DISTANCE_FACTOR,
  SUN_SIZE_EXAGGERATION,
  EXAGGERATION_NEAR_RATIO,
  HIT_SPHERE_MIN_RADIUS,
  HIT_SPHERE_MAX_RADIUS_DEFAULT,
  HIT_SPHERE_MAX_RADIUS_SUN,
  HIT_SPHERE_DISTANCE_FRACTION,
  smoothstep,
  julianDateToUtcString,
  sampleArcPosition,
  densifyCurvePoints,
  sceneVecFromMeters,
  sceneVecFromEclipticMeters,
  ringPositions,
  bodyOrbitRingPoints,
  interpolateAroundAxis,
  interpolateHeliocentric,
  PlanetBody,
  BurnMarker,
  EclipticGrid,
  PerturberBodyFromState,
  liveVecFromState,
  jNowForRing,
  useClickNotDrag,
} from "@/components/scene/sceneShared"
import { keplerPositionM, PLANET_ELEMENTS } from "@/lib/keplerEphemeris"
import { isFrozenOriginOrbit } from "@/lib/cruiseSeed"
import { deriveMgaSceneData, extractLegBoundaryTimes } from "@/components/scene/mgaSceneData"

// Lengthened 18 -> 28 (
// so its more clear") -- more real wall-clock time for the same mission
// duration means more distinct rendered animation frames along the way,
// giving the motion (especially the now-longer departure linger above)
// more room to actually read as smooth and gradual rather than compressed.
const TARGET_PLAYBACK_SECONDS = 28
// Preroll = the fly-in itself (CameraController's scripted zoom to the
// departure framing) plus an explicit hold afterward -- real bug, found
// (
// pause at the beginning. you zoom in on departure body/s/c geometry, THEN
// you start"). Before this, preroll's total duration exactly equalled the
// fly-in's own duration (CAMERA_FLY_DURATION_S, 1.1s -- see the 
// note below for why that pairing existed), so the moment the camera
// finished settling into the departure view, playback started immediately
// -- there was never a genuine "sit still and look at the geometry" beat,
// only a fly-in immediately followed by motion. PREROLL_HOLD_S adds real
// dwell time on top of the fly-in before the elapsed-mission-time clock
// (in the playback useFrame below) starts advancing at all.
// 1.6 -> 5.0 -> back to 1.6 (
// orbiting first and then it moves onto the trajectory... we let it orbit
// the parking orbit when the animation is not running, like the planets
// are also always spinning"). The 5.0 bump existed only to give the OLD
// fixed-hold orbit flourish enough real time to complete a couple of
// loops before handing off -- now that the orbit runs continuously
// whenever the animation isn't playing (see parkingOrbitCurve below), it
// no longer depends on this hold's length at all, so this is back to its
// original "just long enough to look at the still geometry" value.
const PREROLL_HOLD_S = 1.6
// The fly-in duration itself is still exactly CAMERA_FLY_DURATION_S, not
// an arbitrary padding -- real bug, found: the old fixed 2000ms
// was disconnected from CAMERA_FLY_DURATION_S (1.1s), so playback could
// start slightly before or after the zoom-in visually settled depending on
// which was tuned last.
const PREROLL_DWELL_MS = (CAMERA_FLY_DURATION_S + PREROLL_HOLD_S) * 1000

type PlaybackState = "idle" | "preroll" | "playing" | "paused" | "done"
type CameraPhase = "idle" | "preroll" | "playing" | "paused" | "done"

// Intermediate flyby marker colour -- same purple already used for SOI
// annotations (SOI_ANNOTATION_COLOR), a reasonable visual reuse since a
// flyby *is* an SOI encounter.
const FLYBY_COLOR = "#c084fc"
// Cycled per leg so an MGA multi-leg arc reads as distinct segments rather
// than one undifferentiated line -- first colour matches the single-leg
// cyan so a 1-leg MGA result still looks like today's GA/PSO arc.
const LEG_COLORS = ["#00d4ff", "#34d399", "#f472b6", "#facc15", "#a78bfa", "#fb923c"]

// EncounterMarker's own dot radius -- shared so the "how big is the dense
// altitude-line area around a flyby" calc below can be defined relative to
// it ("5 times bigger [than] the sphere,"),
// instead of an unrelated arbitrary number.
//
// Found to have the SAME bug as BURN_MARKER_MAX_RADIUS_SCENE
// (sceneShared.tsx): a fixed absolute size tuned against Earth-scale bodies,
// never revisited for a body smaller than Earth. Mercury's real radius in
// scene units (~0.0024) is smaller than this marker (0.028) -- the "arrival
// point" marker (the only EncounterMarker that keeps its visible dot; every
// flyby's dot is already replaced by a highlight segment) fully SWALLOWED
// Mercury's own true-scale textured mesh entirely, which is why the user saw
// a flat, untextured grey sphere and reported "Mercury is not rendered" --
// that grey sphere WAS this marker, not the planet.
//
// A body-radius RATIO fix (like BurnMarker's own first correction) was tried
// and reverted the same day -- see BURN_MARKER_MAX_RADIUS_SCENE's own
// comment (sceneShared.tsx) for why that whole approach was wrong, not just
// mis-tuned: it skips the camera-distance step that actually made 0.028
// read as reasonable against Saturn in the first place. Fixed the same way
// BurnMarker was: constant-apparent-screen-size, scaled off camera distance,
// not body radius. ENCOUNTER_MARKER_RADIUS_SCENE stays as a ceiling.
const ENCOUNTER_MARKER_RADIUS_SCENE = 0.028
const ENCOUNTER_MARKER_DISTANCE_FRACTION = 0.0037
const ENCOUNTER_MARKER_MIN_RADIUS_SCENE = 0.0003

// Gravity-assist glow's own proximity-in-time window -- same real-time
// radius mgaSceneData.ts's HIGHLIGHT_TIME_RADIUS_S uses for the flyby
// highlight segment itself, so the glow appears across exactly the stretch
// that's already visually highlighted, not a separately-tuned window.
const GRAVITY_ASSIST_GLOW_WINDOW_S = 24 * 3600

// Extra pull-back at full arrival look-back,
// applied both to the "playing"-phase rotation's own distance and to the
// "done" phase's fly-in distance -- shared so the two stay in agreement
// (the whole point of restoring the "done" fly-in was to match what the
// rotation was already heading toward).
const ARRIVAL_LOOK_BACK_PULLBACK_FACTOR = 0.6

// Focus-click fly-in distance, as a multiple of the CLICKED body's own
// true radius (fix -- see focusDist's own comment at the fly-in
// call site). Same order of magnitude as DEPARTURE_FRAMING_RADIUS_MULTIPLIER
// (6x) -- comfortably frames the whole body without being so far out the
// click doesn't feel like "zooming in."
const FOCUS_CLICK_RADIUS_MULTIPLIER = 8

// Spacecraft: tiny 3D model visible when zoomed in, always-on crosshair
// at the ship's screen position, and a labelled pointer above the ecliptic.
// SC_LABEL_LIFT reuses the global LABEL_LIFT so all labels sit at the same Z.
// Redesigned (feedback: the old model -- a plain grey box
// with two flat rectangular "wings" -- read as a generic, cheap placeholder,
// not a spacecraft). Direction chosen: a more recognizable real-probe
// silhouette (hexagonal bus + boom-mounted high-gain dish facing the travel
// direction + a pair of gently canted solar panels), still simple low-poly
// primitives, no textures/external asset -- same "tiny model, real detail
// only up close" role as before. Object3D.lookAt (in the useFrame below)
// orients the group's local -Z axis toward `velocity`, so the dish/boom sit
// on -Z ("the nose") and the panels stick out along local X.
function SpacecraftModel({
  position,
  moving,
}: {
  position: THREE.Vector3
  /** True during active playback -- bigger/filled crosshair while the ship
   * is actually moving, see the render below for why. */
  moving?: boolean
}) {
  // Real 3D probe model (hex bus/dish/panels) removed entirely (
  //
  // part") -- this was the "hideCrosshair" handoff's whole reason to exist
  // (fading the crosshair out once a real mesh was close enough to read as
  // more than a dot); with no mesh to hand off to anymore, the crosshair is
  // now simply always the spacecraft, in both moving and still states. A
  // detailed probe model is explicitly deferred to whenever GNC-phase work
  // gives it a real reason to exist (attitude/pointing visualization etc.),
  // not built speculatively now.
  const groupRef = useRef<THREE.Group>(null)
  useFrame(() => {
    groupRef.current?.position.copy(position)
  })
  return (
    <group ref={groupRef}>
      {/* Crosshair at the ship's screen position -- the ONLY spacecraft
          indicator now. Fixed screen-pixel size at every zoom level
 (
          zoom, so it has a consistent size") -- an earlier round made this
          distance-responsive (bigger far, smaller close); reverted, no
          `transform: scale()` anymore, an `Html` overlay's natural
          fixed-screen-size behavior is what's wanted here after all.
 Two styles (
          or bigger when its moving, maybe a filled dot not an empty dot"):
          while playing, a bigger filled dot with a soft glow ring;
          otherwise (paused/idle/done -- a still ship), a smaller open
          crosshair with tick marks. */}
      <Html center style={{ pointerEvents: "none" }}>
        {moving ? (
          <svg width="20" height="20" viewBox="0 0 20 20" style={{ display: "block", pointerEvents: "none" }}>
            <circle cx="10" cy="10" r="8" fill="none" stroke="#00d4ff" strokeWidth="1" opacity="0.35" />
            <circle cx="10" cy="10" r="4.5" fill="#00d4ff" stroke="#ffffff" strokeWidth="0.75" opacity="0.95" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" style={{ display: "block", pointerEvents: "none" }}>
            <circle cx="7" cy="7" r="3.5" fill="none" stroke="#00d4ff" strokeWidth="1.5" opacity="0.9" />
            <line x1="7" y1="0" x2="7" y2="3" stroke="#00d4ff" strokeWidth="1" opacity="0.7" />
            <line x1="7" y1="11" x2="7" y2="14" stroke="#00d4ff" strokeWidth="1" opacity="0.7" />
            <line x1="0" y1="7" x2="3" y2="7" stroke="#00d4ff" strokeWidth="1" opacity="0.7" />
            <line x1="11" y1="7" x2="14" y2="7" stroke="#00d4ff" strokeWidth="1" opacity="0.7" />
          </svg>
        )}
      </Html>
    </group>
  )
}

// A real radial-gradient texture (canvas-generated, cached per colour) for
// a genuinely SOFT glow -- fix, see GravityAssistGlow's own
// comment below for why a solid sphere couldn't give this. Multiple
// gradient stops (not just centre/edge) approximate a smooth falloff
// rather than a visible ring where the alpha ramp changes rate.
const radialGlowTextureCache = new Map<string, THREE.CanvasTexture>()
function radialGlowTexture(colorHex: string): THREE.CanvasTexture | null {
  const cached = radialGlowTextureCache.get(colorHex)
  if (cached) return cached
  const size = 128
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  const c = new THREE.Color(colorHex)
  const [r, g, b] = [c.r, c.g, c.b].map((v) => Math.round(v * 255))
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, `rgba(${r},${g},${b},1)`)
  gradient.addColorStop(0.2, `rgba(${r},${g},${b},0.85)`)
  gradient.addColorStop(0.45, `rgba(${r},${g},${b},0.45)`)
  gradient.addColorStop(0.75, `rgba(${r},${g},${b},0.12)`)
  gradient.addColorStop(1, `rgba(${r},${g},${b},0)`)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  radialGlowTextureCache.set(colorHex, texture)
  return texture
}

// Gravity-assist glow (
// going through a flyby... a glow around the flyby location, something
// that makes it clear you're moving through a gravity assist"). Wraps the
// SPACECRAFT itself rather than sitting at a fixed point -- reads as "the
// ship is experiencing this," and naturally lines up with the flyby body
// since that's where the encounter physically happens. Intensity is
// driven by the caller (see gravityAssistIntensity below); this component
// just renders whatever intensity it's given.
//
// Real bug, found immediately after shipping the first cut
// (
// hard circle"). Root cause: a `meshBasicMaterial` applies ONE opacity
// value uniformly across the whole sphere's surface -- from the camera's
// view that's a flat disc with a sharp, uniform-alpha edge (a hard-edged
// circle), not a soft radial falloff, no matter how transparent the
// material is set. Fixed by switching from two solid spheres to two
// camera-facing `sprite`s textured with a real radial-gradient canvas
// texture (radialGlowTexture) -- the gradient itself carries the
// soft-to-transparent falloff, so the sprite's own edge is genuinely
// invisible regardless of opacity. Growth range (how much the sprite
// scales up at full intensity) was also narrowed -- the previous version
// grew up to 2.5x its base size at peak intensity, reading as an expanding
// ball; now stays close to its base size and mostly just fades in/out.
//
// Follow-up, same day (
// more glow"): the softening pass above also made it too faint to read at
// typical viewing distance. Bumped the gradient texture's own alpha stops
// (radialGlowTexture, brighter through the middle of the falloff, not just
// the very centre), the base apparent size (dist fraction 0.03 -> 0.05,
// caps 5 -> 8), and both sprites' opacity multipliers -- the core in
// particular can now hit full opacity at peak intensity instead of
// topping out at 0.5. Still a soft gradient sprite, not a hard-edged mesh
// -- only the strength changed, not the shape.
function GravityAssistGlow({ position, intensity }: { position: THREE.Vector3; intensity: number }) {
  const haloTexture = useMemo(() => radialGlowTexture(FLYBY_COLOR), [])
  const coreTexture = useMemo(() => radialGlowTexture("#f5e9ff"), [])
  const coreRef = useRef<THREE.Sprite>(null)
  const haloRef = useRef<THREE.Sprite>(null)
  useFrame(({ camera }) => {
    const dist = camera.position.distanceTo(position)
    // Constant-apparent-size, same pattern as every other hit-sphere/glow
    // in this scene -- a fixed physical size would be invisible from far
    // away and absurdly large up close.
    const baseRadius = THREE.MathUtils.clamp(dist * 0.05, 0.03, 8)
    if (haloRef.current) {
      haloRef.current.position.copy(position)
      haloRef.current.scale.setScalar(baseRadius * (1.4 + intensity * 0.8))
      ;(haloRef.current.material as THREE.SpriteMaterial).opacity = intensity * 0.7
    }
    if (coreRef.current) {
      coreRef.current.position.copy(position)
      coreRef.current.scale.setScalar(baseRadius * (0.65 + intensity * 0.45))
      ;(coreRef.current.material as THREE.SpriteMaterial).opacity = Math.min(intensity * 1.1, 1)
    }
  })
  if (!haloTexture || !coreTexture) return null
  return (
    <group>
      <sprite ref={haloRef}>
        <spriteMaterial map={haloTexture} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </sprite>
      <sprite ref={coreRef}>
        <spriteMaterial map={coreTexture} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </sprite>
    </group>
  )
}

// Small persistent marker at a body's real encounter position (
// review round item 1) -- distinct from BurnMarker (a ΔV event) and from the
// moving PlanetBody it sits alongside (the real body, now moving through
// its own true position during playback, see flybyLivePositions above): a
// plain ring rather than an octahedron/diamond so it doesn't read as "one
// more burn," and no dv figure since it isn't one. Always visible (no
// showLabel gating) -- unlike a burn, "where the flyby/arrival actually
// happens" is useful reference context throughout playback, not just once
// reached.
function EncounterMarker({
  position,
  label,
  hideMarkerShape,
  onFocus,
}: {
  position: THREE.Vector3
  label: string
  /** Skips the visible dot (
   * sphere's. i dont like that. it would be better if the trajectory
   * itself is highlighted/enlightened around the flyby" -- same idiom as
   * BurnMarker's own hideMarkerShape). Hit-sphere/hover/click/label all
   * stay functional; only the visible shape drops, since the caller now
   * draws a glowing trajectory-segment overlay instead (see
   * flybyHighlightSegments below) as the real visual cue. Only passed for
   * flyby markers -- the arrival-point marker has no such segment to fall
   * back on, so it keeps its dot. */
  hideMarkerShape?: boolean
  onFocus?: (pos: THREE.Vector3) => void
}) {
  const [hovered, setHovered] = useState(false)
  const hitMeshRef = useRef<THREE.Mesh>(null)
  const visibleMeshRef = useRef<THREE.Mesh>(null)
  const clickNotDrag = useClickNotDrag(() => onFocus?.(position))
  const labelPos = useMemo(
    () => position.clone().add(new THREE.Vector3(0, 0, LABEL_LIFT * 0.55)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [position.x, position.y, position.z],
  )

  useFrame(({ camera }) => {
    if (!hitMeshRef.current) return
    const dist = camera.position.distanceTo(position)
    const radius = THREE.MathUtils.clamp(dist * HIT_SPHERE_DISTANCE_FRACTION, HIT_SPHERE_MIN_RADIUS, HIT_SPHERE_MAX_RADIUS_DEFAULT)
    hitMeshRef.current.scale.setScalar(radius)
    // Visible marker size, constant-apparent-screen-size (fix,
    // see ENCOUNTER_MARKER_RADIUS_SCENE's own comment for why this replaced
    // a body-radius ratio) -- same idiom as the hit sphere above.
    if (visibleMeshRef.current) {
      const markerRadius = THREE.MathUtils.clamp(dist * ENCOUNTER_MARKER_DISTANCE_FRACTION, ENCOUNTER_MARKER_MIN_RADIUS_SCENE, ENCOUNTER_MARKER_RADIUS_SCENE)
      visibleMeshRef.current.scale.setScalar(markerRadius * (hovered ? 1.5 : 1))
    }
  })

  return (
    <group>
      <group position={position}>
        {/* Plain filled dot -- superseded for flybys same day, see
            hideMarkerShape's comment above; still the default for the
            arrival-point marker (no highlight segment to fall back on).
            Base geometry is a unit sphere (radius 1); the useFrame above
            rescales it every frame. */}
        {!hideMarkerShape && (
          <mesh ref={visibleMeshRef}>
            <sphereGeometry args={[1, 16, 16]} />
            <meshBasicMaterial color="#e2e8f0" transparent opacity={0.85} />
          </mesh>
        )}
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
      {hovered && (
        <group position={labelPos}>
          <Html center style={{ pointerEvents: "none" }}>
            <div style={{
              color: "#e2e8f0", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
              textShadow: "0 1px 3px #000, 0 0 6px #000", pointerEvents: "none",
            }}>
              {label}
            </div>
          </Html>
        </group>
      )}
    </group>
  )
}

// Camera with two modes:
// - Continuous follow during playback (rewrite, after the user
//   rightly rejected the fly-in-then-free behaviour -- the camera must track
//   the spacecraft every frame, zoomed in near departure/flyby/arrival
//   bodies and out during interplanetary cruise; the old scripted-fly-then-
//   free approach left the camera parked while the s/c sailed away).
// - Scripted fly-ins outside playback (idle/done framing, double-click body
//   focus, the "Fit all" button) -- unchanged.
function CameraController({
  controlsRef,
  focusPoint,
  phase,
  flyToDistance,
  fitAllTrigger,
  fitAllDistance,
  focusRequest,
  followPoint,
  followDistance,
  followVelocity,
  lookBackBlend,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>
  focusPoint: THREE.Vector3
  phase: CameraPhase | string
  flyToDistance: number
  fitAllTrigger?: number
  fitAllDistance?: number
  focusRequest?: { pos: THREE.Vector3; version: number; radiusScene?: number }
  /** Non-null while playing: the camera continuously tracks this point (the spacecraft). */
  followPoint?: THREE.Vector3 | null
  /** Desired camera distance while following -- recomputed by the caller from body proximity. */
  followDistance?: number
  /** Spacecraft velocity direction while following -- drives the chase-from-behind offset below. */
  followVelocity?: THREE.Vector3 | null
  /** 0-1, ramps up only in the final stretch of the arrival leg (see the
   * caller's arrivalLookBackBlend) -- rotates the chase offset from
   * "behind the spacecraft" toward "ahead of it, on the far side of the
   * target," so the camera ends the approach looking back at the incoming
   * trajectory instead of still chasing from directly behind. */
  lookBackBlend?: number
}) {
  const { camera } = useThree()
  const lastPhaseRef = useRef<CameraPhase | string | null>(null)
  const flyElapsedRef = useRef(0)
  const flyStartPosRef = useRef(new THREE.Vector3())
  const flyStartTargetRef = useRef(new THREE.Vector3())
  const prevFitAllTriggerRef = useRef<number | undefined>(fitAllTrigger)
  const fitAllFlyElapsedRef = useRef(Infinity)
  const fitAllFlyStartPosRef = useRef(new THREE.Vector3())
  const fitAllFlyStartTargetRef = useRef(new THREE.Vector3())
  const prevFocusVersionRef = useRef<number | undefined>(undefined)
  const focusFlyElapsedRef = useRef(Infinity)
  const focusFlyStartPosRef = useRef(new THREE.Vector3())
  const focusFlyStartTargetRef = useRef(new THREE.Vector3())
  const SUN_POS = useMemo(() => new THREE.Vector3(0, 0, 0), [])
  // Smoothed chase-offset direction (item 11c below) -- damped separately
  // from position/target so a noisy frame-to-frame velocity sample doesn't
  // make the camera itself jitter.
  const chaseOffsetDirRef = useRef(FOLLOW_CAMERA_OFFSET_DIR.clone())

  useFrame((state, delta) => {
    // Double-click body focus fly-in
    if (focusRequest && focusRequest.version !== prevFocusVersionRef.current) {
      prevFocusVersionRef.current = focusRequest.version
      focusFlyElapsedRef.current = 0
      focusFlyStartPosRef.current.copy(state.camera.position)
      focusFlyStartTargetRef.current.copy(controlsRef.current?.target ?? focusRequest.pos)
    }
    const focusFlying = focusFlyElapsedRef.current < CAMERA_FLY_DURATION_S
    if (focusFlying && focusRequest) {
      focusFlyElapsedRef.current += delta
      const t = smoothstep(0, CAMERA_FLY_DURATION_S, focusFlyElapsedRef.current)
      // Real bug, found (
      // will correctly zoom in all the way, but too far so that the planet
      // disappears... you then need to zoom out"). This used to always use
      // the ambient `flyToDistance` -- whatever distance happens to be
      // active for the CURRENT playback context (departure/current-leg
      // framing), completely unrelated to the size of whatever body was
      // actually clicked. Now uses the clicked body's own real radius
      // (threaded through via PlanetBody's onFocus, see that prop's own
      // comment) when available, falling back to the ambient value only
      // for focus requests with no body behind them (e.g. none currently,
      // but keeps this robust).
      const focusDist = focusRequest.radiusScene != null
        ? Math.max(focusRequest.radiusScene * FOCUS_CLICK_RADIUS_MULTIPLIER, 0.05)
        : flyToDistance
      const closeup = focusRequest.pos.clone().add(FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(focusDist))
      state.camera.position.lerpVectors(focusFlyStartPosRef.current, closeup, t)
      state.camera.up.set(0, 0, 1)
      const tgt = focusFlyStartTargetRef.current.clone().lerp(focusRequest.pos, t)
      state.camera.lookAt(tgt)
      if (controlsRef.current) { controlsRef.current.enabled = false; controlsRef.current.target.copy(tgt) }
      return
    }

    // "Fit all" button fly-in
    if (fitAllTrigger !== undefined && fitAllTrigger !== prevFitAllTriggerRef.current) {
      prevFitAllTriggerRef.current = fitAllTrigger
      fitAllFlyElapsedRef.current = 0
      fitAllFlyStartPosRef.current.copy(state.camera.position)
      fitAllFlyStartTargetRef.current.copy(controlsRef.current?.target ?? SUN_POS)
    }
    const fitAllFlying = fitAllFlyElapsedRef.current < CAMERA_FLY_DURATION_S
    if (fitAllFlying && fitAllDistance != null) {
      fitAllFlyElapsedRef.current += delta
      const t = smoothstep(0, CAMERA_FLY_DURATION_S, fitAllFlyElapsedRef.current)
      const desiredPos = SUN_POS.clone().add(FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(fitAllDistance))
      state.camera.position.lerpVectors(fitAllFlyStartPosRef.current, desiredPos, t)
      state.camera.up.set(0, 0, 1)
      const lookTarget = fitAllFlyStartTargetRef.current.clone().lerp(SUN_POS, t)
      state.camera.lookAt(lookTarget)
      if (controlsRef.current) { controlsRef.current.enabled = false; controlsRef.current.target.copy(lookTarget) }
      return
    }

    // Continuous chase during playback: damp the orbit target onto the
    // spacecraft and the camera onto spacecraft + offset·distance every
    // frame. Exponential damping (frame-rate independent) keeps it smooth
    // through the leg-to-leg zoom changes; distance itself is already a
    // smooth function of body proximity, computed by the caller.
    if (followPoint) {
      const posAlpha = 1 - Math.exp(-2.5 * delta)
      const tgtAlpha = 1 - Math.exp(-6.0 * delta)
      // Chase-from-behind (review round item 11c, the diagnosed
      // root cause of "camera reads as top-down, not chase-from-behind"):
      // FOLLOW_CAMERA_OFFSET_DIR used to be a FIXED world-space direction
      // applied regardless of the spacecraft's own heading, so the camera
      // always sat in roughly the same direction relative to the SCENE, not
      // relative to the ship -- never actually "behind" it the way a real
      // chase camera reads. Now computed from the spacecraft's own velocity
      // each frame: mostly opposite the direction of travel (behind),
      // lifted above the orbital plane so the trajectory geometry stays
      // readable (a dead-astern view flattens it to a point), plus a small
      // fixed lateral term so a purely radial velocity (e.g. straight off
      // a departure burn) never degenerates into an ill-defined offset.
      // Damped through chaseOffsetDirRef (its own slower alpha) rather than
      // following the raw per-frame velocity sample directly -- that sample
      // is itself only a 1-second finite-difference estimate and noisy
      // enough to read as camera jitter if applied unsmoothed.
      // Lift term nearly halved, 0.55 -> 0.25 (user, watching a
      // full playback: "try to stay away from zooming out to top view and
      // keep the camera always a bit behind the moving s/c"). The elevation
      // angle above the orbital plane is set by this Z term relative to the
      // "behind" weight -- 0.55 put the camera steep enough overhead that
      // long interplanetary cruise legs (where distance grows large but the
      // ANGLE stays the same, since this is a normalized direction) read as
      // looking down at a flat map instead of chasing from behind. Kept
      // nonzero, not zero -- the original comment's own reasoning still
      // holds: a dead-astern (zero-elevation) view flattens the trajectory
      // to a point, so some lift is genuinely needed for the geometry to
      // stay readable, just less of it than before.
      // Real bug, found (
      // topview (it happens around jupiter 2 times)"). Root cause: the
      // degenerate-velocity fallback here used to be FOLLOW_CAMERA_OFFSET_DIR
      // -- a fixed, near-VERTICAL world-space direction ((0.22, 0.1, 1)
      // normalized, i.e. Z completely dominates X/Y) meant for scripted
      // fit-all/focus-click fly-ins, not a sane "keep chasing" fallback.
      // `spacecraftVel` is a 1-second finite-difference estimate
      // (posAhead - pos via sampleArcPosition) -- and the real arc data has
      // literal DUPLICATE t_s samples right at a leg boundary (confirmed by
      // inspecting the raw Cassini snapshot around a flyby: five consecutive
      // points all reading t_s ~ 0 relative to the encounter), which makes
      // that estimate go to (near) zero exactly there. Every time playback
      // crossed one of these degenerate-velocity windows, the offset used to
      // SNAP to the near-vertical fallback for a frame or more -- reading
      // exactly as "the camera rotates to top view," right at a flyby, since
      // that's precisely where the duplicate timestamps cluster. Fixed by
      // falling back to the already-damped `chaseOffsetDirRef.current`
      // instead -- "keep going the direction you were already going" rather
      // than snapping to an unrelated fixed direction; seamless since the
      // ref already holds a smoothed, continuous value from the previous
      // frame.
      // Look-back rotation (ask, see lookBackBlend's own
      // comment). Real bug, found and fixed the same day the feature
      // shipped (
      // sure the s/c never leaves our sight when you rotate"): the first
      // cut LERPED the offset direction straight toward its mirror image
      // (`behind.lerp(ahead, blend)`) -- a straight-line blend between two
      // roughly-opposite vectors passes close to ZERO length partway
      // through (since `behind` and `ahead` roughly cancel), which isn't a
      // rotation around anything at all, just a wobbly, poorly-defined
      // path through the middle -- not the "swing around and look back"
      // the user actually asked for.
      // Revised again same day (
      // really looks in opposite direction as the velocity of the s/c").
      // The first fix (rotate `behind` by a fixed 180 degrees around the
      // ecliptic normal) swept a well-defined arc, but a FIXED axis/angle
      // rotation of the whole `behind` vector -- lateral/elevation tilt
      // included -- doesn't necessarily land exactly opposite the
      // velocity direction at full blend; the tilt term rotates right
      // along with the velocity-aligned part instead of staying pinned to
      // its own small role. Revised again the same day (
      // point was to show you how i want the camera to rotate in the
      // end. It needs to rotate to that second screenshot's view angle"):
      // the target direction isn't a velocity-derived guess anymore at
      // all -- it's `FOLLOW_CAMERA_OFFSET_DIR`, the EXACT fixed direction
      // every scripted fly-in in this file already uses (idle/preroll,
      // fit-all, focus-click, and -- before the previous round removed
      // its own separate fly-in -- "done" itself). The user's two
      // reference screenshots were showing the live rotation's own honest
      // (but different-angle) composition versus the OLD done-phase
      // fly-in's specific, already-liked shot -- so the fix isn't a new
      // angle, it's making the ROTATION itself sweep to that exact same,
      // already-correct direction instead of a separately-invented one.
      // The sweep still uses `Quaternion.setFromUnitVectors(behind, ahead)`
      // -- the exact rotation between the two real unit vectors, SLERPed
      // by `lookBackBlend` -- so the camera provably ends up exactly at
      // `FOLLOW_CAMERA_OFFSET_DIR`, not just "a 180-degree turn from
      // behind that happens to land nearby."
      const rawOffsetDir = (() => {
        if (!followVelocity || followVelocity.lengthSq() < 1e-10) return chaseOffsetDirRef.current
        const dir = followVelocity.clone().normalize()
        const behind = dir.clone().multiplyScalar(-0.88).add(new THREE.Vector3(0.12, 0.05, 0.25)).normalize()
        if (!lookBackBlend) return behind
        const sweepQuat = new THREE.Quaternion().setFromUnitVectors(behind, FOLLOW_CAMERA_OFFSET_DIR)
        const identity = new THREE.Quaternion()
        const stepQuat = identity.clone().slerp(sweepQuat, THREE.MathUtils.clamp(lookBackBlend, 0, 1))
        return behind.clone().applyQuaternion(stepQuat).normalize()
      })()
      // Damping rate lowered 3.0 -> 1.8 (
      // be moving back and forward a little bit around its true position,
      // throughout the entire trajectory"). Investigated properly first,
      // not assumed: a throwaway script sampled the actual position curve
      // at fine steps both mid-leg and near (not at) a boundary and found
      // ZERO direction reversals in the sampled POSITION itself -- the
      // math driving where the dot IS does not move backward. The most
      // plausible remaining source is this offset direction reacting to
      // `followVelocity`, itself a 1-second finite-difference sample of an
      // interpolated curve -- small legitimate local tangent variation
      // between nearby samples can still nudge the CAMERA's own position
      // slightly frame to frame even though the dot's real position never
      // reverses, reading as "the dot wobbles" from a viewer's fixed
      // frame. A lower damping rate (longer time constant) makes this
      // offset direction less reactive to small-magnitude noise while
      // still following genuine, larger trajectory curvature (a real
      // flyby's actual direction change is far larger than this kind of
      // noise) -- a conservative mitigation for the most likely cause,
      // not a proven fix (see this round's the design notes entry for the honest
      // caveat).
      chaseOffsetDirRef.current.lerp(rawOffsetDir, 1 - Math.exp(-1.8 * delta)).normalize()
      const desiredPos = followPoint.clone().add(
        chaseOffsetDirRef.current.clone().multiplyScalar(followDistance ?? flyToDistance),
      )
      camera.position.lerp(desiredPos, posAlpha)
      camera.up.set(0, 0, 1)
      if (controlsRef.current) {
        controlsRef.current.enabled = false
        controlsRef.current.target.lerp(followPoint, tgtAlpha)
        camera.lookAt(controlsRef.current.target)
      } else {
        camera.lookAt(followPoint)
      }
      // Reset the phase tracker so leaving playback (pause/done) triggers a
      // fresh scripted fly-in instead of continuing from a stale phase.
      lastPhaseRef.current = null
      return
    }

    // Paused: hand full control back to OrbitControls immediately, right
    // where the camera already is -- no scripted fly-in, no movement. Real
    // bug, found: "paused" used to fall through to the same
    // phase as "playing" below, which kept the chase-cam engaged and
    // force-disabled OrbitControls every frame, silently overwriting any
    // manual zoom/drag/pan the instant the user tried it.
    if (phase === "paused") {
      if (controlsRef.current) controlsRef.current.enabled = true
      lastPhaseRef.current = phase
      return
    }

    // "done" -- history worth reading before touching this again, it's
    // been wrong in two different ways the same day. `playbackState` only
    // ever REACHES "done" via `onDone()`, called from the playing-tick the
    // moment elapsed time hits the mission's real end -- there is no other
    // path to "done" in this codebase.
    //
    // Attempt 1 (unchanged): "done" fell through to the same generic
    // scripted fly-in idle/preroll use -- a brand-new flight to `targetPos`
    // at `closeDistArrival` via `FOLLOW_CAMERA_OFFSET_DIR`, built long
    // before the recent arrival-rotation work and never reconciled
    // with it. Since the "playing" phase's own `lookBackBlend` rotation
    // swept toward a DIFFERENT, self-invented direction, the two never
    // agreed -- a visible jump cut the instant playback finished (caught
    // by comparing two screenshots).
    //
    // Attempt 2 (reverted): treated "done" exactly like "paused" -- freeze
    // wherever "playing" left the camera, no second fly-in at all. This
    // assumed the rotation always has enough real TIME to fully sweep to
    // its target before elapsed time hits the mission's end -- false in
    // general (confirmed live: seeking to very near the true end and
    // resuming finishes playback almost instantly, well before the
    // rotation's own damped lerp can converge, freezing "done" on a
    // visibly incomplete, wide/off-angle frame -- not what the previous
    // fix's own screenshot comparison happened to catch, since that test
    // seeked earlier and gave the rotation enough time).
    //
    // Current fix: now that the "playing" phase's rotation target IS
    // `FOLLOW_CAMERA_OFFSET_DIR` (this same round, see rawOffsetDir's own
    // comment above -- no longer a separately-invented direction), the
    // scripted fly-in below and the live rotation are heading to the
    // SAME place. Restoring the scripted fly-in for "done" is safe again:
    // when the rotation already finished, start≈end and it's an
    // imperceptible top-off; when it didn't (this app's real fast-
    // finishing-near-the-end case), the fly-in smoothly completes the
    // remaining sweep over CAMERA_FLY_DURATION_S instead of leaving it
    // stuck partway. Falls through to the generic phase-gated fly-in
    // below, same as idle/preroll.

    // Phase-gated fly-in (idle/done framing)
    if (phase !== lastPhaseRef.current) {
      lastPhaseRef.current = phase
      flyElapsedRef.current = 0
      flyStartPosRef.current.copy(camera.position)
      flyStartTargetRef.current.copy(controlsRef.current?.target ?? focusPoint)
    }
    const flying = flyElapsedRef.current < CAMERA_FLY_DURATION_S
    if (controlsRef.current) controlsRef.current.enabled = !flying
    if (flying) {
      flyElapsedRef.current += delta
      const t = smoothstep(0, CAMERA_FLY_DURATION_S, flyElapsedRef.current)
      const desiredPos = focusPoint.clone().add(FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(flyToDistance))
      camera.position.lerpVectors(flyStartPosRef.current, desiredPos, t)
      camera.up.set(0, 0, 1)
      const lookTarget = flyStartTargetRef.current.clone().lerp(focusPoint, t)
      camera.lookAt(lookTarget)
      controlsRef.current?.target.copy(lookTarget)
    }
    // Outside playback, after any fly-in: fully free OrbitControls.
  })
  return null
}

// Event-aware time <-> slider[0,1] mapping (: "yess
// finer control around interesting moments"). A linear slider spends almost
// all of its drag range on cruise -- a multi-year MGA mission's few real
// "moments" (departure, each flyby, arrival/capture) are each a tiny sliver
// of total duration, so scrubbing to line up on one precisely was hard even
// with a small step size (`densifyCurvePoints`, the round before this one,
// only densified the RENDERED line shape, not this -- a distinct bug from
// what it looked like at first, see the design notes). This builds a piecewise
// weighted-CDF: real time is divided into BUCKET_COUNT equal buckets, each
// bucket's WEIGHT is boosted near an event time (smoothstep falloff within
// EVENT_WINDOW_FRACTION of the total span), then the cumulative weight is
// normalized to [0,1] -- so a fixed slider drag-distance now covers less
// real time near an event and more real time during plain cruise, without
// changing what displayElapsedS/the date readout/onElapsedChange mean (still
// real seconds throughout -- only the slider's OWN position is remapped, at
// the two functions returned here).
// 800 -> 2000 (alongside the peak-boost addition below): more
// buckets means the boost function's real SHAPE (in particular the much
// narrower peak window, ~24 real hours) is captured with enough real-time
// resolution to matter -- 800 buckets over Cassini's ~3562-day span
// average ~4.45 days/bucket, coarser than the peak window itself would
// need to be represented faithfully.
const EVENT_TIME_BUCKET_COUNT = 2000
const EVENT_WINDOW_FRACTION = 0.02
// 18 -> 180 (
// flybys?") -- a straight 10x multiply on the weight boost. This doesn't
// change how many real-time samples exist near an event (still bounded by
// EVENT_TIME_BUCKET_COUNT's uniform time buckets, linearly interpolated
// within each) -- it changes how much of the SLIDER's [0,1] drag range a
// near-event bucket occupies, which is what actually determines how many
// real seconds a fixed mouse-drag/step covers there. Bumping this 10x
// reallocates roughly 10x more slider real estate to the boosted window,
// at cruise's expense (already coarse, gets a bit coarser).
const EVENT_WEIGHT_BOOST = 180
// Second, much sharper boost layer, nested inside the flyby-range boost
// above (user, after the range-based fix STILL wasn't enough:
// "i need a lot of points in between... exactly 0 points in between" —
// screenshot showed two adjacent slider STEPS jumping clean across the
// visibly highlighted close-approach geometry). Root cause: the range
// boost spreads its finer resolution EVENLY across the whole highlight
// window (23-30 real days for Cassini's flybys) -- correct for "let me
// scrub near this flyby in general," but the actual dramatic close-
// approach swing (confirmed by inspecting the real arc's own sample
// density right at the boundary: ~38 hours of genuinely dense real
// sampling, roughly -25h to +13h around the leg-boundary instant) is a
// much SHORTER slice buried inside that wider window, and got the exact
// same few-hours-per-step resolution as the boring lead-in/lead-out
// cruise on either side of it. PEAK_WINDOW_S (24h, so ±24h = 48h total,
// comfortably covering the observed ~38h dense-sampling span) gets its
// own much larger PEAK_BOOST, centered on the real closest-approach
// instant (flybyClosestTimes, not just the raw leg boundary). Tuned by
// direct measurement against the real Cassini snapshot (not guessed):
// with these values every one of Cassini's 4 flybys gets at least ~30
// slider positions within its own ±24h peak window (the two close-
// together Venus/Earth flybys share proportionally less of the total bar
// since their surrounding padding overlaps, but even the worst case
// clears the "at least 20" ask comfortably), while the 4 peaks together
// still leave ~80% of the bar for the rest of the mission.
const PEAK_WINDOW_S = 24 * 3600
const PEAK_BOOST = 8000

interface TimeSliderMapping {
  toSlider: (t: number) => number
  toTime: (s: number) => number
}

// A "point" event (departure/arrival/capture) is just a zero-width range
// [t, t] -- distanceToRange collapses to plain |t - evt| for those, so one
// code path covers both without a separate branch.
function distanceToRange(t: number, lo: number, hi: number): number {
  if (t < lo) return lo - t
  if (t > hi) return t - hi
  return 0
}

function buildEventAwareTimeMapping(
  startS: number,
  endS: number,
  eventRanges: [number, number][],
  peakTimesS: number[] = [],
): TimeSliderMapping {
  const span = endS - startS
  if (!(span > 0)) {
    return { toSlider: () => 0, toTime: () => startS }
  }
  const windowS = Math.max(span * EVENT_WINDOW_FRACTION, 1)
  const bucketTimes: number[] = []
  for (let i = 0; i <= EVENT_TIME_BUCKET_COUNT; i++) bucketTimes.push(startS + (span * i) / EVENT_TIME_BUCKET_COUNT)

  // user, after correcting an earlier misread of this request
  // (it's about the SLIDER, not the altitude lines -- see the design notes):
  // "give me more points" specifically across "the highlighted area you
  // have now" -- i.e. the ENTIRE real flyby highlight window
  // (flybyHighlightTimeRanges, the same span the glowing trajectory
  // overlay covers), not just a taper centered on a single instant. Full
  // boost (1) for every t INSIDE a range, tapering only in the
  // windowS-wide padding just outside its edges -- a real behavioral
  // change from the old point-only version, where even a multi-day flyby
  // window only got its PEAK boost at the exact center instant.
  //
  // STILL not enough on its own (user, immediately after: "i
  // need a lot of points in between... exactly 0 points in between" --
  // two adjacent slider STEPS jumped clean across the whole visible
  // close-approach hook). The range boost above spreads its resolution
  // EVENLY across the wide highlight window, but the real dramatic swing
  // is a much shorter slice inside it -- see PEAK_WINDOW_S/PEAK_BOOST's
  // own comment for the measurement behind these numbers. This second
  // term stacks a much sharper, narrower boost on top, centered on the
  // real closest-approach instant specifically.
  const weightAt = (t: number) => {
    let boost = 0
    for (const [lo, hi] of eventRanges) {
      const d = distanceToRange(t, lo, hi)
      if (d < windowS) boost = Math.max(boost, 1 - smoothstep(0, windowS, d))
    }
    let peak = 0
    for (const p of peakTimesS) {
      const d = Math.abs(t - p)
      if (d < PEAK_WINDOW_S) peak = Math.max(peak, 1 - smoothstep(0, PEAK_WINDOW_S, d))
    }
    return 1 + boost * EVENT_WEIGHT_BOOST + peak * PEAK_BOOST
  }

  const cumulative = [0]
  for (let i = 1; i <= EVENT_TIME_BUCKET_COUNT; i++) {
    const midT = (bucketTimes[i - 1] + bucketTimes[i]) / 2
    cumulative.push(cumulative[i - 1] + weightAt(midT))
  }
  const totalWeight = cumulative[cumulative.length - 1]
  const sliderPositions = cumulative.map((w) => w / totalWeight)

  const toSlider = (t: number) => {
    const clamped = THREE.MathUtils.clamp(t, startS, endS)
    const frac = (clamped - startS) / span
    const idxF = frac * EVENT_TIME_BUCKET_COUNT
    const i0 = Math.min(Math.floor(idxF), EVENT_TIME_BUCKET_COUNT - 1)
    const localT = idxF - i0
    return THREE.MathUtils.lerp(sliderPositions[i0], sliderPositions[i0 + 1], localT)
  }

  const toTime = (s: number) => {
    const clamped = THREE.MathUtils.clamp(s, 0, 1)
    // sliderPositions is monotonically increasing -- binary search for the
    // bucket straddling `clamped`, then linearly interpolate back to real time.
    let lo = 0
    let hi = EVENT_TIME_BUCKET_COUNT
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sliderPositions[mid] < clamped) lo = mid + 1
      else hi = mid
    }
    const i1 = Math.max(1, lo)
    const i0 = i1 - 1
    const range = sliderPositions[i1] - sliderPositions[i0]
    const localT = range > 0 ? (clamped - sliderPositions[i0]) / range : 0
    return THREE.MathUtils.lerp(bucketTimes[i0], bucketTimes[i1], localT)
  }

  return { toSlider, toTime }
}

function SceneContents({
  result,
  departureBodyName,
  targetBodyName,
  forceModelBodies,
  captureRadiusM,
  playbackState,
  fitAllTrigger,
  focusRequest,
  seekRequest,
  zoomToShipTrigger,
  onRequestFocus,
  onDone,
  onUncoveredBodies,
  onElapsedChange,
}: {
  result: OptimizeApiResult
  departureBodyName: string
  targetBodyName: string
  forceModelBodies: string[]
  captureRadiusM?: number | null
  playbackState: PlaybackState
  fitAllTrigger?: number
  focusRequest?: { pos: THREE.Vector3; version: number }
  /** A scrub-slider request from the parent (see the timeline slider in
   * OptimizeTrajectoryView below) -- a new `version` on an unchanged `s`
   * still means "jump here," same idiom as focusRequest. */
  seekRequest?: { s: number; version: number }
  /** "Zoom to S/C" button request (ask) -- a version bump,
   * same idiom as fitAllTrigger, but focuses on the spacecraft's CURRENT
   * position, which only this component has (spacecraftPos below) -- the
   * parent can't build a focusRequest itself the way it does for a clicked
   * body, since it has no reason to track a fast-changing per-frame
   * position. Handled below via the same onRequestFocus fly-in every body/
   * burn marker's click already triggers, just sourced from spacecraftPos
   * instead of a fixed body position. */
  zoomToShipTrigger?: number
  onRequestFocus: (pos: THREE.Vector3, radiusScene?: number) => void
  onDone: () => void
  onUncoveredBodies: (names: string[]) => void
  /** Reports the current playback clock up to the parent every time it
   * changes, purely for display (the timeline slider position + the
   * mission date/time readout) -- the parent has no other way to see
   * elapsedS, which lives in this component's own state. */
  onElapsedChange: (s: number) => void
}) {
  const { data: bodiesData } = useBodies()
  const departureBody = bodiesData?.bodies.find((b) => b.name === departureBodyName)
  const targetBody = bodiesData?.bodies.find((b) => b.name === targetBodyName)
  const sunBody = bodiesData?.bodies.find((b) => b.name === "Sun")

  const sunPos = useMemo(() => new THREE.Vector3(0, 0, 0), [])
  // Trimmed to the real achieved capture instant when one happened (
  // fix
  // to be already in a captured orbit, doesn't make sense"). `result.arc`
  // always spans the FULL requested max_coast_days budget regardless of when
  // the real encounter happens (see totalDurationS's own comment below, and
  // the arrival-timing clamp fix earlier this same session) -- that's
  // correct/intentional data (the real physical coast tail), but drawing it
  // as a continuous straight heliocentric line past a REAL capture reads as
  // "the spacecraft flew straight through and kept going," when physically
  // it's now in the bound elliptical orbit shown by postCaptureOrbitPoints
  // instead. Only trimmed when `capture_time_s` is real (an actual capture
  // crossing happened, not just closest-approach) -- a Flyby/no-capture
  // result still draws its full raw coast, unchanged.
  const linePoints = useMemo(() => {
    const capturedAtS = result.capture_time_s != null ? result.achieved_tof_days * 86_400 : null
    const arcPoints = capturedAtS != null ? result.arc.filter((p) => p.t_s <= capturedAtS) : result.arc
    const scenePoints = arcPoints.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m))
    // Real gap, found (
    // incoming trajectory and the orbit... this is not supposed to
    // happen"). Confirmed NOT a real physics/backend issue by reading
    // optimize.rs directly: post_capture_orbit's plane_normal is built
    // from the real propagated crossing state's own r_rel_m/v_rel_mps, so
    // it's tangent to the incoming trajectory by construction -- no plane
    // change is modeled anywhere. The visible angle is a pure display
    // artifact: `result.arc` is sparsely sampled near a fast encounter
    // (the same well-documented issue as the MGA DSM-marker gap
    // elsewhere in this file), so the trimmed line's last raw sample can
    // land a real, if usually small, distance/time short of the true
    // crossing instant (measured on this preset: ~16 real seconds, ~3,700
    // km). Fixed by appending the exact real crossing point --
    // post_capture_orbit_arc's own first point, built server-side from
    // that same exact crossing state -- as the line's literal final
    // point when both are available. This fills in real data the raw
    // sampling was too coarse to include; it isn't a display-only fudge
    // the way projecting a DSM marker onto an already-drawn line is (see
    // that fix's own comment for the distinction).
    //
    // Real bug found and fixed (: "the trajectory
    // moves correctly to the orbit, but then buckles 90 deg to a random
    // direction"): this used to add `target_r_arr_m` (the target body's
    // own heliocentric position) on top of `capArc[0]` -- correct ONLY
    // back when `post_capture_orbit_arc` was body-relative. It's been
    // heliocentric since backend Phase 12k -- see
    // `postCaptureOrbitPoints` below, which was correctly updated to drop
    // its own `.add(targetPos)` the same day. This ONE stitching point was
    // missed, so it silently became a double-add: the real crossing state
    // plus the target body's own (often much larger) heliocentric offset,
    // landing this single point roughly the target's own solar distance
    // away from where the rest of the line actually goes -- exactly a
    // sharp kink at the very end of an otherwise-correct arc.
    const capArc = result.post_capture_orbit_arc
    if (capturedAtS != null && capArc && capArc.length > 0) {
      scenePoints.push(sceneVecFromMeters(capArc[0].x_m, capArc[0].y_m, capArc[0].z_m))
    }
    return scenePoints
  }, [result.arc, result.capture_time_s, result.achieved_tof_days, result.post_capture_orbit_arc, result.target_r_arr_m])
  // MGA: same arc + burns shape GA/PSO already produce, just chained across
  // more legs/bodies (see the design notes) -- extend this one
  // view rather than build a separate component. mga_* fields are null for
  // GA/PSO, so isMga gates every branch below. Shared with
  // OverviewTrajectoryView via deriveMgaSceneData (extracted) so
  // this derivation isn't duplicated a second time there.
  const mga = useMemo(() => deriveMgaSceneData(result, linePoints), [result, linePoints])
  const {
    isMga,
    bodySequence,
    dsmDvs,
    dsmDisplayPositions,
    legBoundaryTimes,
    legStartTimes,
    flybyPositions,
    flybyClosestTimes,
    flybyHighlightSegments,
    legSegments,
  } = mga

  // Intermediate flyby bodies only (not departure/target) -- used below to
  // keep them OUT of the live-extrapolated perturber list.
  const flybySequenceBodies = useMemo(() => (isMga ? bodySequence.slice(1, -1) : []), [isMga, bodySequence])

  // Filter Sun: always at origin, no state needed. Filter departure/target: rendered separately.
  // Filter out flyby-sequence bodies too (real bug, found): every
  // MGA flyby body is always also in the force-model perturber list
  // (missionStore.setMgaParams rebuilds it that way), so without this
  // exclusion a flyby body was rendered TWICE -- once as the authoritative
  // arc-sampled purple marker below, once as a live circular-orbit-
  // extrapolated mesh here, and the two visibly diverged the longer after
  // departure the encounter happened ("the purple dot is much higher than
  // the rendered planet"). The purple marker is already the single correct
  // representation; a flyby body only matters visually right around its own
  // encounter anyway, so a static-but-correct marker beats a moving-but-
  // wrong one.
  // Filter out bodies with no ANISE ephemeris coverage - fetching their state 422s and React Query
  // retries the failing request on a timer, flooding the network tab.
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

  // Decorative background planets ("add all bodies
  // we have available in the render -- be careful, not in the force body
  // models, only in the render"). Every major planet NOT already rendered
  // as departure/target/flyby/a real force-model perturber, so the scene
  // reads as "the whole solar system" the way the landing page's sky
  // already does, instead of only showing bodies the user happened to
  // check as physics perturbers. Positions come from
  // lib/keplerEphemeris.ts -- no extra network fetch per body, unlike
  // PerturberBodyFromState -- and these are NEVER added to
  // optimization.force_model.bodies; purely visual context.
  const decorativePlanetNames = useMemo(
    () =>
      Object.keys(PLANET_ELEMENTS).filter(
        (n) =>
          n !== departureBodyName &&
          n !== targetBodyName &&
          !flybySequenceBodies.includes(n) &&
          !forceModelBodies.includes(n),
      ),
    [departureBodyName, targetBodyName, flybySequenceBodies, forceModelBodies],
  )

  useEffect(() => {
    onUncoveredBodies(uncoveredPerturberBodies)
  }, [uncoveredPerturberBodies, onUncoveredBodies])

  const arcStartPos = useMemo(() => linePoints[0] ?? new THREE.Vector3(), [linePoints])
  const targetPos = useMemo(
    () => sceneVecFromMeters(result.target_r_arr_m[0], result.target_r_arr_m[1], result.target_r_arr_m[2]),
    [result.target_r_arr_m],
  )
  const legCount = isMga ? Math.max(bodySequence.length - 1, 1) : 1

  // Real bug, found (
  // to the departure trajectory... how come this trajectory doesn't
  // actually start on the parking orbit?"). Confirmed numerically against
  // the live backend, not guessed: `arc[0]` is NOT at t_s=0 anymore -- since
  // the real escape-leg work landed (12j, `the design notes`),
  // `arc[0].t_s` is genuinely NEGATIVE (the real periapsis-burn/injection
  // point now precedes the old "mission start" reference by however long
  // the real escape transit takes, ~2.46 days for this Cassini run). This
  // view fetched the departure body's real state at `dep_jd` (t_s=0)
  // unconditionally -- for a result with this real escape leg, that is the
  // WRONG epoch: Earth moves ~6.38 million km in 2.46 days (verified by
  // querying `/api/bodies/Earth/state` at both epochs directly), which
  // completely swamps the real ~6,578 km parking-orbit radius the ring is
  // supposed to represent -- so the ring rendered millions of km from
  // where the arc actually starts. `arcT0S` is the correction: the fetch
  // epoch now matches `arc[0]`'s own real t_s, which measured out to within
  // ~6 km of the real parking-orbit radius once fixed -- the two aren't a
  // coincidental near-miss, they're the same physical point. `arcT0S` is 0
  // for any older/non-escape-leg result, so this is a no-op there.
  const arcT0S = result.arc[0]?.t_s ?? 0
  const effectiveDepartureEpoch = useMemo(
    () => julianDateToUtcString(result.dep_jd + arcT0S / 86_400),
    [result.dep_jd, arcT0S],
  )
  const { data: departureBodyState, isError: departureBodyStateError } = useBodyState(departureBodyName, effectiveDepartureEpoch)
  const departurePos = useMemo(() => {
    if (departureBodyState) return sceneVecFromMeters(departureBodyState.x_m, departureBodyState.y_m, departureBodyState.z_m)
    return arcStartPos
  }, [departureBodyState, arcStartPos])
  const departurePosIsReal = Boolean(departureBodyState) && !departureBodyStateError
  // Fetched at the same corrected epoch as departureBodyState above (see
  // arcT0S) -- purely to extrapolate the target body's *live* rendered
  // position during playback (see targetLivePos below) -- target_r_arr_m
  // above remains the sole authority for anything that isn't the moving
  // mesh itself (capture ring, camera framing, "done" state, fit-all
  // bounds), since it's the backend's real propagated arrival position,
  // not this view's decorative circular approximation.
  const { data: targetBodyState } = useBodyState(targetBodyName, effectiveDepartureEpoch)

  // Real bug, found (user, testing the new direct-transfer
  // Mercury preset: "it also seems as if we dont reach mercury at all, not
  // even a proper flyby... it doesnt look like we arrive at mercury at the
  // right time... why does the propagation continue for so long
  // afterwards?"). Root-caused by reading the actual result data, not
  // guessed: for a GA result, `result.arc`'s own real minimum-distance
  // point to `target_r_arr_m` sits EXACTLY at `t_s == achieved_tof_days *
  // 86400` (confirmed numerically, twice, against two real optimizer runs
  // at different `max_coast_days` bounds) -- but the arc itself keeps
  // being propagated past that point, all the way out to whatever
  // `optimization.max_coast_days` was configured to (a real backend
  // behavior: the returned arc spans the full requested coast BUDGET, not
  // just the achieved transfer duration -- `openapi.json`'s own doc
  // comment on `max_coast_days` confirms this is "a ceiling, not a
  // prescribed transfer duration"). Using `arc[last].t_s` as "the
  // mission's real end" (this file's own established convention, correct
  // for MGA -- MGA's own arc naturally ends at the real encounter, no
  // excess tail) silently treated up to hundreds of days of meaningless
  // post-encounter empty-space coasting as still "in progress," so
  // playback sailed straight through the real close approach with no
  // arrival framing, camera slowdown, or "done" state anywhere near it,
  // then finished the mission far from the target in empty space --
  // exactly "we don't reach Mercury at all." `achieved_tof_days` is
  // documented (`OptimizeApiResult`'s own schema comment on
  // `target_r_arr_m`) as the real encounter time regardless of method, so
  // clamping the EFFECTIVE mission duration to it (never past the arc's
  // own real last point, via Math.min) makes playback/camera/pacing end
  // at the real achieved encounter for any method, while leaving the
  // underlying `result.arc` data itself untouched (the full physical
  // coast is still real data, still visible in "Fit all"/Overview, just
  // no longer treated as part of the "eventful" playback).
  const rawTotalDurationS = result.arc.length === 0 ? 0 : result.arc[result.arc.length - 1].t_s
  const achievedArrivalS = result.achieved_tof_days * 86_400
  const totalDurationS = achievedArrivalS > 0 ? Math.min(rawTotalDurationS, achievedArrivalS) : rawTotalDurationS

  // Real propagated departure parking orbit (
  // backend now provided us with a real propagated departure parking orbit,
  // but that doesn't seem to be the case"). `pre_departure_orbit_arc` is
  // real (`mga_departure_injection_state`/GA-PSO's own real parking-orbit
  // solve, per its own doc comment) but was never wired into any rendering
  // -- this view only ever drew `parkingOrbitRingPoints`, a CIRCULAR
  // APPROXIMATION sized from `arcStartPos.distanceTo(departurePos)`. That
  // distance turned out to be a real, separate bug once the backend started
  // returning `arc` beginning at SOI-EXIT (a real escape leg now precedes
  // the heliocentric arc, see `arc[0].t_s` going negative) rather than at
  // the body: `arcStartPos` sits near Earth's SOI boundary (hundreds of
  // thousands of km out), nowhere near a real ~200 km-altitude parking
  // orbit -- so the "ring" was actually approximating the SOI-exit
  // distance, not the parking orbit at all, which is exactly why it read as
  // wrong. Points are DEPARTURE-BODY-CENTERED meters (openapi.json's own
  // doc comment) -- `sceneVecFromMeters` converts the relative offset
  // (rotation + scale only), then `.add(departurePos)` anchors it at the
  // body's real position, same convention `sampleArcPosition` etc. already
  // use for the heliocentric arc.
  // Backend fix pre_departure_orbit_arc/
  // post_capture_orbit_arc are now returned already in the SAME heliocentric
  // frame `arc` uses -- the body's real position is already added
  // server-side. Do NOT re-add departurePos/targetPos here (that used to be
  // required when these fields were body-relative; doing it now would
  // double-translate every point, landing the ring roughly 2x the body's
  // heliocentric distance away from where it should be).
  // (screenshot: "this animation of the orbit is
  // not correct anymore... the real heliocentric trajectory of the s/c
  // before launch, but it doesn't make much sense like this"): since the
  // backend's time-resolved orbit arcs, this field is the real
  // parking coast in the HELIOCENTRIC frame -- for the Mars example,
  // ~320,000 km of Earth's own orbital motion over the ~3 h coast, with the
  // ~6,600 km parking orbit riding on it as a small wiggle (measured
  // against real ephemeris: every sample sits at parking radius from where
  // Earth WAS at that sample's own epoch). Drawn as-is with the body
  // rendered at one instant it reads as a giant squiggle hanging off the
  // planet, and the idle-loop spacecraft rides the whole 320,000 km wave.
  // So for a time-resolved arc the DISPLAY subtracts the body's own motion
  // at each sample's epoch (body position from liveVecFromState -- the same
  // circular extrapolation the moving-body render already uses; error ~km
  // over a coast this short) and re-anchors at the fixed departurePos,
  // giving the closed parking ellipse a person expects. Timebase: the
  // arc's LAST sample coincides with arc[0] (verified 0 km apart on real
  // data), which is exactly the epoch departureBodyState was fetched at
  // (effectiveDepartureEpoch), so dt_i = t_s[i] - t_s[last]. Frozen-origin
  // arcs (pre-captures, e.g. the frozen Mercury preset --
  // isFrozenOriginOrbit true) keep the original as-is rendering: their
  // points already form a closed ring at the frozen body position, and
  // subtracting a moving extrapolation would corrupt exactly what is
  // correct about them. Display-only re-anchoring
  // - the served data itself is never modified.
  // Body position at each sample epoch: the circular liveVecFromState
  // extrapolation is NOT good enough here (first cut, user screenshot
  // "now its some weird spiral") -- Earth's e=0.0167 makes its
  // real rate differ from circular by ~0.5 km/s, i.e. ~5,000 km of residual
  // drift over the ~3 h coast, the same size as the 6,578 km parking radius
  // itself, so the "closed" ring rendered as an opening spiral. Use the
  // Standish Kepler elements' RELATIVE motion instead (real elliptical
  // rate; meters-level relative error over hours), de-biased to the fetched
  // real state at the arc's end epoch -- the same technique the capture
  // side below already uses for the same reason at 273 days.
  const preOrbitOffsets = useMemo(() => {
    const src = result.pre_departure_orbit_arc
    if (!src || src.length === 0 || !departureBodyState) return null
    if (isFrozenOriginOrbit(src)) return null
    const elements = PLANET_ELEMENTS[departureBodyName]
    const tEnd = src[src.length - 1].t_s
    const bodyEnd = sceneVecFromMeters(departureBodyState.x_m, departureBodyState.y_m, departureBodyState.z_m)
    const jdEnd = result.dep_jd + arcT0S / 86_400
    const keplerEnd = elements ? sceneVecFromEclipticMeters(...keplerPositionM(elements, jdEnd)) : null
    return src.map((p) => {
      const bodyAt =
        elements && keplerEnd
          ? sceneVecFromEclipticMeters(...keplerPositionM(elements, jdEnd + (p.t_s - tEnd) / 86_400))
              .sub(keplerEnd)
              .add(bodyEnd)
          : liveVecFromState(departureBodyState, p.t_s - tEnd)
      return sceneVecFromMeters(p.x_m, p.y_m, p.z_m).sub(bodyAt)
    })
  }, [result.pre_departure_orbit_arc, departureBodyState, departureBodyName, result.dep_jd, arcT0S])
  const preDepartureOrbitPoints = useMemo(() => {
    const src = result.pre_departure_orbit_arc
    if (!src || src.length === 0) return null
    if (preOrbitOffsets) return preOrbitOffsets.map((o) => o.clone().add(departurePos))
    return src.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m))
  }, [result.pre_departure_orbit_arc, preOrbitOffsets, departurePos])

  const parkingOrbitRadiusScene = useMemo(() => {
    if (preDepartureOrbitPoints) {
      const sum = preDepartureOrbitPoints.reduce((acc, p) => acc + p.distanceTo(departurePos), 0)
      return sum / preDepartureOrbitPoints.length
    }
    if (departurePosIsReal) return arcStartPos.distanceTo(departurePos)
    return (departureBody?.radius_m ?? 6_378_137) * SCENE_SCALE * 1.05
  }, [preDepartureOrbitPoints, departurePosIsReal, arcStartPos, departurePos, departureBody])
  // Falls back to the old circular approximation only when the backend
  // didn't return real data (an older result, or a method that doesn't
  // populate this field) -- real data always wins when present.
  const parkingOrbitRingPoints = useMemo(
    () => preDepartureOrbitPoints ?? ringPositions(departurePos, parkingOrbitRadiusScene, 64),
    [preDepartureOrbitPoints, departurePos, parkingOrbitRadiusScene],
  )

  // Same real-data-over-approximation upgrade for the post-capture orbit --
  // `post_capture_orbit_arc` is only present when `mga_ms_converged` is
  // true (or always, for GA/PSO) -- see its own openapi.json doc comment.
  // Already heliocentric since (Phase 12k, see the
  // pre_departure_orbit_arc comment above) -- no .add(targetPos) here.
  // captureRadiusM (the sidebar's configured value) remains the fallback
  // for a result that doesn't have it.
  // Same time-resolved re-anchoring as preOrbitOffsets above,
  // with two differences forced by the 273-day gap to targetBodyState's
  // fetch epoch: (1) the body's motion across the ring's own 12-day span
  // comes from the Standish Kepler elements (keplerPositionM -- real
  // elliptical relative motion; the circular liveVecFromState extrapolation
  // accumulates ~e·a-scale radial error over 273 days, which for Mars
  // (e=0.09) would distort the ring by more than its own size), and (2)
  // only RELATIVE motion is used, de-biased so the ring's first sample
  // lands exactly on targetPos (target_r_arr_m, the backend's real arrival
  // position -- the same anchor the capture ring/burn markers already
  // use); the absolute Kepler position can be ~100,000 km off, but that
  // bias cancels in the difference. Measured need, not hypothetical: the
  // Mars example's post_capture_orbit_arc spans 24.9 MILLION km
  // heliocentrically (two 6-day e=0.9 periods of Mars's own motion) --
  // drawn as-is it was a giant scrawl, and captureOrbitRadiusScene (which
  // feeds arrival camera framing) inflated to millions of km.
  const postOrbitOffsets = useMemo(() => {
    const src = result.post_capture_orbit_arc
    if (!src || src.length === 0) return null
    if (isFrozenOriginOrbit(src)) return null
    const elements = PLANET_ELEMENTS[targetBodyName]
    if (!elements) return null
    const captureS = result.capture_time_s ?? achievedArrivalS
    const jd0 = result.dep_jd + captureS / 86_400
    const t0 = src[0].t_s
    // De-bias against the BODY, not against post[0] (real bug, user
    // screenshot "the ellipse is not connected to the transfer
    // arc... and seems to go below mars' surface"): the first cut anchored
    // post[0] -- the orbit's PERIAPSIS POINT -- onto targetPos, which is
    // measured to be Mars's CENTER at the capture epoch (target_r_arr_m
    // sits 5 km from the real Mars ephemeris; post[0] sits 6,681 km out,
    // exactly the configured periapsis). That shifted the whole ellipse by
    // one periapsis vector: periapsis at the planet's center, far side
    // dipping through the surface, and a visible gap to the transfer arc.
    // Correct de-bias: body(epoch_i) ≈ targetPos + (kepler_i − kepler_0)
    // (targetPos IS the real body center at epoch_0; Standish's ~100k-km
    // absolute bias cancels in the difference), so offset_i =
    // post_i − kepler_i + kepler_0 − targetPos is the orbit's true
    // Mars-centered geometry -- periapsis 6,681 km from the mesh, ellipse
    // meeting the transfer arc's end at the real capture point (339 km
    // between arc(capture) and post[0] in the data).
    const targetPosSnapshot = targetPos.clone()
    const body0 = sceneVecFromEclipticMeters(...keplerPositionM(elements, jd0))
    return src.map((p) => {
      const body = sceneVecFromEclipticMeters(...keplerPositionM(elements, jd0 + (p.t_s - t0) / 86_400))
      return sceneVecFromMeters(p.x_m, p.y_m, p.z_m).sub(body).add(body0).sub(targetPosSnapshot)
    })
  }, [result.post_capture_orbit_arc, result.capture_time_s, result.dep_jd, targetBodyName, achievedArrivalS, targetPos])
  const postCaptureOrbitPoints = useMemo(() => {
    const src = result.post_capture_orbit_arc
    if (!src || src.length === 0) return null
    if (postOrbitOffsets) return postOrbitOffsets.map((o) => o.clone().add(targetPos))
    return src.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m))
  }, [result.post_capture_orbit_arc, postOrbitOffsets, targetPos])

  const captureOrbitRadiusScene = useMemo(() => {
    if (postCaptureOrbitPoints) {
      const sum = postCaptureOrbitPoints.reduce((acc, p) => acc + p.distanceTo(targetPos), 0)
      return sum / postCaptureOrbitPoints.length
    }
    return captureRadiusM != null ? captureRadiusM * SCENE_SCALE : null
  }, [postCaptureOrbitPoints, captureRadiusM, targetPos])
  const captureOrbitRingPoints = useMemo(() => {
    if (postCaptureOrbitPoints) return postCaptureOrbitPoints
    return captureOrbitRadiusScene != null ? ringPositions(targetPos, captureOrbitRadiusScene, 64) : []
  }, [postCaptureOrbitPoints, targetPos, captureOrbitRadiusScene])

  // Tightened (review round item 11b: "zoom in tightly enough
  // that only the spacecraft and the relevant body are in frame -- not much
  // more"). *8 / a 3-unit floor left real headroom around the body at close
  // framing; *5 and a 2-unit floor read as a genuinely tight two-object
  // frame without clipping the body itself.
  //
  // Real bug, found alongside the real-parking-orbit wiring
  // above (
  // crash into the planet"): these floors (1.4 / MIN_CLOSE_FRAMING_DIST=2
  // scene units) were tuned against the OLD circular approximation, which
  // (before today's fix) was SOI-exit-scale -- hundreds of thousands of km,
  // already far bigger than either floor, so the floors rarely bound and
  // "*3.5"/"*5" alone drove the framing distance. Now that
  // parkingOrbitRadiusScene/captureOrbitRadiusScene are the REAL, much
  // smaller orbit scale (a few hundred km of altitude, only slightly larger
  // than the body's own radius), those same multipliers produce a tiny
  // scene-unit distance and the ABSOLUTE floors take over completely --
  // 1.4/2 scene units is enormous relative to a real body's true radius
  // (Earth's is ~0.0064 scene units), so the camera was landing hundreds of
  // body-radii out at "close" framing: comfortably past
  // EXAGGERATION_FAR_RATIO (9 body-radii, see sceneShared.tsx), meaning the
  // body rendered at FULL 90x exaggerated size right as the camera was
  // supposed to be at its closest and tightest. Fixed by flooring on the
  // relevant body's own TRUE radius instead of an absolute scene-unit
  // constant -- tied directly to EXAGGERATION_NEAR_RATIO (sceneShared.tsx)
  // now, not a separately-tuned number that can drift out of sync with it
  // again. Real bug, found in THIS SAME fix's first cut: a flat
  // *5 multiplier sat just past EXAGGERATION_NEAR_RATIO (3.5), still ~40%
  // into the exaggeration ramp (~17x, not 1x) -- the body rendered large
  // enough to swallow the (correctly, now, positioned) parking-orbit ring
  // entirely. `smoothstep` clamps to exactly 0 (true 1x scale) for any
  // distance AT OR BELOW its edge0, so flooring just inside
  // EXAGGERATION_NEAR_RATIO -- not somewhere in the 3.5-9 ramp -- guarantees
  // the body renders at its real physical size during an actual close
  // encounter, while still comfortably framing the real parking/capture
  // orbit (~1.03-1.8x body radius) inside that view.
  const departureTrueRadiusScene = Math.max((departureBody?.radius_m ?? 6_378_137) * SCENE_SCALE, 1e-6)
  const targetTrueRadiusScene = Math.max((targetBody?.radius_m ?? 3_396_200) * SCENE_SCALE, 1e-6)
  const ABSOLUTE_MIN_FRAMING_DIST = 0.05
  const CLOSE_FRAMING_RADIUS_MULTIPLIER = EXAGGERATION_NEAR_RATIO * 0.9
  // Departure gets its OWN, tighter multiplier (
  // starting positions to be closer to the departure body... so you can
  // see the parking orbit"). The shared CLOSE_FRAMING_RADIUS_MULTIPLIER
  // above (13.5x body radius) was originally tied to EXAGGERATION_NEAR_RATIO
  // so the old "1-body mode" size ramp would land exactly at true scale by
  // the time the camera got this close -- that ramp is gone entirely now
  // ("always true size unless hovered"), so this coupling is
  // no longer load-bearing and departure is free to use its own value. The
  // real parking orbit sits only ~1.03-1.05x the body's own radius out --
  // at 13.5 body-radii viewing distance that few-percent gap was too few
  // pixels wide to read as a distinct ring, not swallowed by the planet's
  // disc so much as just too close to it to notice. Halved-ish to 6x,
  // still comfortably fitting the whole body in frame.
  const DEPARTURE_FRAMING_RADIUS_MULTIPLIER = 6
  const closeDistDeparture = Math.max(parkingOrbitRadiusScene * 3, departureTrueRadiusScene * DEPARTURE_FRAMING_RADIUS_MULTIPLIER, ABSOLUTE_MIN_FRAMING_DIST)
  const closeDistArrival = Math.max((captureOrbitRadiusScene ?? parkingOrbitRadiusScene) * 2, targetTrueRadiusScene * CLOSE_FRAMING_RADIUS_MULTIPLIER, ABSOLUTE_MIN_FRAMING_DIST)
  // Still used below for MGA per-leg/flyby framing (legCameraDistances,
  // followDistance) -- those aren't body-radius-scaled by this fix, kept as
  // the same flat absolute floor they always were.
  const MIN_CLOSE_FRAMING_DIST = 2
  const wideDist = useMemo(() => {
    const box = new THREE.Box3()
    linePoints.forEach((p) => box.expandByPoint(p))
    box.expandByPoint(sunPos)
    const size = new THREE.Vector3(); box.getSize(size)
    return Math.max(size.length() * 0.35, 5)
  }, [linePoints, sunPos])

  // Full body-encounter chain: departure, each intermediate flyby, final
  // target -- length = legCount + 1, matches bodySequence for MGA.
  const encounterPositions = useMemo(
    () => [departurePos, ...flybyPositions, targetPos],
    [departurePos, flybyPositions, targetPos],
  )

  // legSegments (arc split into one colour-cycled polyline per leg) comes
  // from the shared `mga` derivation above now.

  // Display-only densification (
  // the animation... finer stepsizes... by simply interpolating") -- a
  // smooth spline through the SAME real per-leg points, resampled more
  // densely, purely for how the rendered line looks. Every other use of
  // legSegments (camera framing, leg-boundary/encounter-position math)
  // deliberately stays on the original, real points -- only the drawn
  // `<Line>` below uses this.
  const smoothLegSegments = useMemo(
    () => legSegments.map((seg) => ({ ...seg, points: densifyCurvePoints(seg.points) })),
    [legSegments],
  )

  // EXPERIMENTAL, opt-in via SHOW_SMOOTHED_SPACECRAFT_POSITION below
  // (
  // the one we show. So there's coherence between the s/c dot and the
  // trajectory... a bit cheating, as it would not be the original data
  // from the backend, but i want to see what that looks like"). Builds one
  // real THREE.CatmullRomCurve3 per leg -- the SAME centripetal
  // construction densifyCurvePoints already does internally for the
  // rendered line -- so the spacecraft dot can sample the identical curve
  // via getPointAt() instead of doing its own separate raw linear
  // interpolation (sampleArcPosition) between the same real points. Built
  // directly from each leg's REAL points (not the already-densified
  // smoothLegSegments), since CatmullRomCurve3.getPointAt already
  // interpolates continuously -- no need to construct a second curve from
  // an already-resampled one. Explicitly scoped to ONLY the dot's own
  // position: legSegments/smoothLegSegments (colours, the rendered line
  // itself), camera framing, burn/encounter markers, and every other real
  // position in this view are completely untouched by this.
  const legCurves = useMemo(
    () =>
      legSegments.map((seg) =>
        seg.points.length >= 3 ? new THREE.CatmullRomCurve3(seg.points, false, "centripetal", 0.5) : null,
      ),
    [legSegments],
  )
  const legBoundariesForSampling = useMemo(
    () => [arcT0S, ...legBoundaryTimes, totalDurationS],
    [arcT0S, legBoundaryTimes, totalDurationS],
  )
  // Real bug, found and fixed (see the long history in
  // sampleSmoothedPosition's own comment below): each leg's own points
  // array starts at the GLOBAL result.arc index where that leg's own
  // real samples begin (the boundary sample is shared -- it's the last
  // point of the previous leg AND the first point of this one, matching
  // how the legSegments-building loop above pushes it to both). Needed to
  // convert a GLOBAL arc-index bracket (found once, below, the same way
  // sampleArcPosition already does) into a LOCAL fractional index within
  // the current leg's own control-point array.
  const legStartArcIndices = useMemo(() => {
    const starts: number[] = [0]
    for (let i = 1; i < result.arc.length; i++) {
      if ((result.arc[i].leg_idx ?? 0) !== (result.arc[i - 1].leg_idx ?? 0)) starts.push(i)
    }
    return starts
  }, [result.arc])
  const sampleSmoothedPosition = useCallback(
    (t: number): THREE.Vector3 => {
      let idx = 0
      for (let i = 0; i < legBoundariesForSampling.length - 2; i++) {
        if (t >= legBoundariesForSampling[i + 1]) idx = i + 1
      }
      idx = Math.min(idx, legCurves.length - 1)
      const curve = legCurves[idx]
      if (!curve) return sampleArcPosition(result.arc, t)
      // Binary-search the REAL arc for t's own bracketing global samples --
      // the same search sampleArcPosition does internally -- then convert
      // to a fractional CONTROL-POINT INDEX within this leg's own points
      // array (curve.getPoint, NOT curve.getPointAt -- see the comment
      // below for exactly why that distinction is the whole fix).
      const arc = result.arc
      if (arc.length === 0) return new THREE.Vector3()
      let lo = 0
      let hi = arc.length - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (arc[mid].t_s <= t) lo = mid
        else hi = mid
      }
      const a = arc[lo]
      const b = arc[hi]
      const timeFrac = b.t_s === a.t_s ? 0 : THREE.MathUtils.clamp((t - a.t_s) / (b.t_s - a.t_s), 0, 1)
      const globalFracIdx = lo + timeFrac
      const legStartIdx = legStartArcIndices[idx] ?? 0
      const pointCount = curve.points.length
      const localFracIdx = THREE.MathUtils.clamp(globalFracIdx - legStartIdx, 0, pointCount - 1)
      return curve.getPoint(pointCount > 1 ? localFracIdx / (pointCount - 1) : 0)
    },
    [legCurves, legBoundariesForSampling, legStartArcIndices, result.arc],
  )
  // Real bug, found and fixed. An early suspicion ("could it
  // be your interpolation has altered the trajectory too much... I almost
  // can't believe the interpolation can cause such a weird deflection")
  // was exactly right, and worse than either of us guessed at first: a
  // throwaway script measured the smoothed dot's deviation from the real
  // backend position at Cassini's own DSM 5 (leg 5, Jupiter->Saturn) at
  // **~21.2 MILLION km**. Root cause: the ORIGINAL version of
  // `sampleSmoothedPosition` fed a TIME-based fraction (real elapsed time
  // within the leg, normalized 0-1) into `curve.getPointAt(frac)` --
  // `getPointAt` parameterizes by ARC LENGTH, not by time or by
  // control-point order, silently assuming constant speed along the
  // curve. Real spacecraft speed is wildly non-constant (fast near a
  // flyby, slow in cruise) AND this leg's own raw sample spacing is
  // wildly non-uniform in time (the same "coarse sampling" issue
  // documented throughout this file for Jupiter's leg) -- so a
  // time-fraction and an arc-length-fraction can point at completely
  // different places on the curve. Turned off entirely as an immediate
  // fix at the time. **Now properly fixed** (not just reverted) per the
  // a follow-up refinement ("i really prefer the interpolated s/c state
  // too... but only if it doesn't cause these kind of issues"):
  // `sampleSmoothedPosition` above now derives a fractional CONTROL-POINT
  // INDEX from `t` (the same bracket search `sampleArcPosition` already
  // does, just kept as a fractional index instead of collapsing straight
  // to a lerped position) and calls `curve.getPoint(indexFrac)` -- NOT
  // `getPointAt` -- which walks the curve by control-point order, the
  // same order the real samples are already in. This was confirmed safe
  // BEFORE shipping, not just asserted: a throwaway script compared
  // `getPoint(indexFrac)` against the real backend position at exactly
  // Cassini's own DSM 5 moment and got ZERO deviation. NOTE this fixes the
  // dot's OWN motion smoothness only -- it does NOT and CANNOT make the
  // dot pass exactly through the DSM marker if the marker's reported
  // position doesn't sit on `result.arc` in the first place, which turned
  // out to be a real, separate, non-frontend-fixable issue (see
  // `dsmPositionsM`'s own comment in `mgaSceneData.ts` for why: MGA's
  // reported DSM position and the real converged arc can come from
  // different physics when multiple-shooting refinement hasn't fully
  // converged, `mga_ms_converged: false`, which it is for this exact
  // Cassini result).
  const SHOW_SMOOTHED_SPACECRAFT_POSITION = true
  const sampleSpacecraftPosition = SHOW_SMOOTHED_SPACECRAFT_POSITION
    ? sampleSmoothedPosition
    : (t: number) => sampleArcPosition(result.arc, t)

  // Per-leg chase-cam framing distance: a loose zoom fitting that leg's arc
  // shape plus its two endpoint bodies, per the Artemis/Orion camera
  // reference the user supplied (the design notes note) -- close enough
  // to read the loop/flyby geometry, wide enough not to crop it. Falls back
  // to the existing single-leg closeDistDeparture formula for GA/PSO so that
  // behaviour is unchanged.
  const legCameraDistances = useMemo(() => {
    if (!isMga) return [closeDistDeparture]
    return legSegments.map((seg, idx) => {
      const box = new THREE.Box3()
      seg.points.forEach((p) => box.expandByPoint(p))
      box.expandByPoint(encounterPositions[idx] ?? seg.points[0])
      box.expandByPoint(encounterPositions[idx + 1] ?? seg.points[seg.points.length - 1])
      const size = new THREE.Vector3(); box.getSize(size)
      // Tightened 0.4 -> 0.28 alongside closeDistDeparture/Arrival above,
      // same item-11b framing goal for MGA's per-leg chase distance.
      return Math.max(size.length() * 0.28, MIN_CLOSE_FRAMING_DIST)
    })
  }, [isMga, legSegments, encounterPositions, closeDistDeparture])

  const [perturberPositions, setPerturberPositions] = useState<Record<string, THREE.Vector3>>({})
  const handlePerturberPosition = useCallback((name: string, pos: THREE.Vector3) => {
    setPerturberPositions((prev) => prev[name]?.equals(pos) ? prev : { ...prev, [name]: pos })
  }, [])

  const fitAllDist = useMemo(() => {
    const box = new THREE.Box3()
    linePoints.forEach((p) => box.expandByPoint(p))
    box.expandByPoint(sunPos)
    box.expandByPoint(departurePos)
    box.expandByPoint(targetPos)
    Object.values(perturberPositions).forEach((p) => box.expandByPoint(p))
    const size = new THREE.Vector3(); box.getSize(size)
    return Math.max(size.length() * FIT_ALL_DISTANCE_FACTOR, 5)
  }, [linePoints, sunPos, departurePos, targetPos, perturberPositions])

  // Real gap, found (review round item 4): the ecliptic reference
  // grid was fixed at a 2 AU outer radius regardless of mission scale, so an
  // outer-planet mission had no reference rings past 2 AU at all. Derived
  // from the same real positions fitAllDist already uses (arc + Sun +
  // departure/target + perturbers), converted to AU -- EclipticGrid then
  // builds rings out to this real extent instead of a fixed set.
  //
  // Floored at Neptune's own real semi-major axis, not just the mission's
  // own bodies (
  // outer planets, always") -- an inner-planet mission (e.g. Earth->Mars)
  // previously left the grid stopping at ~1.5 AU even though the decorative
  // background planets (added) already render out to Neptune,
  // reading as inconsistent. `PLANET_ELEMENTS` is already imported for the
  // decorative-planet/ring rendering below, so this is free real data, not
  // a hardcoded constant.
  const NEPTUNE_A0_AU = PLANET_ELEMENTS.Neptune?.a0 ?? 30.1
  const outerExtentAU = useMemo(() => {
    let maxR = sunPos.distanceTo(departurePos)
    maxR = Math.max(maxR, sunPos.distanceTo(targetPos))
    linePoints.forEach((p) => { maxR = Math.max(maxR, sunPos.distanceTo(p)) })
    Object.values(perturberPositions).forEach((p) => { maxR = Math.max(maxR, sunPos.distanceTo(p)) })
    return Math.max(maxR / AU_SCENE, NEPTUNE_A0_AU)
  }, [sunPos, departurePos, targetPos, linePoints, perturberPositions, NEPTUNE_A0_AU])

  const captureBurnPos = useMemo(
    () => (result.capture_time_s != null ? sampleArcPosition(result.arc, result.capture_time_s) : null),
    [result.arc, result.capture_time_s],
  )

  const [spacecraftPos, setSpacecraftPos] = useState(() => arcStartPos.clone())
  const [spacecraftVel, setSpacecraftVel] = useState(() => new THREE.Vector3(1, 0, 0))

  // Pre-departure orbiting flourish, REDESIGNED (
  // not do parking orbiting first and then it moves onto the trajectory...
  // we let it orbit the parking orbit when the animation is not running
  // (like the planets are also always spinning). Then when we start
  // simulation it leaves the orbit"). Earlier same-day cut (see the
  // deleted comment this replaces) tied the orbit to a fixed "preroll"
  // hold with an eased deceleration timed to end exactly when the hold
  // did -- correct for THAT design, but the wrong shape for this one: an
  // indefinite, continuous idle animation (same idiom as a planet's own
  // spin, which never stops either) doesn't have an "end" to decelerate
  // toward, so it's back to a flat constant angular rate. The SPEED
  // mismatch concern the deceleration was originally solving for is now
  // handled by the departure ramp-in below instead (a smooth ease-in on
  // the TRAJECTORY side of the handoff), not by slowing the orbit down to
  // meet it. Runs whenever the spacecraft hasn't "left" the parking orbit
  // yet -- "idle" (resting, before Play is ever pressed) and "preroll"
  // (the camera fly-in/settle beat right after Play, before the mission
  // clock starts advancing) -- and stops the instant `playbackState`
  // becomes `"playing"`. Samples a closed curve through the real
  // parking-orbit ring (parkingOrbitRingPoints, real propagated data when
  // available, a circular approximation otherwise) via a LOCAL wall-clock
  // timer completely independent of elapsedS/mission time, so it can
  // never skew the date readout, the slider, or anything that treats
  // elapsedS as real mission time.
  const parkingOrbitCurve = useMemo(
    () => (parkingOrbitRingPoints.length >= 3 ? new THREE.CatmullRomCurve3(parkingOrbitRingPoints, true) : null),
    [parkingOrbitRingPoints],
  )
  const orbitElapsedRef = useRef(0)
  const PARKING_ORBIT_PERIOD_S = 3.5
  useFrame((_, delta) => {
    if ((playbackState !== "idle" && playbackState !== "preroll") || !parkingOrbitCurve) return
    orbitElapsedRef.current += delta
    const frac = (orbitElapsedRef.current / PARKING_ORBIT_PERIOD_S) % 1
    setSpacecraftPos(parkingOrbitCurve.getPointAt(frac))
  })

  // Same idea as the parking-orbit idle loop above, mirrored for arrival
  // (
  // before the animation with letting the s/c orbit the dep body)") --
  // once playback reaches "done", the spacecraft keeps circling the real
  // capture orbit ring instead of just sitting still at the last sampled
  // point. Same local wall-clock timer (independent of elapsedS/mission
  // time), same closed-curve-through-the-real-ring approach.
  const captureOrbitCurve = useMemo(
    () => (captureOrbitRingPoints.length >= 3 ? new THREE.CatmullRomCurve3(captureOrbitRingPoints, true) : null),
    [captureOrbitRingPoints],
  )
  const arrivalOrbitElapsedRef = useRef(0)
  const ARRIVAL_ORBIT_PERIOD_S = 3.5
  useFrame((_, delta) => {
    if (playbackState !== "done" || !captureOrbitCurve) return
    arrivalOrbitElapsedRef.current += delta
    const frac = (arrivalOrbitElapsedRef.current / ARRIVAL_ORBIT_PERIOD_S) % 1
    setSpacecraftPos(captureOrbitCurve.getPointAt(frac))
  })

  // "Zoom to S/C" button (ask) -- fires the same scripted
  // fly-in a body/burn-marker click already triggers, just aimed at the
  // spacecraft's current position instead. Version-bump idiom so a repeated
  // click while already focused still re-fires the fly-in (an unchanged
  // trigger value would look like a no-op otherwise).
  const prevZoomToShipTriggerRef = useRef(zoomToShipTrigger)
  useEffect(() => {
    if (zoomToShipTrigger === undefined || zoomToShipTrigger === prevZoomToShipTriggerRef.current) return
    prevZoomToShipTriggerRef.current = zoomToShipTrigger
    onRequestFocus(spacecraftPos)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomToShipTrigger])
  // Starts at arcT0S (the arc's own real first t_s, negative when a real
  // escape leg precedes t=0 -- see arcT0S's own comment above), not a
  // hardcoded 0, so playback actually begins at the arc's real first point
  // instead of skipping ahead into the middle of the escape leg.
  const [elapsedS, setElapsedS] = useState(() => arcT0S)
  const elapsedSRef = useRef(arcT0S)
  // Real, measured bug, found (
  // the animation, the s/c dot moves a bit buggy... not much, its not
  // very bad, but a little"). Confirmed numerically (a throwaway script
  // sampling sampleSmoothedPosition/sampleArcPosition at fixed small real-
  // time steps across each leg boundary against the real Cassini
  // snapshot): right at Jupiter's leg boundary specifically, the local
  // step-to-step speed genuinely dips to roughly HALF its immediate
  // neighbours' speed for one sample, then recovers -- a real, brief
  // "stutter." Root cause is centripetal Catmull-Rom's local tangent
  // estimate reacting to a sharp transition in the underlying real arc's
  // own sampling density right at that point (confirmed NOT a per-leg-
  // curve-splitting artifact specifically -- rebuilding the same test
  // against a single curve spanning the WHOLE arc, ignoring leg
  // boundaries entirely, reproduced the exact same dip, byte-for-byte).
  // Since the underlying cause is inherent to interpolating through
  // genuinely non-uniformly-sampled real data (not a bug in how the curve
  // is split), fixed by lightly smoothing the TIME fed into position
  // sampling rather than chasing the curve math further: a short
  // exponential lag (SPACECRAFT_TIME_SMOOTHING_HZ) absorbs a momentary
  // local speed hiccup from whatever's driving it, without touching the
  // real elapsedS used for the date readout/timeline slider (those stay
  // exact -- only what feeds the DOT's own position is smoothed). Seeking
  // snaps this instantly to the target time (see the seek handler below)
  // so manual scrubbing never feels laggy.
  const smoothedElapsedRef = useRef(arcT0S)
  const SPACECRAFT_TIME_SMOOTHING_HZ = 6.0

  // Gravity-assist glow intensity (ask, see
  // GravityAssistGlow's own comment for the visual). Smoothly ramps 0->1
  // as elapsedS approaches the NEAREST flyby's real closest-approach
  // instant (flybyClosestTimes), peaks exactly at the encounter, and fades
  // back to 0 -- same window (GRAVITY_ASSIST_GLOW_WINDOW_S) the flyby
  // highlight segment's own real-time radius uses (mgaSceneData.ts's
  // HIGHLIGHT_TIME_RADIUS_S), so the glow appears across exactly the
  // stretch that's already visually highlighted, not a separately-tuned
  // window. Takes the MAX across all flybys (only one is ever relevant at
  // a time in practice, given real flyby spacing).
  const gravityAssistIntensity = useMemo(() => {
    if (!isMga || flybyClosestTimes.length === 0) return 0
    let intensity = 0
    for (const t of flybyClosestTimes) {
      const d = Math.abs(elapsedS - t)
      intensity = Math.max(intensity, 1 - smoothstep(0, GRAVITY_ASSIST_GLOW_WINDOW_S, d))
    }
    return intensity
  }, [isMga, flybyClosestTimes, elapsedS])

  // Mission-time instants worth lingering on during playback: departure,
  // every MGA flyby, arrival, and the capture burn if any (user
  // feedback, item 10: "zoom in further and linger ... at departure/each
  // flyby/arrival specifically so the local geometry reads clearly, then
  // zoom out and move faster through interplanetary cruise"). Also folds in
  // item 5's "buckle" complaint: a real close encounter genuinely takes very
  // little mission time relative to the whole transfer, so under the old
  // constant-speed mapping it could flash past in a single frame or two,
  // reading as a paused/skipped moment rather than visible motion -- slowing
  // the clock near every event makes that geometry visible instead of
  // instantaneous, whether or not the specific kink the user saw turns out
  // to be real dynamics or a propagator artifact (still an open question,
  // see the design notes).
  // Real bug, found (
  // accelrating inside the flyby window (it slower down before)"). Same
  // root cause class as the slider-tick/peak-boost misalignment fixed
  // earlier: this used to center each flyby's slowdown on the
  // raw leg-BOUNDARY time (legBoundaryTimes), not the real closest-approach
  // instant (flybyClosestTimes) -- for Jupiter specifically, that gap was
  // large enough that the linger's minimum-speed point landed well away
  // from where the actual close-approach geometry happens, so playback
  // read as slowing down approaching a point that wasn't the real
  // encounter, then speeding back up WHILE the real encounter was still
  // in progress. Falls back to the boundary time only for a flyby with no
  // known orbital elements to search against (matching
  // computeFlybyClosestApproach's own fallback).
  const missionEventTimesS = useMemo(() => {
    const times = [arcT0S, ...legBoundaryTimes.map((t, i) => flybyClosestTimes[i] ?? t), totalDurationS]
    if (result.capture_time_s != null) times.push(result.capture_time_s)
    return times
  }, [arcT0S, legBoundaryTimes, flybyClosestTimes, totalDurationS, result.capture_time_s])
  // Real mission SPAN (not the raw absolute totalDurationS number, which is
  // now offset by arcT0S) -- used for pacing/window sizing so the real
  // escape-leg prefix doesn't skew how "28 seconds of playback" maps onto
  // the mission, or how wide the departure linger window is.
  const missionSpanS = totalDurationS - arcT0S
  // Strengthened (review round item 11a: "still not sufficiently
  // done ... enough to actually see the flyby geometry"). 0.15/0.04 eased
  // off too quickly to read a flyby's geometry before speeding back up;
  // 0.06 (slower at the event itself) over a wider window (0.07 of total
  // mission duration) gives noticeably more real time at each event.
  const EVENT_LINGER_MIN_FACTOR = 0.06
  const eventLingerWindowS = Math.max(missionSpanS * 0.07, 1)
  // Departure gets its own, stronger linger (
  // at departure and depart slower") -- a wider window (it starts easing
  // down sooner) and a lower floor (it gets slower at its slowest point)
  // than every other event, which all still share the settings above.
  const DEPARTURE_LINGER_MIN_FACTOR = 0.025
  const departureLingerWindowS = eventLingerWindowS * 1.8
  // Real bug, found (
  // slow... delay the steps a lot so the s/c doesnt shoot away in the
  // beginning"). The departure linger above is sized relative to the
  // WHOLE MISSION span (missionSpanS * 0.07 * 1.8) -- but the real escape
  // leg itself (arcT0S to t_s=0, the actual hyperbolic-departure transit)
  // is only a few real DAYS long (e.g. ~2.46 days for the Cassini
  // snapshot). Even the departure linger's own floor (2.5% speed) still
  // advances mission-time at ~3 real days per real second at typical
  // mission-span compression -- fast enough to blow through the ENTIRE
  // escape leg in well under a second, reading exactly as "shoots away."
  //
  // REDESIGNED (user, after the first cut: "not really great...
  // for the very first part of the trajectory, put some tiny pauses
  // between the steps... it slowly increases speed"). The original fix
  // was a SECOND, separate speedFactor floor taken via Math.min alongside
  // the existing per-event linger -- correct in principle, but it produced
  // a real two-stage speed profile: rock-bottom for its own short window,
  // then a JUMP up to whatever the outer departure linger's floor already
  // was the moment that window ended, since the two floors don't hand off
  // continuously into each other. Replaced with a single MULTIPLICATIVE
  // ramp instead of a second competing floor: speed is scaled by a
  // smoothly, monotonically increasing factor from RAMP_MIN_FACTOR up to
  // 1.0 as elapsedS moves from arcT0S across the first RAMP_FRACTION of
  // the FIRST LEG's own real duration (not the whole mission -- keeps this
  // proportional to how long the departure leg itself actually is), a
  // cubic ease-in (slow start, accelerating) applied ON TOP of whatever
  // the existing per-event linger system already computes. One continuous
  // acceleration curve now, not two floors handing off abruptly.
  // Real bug, found (user, testing the new direct-transfer
  // Mercury GA preset: playback appeared to freeze indefinitely right
  // after departure). Root-caused with real numbers, not guessed: a
  // throwaway diagnostic logged `speedFactor` every frame and found it
  // pinned at EXACTLY `RAMP_MIN_FACTOR * DEPARTURE_LINGER_MIN_FACTOR`
  // (0.00075) for the entire captured window, never easing up. The bug is
  // in the `?? totalDurationS` fallback below: for an MGA mission,
  // `legBoundaryTimes[0]` is the first REAL leg boundary -- typically a
  // small fraction of the whole mission (Cassini's first Earth->Venus leg
  // is ~4% of its total ~3562-day span), so `rampWindowS` (and the real
  // WALL-CLOCK time needed to clear it, which is proportional to
  // `firstLegDurationS / missionSpanS` and -- critically -- independent
  // of the mission's absolute length otherwise) stays a small slice of
  // the ~28-second playback target. A single-leg GA/PSO result has no
  // `legBoundaryTimes` at all, so the fallback used the ENTIRE mission
  // span instead -- for Mercury (achieved TOF ~103 days), that's a
  // firstLeg/missionSpan ratio of 1.0 instead of Cassini's ~4%, a ~24x
  // blowup translating to roughly 560 real SECONDS (worked out
  // algebraically: `TARGET_PLAYBACK_SECONDS * RAMP_FRACTION * ratio /
  // (RAMP_MIN_FACTOR * DEPARTURE_LINGER_MIN_FACTOR)`, and this scales
  // with the RATIO only -- the mission's absolute duration cancels out)
  // instead of the ~20 real seconds an MGA mission's own first leg
  // typically costs -- reading as "frozen," not just "slow." Fixed by
  // giving the no-real-leg-boundary case its own small FRACTION of
  // missionSpanS (chosen to land in the same real-time-cost ballpark as
  // MGA's typical first-leg ratio) instead of the whole mission.
  const SINGLE_LEG_RAMP_FALLBACK_FRACTION = 0.04
  const firstLegDurationS = legBoundaryTimes[0] !== undefined
    ? Math.max(legBoundaryTimes[0] - arcT0S, 1)
    : Math.max(missionSpanS * SINGLE_LEG_RAMP_FALLBACK_FRACTION, 1)
  const RAMP_FRACTION = 0.015
  const RAMP_MIN_FACTOR = 0.03
  const rampWindowS = firstLegDurationS * RAMP_FRACTION
  // A direct transfer (single-leg GA/PSO, no flybys) has far less real
  // choreography than an MGA tour -- just departure, cruise, arrival -- so
  // the same ~28s target built for a multi-flyby mission reads as
  // sluggish (
  // animation a bit"; matches the Mercury preset's own honest "~55-60s vs
  // the nominal ~28s target" note). Shortened target for the non-MGA case
  // only -- MGA missions keep the pacing already tuned against Cassini.
  const TARGET_PLAYBACK_SECONDS_DIRECT = 16
  const targetPlaybackSecondsForMission = isMga ? TARGET_PLAYBACK_SECONDS : TARGET_PLAYBACK_SECONDS_DIRECT

  useFrame((_, delta) => {
    if (playbackState !== "playing" || missionSpanS <= 0) return
    const multiplier = missionSpanS / targetPlaybackSecondsForMission
    // Smooth per-event slowdown: 1x speed during cruise, easing down to
    // each event's own min-speed floor within its own window. Takes the
    // MINIMUM resulting speed factor across all events (the strongest
    // applicable slowdown), not a single shared proximityWeight, so
    // departure's stronger settings don't get diluted by also being
    // evaluated against the other events' weaker ones.
    let speedFactor = 1
    for (const evt of missionEventTimesS) {
      const isDeparture = evt === arcT0S
      const window = isDeparture ? departureLingerWindowS : eventLingerWindowS
      const minFactor = isDeparture ? DEPARTURE_LINGER_MIN_FACTOR : EVENT_LINGER_MIN_FACTOR
      const w = 1 - smoothstep(0, window, Math.abs(elapsedSRef.current - evt))
      speedFactor = Math.min(speedFactor, 1 - w * (1 - minFactor))
    }
    // Cubic ease-in, clamped to [0,1] before and after the ramp window --
    // rampT=0 (right at arcT0S) gives rampEase=0, so speed starts at
    // exactly RAMP_MIN_FACTOR of whatever the linger system alone would
    // have given; rampT=1 (rampWindowS later) gives rampEase=1, restoring
    // full speed with no discontinuity in VALUE (both sides meet at 1.0)
    // -- unlike the old two-floor version, the RATE of change is also
    // continuous throughout since this multiplies smoothly into the
    // existing speedFactor rather than competing with it via Math.min.
    const rampT = THREE.MathUtils.clamp((elapsedSRef.current - arcT0S) / rampWindowS, 0, 1)
    const rampEase = rampT * rampT * rampT
    const rampFactor = RAMP_MIN_FACTOR + (1 - RAMP_MIN_FACTOR) * rampEase
    speedFactor *= rampFactor
    elapsedSRef.current = Math.min(elapsedSRef.current + delta * multiplier * speedFactor, totalDurationS)
    smoothedElapsedRef.current +=
      (elapsedSRef.current - smoothedElapsedRef.current) * (1 - Math.exp(-SPACECRAFT_TIME_SMOOTHING_HZ * delta))
    const pos = sampleSpacecraftPosition(smoothedElapsedRef.current)
    const posAhead = sampleSpacecraftPosition(Math.min(smoothedElapsedRef.current + 1, totalDurationS))
    setSpacecraftPos(pos)
    setSpacecraftVel(posAhead.clone().sub(pos))
    setElapsedS(elapsedSRef.current)
    if (elapsedSRef.current >= totalDurationS) onDone()
  })

  // Scrub/seek (: "still missing the option to
  // scroll through time instead of only being able to play/pause/replay").
  // Runs every frame but is a no-op unless the parent's timeline slider
  // actually moved (version bump, same idiom as focusRequest above) --
  // works regardless of playbackState, including "paused", since scrubbing
  // needs to work whether or not playback is currently running.
  // Real bug, found (
  // slide the slider... the zoom and positioning [should] not [be] reset,
  // keep my manual view"): this used to ALSO call onRequestFocus(pos) on
  // every scrub, triggering CameraController's scripted fly-in to the new
  // spacecraft position -- meaning any manual pan/zoom/rotate was silently
  // discarded the instant the slider moved. That call was a deliberate
  // design choice at the time ("so the camera doesn't stay stuck wherever
  // it happened to be"), but the user now wants the opposite: scrubbing
  // should only move the spacecraft/body positions, never the camera. If
  // the camera needs re-centering after a big scrub, "Fit all" (or
  // double-clicking empty space) already does that on request.
  const lastSeekVersionRef = useRef<number | undefined>(undefined)
  useFrame(() => {
    if (!seekRequest || seekRequest.version === lastSeekVersionRef.current) return
    lastSeekVersionRef.current = seekRequest.version
    const s = THREE.MathUtils.clamp(seekRequest.s, arcT0S, totalDurationS)
    elapsedSRef.current = s
    smoothedElapsedRef.current = s
    const pos = sampleSpacecraftPosition(s)
    const posAhead = sampleSpacecraftPosition(Math.min(s + 1, totalDurationS))
    setSpacecraftPos(pos)
    setSpacecraftVel(posAhead.clone().sub(pos))
    setElapsedS(s)
  })

  // Reports the playback clock up to the parent purely for display (the
  // timeline slider's own position + the mission date/time readout) -- see
  // onElapsedChange's own doc comment above for why this can't just be read
  // from here directly.
  useEffect(() => {
    onElapsedChange(elapsedS)
  }, [elapsedS, onElapsedChange])

  // Live (moving) render positions for the departure/target bodies -- 2026-
  // 07-19 user feedback: "the bodies in the animation should move through
  // time... I thought that was obvious." Recomputed every render (cheap
  // vector math, no network call) from the one real state already fetched
  // above, extrapolated forward by however much playback time has elapsed
  // SINCE THAT FETCH'S OWN EPOCH (`elapsedS - arcT0S`, not raw `elapsedS`)
  // -- departureBodyState/targetBodyState are now fetched at `arcT0S`'s real
  // epoch (see effectiveDepartureEpoch above), not always t_s=0, so the
  // extrapolation delta has to account for that same shift or it'd be off
  // by however long the real escape leg takes. Rendering-only: every other
  // use of departurePos/targetPos in this file (rings, camera distances,
  // encounter positions) is deliberately left on the fixed reference
  // position so that tuned framing math doesn't shift.
  const departureLivePos = departureBodyState ? liveVecFromState(departureBodyState, elapsedS - arcT0S) : departurePos
  // Two-anchor interpolation, not a single-anchor extrapolation (real bug
  // fix): anchor A is the same real departure-epoch state
  // fetched above, anchor B is target_r_arr_m -- the backend's own real
  // propagated arrival position, already authoritative for the capture
  // ring/camera/burn marker but previously unused for the rendered mesh
  // itself. Interpolating between two known-true points instead of
  // extrapolating open-ended from one is what actually fixes the target
  // visibly drifting from its own capture ring on a long/outer-planet
  // transfer -- and it lands exactly on target_r_arr_m at/after arrival
  // instead of overshooting it. The interpolation fraction is now
  // (elapsedS - arcT0S) / missionSpanS, the real 0..1 progress through the
  // mission's real span, not raw elapsedS/totalDurationS (which would be
  // skewed by the arcT0S offset).
  // Real bug, found (
  // direction"). `interpolateHeliocentric`'s SLERP always takes the
  // SHORTER of the two possible rotations between the two anchor
  // directions (Quaternion.setFromUnitVectors never exceeds 180 deg) --
  // silently wrong whenever the body's real prograde sweep over the
  // mission is itself > 180 deg, which a slow target (Mars, an outer
  // planet) essentially never does over a realistic transfer, but a fast
  // one very much can: Mercury's real period is ~88 days, and this
  // preset's own achieved TOF (72-103 days across reruns) is a large
  // fraction of, or exceeds, a full Mercury year. The interpolated point
  // then swings the SHORT way around -- the geometric complement of the
  // real sweep -- which reads as motion in the opposite (retrograde)
  // sense.
  //
  // First fix attempted (same day, reverted): rendering the target's raw
  // `keplerPositionM` position directly, matching `flybyLivePositions`
  // above. Wrong -- and a real, immediately-visible regression, caught by
  // the user via screenshot ("the arrival orbit is not around mercury"):
  // the low-precision Standish-1992 model can differ from the real
  // backend-propagated `target_r_arr_m` by a fraction of a degree, which
  // at Mercury's ~57.9M km orbital radius is on the order of 100,000+ km
  // -- dwarfing the capture ring's own ~2,839 km scale, so the rendered
  // planet visibly missed its own ring/burn markers entirely. Flyby
  // bodies get away with the raw ephemeris position because nothing else
  // in the scene is anchored to their exact position the way the capture
  // ring/burn markers are anchored to the target's.
  //
  // Actual fix: `interpolateAroundAxis` (sceneShared.tsx) -- still lands
  // EXACTLY on the two real anchors (targetBodyState's fetched state,
  // target_r_arr_m) at t=0/t=1 like the old interpolateHeliocentric did,
  // but sweeps in the ephemeris model's real prograde SENSE and real
  // (possibly >360 deg) total angle in between, fixing the retrograde
  // artifact without reintroducing the drift the raw-position attempt
  // caused. The axis comes from two close-in-time raw Kepler samples
  // (their cross product) -- already in the same ecliptic-frame
  // convention `sceneVecFromEclipticMeters` expects, so no extra leveling
  // rotation is needed just to get a direction out of it. The total-angle
  // estimate comes from the element's own mean motion (`lDot`, deg/
  // century) times the real mission span in days.
  const targetLivePos = useMemo(() => {
    if (!targetBodyState || missionSpanS <= 0) return targetPos
    const anchorA = sceneVecFromMeters(targetBodyState.x_m, targetBodyState.y_m, targetBodyState.z_m)
    const elements = PLANET_ELEMENTS[targetBodyName]
    if (elements) {
      const jdDep = result.dep_jd + arcT0S / 86_400
      const [ax, ay, az] = keplerPositionM(elements, jdDep)
      const [bx, by, bz] = keplerPositionM(elements, jdDep + 0.01)
      const axis = new THREE.Vector3(ax, ay, az).cross(new THREE.Vector3(bx, by, bz))
      const meanMotionDegPerDay = elements.lDot / 36_525
      const missionSpanDays = missionSpanS / 86_400
      const estimatedTotalAngleRad = (meanMotionDegPerDay * missionSpanDays * Math.PI) / 180
      return interpolateAroundAxis(anchorA, targetPos, (elapsedS - arcT0S) / missionSpanS, axis, estimatedTotalAngleRad)
    }
    return interpolateHeliocentric(anchorA, targetPos, (elapsedS - arcT0S) / missionSpanS)
  }, [targetBodyState, targetPos, targetBodyName, result.dep_jd, elapsedS, arcT0S, missionSpanS])

  // Real gap, found (review round item 1): intermediate flyby
  // bodies used to render ONLY at their fixed encounter position -- static
  // throughout playback, unlike the departure/target bodies above, which
  // already move. User's explicit preferred fix (not "make everything
  // static," the alternative considered): keep each body's TRUE moving
  // position throughout playback, AND add a persistent marker at the exact
  // position the encounter actually happens (see EncounterMarker below), so
  // during playback the real moving body visibly passes through its own
  // encounter marker at the right moment. Reuses the same real Kepler
  // ephemeris (lib/keplerEphemeris.ts) the decorative background planets
  // already use -- no extra network fetch -- since MGA flyby targets are
  // overwhelmingly major planets. Falls back to the fixed encounter
  // position (no motion) for anything without catalogued elements (a moon
  // or small body flyby target), which is the previous, still-correct
  // behavior for that case.
  const flybyLivePositions = useMemo(() => {
    if (!isMga) return flybyPositions
    const jd = result.dep_jd + elapsedS / 86_400
    return flybyPositions.map((fixedPos, i) => {
      const name = bodySequence[i + 1]
      const elements = name ? PLANET_ELEMENTS[name] : undefined
      if (!elements) return fixedPos
      const [xM, yM, zM] = keplerPositionM(elements, jd)
      return sceneVecFromEclipticMeters(xM, yM, zM).add(sunPos)
    })
  }, [isMga, flybyPositions, bodySequence, result.dep_jd, elapsedS, sunPos])

  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  // Activate zoomToCursor once controls mount so scroll always zooms toward
  // the pointer position, not the orbit target - prevents zoom feeling slow
  // after panning.
  useEffect(() => {
    if (controlsRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(controlsRef.current as any).zoomToCursor = true
    }
  })

  const cameraPhase: CameraPhase =
    playbackState === "done" ? "done"
    : playbackState === "idle" ? "idle"
    : playbackState === "preroll" ? "preroll"
    : playbackState === "paused" ? "paused"
    : "playing"
  // "done" uses the LIVE target position (targetLivePos), matching what
  // arrivalFollowPoint converges to during the look-back rotation, not the
  // fixed reference targetPos -- keeps the fly-in and the rotation it's
  // completing pointed at the same spot.
  const cameraFocusPoint = cameraPhase === "done" ? targetLivePos : cameraPhase === "playing" ? spacecraftPos : departurePos

  // Which leg the spacecraft is currently on, from elapsed playback time vs
  // leg boundary times. Drives both the per-leg framing distance and (below)
  // the camera phase key that re-triggers a fresh scripted fly-in at each
  // flyby -- chaining departure close-up → each flyby → arrival the same way
  // the single-leg case already chains departure → transfer → arrival.
  const currentLegIndex = useMemo(() => {
    if (!isMga) return 0
    let idx = 0
    for (const t of legBoundaryTimes) {
      if (elapsedS >= t) idx++
      else break
    }
    return Math.min(idx, legCount - 1)
  }, [isMga, legBoundaryTimes, elapsedS, legCount])

  // Real bug, found (: "we don't start in fully
  // zoomed in geometry, making it hard to see the planet at all... better
  // to start/end in a good closed up view"). Idle used to rest at wideDist
  // (the full "fit all" framing) -- harmless on its own, but "preroll"
  // triggers a scripted CAMERA_FLY_DURATION_S fly-in on every phase change
  // FROM wherever the camera currently is, so clicking Play always paid for
  // a fresh wide-to-close flight even though idle had nothing to show at
  // that distance anyway. Idle now rests at the same close departure
  // framing preroll/playing start at, so there's no wide "establishing
  // shot" to fly in from at all -- "Fit all" remains available for anyone
  // who explicitly wants the wide overview.
  // Real bug, found (user, after the idle-framing fix still
  // wasn't enough: "you DIDNT FIX the camera view at the start of the
  // trajectory... MAKE IT START FROM A VIEW ZOOMED IN ON THE PARKING
  // ORBIT"). This comment already SAID preroll was supposed to share
  // idle's close departure framing -- the CODE never actually did that for
  // an MGA mission: only "idle" and "done" were special-cased, so
  // "preroll" (the phase active the instant Play is pressed, i.e. exactly
  // "the start of the trajectory" from the intended framing) fell
  // through to the isMga branch and used legCameraDistances[currentLegIndex]
  // instead -- the WHOLE FIRST LEG's bounding-box distance (departure all
  // the way to the first flyby, easily hundreds of scene units for a real
  // interplanetary leg), nothing like closeDistDeparture's tight,
  // body-radius-relative framing. This is why the earlier idle-only fix
  // never showed up when actually pressing Play: idle was fixed, but
  // preroll -- what you actually SEE when starting playback -- was not.
  const cameraFlyToDistance = cameraPhase === "idle" || cameraPhase === "preroll"
    ? closeDistDeparture
    : cameraPhase === "done"
      ? closeDistArrival * (1 + ARRIVAL_LOOK_BACK_PULLBACK_FACTOR)
      : (isMga ? legCameraDistances[currentLegIndex] : closeDistDeparture)

  const cameraPhaseKey = cameraPhase

  // Continuous-follow zoom (rewrite, repeated
  // spec): while playing, the camera tracks the spacecraft every frame; its
  // distance is a smooth function of proximity to the nearest encounter
  // body -- fully zoomed to that body's close-framing distance when the
  // spacecraft is at the body (departure body clearly visible at departure,
  // arrival body at arrival, each flyby body at its flyby), easing out to
  // the wide interplanetary framing in between. Recomputed per rendered
  // frame (spacecraftPos is per-frame state during playback).
  // Real bug, same root cause as closeDistDeparture/closeDistArrival above:
  // this used to reuse closeDistArrival (the TARGET body's own close
  // distance) for every intermediate flyby regardless of that flyby body's
  // own radius -- fine when the old absolute floor dominated everywhere,
  // wrong now that close distances are body-radius-relative (a Venus flyby
  // framed at Saturn's close distance would still be hundreds of Venus-radii
  // out, back to full exaggeration right at the flyby). Each flyby now gets
  // its own close distance from its own real body radius.
  const flybyCloseDists = useMemo(
    () =>
      flybyPositions.map((_, i) => {
        const name = bodySequence[i + 1]
        const body = bodiesData?.bodies.find((b) => b.name === name)
        const radiusScene = Math.max((body?.radius_m ?? 3_396_200) * SCENE_SCALE, 1e-6)
        return Math.max(radiusScene * CLOSE_FRAMING_RADIUS_MULTIPLIER, ABSOLUTE_MIN_FRAMING_DIST)
      }),
    [flybyPositions, bodySequence, bodiesData, CLOSE_FRAMING_RADIUS_MULTIPLIER],
  )

  // Capped below wideDist (
  // top view and keep the camera always a bit behind the moving s/c") --
  // during plain cruise, far from any encounter body, this used to relax
  // all the way out to wideDist (the same distance "Fit all" uses), which
  // reads as a wide survey/map view no matter the elevation angle. "Fit
  // all" itself is untouched (still reaches the true wideDist) -- this only
  // caps the CONTINUOUS chase camera's own cruise-phase distance.
  const CRUISE_FOLLOW_DIST_CAP_FACTOR = 0.55
  const followDistance = useMemo(() => {
    const cruiseDist = wideDist * CRUISE_FOLLOW_DIST_CAP_FACTOR
    const encounterCloseDists = [closeDistDeparture, ...flybyCloseDists, closeDistArrival]
    let desired = cruiseDist
    encounterPositions.forEach((bodyPos, i) => {
      const c = encounterCloseDists[i] ?? closeDistArrival
      const d = spacecraftPos.distanceTo(bodyPos)
      // 1 when at the body, 0 once farther than half the wide framing.
      const w = 1 - smoothstep(c, Math.max(wideDist * 0.5, c * 4), d)
      desired = Math.min(desired, c + (cruiseDist - c) * (1 - w))
    })
    return desired
  }, [spacecraftPos, encounterPositions, flybyCloseDists, closeDistDeparture, closeDistArrival, wideDist])

  // Arrival-approach camera behavior, added (
  // arrival, it can be nicer if the camera starts to follow both s/c and
  // target/arrival body already early, like halfway in the last leg, so we
  // can see where we're going. Also, it can maybe rotate completely at the
  // end to look back at the incoming planet and the s/c trajectory before
  // arrival."). "The last leg" is the whole mission for a single-leg
  // GA/PSO result (no legBoundaryTimes), or MGA's final leg otherwise.
  const arrivalLegStartS = isMga && legBoundaryTimes.length > 0 ? legBoundaryTimes[legBoundaryTimes.length - 1] : arcT0S
  const arrivalLegProgress = useMemo(() => {
    const span = totalDurationS - arrivalLegStartS
    return span > 0 ? THREE.MathUtils.clamp((elapsedS - arrivalLegStartS) / span, 0, 1) : 0
  }, [elapsedS, arrivalLegStartS, totalDurationS])
  // Widens the framing to keep the target body in view too, starting at the
  // leg's halfway point ("halfway in the last leg" ask)
  // and reaching full effect by 88% through -- leaves the last stretch for
  // the look-back rotation below, which needs the wider framing already
  // settled rather than fighting it.
  const arrivalWidenBlend = arrivalLegProgress > 0 && arrivalLegProgress < 1
    ? smoothstep(0.5, 0.88, arrivalLegProgress)
    : arrivalLegProgress >= 1 ? 1 : 0
  // The "rotate to look back" ask -- a much narrower window right at the
  // end (the final 12% of the leg), so it reads as a deliberate final
  // flourish rather than a slow drift throughout the whole approach.
  const arrivalLookBackBlend = arrivalLegProgress > 0
    ? smoothstep(0.88, 1.0, arrivalLegProgress)
    : 0
  const arrivalFollowPoint = useMemo(() => {
    if (arrivalWidenBlend <= 0) return spacecraftPos
    // Shift the orbit/lookAt target from "just the spacecraft" toward the
    // target body -- up to halfway during the widen phase (enough to keep
    // both comfortably framed without centering on empty space between
    // them), reaching the target itself FULLY (shift=1) by the end of the
    // look-back flourish -- matches the old "done" phase's own fly-in,
    // which always looked directly AT the target, not partway toward it
    // (
    // view angle" -- the reference shot centers on the target, not a
    // point between it and the spacecraft).
    const shift = Math.min(arrivalWidenBlend * 0.5 + arrivalLookBackBlend * 0.5, 1)
    return spacecraftPos.clone().lerp(targetLivePos, shift)
  }, [spacecraftPos, targetLivePos, arrivalWidenBlend, arrivalLookBackBlend])
  // Real bug, found (
  // sight when you rotate"). Provably real, not just a hunch: the old
  // formula sized the distance off the raw spacecraft-target SEPARATION
  // (`* 0.75`), but `arrivalFollowPoint` above can sit up to 80% of the
  // way from the spacecraft toward the target -- meaning the spacecraft's
  // own OFFSET from the point the camera actually looks at can be nearly
  // as large as the full separation itself, while the old distance was
  // sized smaller than that (0.75x). At a 50deg FOV (half-angle 25deg,
  // tan=0.4663), an offset comparable to the framing distance itself
  // subtends an angle far wider than the frustum can cover -- the
  // spacecraft would fall outside the visible frame exactly during the
  // look-back sweep this feature is supposed to showcase. Fixed by sizing
  // the distance off the LARGER of the two real offsets from the follow
  // point (spacecraft or target, whichever is farther from where the
  // camera is actually looking), divided by a generously conservative
  // fraction of the true half-FOV tangent -- guarantees both stay
  // comfortably inside the frame at every blend value, not just at the
  // widen phase's own original 0.5 shift this was tuned against.
  // Revised alongside arrivalFollowPoint (same user round: "it needs to
  // rotate to that second screenshot's view angle") -- the reference shot
  // is the OLD "done" phase's own fly-in distance (closeDistArrival), not
  // a distance this feature invented from scratch. Converges toward
  // `closeDistArrival * lookBackPullback` (the still-standing "zoom out
  // further" pull-back) as the look-back flourish completes, while the
  // FOV-based frame-guarantee formula stays in effect underneath (as a
  // floor, via Math.max) so the spacecraft still can't be clipped out of
  // frame partway through the sweep, before arrivalFollowPoint has fully
  // reached the target.
  const arrivalFollowDistance = useMemo(() => {
    if (arrivalWidenBlend <= 0) return followDistance
    const maxOffset = Math.max(
      arrivalFollowPoint.distanceTo(spacecraftPos),
      arrivalFollowPoint.distanceTo(targetLivePos),
    )
    const halfFovTan = Math.tan(THREE.MathUtils.degToRad(25))
    const lookBackPullback = 1 + arrivalLookBackBlend * ARRIVAL_LOOK_BACK_PULLBACK_FACTOR
    const guaranteeDist = (maxOffset / (halfFovTan * 0.5)) * lookBackPullback
    const referenceDist = closeDistArrival * lookBackPullback
    const wideningDist = THREE.MathUtils.lerp(guaranteeDist, Math.max(guaranteeDist, referenceDist), arrivalLookBackBlend)
    return THREE.MathUtils.lerp(followDistance, Math.max(followDistance, wideningDist), arrivalWidenBlend)
  }, [followDistance, arrivalFollowPoint, spacecraftPos, targetLivePos, arrivalWidenBlend, arrivalLookBackBlend, closeDistArrival])

  const showCaptureBurnLabel = elapsedS >= (result.capture_time_s ?? Infinity)

  // Triggers CameraController's scripted close-up fly-in (see its
  // focusRequest handling) instead of just snapping the orbit target --
  // "click to zoom in" needs the camera to
  // actually move closer, not just re-center around the same distance.
  const handleBodyFocus = useCallback((pos: THREE.Vector3, radiusScene?: number) => {
    onRequestFocus(pos, radiusScene)
  }, [onRequestFocus])

  return (
    <>
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
        onFocus={handleBodyFocus}
      />
      <EclipticGrid origin={sunPos} maxRadiusAU={outerExtentAU} />

      {/* Heliocentric orbit ring for every body in the scene, not just
 perturbers -- real gap, found: PerturberBody already
          draws one of these for every force-model perturber, but departure/
          target/flyby bodies were silently excluded from that code path and
          never got one at all. Uses the fixed reference position (not the
          live/interpolated mesh) so the ring itself doesn't jitter.

          Real orbit ellipse (bodyOrbitRingPoints, lib/keplerEphemeris.ts)
          for the 8 major planets instead of a circle at the body's current
 distance -- ("planets still don't follow
          the orbits that are displayed... can we ensure the ephemeris we
          show is the true path"). Falls back to the previous circular
          approximation for any body with no catalogued elements (Moon,
          asteroids, custom bodies).

 Styled distinctly from the plain reference grid (review
          round item 5: "genuinely confusing which is which") -- brighter
          teal, thicker line, see BODY_ORBIT_RING_* in sceneShared.tsx. */}
      {/* Real bug, found (
          enabled for planets that are not included in the mission... Why
          is this? Apply for all"). Root cause: these three rings used to
          be plain `<Line>` elements with no hover capability at all --
          only the DECORATIVE planets below got PlanetBody's `ringPoints`
          prop (which is what actually wires up RingHoverBead). Fixed by
          passing `ringPoints` into the departure/target/flyby PlanetBody
          calls themselves instead of drawing a separate un-hoverable
          `<Line>` -- PlanetBody already renders the ring line internally
          when given this prop, so the standalone `<Line>` elements that
          used to sit here are gone, not duplicated. */}
      <PlanetBody
        name={departureBodyName}
        position={departureLivePos}
        radiusM={departureBody?.radius_m ?? 6_378_137}
        spinRateRadS={departureBody?.spin_rate_rads}
        color="#f59e0b"
        poleRaDeg={departureBody?.pole_ra_deg}
        poleDecDeg={departureBody?.pole_dec_deg}
        ringPoints={bodyOrbitRingPoints(departureBodyName, sunPos, departurePos.distanceTo(sunPos), result.dep_jd)}
        onFocus={handleBodyFocus}
      />
      <PlanetBody
        name={targetBodyName}
        position={targetLivePos}
        radiusM={targetBody?.radius_m ?? 3_396_200}
        spinRateRadS={targetBody?.spin_rate_rads}
        color="#f472b6"
        poleRaDeg={targetBody?.pole_ra_deg}
        poleDecDeg={targetBody?.pole_dec_deg}
        ringPoints={bodyOrbitRingPoints(targetBodyName, sunPos, targetPos.distanceTo(sunPos), result.dep_jd)}
        onFocus={handleBodyFocus}
      />
      <EncounterMarker
        position={targetPos}
        label={`${targetBodyName} arrival point`}
        onFocus={handleBodyFocus}
      />

      {perturberBodies.map((name) => {
        const body = bodiesData?.bodies.find((b) => b.name === name)
        return (
          <PerturberBodyFromState
            key={name}
            name={name}
            epoch={effectiveDepartureEpoch}
            elapsedS={elapsedS}
            sunPosition={sunPos}
            radiusM={body?.radius_m ?? 6_378_137}
            spinRateRadS={body?.spin_rate_rads}
            poleRaDeg={body?.pole_ra_deg}
            poleDecDeg={body?.pole_dec_deg}
            onPositionResolved={handlePerturberPosition}
            onFocus={handleBodyFocus}
          />
        )
      })}

      {decorativePlanetNames.map((name) => {
        const elements = PLANET_ELEMENTS[name]
        const body = bodiesData?.bodies.find((b) => b.name === name)
        const jd = result.dep_jd + elapsedS / 86_400
        const [xM, yM, zM] = keplerPositionM(elements, jd)
        const pos = sceneVecFromEclipticMeters(xM, yM, zM).add(sunPos)
        const ringPts = bodyOrbitRingPoints(name, sunPos, pos.distanceTo(sunPos), jNowForRing())
        return (
          // Real bug, found (: "Mars' orbit is now not
          // as thick as the other planet rings ... all rings should be
          // equally visible"): this used to render its own separate <Line>
          // with a dimmer opacity + a hardcoded lineWidth=1 instead of the
          // shared BODY_ORBIT_RING_* constants every other body ring uses.
          // Now handed to PlanetBody's own `ringPoints` prop instead (still
          // BODY_ORBIT_RING_* by default, so it's automatically consistent) --
          // which ALSO makes the whole ring hoverable, not just the tiny body
          // (same user round: "for planets not in the flyby
          // sequence, hard to find and hover ... can we hover above the ring,
          // anywhere above the ring instead").
          <PlanetBody
            key={name}
            name={name}
            position={pos}
            radiusM={body?.radius_m ?? 6_378_137}
            spinRateRadS={body?.spin_rate_rads}
            color="#5a6478"
            poleRaDeg={body?.pole_ra_deg}
            poleDecDeg={body?.pole_dec_deg}
            alwaysShowLabel={false}
            ringPoints={ringPts}
            onFocus={handleBodyFocus}
          />
        )
      })}

      {smoothLegSegments.map((seg) => (
        <Line
          key={seg.legIdx}
          points={seg.points}
          color={LEG_COLORS[seg.legIdx % LEG_COLORS.length]}
          opacity={0.85}
          transparent
          lineWidth={2}
        />
      ))}
      <SpacecraftModel
        position={spacecraftPos}
        moving={playbackState === "playing"}
      />
      {gravityAssistIntensity > 0.01 && (
        <GravityAssistGlow position={spacecraftPos} intensity={gravityAssistIntensity} />
      )}

      {/* Intermediate flyby bodies: rendered at their real MOVING position
          (flybyLivePositions, real Kepler ephemeris when the body is one of
          the 8 majors -- see that memo's comment), with a persistent
          EncounterMarker at the fixed arc-sampled encounter point
          (flybyPositions) so the body can be seen passing through its own
          flyby moment during playback (review round item 1).

 Real bug, found (: "i now see two earths...
          one is in the wrong location"): a resonant-return route (e.g.
          Cassini's VEEGA, which flies past Earth again as a flyby after
          departing FROM Earth) has the SAME body playing two roles in
          bodySequence. Departure/target bodies already get their own
          continuously-moving render (departureLivePos/targetLivePos, driven
          by a real fetched ephemeris state); before this fix, a flyby
          occurrence of that SAME body got a SECOND, independent moving
          render (via this block's own Kepler-mean-element approximation)
          for the ENTIRE playback, not just near the encounter -- two
          different approximations of the one real body's position,
          inevitably diverging (Kepler mean elements vs. real fetched state)
          and reading as "two Earths, one wrong." Fixed by skipping the
          duplicate moving mesh for any flyby body that's also the
          departure or target (that body's own track already covers it);
          the EncounterMarker still renders for every occurrence, since it's
          just a static ring at a specific point in space, not a duplicated
          moving approximation. */}
      {isMga && flybyPositions.map((pos, i) => {
        const flybyName = bodySequence[i + 1] ?? `Flyby ${i + 1}`
        const flybyBody = bodiesData?.bodies.find((b) => b.name === flybyName)
        const hasOwnTrackElsewhere = flybyName === departureBodyName || flybyName === targetBodyName
        return (
          <group key={`flyby-${i}`}>
            {!hasOwnTrackElsewhere && (
              <PlanetBody
                name={flybyName}
                position={flybyLivePositions[i] ?? pos}
                radiusM={flybyBody?.radius_m ?? 3_396_200}
                spinRateRadS={flybyBody?.spin_rate_rads}
                color={FLYBY_COLOR}
                poleRaDeg={flybyBody?.pole_ra_deg}
                poleDecDeg={flybyBody?.pole_dec_deg}
                ringPoints={bodyOrbitRingPoints(flybyName, sunPos, pos.distanceTo(sunPos), result.dep_jd)}
                onFocus={handleBodyFocus}
              />
            )}
            {/* No visible dot for flybys anymore (
                flyby areas are now sphere's. i dont like that. it would be
                better if the trajectory itself is highlighted/enlightened
                around the flyby") -- hideMarkerShape drops the sphere,
                keeping hit-sphere/hover/click/label. The highlight segment
                below is now the ONLY visual cue, "enlightened" via a
                cheap two-layer glow (a wide, dim outer line plus a thin,
                bright core -- Three.js Line materials don't expose true
                bloom, so this is the standard fake-glow trick, same
                category as PlanetBody's own hover glow halo). */}
            <EncounterMarker position={pos} label={`${flybyName} flyby point`} onFocus={handleBodyFocus} hideMarkerShape />
            {flybyHighlightSegments[i] && flybyHighlightSegments[i].length > 1 && (
              <>
                <Line points={flybyHighlightSegments[i]} color="#e2e8f0" opacity={0.28} transparent lineWidth={10} />
                <Line points={flybyHighlightSegments[i]} color="#ffffff" opacity={0.95} transparent lineWidth={3} />
              </>
            )}
          </group>
        )
      })}

      {/* hideMarkerShape (
          (the yellow one) and only use the blue dot") -- this marker sits
          right at the ship's own starting position (arcStartPos), so its
          amber diamond read as a second, competing spacecraft indicator.
          Label/hover/click still work; only the visible octahedron is
          dropped. */}
      <BurnMarker position={arcStartPos} label="Departure burn" dvMs={result.dv_departure_ms} showLabel hideMarkerShape onFocus={handleBodyFocus} />
      {isMga && dsmDisplayPositions.map((p, i) => (
        <BurnMarker
          key={`dsm-${i}`}
          position={p}
          label={`DSM ${i + 1} (leg ${i + 1})`}
          dvMs={dsmDvs[i] ?? 0}
          showLabel={elapsedS >= (legStartTimes[i] ?? 0)}
          onFocus={handleBodyFocus}
        />
      ))}
      {captureBurnPos && (
        <BurnMarker
          position={captureBurnPos}
          label="Capture burn"
          dvMs={result.dv_arrival_ms}
          showLabel={showCaptureBurnLabel}
          onFocus={handleBodyFocus}
        />
      )}

      {/* Parking/capture orbit rings: real propagated data
          (pre_departure_orbit_arc/post_capture_orbit_arc) when the backend
          result has it, a circular approximation otherwise -- see
          preDepartureOrbitPoints/postCaptureOrbitPoints above. Brighter when
          real, so it doesn't read as the exact same "just a guess" ring it
          used to always be. */}
      <Line points={parkingOrbitRingPoints} color="#6b7a99" opacity={preDepartureOrbitPoints ? 0.55 : 0.3} transparent lineWidth={1} />
      {captureOrbitRingPoints.length > 0 && (
        <Line points={captureOrbitRingPoints} color="#6b7a99" opacity={postCaptureOrbitPoints ? 0.55 : 0.3} transparent lineWidth={1} />
      )}

      <CameraController
        controlsRef={controlsRef}
        focusPoint={cameraFocusPoint}
        phase={cameraPhaseKey}
        flyToDistance={cameraFlyToDistance}
        fitAllTrigger={fitAllTrigger}
        fitAllDistance={fitAllDist}
        focusRequest={focusRequest}
        followPoint={cameraPhase === "playing" ? arrivalFollowPoint : null}
        followDistance={arrivalFollowDistance}
        followVelocity={cameraPhase === "playing" ? spacecraftVel : null}
        lookBackBlend={cameraPhase === "playing" ? arrivalLookBackBlend : 0}
      />
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        makeDefault
        // Real bug, found (: "indefinite zooming is
        // still difficult, especially after dragging, zoom goes slower and
        // slower"): no bounds or zoomSpeed were ever set here, so three.js's
        // default proportional-to-distance dolly (each scroll tick moves a
        // shrinking absolute amount the closer you get) was the only
        // behavior -- reads exactly as "zoom slowing down." zoomSpeed above
        // 1 compensates partially; explicit min/maxDistance (scaled to this
        // mission's own close/wide framing distances, not a fixed constant --
        // missions span anywhere from ~1 AU to tens of AU) keeps the range
        // sane regardless of mission scale.
        //
        // maxDistance's *3 multiplier (found
        // max in how far i can zoom out, why?") was never a deliberate cap
        // on how far out someone should be able to go -- it was just
        // whatever value happened to ship alongside the minDistance fix
        // above, sized off the same "fit all" framing distance (wideDist)
        // with no real headroom past it. There's no technical reason to
        // stay that tight (camera.far is 200,000 scene units; even a
        // Neptune-scale mission's wideDist is nowhere near that), so this is
        // loosened substantially -- "Fit all" is still the fast way back to
        // a sane framing regardless of where the user has scrolled to.
        zoomSpeed={1.4}
        minDistance={Math.max(closeDistDeparture * 0.15, 0.05)}
        maxDistance={wideDist * 15}
        mouseButtons={{
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        }}
      />
      {/* Stars removed entirely, (
          stars in the background are not fixed, and that's still not
          solved. If we cant solve that, we should just remove them
 entirely"). Two earlier rounds (: re-centering the star
          group on the camera every frame; a same-day follow-up: fixing a
          one-frame mount-order lag in that re-centering) were both real,
          measured fixes for real bugs, but the user still saw the stars
          move. Rather than guess at a third theory with no reliable way to
          pixel-confirm it (a casual screenshot comparison of ~6000 faint
          scattered dots isn't a trustworthy diff), taking the
          simplest fallback: removed outright. FixedStars, its own
          useMemo-cached texture/geometry, and the `Stars` import are gone
          from this file. */}
    </>
  )
}

export function OptimizeTrajectoryView({
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
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle")
  const [playKey, setPlayKey] = useState(0)
  const [fitAllTrigger, setFitAllTrigger] = useState(0)
  const [zoomToShipTrigger, setZoomToShipTrigger] = useState(0)
  const lastMissedClickRef = useRef(0)
  const [uncoveredBodies, setUncoveredBodies] = useState<string[]>([])
  const [focusRequest, setFocusRequest] = useState<{ pos: THREE.Vector3; version: number; radiusScene?: number } | undefined>(undefined)
  // Bumps the version every call so CameraController's focus-fly-in effect
  // fires even if the same body is clicked twice in a row (a repeated
  // request with an unchanged version would look like a no-op to it).
  const handleRequestFocus = useCallback(
    (pos: THREE.Vector3, radiusScene?: number) => setFocusRequest({ pos, version: Date.now(), radiusScene }),
    [],
  )

  const handleDone = useCallback(() => setPlaybackState("done"), [])
  const handleUncoveredBodies = useCallback((names: string[]) => setUncoveredBodies(names), [])

  // Timeline scrub slider + mission date/time readout (user
  // request: "still missing the option to scroll through time... it would
  // be cool to see the date/time somewhere"). totalDurationS is computed
  // directly here (cheap, same one-liner SceneContents itself uses) rather
  // than lifted up from there, since it doesn't depend on any playback
  // state; displayElapsedS DOES need to come from SceneContents (its own
  // internal state), reported up via onElapsedChange every time it changes.
  // Clamped to the real achieved encounter time (achieved_tof_days), not
  // just the arc's own raw last point -- see SceneContents' own
  // `totalDurationS` for the full root-cause writeup (the
  // Mercury GA preset's post-encounter coast tail). Must match exactly:
  // this is what sizes the timeline slider's real bounds.
  const rawTotalDurationS = result.arc.length === 0 ? 0 : result.arc[result.arc.length - 1].t_s
  const achievedArrivalS = result.achieved_tof_days * 86_400
  const totalDurationS = achievedArrivalS > 0 ? Math.min(rawTotalDurationS, achievedArrivalS) : rawTotalDurationS
  // The arc's own real first t_s (negative when a real escape leg precedes
  // t=0 -- see SceneContents' arcT0S for the full explanation) -- the
  // slider's real lower bound, not always 0.
  const arcT0S = result.arc[0]?.t_s ?? 0
  const [displayElapsedS, setDisplayElapsedS] = useState(() => arcT0S)
  const [seekRequest, setSeekRequest] = useState<{ s: number; version: number } | undefined>(undefined)
  const handleElapsedChange = useCallback((s: number) => setDisplayElapsedS(s), [])
  // Real bug, found (
  // earth has dissapeared"). Root cause, confirmed live: this had nothing
  // to do with Earth specifically, or with anything from the recent
  // arrival-camera work -- Replay/Restart appeared to do NOTHING at all
  // after scrubbing the timeline slider close to the mission's end and
  // letting it finish (exactly the test pattern this whole session's
  // arrival-rotation work required repeatedly). `handleRestart` bumps
  // `playKey`, remounting `SceneContents` fresh -- which correctly resets
  // its OWN internal elapsed-time state back to `arcT0S` -- but `seekRequest`
  // (this PARENT's own state, passed down as a prop) was never cleared.
  // The fresh child's `lastSeekVersionRef` starts at `undefined`, which
  // doesn't match the STALE `seekRequest.version` still sitting in this
  // parent's state from the last scrub -- so the child's seek handler
  // treats it as a brand-new request on its very first frame and
  // immediately re-applies it, snapping elapsed time right back to
  // wherever the user had last scrubbed to (near the true end, in the
  // reported case) -- making Restart look like it does nothing at all
  // (every visible label/body position stays at the end-of-mission state,
  // Earth's own label just happened to be the one the user was looking
  // for and couldn't find, buried/overlapping with several late-mission
  // DSM labels that shouldn't have still been showing). Fixed by clearing
  // `seekRequest` in `handleRestart` itself, so a fresh child never
  // receives a stale one.
  const handleRestart = useCallback(() => {
    setPlayKey((k) => k + 1)
    setPlaybackState("preroll")
    setSeekRequest(undefined)
    setDisplayElapsedS(arcT0S)
  }, [arcT0S])

  // Event-aware slider mapping (see buildEventAwareTimeMapping's own header
  // comment above) -- the same real event times SceneContents already uses
  // for camera event-linger pacing (departure/flybys/arrival/capture), so
  // "where the slider gives you fine control" matches "where the camera
  // already slows down," not two independently-tuned notions of "event."
  const legBoundaryTimes = useMemo(() => extractLegBoundaryTimes(result), [result])
  // Parallel to eventTimesS below -- what each tick actually IS (
  //
  // flyby's? its currently not labeled as flybys so a user wont know
  // that"). Real body name per flyby (bodySequence[i+1] -- index 0 is the
  // departure body, not a flyby) rather than a generic "Event N".
  const eventLabels = useMemo(() => {
    const labels = legBoundaryTimes.map((_, i) => `${result.mga_body_sequence?.[i + 1] ?? "Flyby"} flyby`)
    if (result.capture_time_s != null) labels.push("Capture burn")
    return labels
  }, [legBoundaryTimes, result.mga_body_sequence, result.capture_time_s])
  // Real, already-computed flyby highlight windows (user, after
  // correcting an earlier misread: "for the timeline slider, this is where
  // i want finer control around the flyby's, especially in the highlighted
  // area you have now, give me more points there"). SceneContents (the
  // child) already derives this via deriveMgaSceneData, but only from
  // inside the Canvas -- this component (the slider lives here) has no
  // other access to it, so it's cheaply re-derived here too (plain array
  // math over a few hundred points, no textures/network -- same cost
  // category as `linePoints` itself, not worth lifting state up for).
  const parentLinePoints = useMemo(
    () => result.arc.map((p) => sceneVecFromMeters(p.x_m, p.y_m, p.z_m)),
    [result.arc],
  )
  const parentMga = useMemo(() => deriveMgaSceneData(result, parentLinePoints), [result, parentLinePoints])
  const flybyHighlightTimeRanges = parentMga.flybyHighlightTimeRanges
  // The real closest-approach instants themselves (not just the wider
  // highlight window around them) -- feeds the nested peak-boost layer,
  // see PEAK_WINDOW_S/PEAK_BOOST's own comment.
  const flybyClosestTimes = parentMga.flybyClosestTimes
  // Real bug, found while verifying the peak boost: the tick
  // marks (and eventRanges below) used to be built from the raw
  // legBoundaryTimes, but the peak boost is centered on flybyClosestTimes
  // -- for a flyby where the true closest-approach search shifted the
  // point meaningfully from the raw leg boundary (confirmed live: Jupiter
  // measured ~17h/step exactly AT its tick, vs. 1.5-2.5h/step for the other
  // three), the visible tick sat outside the actual fine-resolution zone
  // entirely. Falls back to the raw boundary only when a flyby has no
  // known orbital elements to search against (flybyClosestTimes[i] is then
  // just the boundary time already, per computeFlybyClosestApproach's own
  // fallback -- this ?? is defensive, not expected to fire for a normal
  // MGA result).
  const eventTimesS = useMemo(() => {
    const events = legBoundaryTimes.map((t, i) => flybyClosestTimes[i] ?? t)
    if (result.capture_time_s != null) events.push(result.capture_time_s)
    return events
  }, [legBoundaryTimes, flybyClosestTimes, result.capture_time_s])
  // Every event as a [lo, hi] range -- a flyby uses its REAL highlight
  // window (full boost across the whole span, not just a taper centered on
  // one instant); departure/arrival/capture stay zero-width point ranges
  // (buildEventAwareTimeMapping's distanceToRange treats [t, t] the same
  // as the old plain-point behavior).
  const eventRanges = useMemo<[number, number][]>(() => {
    const ranges: [number, number][] = [[arcT0S, arcT0S]]
    legBoundaryTimes.forEach((t, i) => {
      const found = flybyHighlightTimeRanges[i]
      ranges.push(found && found[1] > found[0] ? found : [t, t])
    })
    ranges.push([totalDurationS, totalDurationS])
    if (result.capture_time_s != null) ranges.push([result.capture_time_s, result.capture_time_s])
    return ranges
  }, [arcT0S, legBoundaryTimes, flybyHighlightTimeRanges, totalDurationS, result.capture_time_s])
  const timeMapping = useMemo(
    () => buildEventAwareTimeMapping(arcT0S, totalDurationS, eventRanges, flybyClosestTimes),
    [arcT0S, totalDurationS, eventRanges, flybyClosestTimes],
  )
  // Small tick marks on the slider track at each real event's mapped
  // position (
  // smaller around flybys... make sure that this is the case?"). The
  // finer-resolution mapping itself was already verified correct (see
  // the design notes fifteenth round -- a real ~180x resolution ratio measured
  // near vs. far from an event), but a plain `<input type=range>` gives no
  // visual indication of WHERE the compressed regions are -- there was
  // nothing to actually see. These ticks make the compression visible
  // directly: flybys close together in real time (like Cassini's two Venus
  // encounters) show as ticks close together on the track too, but every
  // tick still gets the same minimum visual spacing the boosted mapping
  // guarantees it in slider-space.
  const eventTickSliderPositions = useMemo(
    () => eventTimesS.map((t) => timeMapping.toSlider(t)),
    [eventTimesS, timeMapping],
  )

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const sliderPos = Number(e.target.value)
    const s = timeMapping.toTime(sliderPos)
    setDisplayElapsedS(s)
    // Any manual scrub moves playback to "paused" -- from "playing" so it
    // stops fighting the slider with its own advancing clock, from "idle"/
    // "done" so the primary button reads "Resume" (continue from here)
    // rather than "Play"/"Replay" (which would restart from 0 via a fresh
    // playKey). "preroll" is a ~1s transient with no interactive slider
    // moment in practice, left alone.
    setPlaybackState((prev) => (prev === "preroll" ? prev : "paused"))
    setSeekRequest({ s, version: Date.now() })
  }, [timeMapping])

  const handlePrimaryButton = useCallback(() => {
    if (playbackState === "idle" || playbackState === "done") { handleRestart(); return }
    if (playbackState === "playing") { setPlaybackState("paused"); return }
    if (playbackState === "paused") { setPlaybackState("playing"); return }
  }, [playbackState, handleRestart])

  useEffect(() => {
    if (playbackState !== "preroll") return
    const timer = setTimeout(() => setPlaybackState("playing"), PREROLL_DWELL_MS)
    return () => clearTimeout(timer)
  }, [playbackState])

  if (result.arc.length === 0) {
    return (
      <Card><CardHeader><CardTitle>Trajectory</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No arc in this result to visualize.</p></CardContent>
      </Card>
    )
  }

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Trajectory</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setFitAllTrigger((k) => k + 1)} title="Fit all">
            <Expand data-icon="inline-start" /> Fit all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setZoomToShipTrigger((k) => k + 1)}
            title="Zoom to spacecraft"
          >
            <Crosshair data-icon="inline-start" /> Zoom to S/C
          </Button>
          <Button size="sm" variant="outline" onClick={handlePrimaryButton} disabled={playbackState === "preroll"}>
            {playbackState === "idle" ? <><Play data-icon="inline-start" /> Play</>
              : playbackState === "playing" ? <><Pause data-icon="inline-start" /> Pause</>
              : playbackState === "paused" ? <><Play data-icon="inline-start" /> Resume</>
              : playbackState === "done" ? <><RotateCcw data-icon="inline-start" /> Replay</>
              : <><Play data-icon="inline-start" /> Starting...</>}
          </Button>
          {/* Real bug, found (: "why is there a Replay
              and Restart button, dont they do the same?") -- yes, in the
              "done" phase they did: the primary button already reads
              "Replay" there and calls the exact same handleRestart this
              secondary button also called, so both were shown at once doing
              the identical thing. Hidden here specifically for "done" --
              still shown for playing/paused, where it's a real distinct
              action from Pause/Resume. */}
          {playbackState !== "idle" && playbackState !== "preroll" && playbackState !== "done" && (
            <Button size="sm" variant="ghost" onClick={handleRestart}><RotateCcw data-icon="inline-start" /> Restart</Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        {result.mga_body_sequence && result.mga_body_sequence.length > 1 && (
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {result.mga_body_sequence.map((name, i) => (
              <span key={i} className="flex items-center gap-1">
                <Badge variant="outline" className="text-xs">{name}</Badge>
                {i < result.mga_body_sequence!.length - 1 && <span>→</span>}
              </span>
            ))}
          </div>
        )}
        {uncoveredBodies.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {uncoveredBodies.map((n) => (
              <Badge key={n} variant="outline" className="text-xs text-amber-400 border-amber-400/30">⚠ No ephemeris: {n}</Badge>
            ))}
          </div>
        )}
        {/* Real bug, found (UX review): a fixed 480px height meant
            Theater/fullscreen mode -- which gives this card the whole page's
            height -- still only used 480px of it, leaving a large unused
            void below. flex-1 (with the CardContent/Card ancestors above now
            forming a real flex-column height chain) lets this genuinely fill
            whatever room is available, with the old 480 kept as a floor so
            the normal side-by-side layout looks the same as before. */}
        <div style={{ flex: 1, minHeight: 480, position: "relative", backgroundColor: "#0a0a0f", overflow: "hidden" }}>
          <Canvas
            camera={{ fov: 50, near: 0.001, far: 200_000 }}
            // Double-click empty space to reset the view (
            //) -- reuses the exact same fly-in the "Fit all"
            // button already triggers, not a separate camera path.
            // onPointerMissed (not onDoubleClick) deliberately: it's
            // guaranteed to only fire when the click hit no raycastable
            // object, so double-clicking a body to focus on it (existing
            // behavior, PlanetBody's own onClick) never also triggers a
            // reset -- the two can't fire from the same double-click.
            onPointerMissed={() => {
              const now = performance.now()
              if (now - lastMissedClickRef.current < 350) setFitAllTrigger((k) => k + 1)
              lastMissedClickRef.current = now
            }}
          >
            {/* Phase 01 freeze exception, render-inert: pauses
                this scene's frame loop ONLY while the Study tree is
                CSS-hidden (Phase 03 active) -- it was still rendering at
                60 fps invisibly, one of four WebGL loops saturating the
                renderer (measured, see PauseWhenHidden.tsx). Nothing about
                what this view renders when visible changes. */}
            <PauseWhenHidden tool="study" />
            <color attach="background" args={["#0a0a0f"]} />
            <Suspense fallback={null}>
              <SceneContents
                key={playKey}
                result={result}
                departureBodyName={departureBodyName}
                targetBodyName={targetBodyName}
                forceModelBodies={forceModelBodies ?? []}
                captureRadiusM={captureRadiusM}
                playbackState={playbackState}
                fitAllTrigger={fitAllTrigger}
                focusRequest={focusRequest}
                seekRequest={seekRequest}
                zoomToShipTrigger={zoomToShipTrigger}
                onRequestFocus={handleRequestFocus}
                onDone={handleDone}
                onUncoveredBodies={handleUncoveredBodies}
                onElapsedChange={handleElapsedChange}
              />
            </Suspense>
          </Canvas>
          {/* Mission date/time readout -- moved INSIDE the viewport
 (
              animation") from a plain row below the canvas to an overlay in
              its top-right corner, so it reads as part of the animation
              itself rather than a separate control below it. */}
          <div
            style={{
              position: "absolute", top: 10, right: 12,
              padding: "3px 8px", borderRadius: 4,
              background: "rgba(10, 10, 15, 0.65)",
              pointerEvents: "none",
            }}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {julianDateToUtcString(result.dep_jd + displayElapsedS / 86_400)}
          </div>
        </div>
        {/* Timeline scrub slider (: "still missing
            the option to scroll through time"). Tick marks below it show
            where each real event (flyby/capture) actually landed on the
            [0,1] track after the event-aware remap -- see
            eventTickSliderPositions' own comment for why these exist. */}
        <div className="relative mt-2">
          <input
            type="range"
            min={0}
            max={1}
            // 0.0005 -> 0.0002 (alongside the peak-boost
            // addition): the peak windows are narrow enough now that the
            // old step size was itself a real limiting factor on top of
            // the mapping's own resolution -- verified together against
            // the real Cassini snapshot (see PEAK_WINDOW_S's comment).
            step={0.0002}
            value={timeMapping.toSlider(displayElapsedS)}
            onChange={handleSeek}
            className="w-full accent-[#00d4ff]"
            aria-label="Mission timeline"
          />
          <div className="pointer-events-none relative h-1.5" style={{ marginTop: -4 }}>
            {eventTickSliderPositions.map((pos, i) => (
              <div
                key={i}
                className="absolute top-0 h-1.5 w-0.5 bg-amber-400/80"
                style={{ left: `${pos * 100}%` }}
                title={eventLabels[i] ?? `Event ${i + 1}`}
              />
            ))}
          </div>
        </div>
        {/* Real gap, found (
            slider, i guess also highlighting flybys? its currently not
            labeled as flybys so a user wont know that"). A native
            `<input>` gives no way to show a label without hovering each
            tiny tick one at a time (the title= attribute above), so this
            spells it out once, plainly, right under the track -- only
            shown when there's actually at least one tick to explain. */}
        {eventLabels.length > 0 && (
          <p className="mt-1 text-[10px] text-amber-400/80">
            Amber ticks mark flyby/capture events (hover a tick for which one).
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          During playback the camera follows the spacecraft automatically. When paused or finished: left-drag to
          orbit · scroll to zoom toward cursor · right-drag to pan · hover a body or burn marker to highlight it,
          click to zoom in on it. Ecliptic frame.
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Planet textures: <a href="https://www.solarsystemscope.com/textures/" className="underline" target="_blank" rel="noreferrer">Solar System Scope</a> (CC BY 4.0).{" "}
          {result.pre_departure_orbit_arc || result.post_capture_orbit_arc
            ? "Departure/capture rings show the real propagated orbit where available, a circular approximation otherwise."
            : "Departure/capture rings are circular approximations only."}
        </p>
      </CardContent>
    </Card>
  )
}
