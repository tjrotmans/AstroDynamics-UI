import { useMemo } from "react"
import { Line } from "@react-three/drei"
import * as THREE from "three"

import type { Vec3 } from "@/lib/vehicleGeometry"

// the main engine (spacecraft.propulsion) has
// no placement fields at all -- cruise.rs hardcodes it fixed at body +X
// (thrust direction), mounted through a zero offset from... nothing in
// particular, since there's no real mount-position field to be offset
// from. Not draggable/selectable (there's nothing real to persist a drag
// to yet -- see the the design notes TODO for the real placement ask), but a
// fixed nozzle is still a real, honest improvement over showing nothing at
// all for the one actuator that fires every translational maneuver in the
// app. Mounted at the bus's -X face (the real rocket-engine convention:
// the engine sits at the aft end and its exhaust points aft, producing
// thrust in the opposite, +X, direction -- matching cruise.rs's own
// body_dir = +X = the FORCE on the spacecraft, same convention already
// used for RCS thrusters/PlacedThruster in VehicleViewport.tsx).
//
// Shared by VehicleViewport.tsx (Phase 02 builder, always-fixed geometry)
// and CruiseReplay/VehicleMesh.tsx (Phase 03 mission-replay vehicle, added
// per direct request -- "you can add the main engine to phase
// 03 overview, but not the other actuators" -- so this is the ONE actuator
// intentionally shared between those two renderers, everything else stays
// builder-only per that same scope decision).
export function MainEngineMesh({ busDimsM }: { busDimsM: Vec3 }) {
  const [bx] = busDimsM
  const nozzleLenM = Math.max(0.08, Math.min(...busDimsM) * 0.12)
  const nozzleThroatRadiusM = nozzleLenM * 0.35
  const nozzleBellRadiusM = nozzleLenM * 0.75
  const plumeLenM = Math.max(0.25, Math.min(...busDimsM) * 0.55)
  const plumeRadiusM = plumeLenM * Math.tan((14 * Math.PI) / 180)
  const forceArrowLenM = nozzleLenM * 3
  // Exhaust points -X (aft, outward off the bus); thrust force (the line
  // below) is +X, exactly opposite -- same Newton's-third-law convention
  // PlacedThruster already uses.
  const exhaustQuat = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)),
    [],
  )
  return (
    <group position={[-bx / 2, 0, 0]}>
      <group quaternion={exhaustQuat}>
        <mesh position={[0, nozzleLenM / 2, 0]}>
          <cylinderGeometry args={[nozzleBellRadiusM, nozzleThroatRadiusM, nozzleLenM, 20]} />
          <meshStandardMaterial color="#7d8493" metalness={0.7} roughness={0.35} />
        </mesh>
        <group position={[0, nozzleLenM + plumeLenM / 2, 0]}>
          <mesh rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[plumeRadiusM, plumeLenM, 24, 1, true]} />
            <meshBasicMaterial color="#ff8c3a" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        </group>
      </group>
      <Line points={[[0, 0, 0], [forceArrowLenM, 0, 0]]} color="#4a90c2" lineWidth={1.5} />
    </group>
  )
}
