import { useMemo, useRef, useState } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { PauseWhenHidden } from "@/components/scene/PauseWhenHidden"
import { OrbitControls } from "@react-three/drei"
import * as THREE from "three"

import type { SlewTestSample } from "@/api/client"
import type { Vec3 } from "@/lib/vehicleGeometry"

// The real animated payoff of the slew test's q/omega_radps fields (backend
// ask, done): replays the ACTUAL closed-loop attitude motion
// against the vehicle's real placed hardware -- genuinely tumbles if the
// layout/gains can't hold pointing, genuinely settles if they can. Every
// frame's orientation is a slerp between two consecutive real samples from
// the backend's own SixDofState, not an approximation invented
// client-side. Deliberately small and inline in the paper -- the main
// VehicleViewport.tsx stays exactly as it was, this is a separate,
// simpler, non-interactive canvas.
//
// Round 2 (direct user feedback -- "add a vector that shows
// where it wants to point, and the real pointing vector... I want to see
// which thruster is being used"): the backend now returns q_command (the
// fixed target attitude, constant for the run) and per-sample
// thruster_duty_cycles. Both wired in here:
// - The controlled body axis is +X (verified against
//   reference_guidance.rs's own `burn_attitude_aligns_body_x_with_
//   commanded_direction` test -- not guessed) -- the green "target" arrow
//   is body +X rotated by q_command (static, computed once), the cyan
//   "actual" arrow is body +X rotated by the live q(t) (drawn as a plain
//   child of the rotating bus group, so it tracks for free with zero
//   extra per-frame math). The gold connector line between their tips is
//   the same error_deg the chart already plots, made geometric.
// - Each placed thruster shows a plume cone that inflates and glows
//   bright orange while its own thruster_duty_cycles[i] is nonzero that
//   frame -- real per-actuator firing data, not a guess at which one
//   "should" be firing.

const PLAYBACK_SECONDS = 12
const TARGET_COLOR = new THREE.Color("#4ade80")
const ACTUAL_COLOR = new THREE.Color("#39e6ff")
const THRUSTER_BASE_COLOR = new THREE.Color("#7a4520")
const THRUSTER_FIRING_COLOR = new THREE.Color("#ffb066")

// Round 3 of the "still don't see it" fix, same day -- the real cause
// wasn't visual subtlety at all, it was a threshold bug: a live probe of
// the actual response showed thruster_duty_cycles peaking around 0.015
// (1.5%) for a real, correctly-converging run (rcs_propellant_kg_used was
// genuinely nonzero) -- comfortably real firing, just numerically small
// relative to the actuator's full rated duty. The earlier >0.02 cutoff
// (both here and in the firing-text readout below) silently filtered out
// every real event. FIRE_EPS is deliberately tiny (any nonzero-ish duty
// counts as "firing"); DUTY_REFERENCE is what visual intensity is
// normalized against so a small-but-real duty cycle still reads as a
// strongly "on" plume instead of a barely-visible sliver -- the exact
// number doesn't matter for the qualitative "is this one doing anything"
// read the animation is for; the real numeric value is what
// thruster_duty_cycles/rcs_propellant_kg_used are for.
const FIRE_EPS = 1e-3
const DUTY_REFERENCE = 0.05

interface ThrusterVisual {
  positionM: Vec3
  direction: Vec3
}

// Interpolated playback state at a given simulated time -- bundles the
// slerped attitude with the elementwise-lerped per-thruster duty cycles so
// both share one bracket search per frame instead of two.
interface InterpState {
  quat: THREE.Quaternion
  thrusterDutyCycles: number[]
}

function bracket(samples: SlewTestSample[], simTimeS: number): { a: SlewTestSample; b: SlewTestSample; frac: number } {
  if (simTimeS <= samples[0].t_s) return { a: samples[0], b: samples[0], frac: 0 }
  const last = samples[samples.length - 1]
  if (simTimeS >= last.t_s) return { a: last, b: last, frac: 0 }
  // Linear scan is fine -- samples are capped at 300 points server-side.
  let i = 0
  while (i < samples.length - 1 && samples[i + 1].t_s < simTimeS) i++
  const a = samples[i]
  const b = samples[Math.min(i + 1, samples.length - 1)]
  const span = b.t_s - a.t_s
  const frac = span > 1e-9 ? (simTimeS - a.t_s) / span : 0
  return { a, b, frac: Math.max(0, Math.min(1, frac)) }
}

