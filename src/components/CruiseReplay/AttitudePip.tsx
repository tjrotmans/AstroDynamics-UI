import { useMemo, useRef } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { Html, OrbitControls } from "@react-three/drei"
import * as THREE from "three"

import type { BodyTrackConfig, CruiseStepMsg, HardwareItem } from "@/api/client"
import { ECLIPTIC_LEVEL_QUATERNION } from "@/components/scene/sceneShared"
import { PauseWhenHidden } from "@/components/scene/PauseWhenHidden"
import { DEBUG_FLAGS } from "@/lib/debugFlags"
import { trackPositionAt } from "@/lib/bodyTrackFetch"
import { isManeuverMode, maneuverModeLabel } from "@/lib/cruiseModeSegments"
import { VehicleMesh } from "./VehicleMesh"
import { VehicleVectorLegendEntries } from "./vehicleVectorLegend"

// Real complaint found (user, several rounds): the old version
// rendered a generic placeholder box (not the real vehicle), had its own
// independent OrbitControls that fought the parent's click-to-swap handler
// ("switching between these two plots is too easily triggered" -- any
// click INSIDE the pip, including the release of a drag gesture, bubbled
// up as a swap click), and stacked a world/ecliptic axesHelper on top of
// VehicleMesh's own body-fixed triad ("we now have two frames in that
// attitude plot"). Rebuilt: the REAL VehicleMesh (already draws its own
// SBCF triad -- nothing else needed here), a camera that MIRRORS the main
// Trajectory view's own camera direction (via the shared cameraDirRef, so
// "the attitude of the s/c in the attitude plot is the same as in the
// trajectory plot" is true by construction, not just axis-convention-
// matching), and NO interactive controls at all -- a click anywhere in
// this pip unambiguously means "swap views."
//
// refinement (direct user ask: "see the attitude plot on the
// right in large version, allowing me also to rotate the s/c"): when this
// view occupies the MAIN slot (`interactive`), it gets its own
// OrbitControls -- the original "no controls" reasoning was about the small
// CORNER pip, where any drag-release bubbled up as a swap click. In the
// main slot the swap gesture lives on the corner thumbnail instead, so
// rotation here no longer fights anything. The camera starts from the
// mirrored direction (seamless swap-in) and then belongs to the user.
const TARGET_COLOR = "#4ade80"
// Actual thrust axis (body +X, the fixed main-engine convention --
// cruise.rs's own `body_dir`). Matches the Burning maneuver color used in
// the timeline/figures, since this vector IS what that phase is aligning.
const THRUST_AXIS_COLOR = "#e04a3a"
// Context vectors (ask: "show the trajectory there, or some
// directions, something that gives a bit more clarity, and a wow factor").
// All derived from REAL data: Sun direction is -r̂ (heliocentric position is
// streamed), the target-body direction comes from the same ephemeris track
// the viewport renders, and the velocity direction is finite-differenced
// from adjacent streamed positions -- a DISPLAY-ONLY direction (same
// sanctioned category as lib/lambert.ts: pixels, never a number).
const SUN_DIR_COLOR = "#ffd54a"
const VELOCITY_COLOR = "#6ee7ff"
const TARGET_BODY_COLOR = "#c9d2e8"
const DEPARTURE_BODY_COLOR = "#8fb3ff"
const RATE_COLOR = "#ff8fd6"
const RIBBON_COLOR = "#ffd54a"
const ECLIPTIC_COLOR = "#5b7fd6"

// A faint disc in the ecliptic plane through the vehicle (the pip's scene
// is the leveled frame, so the ecliptic IS z=0 here) -- an absolute "up"
// reference that survives rotating the view, matching the ecliptic grid
// convention of every trajectory view in the app.
function EclipticDisc({ busDist, labeled }: { busDist: number; labeled: boolean }) {
  return (
    <group>
      <mesh>
        <ringGeometry args={[busDist * 0.85, busDist * 2.7, 72]} />
        <meshBasicMaterial color={ECLIPTIC_COLOR} transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh>
        <ringGeometry args={[busDist * 2.68, busDist * 2.7, 72]} />
        <meshBasicMaterial color={ECLIPTIC_COLOR} transparent opacity={0.35} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {labeled && !DEBUG_FLAGS.noLabels && (
        <Html position={[busDist * 2.7, 0, 0]} center style={{ pointerEvents: "none" }}>
          <div style={{ color: ECLIPTIC_COLOR, fontSize: 8, whiteSpace: "nowrap", opacity: 0.7 }}>ecliptic plane</div>
        </Html>
      )}
    </group>
  )
}

