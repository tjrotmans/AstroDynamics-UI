import { useMemo, useRef } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { PauseWhenHidden } from "@/components/scene/PauseWhenHidden"
import { OrbitControls } from "@react-three/drei"
import * as THREE from "three"

import { BodyAxesTriad } from "@/components/Vehicle/BodyAxesTriad"
import type { Vec3 } from "@/lib/vehicleGeometry"

// A real, not invented, drawing of the wheel cluster the simulation
// actually uses -- axis geometry taken directly from
// crates/attitude_control/src/reaction_wheels.rs's ReactionWheelCluster::
// four_wheel_pyramid (S = sqrt(1/3), C = sqrt(2/3), verified against the
// real constructor before drawing anything): four wheels, spin axes at
// (S,0,C)/(0,S,C)/(-S,0,C)/(0,-S,C), i.e. a skew pyramid canted ~35.26 deg
// off +Z, one wheel per XY quadrant. Real finding while building this:
// `wheel_cluster_from_hardware()` never reads the HardwareItem's `count`
// field at all -- the simulated cluster is ALWAYS these exact 4 wheels,
// regardless of what Table 3's Count says (Count only affects the mass
// rollup in vehicle_properties.rs). This diagram deliberately always shows
// 4 wheels for that reason, not `count` -- drawing something else would
// misrepresent what's actually simulated. Wheel disk SIZE is a visual
// proxy only (radius scaled off the selected spec's own mass, relative to
// the real catalog's min/max mass) -- not a claim about real wheel
// dimensions, which aren't part of any catalog spec.
const S = Math.sqrt(1 / 3)
const C = Math.sqrt(2 / 3)
const WHEEL_AXES: Vec3[] = [
  [S, 0, C],
  [0, S, C],
  [-S, 0, C],
  [0, -S, C],
]

// Real bug, found (: "looks like one big
// blob"): every WheelDisk was rotated onto its own spin axis but never
// actually OFFSET from the group origin, so all 4 disks were literally
// coincident -- only their orientation differed, invisible at a glance.
// The real backend cluster geometry has no per-wheel POSITION at all (see
// the file header) -- there's nothing physical to place them at -- so this
// offset is a pure visual-clarity device: each disk is pushed outward
// along its own real spin axis by a small multiple of its own radius,
// which reproduces the classic "splayed skew pyramid" look real 4-wheel
// cluster photos have, without claiming a real position that doesn't
// exist in the model. Round 2 (: "still
// coinciding, even for small ones") -- 1.3x radius wasn't nearly enough
// separation for two axes only ~35 deg apart (the pyramid's own real cant
// angle, verified against reaction_wheels.rs -- not something this file
// controls); bumped substantially so all four disks read as clearly
// distinct at every wheel size in the catalog's real mass range, not just
// the one size this was originally eyeballed against.
const SPREAD_FACTOR = 2.6

function WheelDisk({ axis, radiusM }: { axis: Vec3; radiusM: number }) {
  const axisVec = useMemo(() => new THREE.Vector3(...axis), [axis])
  const quat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisVec), [axisVec])
  const offset = useMemo(() => axisVec.clone().multiplyScalar(radiusM * SPREAD_FACTOR), [axisVec, radiusM])
  const thicknessM = radiusM * 0.35
  return (
    <group position={offset} quaternion={quat}>
      <mesh>
        <cylinderGeometry args={[radiusM, radiusM, thicknessM, 24]} />
        {/* Round 2 ("too dark"): lighter base color + emissive
            kick so the disks read clearly even before extra scene lighting
            is added below. */}
        <meshStandardMaterial color="#b8c3e6" emissive="#3a4470" emissiveIntensity={0.25} metalness={0.35} roughness={0.35} />
      </mesh>
      {/* short spindle showing the spin axis direction */}
      <mesh position={[0, radiusM * 0.9, 0]}>
        <cylinderGeometry args={[radiusM * 0.06, radiusM * 0.06, radiusM * 1.2, 8]} />
        <meshStandardMaterial color="#7783b0" metalness={0.5} roughness={0.25} />
      </mesh>
    </group>
  )
}

// Spins as one rigid cluster -- the AXES TRIAD below is deliberately a
// SIBLING, not a child, of this group: it represents the fixed spacecraft
// body frame the wheels are mounted in, so it must stay still while the
// wheels themselves idle-spin for visual interest.
function SpinningCluster({ radiusM }: { radiusM: number }) {
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (groupRef.current) groupRef.current.rotation.z += dt * 0.15
  })
  return (
    <group ref={groupRef}>
      {WHEEL_AXES.map((axis, i) => (
        <WheelDisk key={i} axis={axis} radiusM={radiusM} />
      ))}
    </group>
  )
}

export function WheelClusterDiagram({
  massKgPerWheel,
  catalogMassRangeKg,
}: {
  massKgPerWheel: number | null
  // [min, max] mass across the real catalog, for scaling this one spec's
  // disk size relative to the range of options actually available -- not
  // an absolute physical dimension (no real diameter field exists in
  // ReactionWheelSpec).
  catalogMassRangeKg: [number, number]
}) {
  const [minMass, maxMass] = catalogMassRangeKg
  const massForScale = massKgPerWheel ?? (minMass + maxMass) / 2
  const t = maxMass > minMass ? (massForScale - minMass) / (maxMass - minMass) : 0.5
  const radiusM = 0.06 + Math.max(0, Math.min(1, t)) * 0.1

  return (
    <div className="relative h-[150px] w-[150px] shrink-0 border border-[#171512] bg-[#04060c]">
      <Canvas camera={{ position: [0.55, 0.45, 0.55], fov: 42, near: 0.01, far: 10 }}>
        <PauseWhenHidden tool="study" />
        <color attach="background" args={["#04060c"]} />
        {/* Round 2 ("too dark"): brighter ambient + a third
            fill light from below/behind, same treatment ThrusterDiagram
            already uses. */}
        <ambientLight intensity={1.4} color="#c3cadf" />
        <directionalLight position={[1, 1.2, 0.8]} intensity={1.8} color="#fff2dd" />
        <directionalLight position={[-1, -0.5, -0.8]} intensity={0.9} color="#a8c4ff" />
        <directionalLight position={[0, -1, 0.5]} intensity={0.5} color="#ffffff" />
        <SpinningCluster radiusM={radiusM} />
        {/* Body-frame axes, -- fixed (not
            spinning with the cluster) and sized well past the wheels'
            own spread so the whole triad stays legible at this scale. */}
        <BodyAxesTriad size={radiusM * (SPREAD_FACTOR + 2)} />
        <OrbitControls enableDamping dampingFactor={0.08} minDistance={0.2} maxDistance={2} />
      </Canvas>
    </div>
  )
}