function interpAt(samples: SlewTestSample[], simTimeS: number): InterpState {
  const { a, b, frac } = bracket(samples, simTimeS)
  const qa = hamiltonToThree(a.q)
  const qb = hamiltonToThree(b.q)
  const dutyA = a.thruster_duty_cycles
  const dutyB = b.thruster_duty_cycles
  const thrusterDutyCycles = dutyA.map((v, i) => v + ((dutyB[i] ?? v) - v) * frac)
  return { quat: qa.slerp(qb, frac), thrusterDutyCycles }
}

// Backend convention is Hamilton [w, x, y, z] (SlewTestSample.q's own doc
// comment, same as SimStepMsg.q/CruiseStepMsg.q) -- THREE.Quaternion's
// constructor takes (x, y, z, w).
function hamiltonToThree(q: number[]): THREE.Quaternion {
  const [w, x, y, z] = q
  return new THREE.Quaternion(x, y, z, w).normalize()
}

// Real gap, found and fixed (: "I still don't
// see what thruster is firing when in the animation"). The original
// version only shifted a thin LINE's color/opacity -- WebGL ignores
// lineBasicMaterial's `linewidth` on most platforms (a well-known
// three.js limitation, not something this app can configure around), so
// the line always rendered at ~1px regardless of the `linewidth={2}`
// prop, and a subtle color lerp on a 1px line in a 240px canvas was
// essentially invisible. Fixed with a real growing/brightening PLUME CONE
// (same nozzle+plume idea VehicleViewport.tsx's PlacedThruster already
// uses for the static builder view) instead of relying on line styling at
// all: near-collapsed and dim at duty=0, visibly inflates and glows
// bright orange at duty=1 -- a shape CHANGE, not just a color shift, which
// reads clearly even at this canvas's small size.
function ThrusterMarker({
  thruster,
  armLenM,
  index,
  dutyCyclesRef,
}: {
  thruster: ThrusterVisual
  armLenM: number
  index: number
  dutyCyclesRef: React.RefObject<number[]>
}) {
  const plumeRef = useRef<THREE.Mesh>(null)
  const plumeMatRef = useRef<THREE.MeshBasicMaterial>(null)
  const glowRef = useRef<THREE.PointLight>(null)

  // Exhaust is -direction (direction is the FORCE on the spacecraft, per
  // RcsThruster's own field doc comment) -- same convention the base line
  // and VehicleViewport's PlacedThruster both already use.
  const exhaustQuat = useMemo(
    () =>
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(-thruster.direction[0], -thruster.direction[1], -thruster.direction[2]),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  // Round 2 of this fix, same day -- after the first pass:
  // "I do see something but it's not very clear." The 0.12->1.0 scale
  // swing was too subtle to read at this canvas's small size/typical zoom.
  // Widened dramatically (near-invisible when idle, MUCH bigger than the
  // thruster's own rest geometry when firing) plus a bright core sphere at
  // the nozzle that only exists while firing at all -- a genuinely new
  // shape appearing/disappearing reads far more clearly than any
  // continuous size/color ramp.
  // Sized down (direct user feedback: "make the thruster/sphere
  // now slightly smaller, but the idea is good") -- the clear-shape-
  // appearing/disappearing idea stays, just less dominant on screen.
  const plumeLenM = armLenM * 1.5
  const plumeRadiusM = plumeLenM * 0.32
  const coreRef = useRef<THREE.Mesh>(null)
  const coreMatRef = useRef<THREE.MeshBasicMaterial>(null)

  useFrame(() => {
    const duty = Math.max(0, dutyCyclesRef.current[index] ?? 0)
    const firing = duty > FIRE_EPS
    // Normalized against DUTY_REFERENCE, not the theoretical [0,1] max --
    // a real duty cycle of 0.015 is "basically fully on" for this
    // qualitative visualization, not 1.5% of the way to visible.
    const intensity = firing ? Math.min(1, duty / DUTY_REFERENCE) : 0
    const scale = firing ? 0.5 + intensity * 0.5 : 0.02
    if (plumeRef.current) plumeRef.current.scale.setScalar(scale)
    if (plumeMatRef.current) {
      plumeMatRef.current.color.lerpColors(THRUSTER_BASE_COLOR, THRUSTER_FIRING_COLOR, intensity)
      plumeMatRef.current.opacity = firing ? 0.5 + intensity * 0.4 : 0.05
    }
    if (glowRef.current) glowRef.current.intensity = intensity * 3
    if (coreRef.current) coreRef.current.visible = firing
    if (coreMatRef.current) coreMatRef.current.opacity = 0.7 + intensity * 0.3
  })

  return (
    <group position={thruster.positionM} quaternion={exhaustQuat}>
      <mesh ref={coreRef} visible={false}>
        <sphereGeometry args={[plumeRadiusM * 0.35, 12, 12]} />
        <meshBasicMaterial ref={coreMatRef} color={THRUSTER_FIRING_COLOR} transparent opacity={0.9} toneMapped={false} />
      </mesh>
      <group position={[0, plumeLenM / 2, 0]}>
        <mesh ref={plumeRef} rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[plumeRadiusM, plumeLenM, 16, 1, true]} />
          <meshBasicMaterial
            ref={plumeMatRef}
            color={THRUSTER_BASE_COLOR}
            transparent
            opacity={0.05}
            side={THREE.DoubleSide}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>
      <pointLight ref={glowRef} position={[0, plumeLenM * 0.4, 0]} color={THRUSTER_FIRING_COLOR} intensity={0} distance={plumeLenM * 4} />
    </group>
  )
}