// Real request: "show cones much larger" (zoomed-out legibility
// in this small pip) + "add a legend... instead of putting the labels
// inside the plot" -- VehicleMesh's own in-scene Html labels are suppressed
// here (showLabels=false) in favor of this legend, and cones are scaled up
// well past their true-to-scale main-view size (boresightScale).
const PIP_BORESIGHT_SCALE = 3.2

function hamiltonToThreeLeveled(q: number[]): THREE.Quaternion {
  const [w, x, y, z] = q
  const raw = new THREE.Quaternion(x, y, z, w).normalize()
  return ECLIPTIC_LEVEL_QUATERNION.clone().multiply(raw)
}

// Body-axis ray: +X of the given attitude quaternion, as an arrow.
function DirectionRay({ quat, armLen, color, label }: { quat: THREE.Quaternion; armLen: number; color: string; label: string }) {
  const dir = useMemo(() => new THREE.Vector3(1, 0, 0).applyQuaternion(quat), [quat])
  return <VectorRay dir={dir} armLen={armLen} color={color} label={label} />
}

// An ARROW from the vehicle's center (the pip scene's origin) with its name
// at the tip (
// arrow" instead of a legend) -- for the commanded/actual thrust axes and
// the Sun/velocity/target context vectors, all directions in the leveled
// world frame.
const UP = new THREE.Vector3(0, 1, 0)
function VectorRay({
  dir,
  armLen,
  color,
  label,
  opacity = 1,
}: {
  dir: THREE.Vector3
  armLen: number
  color: string
  label: string
  opacity?: number
}) {
  const positions = useMemo(
    () => new Float32Array([0, 0, 0, dir.x * armLen, dir.y * armLen, dir.z * armLen]),
    [dir, armLen],
  )
  const headLen = armLen * 0.1
  const headQuat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()), [dir])
  const headCenter = useMemo(() => dir.clone().multiplyScalar(armLen - headLen / 2), [dir, armLen, headLen])
  const labelPos = useMemo(() => dir.clone().multiplyScalar(armLen * 1.12), [dir, armLen])
  return (
    <group>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} transparent opacity={opacity} />
      </line>
      <mesh position={headCenter} quaternion={headQuat}>
        <coneGeometry args={[headLen * 0.35, headLen, 10]} />
        <meshBasicMaterial color={color} transparent opacity={opacity} />
      </mesh>
      {!DEBUG_FLAGS.noLabels && (
        <Html position={labelPos} center style={{ pointerEvents: "none" }}>
          <div style={{ color, fontSize: 9, fontWeight: 700, whiteSpace: "nowrap", textShadow: "0 0 3px #000", opacity }}>
            {label}
          </div>
        </Html>
      )}
    </group>
  )
}