// error_deg is the FULL quaternion distance (all 3 rotational DOF), but a
// single body+X arrow only encodes 2 of them (pitch/yaw) -- it's
// structurally blind to roll ABOUT that axis. A layout with real pitch/yaw
// authority but no roll authority (e.g. several same-direction thrusters
// on one face, see the static torque-authority check above) would show
// the two main arrows perfectly aligned while error_deg stays real and
// nonzero -- a genuine bug found live (: "the pointing
// error in the graph is sometimes much higher than what the 3D animation
// seems to show"). Fixed by drawing a SECOND, shorter reference ray (body
// +Y) alongside the primary one on both target and actual -- a proper
// 2-ray attitude gizmo, not a single vector, so roll misalignment is
// visible as the secondary rays pointing different directions even when
// the primary ones overlap.
const ROLL_REF_LEN_FRAC = 0.4

function TargetArrow({ qCommand, armLenM }: { qCommand: THREE.Quaternion; armLenM: number }) {
  const direction = useMemo(() => new THREE.Vector3(1, 0, 0).applyQuaternion(qCommand), [qCommand])
  const rollDir = useMemo(() => new THREE.Vector3(0, 1, 0).applyQuaternion(qCommand), [qCommand])
  const tip = useMemo(() => direction.clone().multiplyScalar(armLenM), [direction, armLenM])
  const rollTip = useMemo(() => rollDir.clone().multiplyScalar(armLenM * ROLL_REF_LEN_FRAC), [rollDir, armLenM])
  const positions = useMemo(() => new Float32Array([0, 0, 0, tip.x, tip.y, tip.z]), [tip])
  const rollPositions = useMemo(() => new Float32Array([0, 0, 0, rollTip.x, rollTip.y, rollTip.z]), [rollTip])
  return (
    <>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={TARGET_COLOR} transparent opacity={0.85} linewidth={2} />
      </line>
      <mesh position={tip}>
        <sphereGeometry args={[armLenM * 0.03, 12, 12]} />
        <meshBasicMaterial color={TARGET_COLOR} toneMapped={false} />
      </mesh>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[rollPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={TARGET_COLOR} transparent opacity={0.4} linewidth={1} />
      </line>
    </>
  )
}

// Rendered as a child of the rotating bus group -- body +X/+Y are fixed in
// the LOCAL frame, so Three.js's own parent-quaternion composition is what
// makes both rays track the live attitude every frame, no per-frame JS
// needed.
function ActualArrow({ armLenM }: { armLenM: number }) {
  const positions = useMemo(() => new Float32Array([0, 0, 0, armLenM, 0, 0]), [armLenM])
  const rollLen = armLenM * ROLL_REF_LEN_FRAC
  const rollPositions = useMemo(() => new Float32Array([0, 0, 0, 0, rollLen, 0]), [rollLen])
  return (
    <>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={ACTUAL_COLOR} transparent opacity={0.85} linewidth={2} />
      </line>
      <mesh position={[armLenM, 0, 0]}>
        <sphereGeometry args={[armLenM * 0.03, 12, 12]} />
        <meshBasicMaterial color={ACTUAL_COLOR} toneMapped={false} />
      </mesh>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[rollPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={ACTUAL_COLOR} transparent opacity={0.4} linewidth={1} />
      </line>
    </>
  )
}

// The one piece that genuinely needs a per-frame world-space recompute:
// the actual arrow's tip moves (it's inside the rotating group), the
// target arrow's tip doesn't -- so the connector geometry's own position
// attribute is mutated directly here rather than via React state, same
// direct-mutation discipline the rest of this app's Three.js views already
// use for anything touched every frame.
function ErrorConnector({
  targetTip,
  armLenM,
  busGroupRef,
}: {
  targetTip: THREE.Vector3
  armLenM: number
  busGroupRef: React.RefObject<THREE.Group | null>
}) {
  const geomRef = useRef<THREE.BufferGeometry>(null)
  useFrame(() => {
    if (!geomRef.current || !busGroupRef.current) return
    const actualTip = new THREE.Vector3(armLenM, 0, 0).applyQuaternion(busGroupRef.current.quaternion)
    const attr = geomRef.current.getAttribute("position") as THREE.BufferAttribute
    attr.setXYZ(0, targetTip.x, targetTip.y, targetTip.z)
    attr.setXYZ(1, actualTip.x, actualTip.y, actualTip.z)
    attr.needsUpdate = true
  })
  return (
    <line>
      <bufferGeometry ref={geomRef}>
        <bufferAttribute attach="attributes-position" args={[new Float32Array(6), 3]} />
      </bufferGeometry>
      <lineBasicMaterial color="#ffd54a" transparent opacity={0.55} />
    </line>
  )
}

function PlaybackDriver({
  samples,
  busGroupRef,
  playing,
  clockRef,
  dutyCyclesRef,
  onTick,
}: {
  samples: SlewTestSample[]
  busGroupRef: React.RefObject<THREE.Group | null>
  playing: boolean
  clockRef: React.RefObject<number>
  dutyCyclesRef: React.RefObject<number[]>
  onTick: (simTimeS: number, durationS: number, thrusterDutyCycles: number[]) => void
}) {
  useFrame((_, dt) => {
    if (samples.length === 0 || !busGroupRef.current) return
    const durationS = samples[samples.length - 1].t_s
    if (playing) {
      clockRef.current = Math.min(PLAYBACK_SECONDS, clockRef.current + dt)
    }
    const progress = PLAYBACK_SECONDS > 0 ? clockRef.current / PLAYBACK_SECONDS : 0
    const simTimeS = progress * durationS
    const { quat, thrusterDutyCycles } = interpAt(samples, simTimeS)
    busGroupRef.current.quaternion.copy(quat)
    for (let i = 0; i < dutyCyclesRef.current.length; i++) {
      dutyCyclesRef.current[i] = thrusterDutyCycles[i] ?? 0
    }
    onTick(simTimeS, durationS, thrusterDutyCycles)
  })
  return null
}

// The caller passes a fresh `key` (e.g. the mutation's own submittedAt
// timestamp) whenever a new slew-test result arrives, so React remounts
// this component from scratch instead of needing to reset the playback
// clock/play-state itself -- this repo's eslint-plugin-react-hooks config
// forbids both calling setState synchronously in an effect body AND
// reading/writing a ref during render, so a remount-via-key is the clean
// idiomatic way to get "fresh state per new result" without either.
export function AttitudeReplayCanvas({
  busDimsM,
  thrusters,
  samples,
  qCommand,
  onPlaybackComplete,
}: {
  busDimsM: Vec3
  thrusters: ThrusterVisual[]
  samples: SlewTestSample[]
  // [w, x, y, z] Hamilton convention, same as SlewTestSample.q -- the
  // fixed target attitude, constant for the whole run.
  qCommand: number[]
  // Fires once, the first time the compressed playback clock reaches
  // PLAYBACK_SECONDS -- lets a caller chain a new slew-test call timed to
  // the visible end of THIS segment's animation, not the (near-instant)
  // network response. Guarded by firedRef below so a caller relying on
  // this to trigger exactly once per mount doesn't get called repeatedly
  // once clockRef is pinned at PLAYBACK_SECONDS.
  onPlaybackComplete?: () => void
}) {
  const busGroupRef = useRef<THREE.Group>(null)
  const clockRef = useRef(0)
  const dutyCyclesRef = useRef<number[]>(thrusters.map(() => 0))
  const [playing, setPlaying] = useState(true)
  const readoutRef = useRef<HTMLDivElement | null>(null)
  const firingRef = useRef<HTMLDivElement | null>(null)
  const completedRef = useRef(false)

  const busDist = Math.max(...busDimsM) * 3.2
  const thrusterArmLenM = Math.max(...busDimsM) * 0.4
  const vectorArmLenM = Math.max(...busDimsM) * 0.9
  const busGeom = useMemo(() => new THREE.BoxGeometry(busDimsM[0], busDimsM[1], busDimsM[2]), [busDimsM])

  // Computed once, not per frame, since the target is constant for the
  // whole run.
  const qCommandThree = useMemo(() => hamiltonToThree(qCommand), [qCommand])
  const targetDir = useMemo(() => new THREE.Vector3(1, 0, 0).applyQuaternion(qCommandThree), [qCommandThree])
  const targetTip = useMemo(() => targetDir.clone().multiplyScalar(vectorArmLenM), [targetDir, vectorArmLenM])

  // A definitive text readout, independent of the 3D rendering entirely --
  // round 2 of the "still don't see it clearly" fix, so which thruster(s)
  // are firing is unambiguous regardless of camera angle/zoom/how the
  // plume geometry happens to read.
  function handleTick(simTimeS: number, durationS: number, thrusterDutyCycles: number[]) {
    if (readoutRef.current) {
      readoutRef.current.textContent = `t = ${simTimeS.toFixed(0)} s / ${durationS.toFixed(0)} s`
    }
    if (firingRef.current) {
      const firing = thrusterDutyCycles.flatMap((d, i) => (d > FIRE_EPS ? [`#${i + 1}`] : []))
      firingRef.current.textContent = firing.length > 0 ? `Firing: ${firing.join(", ")}` : "No thrusters firing"
    }
    if (!completedRef.current && clockRef.current >= PLAYBACK_SECONDS) {
      completedRef.current = true
      onPlaybackComplete?.()
    }
  }

  if (samples.length === 0) return null

  return (
    <div className="relative h-[240px] w-full border border-[#171512]">
      <Canvas camera={{ position: [busDist * 0.75, busDist * 0.55, busDist * 0.75], fov: 42, near: 0.01, far: 1000 }}>
        <PauseWhenHidden tool="study" />
        <color attach="background" args={["#04060c"]} />
        <ambientLight intensity={0.9} color="#9aa3b8" />
        <directionalLight position={[4, 5, 3]} intensity={1.4} color="#fff2dd" />
        <directionalLight position={[-4, -2, -3]} intensity={0.5} color="#88aaff" />

        <TargetArrow qCommand={qCommandThree} armLenM={vectorArmLenM} />
        <ErrorConnector targetTip={targetTip} armLenM={vectorArmLenM} busGroupRef={busGroupRef} />

        <group ref={busGroupRef}>
          <mesh geometry={busGeom}>
            <meshStandardMaterial color="#9aa3b5" metalness={0.35} roughness={0.55} />
            <lineSegments>
              <edgesGeometry args={[busGeom]} />
              <lineBasicMaterial color="#2a3346" />
            </lineSegments>
          </mesh>
          {thrusters.map((t, i) => (
            <ThrusterMarker key={i} thruster={t} armLenM={thrusterArmLenM} index={i} dutyCyclesRef={dutyCyclesRef} />
          ))}
          <ActualArrow armLenM={vectorArmLenM} />
        </group>

        <PlaybackDriver
          samples={samples}
          busGroupRef={busGroupRef}
          playing={playing}
          clockRef={clockRef}
          dutyCyclesRef={dutyCyclesRef}
          onTick={handleTick}
        />
        <OrbitControls enableDamping dampingFactor={0.08} minDistance={busDist * 0.15} maxDistance={busDist * 8} />
      </Canvas>
      <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="pointer-events-auto rounded border border-white/20 bg-black/50 px-2 py-1 text-[10px] font-bold tracking-[0.08em] text-white/80 uppercase backdrop-blur-sm hover:border-white/40"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={() => {
            clockRef.current = 0
            setPlaying(true)
          }}
          className="pointer-events-auto rounded border border-white/20 bg-black/50 px-2 py-1 text-[10px] font-bold tracking-[0.08em] text-white/80 uppercase backdrop-blur-sm hover:border-white/40"
        >
          Restart
        </button>
        <div ref={readoutRef} className="rounded bg-black/50 px-2 py-1 font-mono text-[10px] text-white/70 backdrop-blur-sm" />
      </div>
      <div className="pointer-events-none absolute top-2 right-2 flex flex-col items-end gap-0.5 text-[9px] font-bold uppercase">
        <span style={{ color: "#4ade80" }}>● target</span>
        <span style={{ color: "#39e6ff" }}>● actual</span>
      </div>
      {thrusters.length > 0 && (
        <div
          ref={firingRef}
          className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-[10px] font-bold text-[#ffb066] backdrop-blur-sm"
        >
          No thrusters firing
        </div>
      )}
    </div>
  )
}