// The local stretch of the actual flown trajectory, drawn THROUGH the
// vehicle at an arbitrary (labeled) zoom: real streamed positions around
// the playhead, relative to the current one, uniformly scaled to fit the
// pip. Shape is true; scale is not (a few-meter vehicle vs. a
// million-km path can't share a literal scale) -- the legend says so.
function LocalTrajectoryRibbon({
  steps,
  tickIdx,
  busDist,
}: {
  steps: CruiseStepMsg[]
  tickIdx: number
  busDist: number
}) {
  const positions = useMemo(() => {
    if (steps.length < 3) return null
    const half = Math.max(5, Math.floor(steps.length * 0.02))
    const lo = Math.max(0, tickIdx - half)
    const hi = Math.min(steps.length - 1, tickIdx + half)
    if (hi - lo < 2) return null
    const cur = steps[tickIdx].r_m
    const rel: THREE.Vector3[] = []
    let maxNorm = 0
    for (let i = lo; i <= hi; i++) {
      const p = steps[i].r_m
      const v = new THREE.Vector3(p[0] - cur[0], p[1] - cur[1], p[2] - cur[2]).applyQuaternion(ECLIPTIC_LEVEL_QUATERNION)
      maxNorm = Math.max(maxNorm, v.length())
      rel.push(v)
    }
    if (maxNorm <= 0) return null
    const scale = (busDist * 2.4) / maxNorm
    const arr = new Float32Array(rel.length * 3)
    rel.forEach((v, i) => {
      arr[i * 3] = v.x * scale
      arr[i * 3 + 1] = v.y * scale
      arr[i * 3 + 2] = v.z * scale
    })
    return arr
  }, [steps, tickIdx, busDist])
  if (!positions) return null
  const n = positions.length / 3
  const endPos: [number, number, number] = [positions[(n - 1) * 3], positions[(n - 1) * 3 + 1], positions[(n - 1) * 3 + 2]]
  return (
    <group>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={RIBBON_COLOR} transparent opacity={0.65} />
      </line>
      {!DEBUG_FLAGS.noLabels && (
        <Html position={endPos} center style={{ pointerEvents: "none" }}>
          <div style={{ color: RIBBON_COLOR, fontSize: 8, whiteSpace: "nowrap", opacity: 0.7, textShadow: "0 0 3px #000" }}>
            flown path (not to scale)
          </div>
        </Html>
      )}
    </group>
  )
}

// Mirrors the main view's camera direction every frame -- no independent
// rotation/zoom of its own, by design (see file header).
function MirrorCamera({ cameraDirRef, busDist }: { cameraDirRef: React.RefObject<THREE.Vector3>; busDist: number }) {
  useFrame((state) => {
    const dir = cameraDirRef.current
    state.camera.position.copy(dir).multiplyScalar(busDist * 1.6)
    state.camera.lookAt(0, 0, 0)
  })
  return null
}

// Real angle a solar panel's own normal makes with the real Sun direction
// (Sun is always at the heliocentric origin, so this needs no ephemeris --
// just tick.r_m/q, both already real streamed data). Both q and r_m are
// used in their RAW (un-leveled) frame together -- self-consistent
// regardless of any scene-rendering leveling correction, since this is a
// pure body-frame geometry question, not a rendering one.
function sunPointingErrorDeg(tick: CruiseStepMsg, panelNormalBody: number[]): number {
  const sunDirWorld = new THREE.Vector3(-tick.r_m[0], -tick.r_m[1], -tick.r_m[2]).normalize()
  const [w, x, y, z] = tick.q
  const qInv = new THREE.Quaternion(x, y, z, w).normalize().invert()
  const sunDirBody = sunDirWorld.applyQuaternion(qInv)
  const n = new THREE.Vector3(...(panelNormalBody as [number, number, number])).normalize()
  const cosAngle = THREE.MathUtils.clamp(sunDirBody.dot(n), -1, 1)
  return (Math.acos(cosAngle) * 180) / Math.PI
}

export function AttitudePip({
  tick,
  busDimsM,
  hardware,
  cameraDirRef,
  interactive = false,
  steps = [],
  targetTrack = null,
  targetName = null,
  departureTrack = null,
  departureName = null,
  sampleSpacingS = null,
}: {
  // Real spacing between the reported samples around the playhead [s] --
  // the attitude shown between them is slerped for display (honesty label).
  sampleSpacingS?: number | null
  tick: CruiseStepMsg | null
  busDimsM: number[]
  hardware: HardwareItem[]
  cameraDirRef: React.RefObject<THREE.Vector3>
  // True when this view fills the MAIN slot (swapped): the camera becomes
  // user-controlled OrbitControls instead of mirroring the trajectory view.
  interactive?: boolean
  // Context for the direction rays/trajectory ribbon (see the color-constant
  // block above) -- all optional; the pip degrades to the plain vehicle+
  // commanded-direction view when absent.
  steps?: CruiseStepMsg[]
  targetTrack?: BodyTrackConfig | null
  targetName?: string | null
  departureTrack?: BodyTrackConfig | null
  departureName?: string | null
}) {
  const targetQuat = useMemo(() => (tick ? hamiltonToThreeLeveled(tick.q_cmd) : new THREE.Quaternion()), [tick])
  const actualQuat = useMemo(() => (tick ? hamiltonToThreeLeveled(tick.q) : new THREE.Quaternion()), [tick])
  const busDist = Math.max(...busDimsM, 0.2) * Math.sqrt(3)

  // Nearest reported sample index by time -- `tick` may be an interpolated
  // display tick (lib/cruiseInterp.ts) that is not itself in `steps`.
  const tickIdx = useMemo(() => {
    if (!tick || steps.length === 0) return -1
    let lo = 0
    let hi = steps.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (steps[mid].t_s < tick.t_s) lo = mid + 1
      else hi = mid
    }
    return lo
  }, [steps, tick])
  const sunDir = useMemo(() => {
    if (!tick) return null
    return new THREE.Vector3(-tick.r_m[0], -tick.r_m[1], -tick.r_m[2]).normalize().applyQuaternion(ECLIPTIC_LEVEL_QUATERNION)
  }, [tick])
  // Direction of motion, finite-differenced from adjacent streamed
  // positions -- display-only (see the color-constant block's note).
  const velDir = useMemo(() => {
    if (tickIdx < 0 || steps.length < 2) return null
    const a = steps[Math.max(0, tickIdx - 1)].r_m
    const b = steps[Math.min(steps.length - 1, tickIdx + 1)].r_m
    const v = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (v.lengthSq() === 0) return null
    return v.normalize().applyQuaternion(ECLIPTIC_LEVEL_QUATERNION)
  }, [steps, tickIdx])
  const bodyDir = (track: BodyTrackConfig | null) => {
    if (!tick || !track) return null
    const p = trackPositionAt(track, tick.t_s)
    const v = new THREE.Vector3(p[0] - tick.r_m[0], p[1] - tick.r_m[1], p[2] - tick.r_m[2])
    if (v.lengthSq() === 0) return null
    return v.normalize().applyQuaternion(ECLIPTIC_LEVEL_QUATERNION)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const targetDir = useMemo(() => bodyDir(targetTrack), [tick, targetTrack])
  // Departure-body (nadir) direction -- the reference that matters during
  // the parking phase and the escape.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const departureDir = useMemo(() => bodyDir(departureTrack), [tick, departureTrack])
  // Body angular rate (real streamed omega_radps, landed backend-side
  //): the rotation axis as an arrow, magnitude in the label --
  // the single most diagnostic vector for slew/tumble behavior. ω is body-
  // frame, so rotate it through the attitude into the (leveled) world.
  // Direction only means something when the rate is not noise-level: a
  // normalized near-zero vector points anywhere (:
  // "the vector starts to point in random directions"). Below RATE_FLOOR
  // the arrow is not drawn; above it, its LENGTH scales with the rate so a
  // fading rate visibly shrinks instead of flailing at full length.
  const RATE_FLOOR_DEG_S = 2e-3
  const RATE_FULL_DEG_S = 0.5
  const rate = useMemo(() => {
    const w = tick?.omega_radps
    if (!tick || !w || w.length !== 3) return null
    const mag = Math.hypot(w[0], w[1], w[2])
    const degPerS = (mag * 180) / Math.PI
    if (degPerS < RATE_FLOOR_DEG_S) return null
    const dir = new THREE.Vector3(w[0], w[1], w[2]).normalize().applyQuaternion(hamiltonToThreeLeveled(tick.q))
    const lengthFrac = 0.35 + 0.65 * Math.min(1, degPerS / RATE_FULL_DEG_S)
    return { dir, degPerS, lengthFrac }
  }, [tick])
  // During a maneuver (Slewing/Burning -- NOT RcsCorrecting, which holds
  // ordinary pointing by design), the commanded ray IS the required burn
  // direction and the actual body +X is what's chasing it -- drawing both
  // makes the alignment gap (the numeric thrust-axis error below) directly
  // visible as an angle, the way STK/Basilisk-style attitude insets show
  // commanded vs. achieved frames.
  const inManeuver = tick != null && isManeuverMode(tick.active_mode) && tick.active_mode !== "RcsCorrecting"
  // Capture the mirrored direction once at mount so an interactive swap-in
  // starts exactly where the trajectory view was looking, then hands over.
  const initialCamPosRef = useRef<[number, number, number] | null>(null)
  if (initialCamPosRef.current == null) {
    const d = cameraDirRef.current.clone().multiplyScalar(busDist * 1.6)
    initialCamPosRef.current = [d.x, d.y, d.z]
  }

  const panelItem = hardware.find((h) => h.type === "SolarPanel" && h.normal)
  const sunErrDeg = useMemo(() => {
    if (!tick || !panelItem || panelItem.type !== "SolarPanel" || !panelItem.normal) return null
    return sunPointingErrorDeg(tick, panelItem.normal)
  }, [tick, panelItem])

  // Real request: "Sun direction doesn't have to be displayed
  // in the attitude plot, but we could add the error for both the payload/
  // boresight pointing and for the panel normal pointing" -- the Sun ray
  // itself is dropped (VehicleMesh's own panel-normal cone is the visual
  // context now); the panel-to-Sun angle is kept as the numeric readout
  // below instead, alongside the existing boresight pointing error.
  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ fov: 42, near: busDist * 0.01, far: 1000, position: initialCamPosRef.current }}
        // Pixel budget (profile: native render work dominated the
        // main thread): the small corner pip renders at 1x, the enlarged
        // view at most 1.5x, instead of the device's full 2x-3x.
        dpr={interactive ? [1, 1.5] : 1}
      >
        <PauseWhenHidden tool="cruise" />
        <color attach="background" args={["#04060c"]} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[2, 2, 2]} intensity={1} color="#fff2dd" />
        <VehicleMesh
          busDimsM={busDimsM}
          hardware={hardware}
          quaternion={tick?.q ?? null}
          boresightScale={PIP_BORESIGHT_SCALE}
          showLabels
          labelsOnHover
          axesGrey
          distanceScaled={false}
        />
        <DirectionRay
          quat={targetQuat}
          armLen={busDist * 1.4}
          color={TARGET_COLOR}
          label={inManeuver ? "commanded thrust" : "commanded"}
        />
        {inManeuver && <DirectionRay quat={actualQuat} armLen={busDist * 1.25} color={THRUST_AXIS_COLOR} label="thrust axis +X" />}
        {sunDir && <VectorRay dir={sunDir} armLen={busDist * 1.6} color={SUN_DIR_COLOR} label="Sun" opacity={0.9} />}
        {velDir && <VectorRay dir={velDir} armLen={busDist * 1.6} color={VELOCITY_COLOR} label="velocity" opacity={0.9} />}
        {targetDir && (
          <VectorRay dir={targetDir} armLen={busDist * 1.6} color={TARGET_BODY_COLOR} label={targetName ?? "target"} opacity={0.8} />
        )}
        {departureDir && (
          <VectorRay
            dir={departureDir}
            armLen={busDist * 1.5}
            color={DEPARTURE_BODY_COLOR}
            label={departureName ?? "departure body"}
            opacity={0.7}
          />
        )}
        {rate && (
          <VectorRay
            dir={rate.dir}
            armLen={busDist * 1.2 * rate.lengthFrac}
            color={RATE_COLOR}
            label={`rate ${rate.degPerS >= 0.1 ? rate.degPerS.toFixed(2) : rate.degPerS.toExponential(1)}°/s`}
            opacity={0.95}
          />
        )}
        <EclipticDisc busDist={busDist} labeled={interactive} />
        {tickIdx >= 0 && <LocalTrajectoryRibbon steps={steps} tickIdx={tickIdx} busDist={busDist} />}
        {interactive ? (
          <OrbitControls
            enableDamping
            dampingFactor={0.08}
            enablePan={false}
            minDistance={busDist * 0.6}
            maxDistance={busDist * 6}
            zoomSpeed={1.2}
          />
        ) : (
          <MirrorCamera cameraDirRef={cameraDirRef} busDist={busDist} />
        )}
      </Canvas>
      {/* Legend only in the LARGE (main-slot) view (
          to always keep the legend in the main plot"): every direction is
          also an arrow named at its tip, and hardware cones name themselves
          on hover, so the small corner pip stays clean. */}
      {interactive ? (
        <div className="pointer-events-none absolute top-1.5 left-1.5 flex flex-col gap-0.5 text-[9px] font-semibold">
          {[
            [TARGET_COLOR, inManeuver ? "commanded thrust direction" : "commanded/target direction"],
            ...(inManeuver ? [[THRUST_AXIS_COLOR, "actual thrust axis (body +X)"]] : []),
            ...(sunDir ? [[SUN_DIR_COLOR, "Sun direction"]] : []),
            ...(velDir ? [[VELOCITY_COLOR, "velocity (prograde)"]] : []),
            ...(targetDir ? [[TARGET_BODY_COLOR, `${targetName ?? "target"} direction`]] : []),
            ...(departureDir ? [[DEPARTURE_BODY_COLOR, `${departureName ?? "departure body"} direction`]] : []),
            ...(rate ? [[RATE_COLOR, "body rotation axis (rate in label)"]] : []),
            ...(tickIdx >= 0 ? [[RIBBON_COLOR, "flown path (not to scale)"]] : []),
            [ECLIPTIC_COLOR, "ecliptic plane"],
          ].map(([color, text]) => (
            <span key={text} className="flex items-center gap-1" style={{ color }}>
              <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
              {text}
            </span>
          ))}
          <VehicleVectorLegendEntries hardware={hardware} />
        </div>
      ) : (
        <div className="pointer-events-none absolute top-1.5 left-1.5 text-[9px] text-white/35">hover a cone for its name</div>
      )}
      {interactive && (
        <div className="pointer-events-none absolute top-1.5 right-1.5 text-right text-[9px] font-semibold text-white/40">
          drag to rotate · scroll to zoom
          {sampleSpacingS != null && (
            <div className="font-normal text-white/30">
              attitude slerped between reported samples (Δ {sampleSpacingS >= 120 ? `${(sampleSpacingS / 60).toFixed(1)} min` : `${sampleSpacingS.toFixed(0)} s`})
            </div>
          )}
        </div>
      )}
      {tick && (
        <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex flex-col gap-0.5 text-[9px] font-semibold text-white/80">
          {/* Real confusion found (
              the difference between SunPointing boresight error and the
              panel-to-Sun pointing error is"). The two used to always show
              together with no relation to which mode was actually active --
              during SunPointing, tick.pointing_error_deg already IS the
              panel-to-Sun error (SunPointing has no boresight target at
              all), so labeling it "boresight error" and showing a second,
              separately-computed panel-to-Sun number right under it read as
              two different measurements when they're the same objective.
              Fixed to mirror the operator's mental model: SunPointing shows
              ONE number (its one real objective, panel-to-Sun); any other
              active mode (TargetPointing, etc.) shows the mode's own
              boresight error as primary plus panel-to-Sun as an explicitly
              labeled secondary/housekeeping check, since panel pointing
              keeps mattering for power even while a different rule has
              priority. */}
          {isManeuverMode(tick.active_mode) ? (
            // Design decision:
            // cruise.rs's TCM executive already IS the "Maneuver
            // Mode" concept -- slew body +X (the assumed main-engine axis)
            // to the computed burn direction, then fire spacecraft.
            // propulsion -- just reported as "Slewing"/"Burning" rather
            // than a named mode. pointing_error_deg here is genuinely the
            // THRUST-AXIS alignment error during this state, not a
            // boresight error (no sensor/hardware rule is active). No
            // secondary panel-to-Sun line -- the backend confirmed has no
            // secondary rule during a burn (a real limitation, not omitted
            // here by choice).
            //
            // `RcsCorrecting` (backend item #4) is a real
            // exception to all of the above: it deliberately does NOT
            // override pointing (that's the entire point of choosing it
            // for a small correction or a pointing-locked mode), so
            // pointing_error_deg here is the ORDINARY boresight/panel error
            // against whatever mode is still active, not a thrust-axis
            // error -- labeling it "thrust-axis error" would be wrong.
            <span>
              {maneuverModeLabel(tick.active_mode as string)} —{" "}
              {tick.active_mode === "RcsCorrecting" ? "pointing held, boresight error" : "thrust-axis error"}:{" "}
              {tick.pointing_error_deg.toFixed(1)}°
            </span>
          ) : tick.active_mode === "SunPointing" ? (
            sunErrDeg != null && <span>SunPointing — panel → Sun error: {sunErrDeg.toFixed(1)}°</span>
          ) : (
            <>
              <span>
                {tick.active_mode ?? "fixed hold"} — boresight → target error: {tick.pointing_error_deg.toFixed(1)}°
              </span>
              {sunErrDeg != null && <span>secondary — panel → Sun error: {sunErrDeg.toFixed(1)}°</span>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
