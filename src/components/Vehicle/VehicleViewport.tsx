import { useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber"
import { PauseWhenHidden } from "@/components/scene/PauseWhenHidden"
import { GizmoHelper, GizmoViewport, Html, Line, OrbitControls } from "@react-three/drei"
import * as THREE from "three"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"

import { useMissionStore } from "@/stores/missionStore"
import { MainEngineMesh } from "./MainEngineMesh"
import { useVehicleUiStore, type PanelPlacement, type ThrusterPlacement } from "@/stores/vehicleUiStore"
import { useVehicleBoresightUiStore, type BoresightPlacement } from "@/stores/vehicleBoresightUiStore"
import {
  CANT_RANGE_DEG,
  CLOCK_RANGE_DEG,
  THRUSTER_OVERHANG_MARGIN_M,
  FACES,
  FACE_NAMES,
  PITCH_RANGE_DEG,
  ROLL_RANGE_DEG,
  YAW_RANGE_DEG,
  TILT_RANGE_DEG,
  SPIN_RANGE_DEG,
  centerOffsetForPlacement,
  clampBoresightAnglesDeg,
  clampRotationDeg,
  clampThrusterAnglesDeg,
  clampToFace,
  compileBoresightItem,
  compileSolarPanel,
  compileThruster,
  crossVec3,
  decomposeBoresightItem,
  decomposeSolarPanel,
  decomposeThruster,
  faceHalfExtents,
  faceNormal,
  faceTangents,
  overhangMarginM,
  panelOrientation,
  thrusterDirection,
  type Vec3,
} from "@/lib/vehicleGeometry"

// The GNC phase 02 "floating spacecraft" viewport -- the counterpart to
// phase 01's trajectory playback, per the design (see the design notes
// "Spacecraft Configuration Builder"). Phase 1 scope only: bus box from
// real bus_dims_m, an idle turntable spin, body-fixed axes triad, and
// face-snapped placement. Panels use the backend's own purpose-built
// SolarPanel placement fields (position_m/normal/width_m/height_m/
// articulation, shipped) -- CustomPlate remains for other
// flat-plate hardware not built yet (antenna dishes, instrument covers).
// No overlays yet (CoM/CoP, SRP arrows, FOV/plume cones) -- CoM/CoP and SRP
// arrows are now unblocked by /api/design/vehicle's real com_m/srp fields,
// just not built this pass.

type PaletteKind = "panel" | "thruster" | "startracker" | "opnavcamera" | "lidar" | "commantenna"

const PALETTE: { kind: PaletteKind; label: string; sub: string; locked?: false }[] = [
  { kind: "panel", label: "Solar panel", sub: "flat plate · SolarPanel" },
  { kind: "thruster", label: "RCS thruster", sub: "point + direction · RcsThruster" },
  { kind: "startracker", label: "Star tracker", sub: "boresight · StarTracker" },
  { kind: "opnavcamera", label: "OpNav camera", sub: "boresight · OpNavCamera" },
  { kind: "lidar", label: "Lidar", sub: "boresight · Lidar" },
  { kind: "commantenna", label: "HGA antenna", sub: "boresight · CommAntenna" },
]
// Reaction wheels (and the other count/spec-only hardware: IMU, the legacy
// aggregate RCS cluster) are deliberately NOT in this palette at all, not
// even as a locked/disabled entry -- they have no position field in the
// backend schema and never will (a wheel's/IMU's physics doesn't depend on
// where in the body it sits), so there's nothing here for the user to ever
// place. They're still real hardware, configured via the sidebar's
// HardwareChecklist (count/model/spec) same as before this builder existed
// -- just not a palette entry that implies "click to place" when nothing
// would happen.

const DEFAULT_PANEL_WIDTH_M = 1.0
const DEFAULT_PANEL_HEIGHT_M = 1.5
const DEFAULT_THRUSTER_THRUST_N = 4.0

interface PlacedPlate {
  hardwareIndex: number
  faceIndex: number
  u: number
  v: number
  widthM: number
  heightM: number
  rotXDeg: number
  rotYDeg: number
  rotZDeg: number
}

interface PlacedThrusterData {
  hardwareIndex: number
  faceIndex: number
  u: number
  v: number
  cantDeg: number
  clockDeg: number
}

// One shared marker+cone renderer for all 4 boresight-family kinds (star
// tracker/OpNav camera/lidar/comm antenna) -- a small box at the mount
// point plus a translucent cone along the boresight direction (radius from
// coneHalfAngleDeg, none rendered if that's null, matching the backend's
// "null fov_deg = no cone" convention).
type BoresightKind = "startracker" | "opnavcamera" | "lidar" | "commantenna"
type BoresightHardwareType = "StarTracker" | "OpNavCamera" | "Lidar" | "CommAntenna"

const BORESIGHT_KIND_META: Record<
  BoresightKind,
  { hardwareType: BoresightHardwareType; label: string; color: string; defaultConeDeg: number }
> = {
  startracker: { hardwareType: "StarTracker", label: "Star tracker", color: "#39e6ff", defaultConeDeg: 10 },
  opnavcamera: { hardwareType: "OpNavCamera", label: "OpNav camera", color: "#6be36b", defaultConeDeg: 20 },
  lidar: { hardwareType: "Lidar", label: "Lidar", color: "#ff59d6", defaultConeDeg: 15 },
  commantenna: { hardwareType: "CommAntenna", label: "HGA antenna", color: "#ffc861", defaultConeDeg: 8 },
}

interface PlacedBoresight {
  hardwareIndex: number
  kind: BoresightKind
  faceIndex: number
  u: number
  v: number
  tiltDeg: number
  spinDeg: number
  coneHalfAngleDeg: number | null
}

function AxesTriad({ size }: { size: number }) {
  const axes: { dir: Vec3; color: string }[] = [
    { dir: [1, 0, 0], color: "#ff6b6b" },
    { dir: [0, 1, 0], color: "#5fd97a" },
    { dir: [0, 0, 1], color: "#5fa8ff" },
  ]
  return (
    <group>
      {axes.map((a, i) => (
        <Line
          key={i}
          points={[
            [0, 0, 0],
            [a.dir[0] * size, a.dir[1] * size, a.dir[2] * size],
          ]}
          color={a.color}
          lineWidth={1.5}
        />
      ))}
    </group>
  )
}

function FacePlanes({
  busDimsM,
  activeFace,
  placing,
  onHoverFace,
  onClickFace,
}: {
  busDimsM: Vec3
  activeFace: number | null
  placing: boolean
  onHoverFace: (idx: number | null) => void
  onClickFace: (idx: number) => void
}) {
  return (
    <>
      {FACES.map((face, i) => {
        const { halfU, halfV, halfN } = faceHalfExtents(face, busDimsM)
        const n = faceNormal(face)
        const { u: uAxis, v: vAxis } = faceTangents(face)
        const pos = new THREE.Vector3(n[0] * halfN, n[1] * halfN, n[2] * halfN)
        const m = new THREE.Matrix4().makeBasis(
          new THREE.Vector3(...uAxis),
          new THREE.Vector3(...vAxis),
          new THREE.Vector3(...n),
        )
        const quat = new THREE.Quaternion().setFromRotationMatrix(m)
        return (
          <mesh
            key={i}
            position={pos}
            quaternion={quat}
            onPointerOver={(e: ThreeEvent<PointerEvent>) => {
              if (!placing) return
              e.stopPropagation()
              onHoverFace(i)
            }}
            onPointerOut={() => placing && onHoverFace(null)}
            onClick={(e: ThreeEvent<PointerEvent>) => {
              if (!placing) return
              e.stopPropagation()
              onClickFace(i)
            }}
          >
            <planeGeometry args={[halfU * 2, halfV * 2]} />
            <meshBasicMaterial
              color="#ffc861"
              transparent
              opacity={!placing ? 0 : activeFace === i ? 0.3 : 0.09}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        )
      })}
    </>
  )
}

// OrbitControls' own drag handling lives OUTSIDE react-three-fiber's
// synthetic pointer-event chain (drei attaches it via native addEventListener
// straight on the canvas), so a plain e.stopPropagation() on this mesh's own
// onPointerDown/Move never reaches it -- the camera kept rotating/zooming
// underneath a panel drag even with stopPropagation() called (confirmed live,
// a real bug: screenshot comparison before/after a drag showed the camera had
// visibly zoomed in). Explicitly disabling the shared OrbitControls ref for
// the drag's duration is the only thing that actually stops it.
//
// Also real, found the same pass: the drag's ray/plane math used to build the
// face plane from LOCAL bus-frame coordinates (faceNormal/faceCenter, never
// transformed by the bus group's own rotation) while the pointer ray itself
// is in WORLD space -- correct only when the bus's local frame happens to
// coincide with world (rotation = identity). Since the idle turntable spin
// keeps advancing rotation, and (separately, also fixed here) used to keep
// spinning even while dragging an already-placed panel, the two bugs
// compounded: the math was wrong, and it kept getting MORE wrong mid-drag.
// Fixed by deriving the face plane's normal/center/u/v axes from the shared
// bus group's actual WORLD transform every drag frame, and by pausing the
// idle spin for the whole drag (draggingAnyRef, shared with BusScene).
//
// A THIRD real bug, found by reading react-three-fiber's own event source
// (not guessed) after the two fixes above still felt unreliable: R3F
// replaces `event.target`/`event.currentTarget` on the SYNTHETIC event it
// hands to a handler with its OWN per-object capture API (a closure over the
// exact intersected mesh -- see @react-three/fiber's events.esm.js,
// `setPointerCapture` around line 699), NOT the raw native DOM element.
// Calling `gl.domElement.setPointerCapture(...)` directly (what this used to
// do) gets real native browser pointer capture, but never registers the mesh
// in R3F's own `internal.capturedMap` -- so R3F's raycasting-based hit
// testing still runs on every subsequent pointermove, and the instant the
// cursor drags off the panel's own small screen-space footprint (trivially
// easy at normal zoom), R3F stops calling this handler at all. That's
// exactly "doesn't always follow the mouse, impossible to get it in the
// right place." The onPointerLeave-triggered early-exit below was a
// workaround for the same symptom and is gone now too -- with real R3F
// capture registered, a captured pointerId bypasses normal hover tracking
// entirely (confirmed in source: incoming events check
// `internal.capturedMap.has(event.pointerId)` first), so there's no
// spurious "left the mesh" cancellation to guard against anymore.
interface R3FPointerCaptureTarget {
  setPointerCapture: (pointerId: number) => void
  releasePointerCapture: (pointerId: number) => void
}

// A FOURTH real gap, found from the user's direct "much smoother in the
// mockup" comparison and confirmed with an actual measurement, not just
// reasoning: `onDrag` used to call straight into missionStore's `set()` on
// EVERY pointermove -- each one a full Zustand update, which re-renders
// VehicleViewport (subscribed to `hardware`), recomputes the `plates`
// array, and reconciles every PlacedPanel + Table 3's rows, all
// synchronously interleaved with the Three.js render loop. The mockup never
// did this -- it mutated a plain JS object and the mesh's own `.position`
// directly, with no framework re-render anywhere in its drag loop at all.
// The panel's OWN mesh position is now mutated directly via `groupRef` on
// every pointermove (zero React involvement). A first cut kept a
// THROTTLED missionStore commit during the drag (a few times a second, not
// every event) so Table 3/the corner chip would still feel live -- an A/B
// frame-timing measurement (idle vs. a mouse-move-only baseline vs. an
// actual drag, `requestAnimationFrame` deltas over ~600 frames) proved even
// THAT was enough to cause real, visible jank: avg frame time rose from
// ~16.7ms (matching idle) to ~27ms with 36% of frames over 33ms, once the
// throttled commits were happening. Disabling the mid-drag commit entirely
// (measured again) brought frame timing back to exactly the idle baseline.
// So the store now commits ONLY ONCE, on release -- Table 3/the chip stay
// at their pre-drag values while actively dragging and snap to the real
// final position the instant the mouse button is released, which is the
// correct trade-off given the measured cost of anything more frequent.
function PlacedPanel({
  plate,
  busDimsM,
  selected,
  onSelect,
  onDrag,
  busGroupRef,
  controlsRef,
  draggingAnyRef,
}: {
  plate: PlacedPlate
  busDimsM: Vec3
  selected: boolean
  onSelect: () => void
  onDrag: (u: number, v: number) => void
  busGroupRef: React.RefObject<THREE.Group | null>
  controlsRef: React.RefObject<OrbitControlsImpl | null>
  draggingAnyRef: React.RefObject<boolean>
}) {
  const face = FACES[plate.faceIndex]
  const n = faceNormal(face)
  const { u: uAxis, v: vAxis } = faceTangents(face)
  const w = plate.widthM
  const h = plate.heightM
  // The group sits at this anchor -- the component's real mounting point
  // on the bus surface, and the fixed pivot Pitch/Roll rotate about. The
  // anchor can be dragged partway past the face's own rectangle (see
  // clampToFace's overhangMarginM below) so a component can hang off an
  // edge or a corner, while never being pushed so far it floats fully
  // disconnected from the bus.
  const anchor = centerOffsetForPlacement(face, plate.u, plate.v, busDimsM)
  const thickness = 0.02
  const zOff = thickness / 2
  const { camera } = useThree()
  const draggingRef = useRef(false)
  const groupRef = useRef<THREE.Group>(null)
  const liveUvRef = useRef({ u: plate.u, v: plate.v })

  // Unified 3-axis orientation (vehicleGeometry.ts's panelOrientation) --
  // replaces the earlier two-mechanism design (a discrete hinge-axis
  // picker + deploy angle, plus a separate cosmetic spin button), per
  // direct user feedback ("the combination of the Rotate button and the U
  // and V hinging is very messy... rotate the panel around 3 axes, with a
  // user defined angle for each"). realNormal/offsetDir are always
  // orthonormal (verified numerically before shipping); widthDir completes
  // a right-handed basis matching the box's own local axes (X=width,
  // Y=height/offset direction, Z=normal).
  const { normal: realNormal, offsetDir } = panelOrientation(face, plate.rotXDeg, plate.rotYDeg, plate.rotZDeg)
  const widthDir = crossVec3(offsetDir, realNormal)
  const halfExtent = h / 2
  const meshLocalPos: [number, number, number] = [0, halfExtent, zOff]

  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...widthDir),
    new THREE.Vector3(...offsetDir),
    new THREE.Vector3(...realNormal),
  )
  const quat = new THREE.Quaternion().setFromRotationMatrix(m)

  function endDrag(e: ThreeEvent<PointerEvent>) {
    draggingRef.current = false
    draggingAnyRef.current = false
    if (controlsRef.current) controlsRef.current.enabled = true
    onDrag(liveUvRef.current.u, liveUvRef.current.v)
    ;(e.target as unknown as R3FPointerCaptureTarget).releasePointerCapture(e.pointerId)
  }

  return (
    <group ref={groupRef} position={new THREE.Vector3(...anchor)} quaternion={quat}>
      <mesh
        position={meshLocalPos}
        onPointerDown={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          onSelect()
          draggingRef.current = true
          draggingAnyRef.current = true
          liveUvRef.current = { u: plate.u, v: plate.v }
          if (controlsRef.current) controlsRef.current.enabled = false
          ;(e.target as unknown as R3FPointerCaptureTarget).setPointerCapture(e.pointerId)
        }}
        onPointerUp={(e: ThreeEvent<PointerEvent>) => endDrag(e)}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          if (!draggingRef.current) return
          e.stopPropagation()
          const busGroup = busGroupRef.current
          if (!busGroup) return
          const worldQuat = busGroup.getWorldQuaternion(new THREE.Quaternion())
          const worldNormal = new THREE.Vector3(...n).applyQuaternion(worldQuat)
          const worldU = new THREE.Vector3(...uAxis).applyQuaternion(worldQuat)
          const worldV = new THREE.Vector3(...vAxis).applyQuaternion(worldQuat)
          const localFaceCenter = new THREE.Vector3(...centerOffsetForPlacement(face, 0, 0, busDimsM))
          const worldFaceCenter = busGroup.localToWorld(localFaceCenter)
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, worldFaceCenter)
          const ray = new THREE.Raycaster()
          ray.setFromCamera(new THREE.Vector2(e.pointer.x, e.pointer.y), camera)
          const hit = new THREE.Vector3()
          if (!ray.ray.intersectPlane(plane, hit)) return
          const rel = hit.clone().sub(worldFaceCenter)
          // Clamped to THIS panel's own fixed face -- a panel can never jump
          // to another side of the bus mid-drag, by construction: `face`
          // above is read once from `plate.faceIndex` and never reassigned.
          // A real overhang margin (sized to the panel's own footprint, see
          // overhangMarginM) lets the anchor cross partway past an edge, so
          // the panel can be dragged to hang off any side of the face.
          const clamped = clampToFace(face, rel.dot(worldU), rel.dot(worldV), busDimsM, overhangMarginM(w, h))
          liveUvRef.current = clamped
          // Direct mesh mutation -- no store, no React re-render -- is what
          // makes the panel itself track the cursor smoothly every frame.
          if (groupRef.current) {
            groupRef.current.position.copy(new THREE.Vector3(...centerOffsetForPlacement(face, clamped.u, clamped.v, busDimsM)))
          }
        }}
      >
        <boxGeometry args={[w, h, thickness]} />
        <meshStandardMaterial
          color={selected ? "#3f7bd6" : "#1c2f6b"}
          emissive={selected ? "#1a2c55" : "#000000"}
          metalness={0.3}
          roughness={0.35}
        />
      </mesh>
    </group>
  )
}

// Placed RCS thruster -- a point (position_m) + a direction vector, not a
// flat plate, so this is a NEW, separate component rather than a variant of
// PlacedPanel above (no width/height/rotXYZ-about-an-edge model applies).
// Drag-anywhere-on-the-face-plane behavior is copied from PlacedPanel's own
// onPointerMove (same face-plane raycasting: derive the face's world
// normal/u/v from the shared bus group's actual world transform, since the
// idle spin keeps rotating it), but clamped with a small FIXED margin
// (THRUSTER_OVERHANG_MARGIN_M) instead of an overhang sized to a
// width/height a thruster doesn't have. Rendering (redesigned 
// the old single cone was "weird... what do the cones
// represent, to what side do they thrust?"): a small opaque metallic
// NOZZLE (the real hardware, bell-shaped) plus a separate translucent
// PLUME cone beyond it (the exhaust spread), both pointing along the real
// exhaust direction (-direction -- `direction` is the FORCE on the
// spacecraft per the backend's own field doc comment, opposite the
// exhaust by Newton's third law), plus a short thin line in a clearly
// different color (blue, not another cone) showing that force direction.
function PlacedThruster({
  thruster,
  busDimsM,
  selected,
  onSelect,
  onDrag,
  busGroupRef,
  controlsRef,
  draggingAnyRef,
}: {
  thruster: PlacedThrusterData
  busDimsM: Vec3
  selected: boolean
  onSelect: () => void
  onDrag: (u: number, v: number) => void
  busGroupRef: React.RefObject<THREE.Group | null>
  controlsRef: React.RefObject<OrbitControlsImpl | null>
  draggingAnyRef: React.RefObject<boolean>
}) {
  const face = FACES[thruster.faceIndex]
  const n = faceNormal(face)
  const { u: uAxis, v: vAxis } = faceTangents(face)
  const anchor = centerOffsetForPlacement(face, thruster.u, thruster.v, busDimsM)
  const direction = thrusterDirection(face, thruster.cantDeg, thruster.clockDeg)
  const { camera } = useThree()
  const draggingRef = useRef(false)
  const groupRef = useRef<THREE.Group>(null)
  const liveUvRef = useRef({ u: thruster.u, v: thruster.v })

  // Two clearly distinct pieces, not one ambiguous cone (direct user
  // report: "what do the cones represent, to what side do they thrust?"):
  // a small opaque metallic NOZZLE (the real hardware, bell-shaped -- narrow
  // throat at the mount, flares outward) and a separate translucent PLUME
  // cone beyond it (the exhaust spread -- this is the previously-unbuilt
  // "thruster plume cone" overlay from the the design notes design vision, built
  // here instead of separately). Both point along the real EXHAUST
  // direction, `-direction` -- `direction` itself is the FORCE on the
  // spacecraft (Newton's third law, opposite the exhaust), which the
  // separate thin line below still shows.
  const nozzleLenM = Math.max(0.035, Math.min(...busDimsM) * 0.05)
  const nozzleThroatRadiusM = nozzleLenM * 0.32
  const nozzleBellRadiusM = nozzleLenM * 0.62
  const plumeLenM = Math.max(0.12, Math.min(...busDimsM) * 0.3)
  const plumeHalfAngleRad = (18 * Math.PI) / 180
  const plumeRadiusM = plumeLenM * Math.tan(plumeHalfAngleRad)
  const forceArrowLenM = nozzleLenM * 2.5
  // A hit-target sized purely off the (small) visible nozzle was hard to
  // actually click at typical zoom -- floored to a fixed minimum so a
  // thruster stays comfortably clickable/draggable regardless of how
  // small the bus itself is, same idea as the constant-apparent-size hit
  // spheres used elsewhere in this app's Three.js views.
  const hitRadiusM = Math.max(nozzleLenM * 1.6, 0.12)

  // Real bug found and fixed here: a single mesh with BOTH a
  // `position` prop AND a `quaternion` prop does NOT get its position
  // rotated along with it -- Three.js composes position/quaternion/scale as
  // position + quaternion.rotate(scale * localVertex), so `position` is a
  // raw offset in the PARENT's (unrotated) axes, applied after the geometry
  // itself is rotated. The old single-mesh version relied on exactly this
  // (`position={[0,-coneLenM/2,0]}` alongside a `quaternion` that aimed the
  // cone at `direction`) and only actually placed the cone at the true
  // mount point for the one face whose rest normal happens to be (0,1,0);
  // every other face, or any nonzero Cant/Clock, visibly displaced it by up
  // to half the cone's own length -- confirmed numerically before this fix
  // (a throwaway script replicating Three.js's own Matrix4.compose showed
  // 0.35-0.5 m of offset on 5 of 6 faces for a 0.5 m test cone). This is
  // exactly what made placement look broken. Fixed the same way
  // PlacedBoresightMarker already does it: an OUTER group carries ONLY the
  // quaternion (rotation), an INNER group carries the along-the-axis
  // translation -- nesting means the inner translation gets correctly
  // swept along by the outer rotation when Three.js composes the two
  // matrices, instead of being added afterward unrotated.
  const exhaustQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(-direction[0], -direction[1], -direction[2]),
  )

  function endDrag(e: ThreeEvent<PointerEvent>) {
    draggingRef.current = false
    draggingAnyRef.current = false
    if (controlsRef.current) controlsRef.current.enabled = true
    onDrag(liveUvRef.current.u, liveUvRef.current.v)
    ;(e.target as unknown as R3FPointerCaptureTarget).releasePointerCapture(e.pointerId)
  }

  return (
    <group ref={groupRef} position={new THREE.Vector3(...anchor)}>
      {/* A generously-sized invisible sphere carries the pointer handlers --
          the visible cone is thin and easy to miss with a raycast at normal
          zoom, same "small target needs a bigger hit area" idea as the
          hover hit-spheres elsewhere in this app's Three.js views. */}
      <mesh
        onPointerDown={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          onSelect()
          draggingRef.current = true
          draggingAnyRef.current = true
          liveUvRef.current = { u: thruster.u, v: thruster.v }
          if (controlsRef.current) controlsRef.current.enabled = false
          ;(e.target as unknown as R3FPointerCaptureTarget).setPointerCapture(e.pointerId)
        }}
        onPointerUp={(e: ThreeEvent<PointerEvent>) => endDrag(e)}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          if (!draggingRef.current) return
          e.stopPropagation()
          const busGroup = busGroupRef.current
          if (!busGroup) return
          const worldQuat = busGroup.getWorldQuaternion(new THREE.Quaternion())
          const worldNormal = new THREE.Vector3(...n).applyQuaternion(worldQuat)
          const worldU = new THREE.Vector3(...uAxis).applyQuaternion(worldQuat)
          const worldV = new THREE.Vector3(...vAxis).applyQuaternion(worldQuat)
          const localFaceCenter = new THREE.Vector3(...centerOffsetForPlacement(face, 0, 0, busDimsM))
          const worldFaceCenter = busGroup.localToWorld(localFaceCenter)
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, worldFaceCenter)
          const ray = new THREE.Raycaster()
          ray.setFromCamera(new THREE.Vector2(e.pointer.x, e.pointer.y), camera)
          const hit = new THREE.Vector3()
          if (!ray.ray.intersectPlane(plane, hit)) return
          const rel = hit.clone().sub(worldFaceCenter)
          const clamped = clampToFace(face, rel.dot(worldU), rel.dot(worldV), busDimsM, THRUSTER_OVERHANG_MARGIN_M)
          liveUvRef.current = clamped
          if (groupRef.current) {
            groupRef.current.position.copy(new THREE.Vector3(...centerOffsetForPlacement(face, clamped.u, clamped.v, busDimsM)))
          }
        }}
      >
        <sphereGeometry args={[hitRadiusM, 12, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* Outer group: rotation only (aims local +Y at the real exhaust
          direction, -direction). Everything below is positioned as a plain
          translation ALONG that already-rotated local +Y axis, which is
          exactly what makes the translation get carried correctly by the
          rotation -- see the bug note above. */}
      <group quaternion={exhaustQuat}>
        {/* Nozzle -- the real hardware. Small, opaque, metallic, bell-
            shaped (narrow throat at the mount, flares toward the exhaust
            exit), flush against the bus. */}
        <mesh position={[0, nozzleLenM / 2, 0]}>
          <cylinderGeometry args={[nozzleBellRadiusM, nozzleThroatRadiusM, nozzleLenM, 16]} />
          <meshStandardMaterial
            color={selected ? "#d8ab5a" : "#a9863f"}
            emissive={selected ? "#3a2a08" : "#000000"}
            metalness={0.65}
            roughness={0.4}
          />
        </mesh>
        {/* Plume -- a translucent overlay showing the exhaust spread, not
            hardware. Open cone, apex at the nozzle's exit, base flaring
            further outward. */}
        <group position={[0, nozzleLenM + plumeLenM / 2, 0]}>
          <mesh rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[plumeRadiusM, plumeLenM, 20, 1, true]} />
            <meshBasicMaterial
              color={selected ? "#ffa447" : "#ff8c3a"}
              transparent
              opacity={selected ? 0.26 : 0.14}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        </group>
      </group>
      {/* Force on the SPACECRAFT (Newton's third law, opposite the exhaust
          above) -- a short, thin, clearly different-colored line so it
          doesn't read as another cone. */}
      <Line
        points={[
          [0, 0, 0],
          [direction[0] * forceArrowLenM, direction[1] * forceArrowLenM, direction[2] * forceArrowLenM],
        ]}
        color={selected ? "#8fd6ff" : "#4a90c2"}
        lineWidth={1.5}
      />
    </group>
  )
}

// Drag handling mirrors PlacedPanel/PlacedThruster's face-plane raycast
// pattern above (same busGroupRef/controlsRef/draggingAnyRef discipline for
// camera-conflict-free dragging), simplified since there's no width/height
// and the anchor margin is a small fixed value rather than footprint-sized.
const BORESIGHT_MARKER_SIZE_M = 0.05
const BORESIGHT_OVERHANG_MARGIN_M = 0.1

function PlacedBoresightMarker({
  item,
  busDimsM,
  coneHeightM,
  selected,
  onSelect,
  onDrag,
  busGroupRef,
  controlsRef,
  draggingAnyRef,
}: {
  item: PlacedBoresight
  busDimsM: Vec3
  coneHeightM: number
  selected: boolean
  onSelect: () => void
  onDrag: (u: number, v: number) => void
  busGroupRef: React.RefObject<THREE.Group | null>
  controlsRef: React.RefObject<OrbitControlsImpl | null>
  draggingAnyRef: React.RefObject<boolean>
}) {
  const face = FACES[item.faceIndex]
  const n = faceNormal(face)
  const { u: uAxis, v: vAxis } = faceTangents(face)
  const { camera } = useThree()
  const draggingRef = useRef(false)
  const groupRef = useRef<THREE.Group>(null)
  const liveUvRef = useRef({ u: item.u, v: item.v })
  const meta = BORESIGHT_KIND_META[item.kind]

  const { boresight, positionM } = compileBoresightItem(face, item.u, item.v, busDimsM, item.tiltDeg, item.spinDeg)
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...boresight))

  const coneHalfAngleRad = item.coneHalfAngleDeg != null ? (item.coneHalfAngleDeg * Math.PI) / 180 : null
  const coneRadius = coneHalfAngleRad != null ? coneHeightM * Math.tan(coneHalfAngleRad) : 0

  function endDrag(e: ThreeEvent<PointerEvent>) {
    draggingRef.current = false
    draggingAnyRef.current = false
    if (controlsRef.current) controlsRef.current.enabled = true
    onDrag(liveUvRef.current.u, liveUvRef.current.v)
    ;(e.target as unknown as R3FPointerCaptureTarget).releasePointerCapture(e.pointerId)
  }

  return (
    <group ref={groupRef} position={new THREE.Vector3(...positionM)}>
      <mesh
        onPointerDown={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          onSelect()
          draggingRef.current = true
          draggingAnyRef.current = true
          liveUvRef.current = { u: item.u, v: item.v }
          if (controlsRef.current) controlsRef.current.enabled = false
          ;(e.target as unknown as R3FPointerCaptureTarget).setPointerCapture(e.pointerId)
        }}
        onPointerUp={(e: ThreeEvent<PointerEvent>) => endDrag(e)}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          if (!draggingRef.current) return
          e.stopPropagation()
          const busGroup = busGroupRef.current
          if (!busGroup) return
          const worldQuat = busGroup.getWorldQuaternion(new THREE.Quaternion())
          const worldNormal = new THREE.Vector3(...n).applyQuaternion(worldQuat)
          const worldU = new THREE.Vector3(...uAxis).applyQuaternion(worldQuat)
          const worldV = new THREE.Vector3(...vAxis).applyQuaternion(worldQuat)
          const localFaceCenter = new THREE.Vector3(...centerOffsetForPlacement(face, 0, 0, busDimsM))
          const worldFaceCenter = busGroup.localToWorld(localFaceCenter)
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, worldFaceCenter)
          const ray = new THREE.Raycaster()
          ray.setFromCamera(new THREE.Vector2(e.pointer.x, e.pointer.y), camera)
          const hit = new THREE.Vector3()
          if (!ray.ray.intersectPlane(plane, hit)) return
          const rel = hit.clone().sub(worldFaceCenter)
          const clamped = clampToFace(face, rel.dot(worldU), rel.dot(worldV), busDimsM, BORESIGHT_OVERHANG_MARGIN_M)
          liveUvRef.current = clamped
          if (groupRef.current) {
            const { positionM: livePos } = compileBoresightItem(
              face,
              clamped.u,
              clamped.v,
              busDimsM,
              item.tiltDeg,
              item.spinDeg,
            )
            groupRef.current.position.copy(new THREE.Vector3(...livePos))
          }
        }}
      >
        <boxGeometry args={[BORESIGHT_MARKER_SIZE_M, BORESIGHT_MARKER_SIZE_M, BORESIGHT_MARKER_SIZE_M]} />
        <meshStandardMaterial
          color={meta.color}
          emissive={selected ? meta.color : "#000000"}
          emissiveIntensity={selected ? 0.6 : 0}
          metalness={0.2}
          roughness={0.5}
        />
      </mesh>
      {coneHalfAngleRad != null && (
        // Nested groups, not one mesh with both `quaternion` and `rotation`
        // props (unreliable in R3F -- both write the same underlying
        // orientation, order not guaranteed). Innermost mesh flips the
        // default THREE.ConeGeometry (apex at +h/2, base at -h/2) so its
        // apex lands at local y=0 and base at y=+h; the middle group's own
        // position offset does that flip's translation; the outer group's
        // quaternion then aims the whole apex-at-origin cone along the real
        // boresight direction.
        <group quaternion={quat}>
          <group position={[0, coneHeightM / 2, 0]}>
            <mesh rotation={[Math.PI, 0, 0]}>
              <coneGeometry args={[coneRadius, coneHeightM, 20, 1, true]} />
              <meshBasicMaterial
                color={meta.color}
                transparent
                opacity={selected ? 0.28 : 0.14}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
          </group>
        </group>
      )}
    </group>
  )
}

// The idle turntable spin used to only pause while dragging an already-
// placed panel (draggingAnyRef, set inside PlacedPanel's own handlers) --
//: clicking and holding ANYWHERE (e.g. to orbit the
// camera) should also stop the spin, not just a panel drag. A native
// pointerdown/pointerup listener on the canvas's own DOM element is used
// instead of another R3F onPointerDown prop, so it fires regardless of
// what's under the cursor (empty space, a face plane, a panel, the bus
// itself) -- R3F's synthetic events only fire on objects with a handler
// attached. pointerup is listened on `window`, not just the canvas, so
// releasing the mouse after dragging off-canvas still resets the flag.
function IdleSpinPauseOnAnyPointer({ draggingAnyRef }: { draggingAnyRef: React.RefObject<boolean> }) {
  const { gl } = useThree()
  useEffect(() => {
    const dom = gl.domElement
    const onDown = () => {
      draggingAnyRef.current = true
    }
    const onUp = () => {
      draggingAnyRef.current = false
    }
    dom.addEventListener("pointerdown", onDown)
    window.addEventListener("pointerup", onUp)
    return () => {
      dom.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointerup", onUp)
    }
  }, [gl, draggingAnyRef])
  return null
}

// The two fixed directional lights left whatever side of the bus was
// facing away from them dim/dark once the user rotated the camera around
// -- ("make the lighting better so the user always
// sees the s/c brightly"). A light that follows the camera (always
// shining from the viewer's own position toward the bus) guarantees
// whatever's actually on screen is lit, regardless of how far the user
// has orbited -- the standard "headlight" rig for a free-orbit viewer.
// Implemented by copying the live camera position into a light + its
// target every frame (R3F has no built-in "attach to camera" shorthand
// for a light with a separate target object).
function CameraHeadlight() {
  const { camera } = useThree()
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const targetRef = useRef<THREE.Object3D>(null)
  useFrame(() => {
    if (!lightRef.current || !targetRef.current) return
    lightRef.current.position.copy(camera.position)
    targetRef.current.position.set(0, 0, 0)
    lightRef.current.target = targetRef.current
  })
  return (
    <>
      <directionalLight ref={lightRef} intensity={1.6} color="#ffffff" />
      <object3D ref={targetRef} />
    </>
  )
}

// The real centre-of-mass marker -- a small sphere at the actual computed
// com_m (from /api/design/vehicle, shared via StudyView's
// useVehicleProperties), plus a short crosshair so it's readable even
// exactly on the bus's own geometric centre where a bare sphere alone
// would be easy to miss against the box's own material. CoP (needs a real
// sun direction, not wired up yet -- see the design notes
// Configuration Builder TODOs) and the CoM-CoP offset line are the next
// piece, not built this pass.
function CoMMarker({ comM }: { comM: Vec3 }) {
  const [hovered, setHovered] = useState(false)
  const r = 0.035
  return (
    <group position={new THREE.Vector3(...comM)}>
      <mesh
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          setHovered(true)
        }}
        onPointerOut={() => setHovered(false)}
      >
        <sphereGeometry args={[hovered ? r * 1.6 : r, 16, 16]} />
        <meshBasicMaterial color="#ffd54a" toneMapped={false} />
      </mesh>
      {([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as Vec3[]).map((axis, i) => (
        <Line
          key={i}
          points={[
            [-axis[0] * r * 3, -axis[1] * r * 3, -axis[2] * r * 3],
            [axis[0] * r * 3, axis[1] * r * 3, axis[2] * r * 3],
          ]}
          color="#ffd54a"
          lineWidth={1}
          transparent
          opacity={0.6}
        />
      ))}
      {hovered && (
        <Html center distanceFactor={8} style={{ pointerEvents: "none" }}>
          <div className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-white">
            Centre of mass · [{comM.map((c) => c.toFixed(3)).join(", ")}] m
          </div>
        </Html>
      )}
    </group>
  )
}

function BusScene({
  busDimsM,
  plates,
  thrusters,
  boresightItems,
  placing,
  selectedIndex,
  onSelect,
  onPlaceFace,
  onDragPlate,
  onDragThruster,
  onDragBoresight,
  spin,
  busGroupRef,
  controlsRef,
  draggingAnyRef,
  comM,
}: {
  busDimsM: Vec3
  plates: PlacedPlate[]
  thrusters: PlacedThrusterData[]
  boresightItems: PlacedBoresight[]
  placing: boolean
  selectedIndex: number | null
  onSelect: (hardwareIndex: number | null) => void
  onPlaceFace: (faceIndex: number) => void
  onDragPlate: (hardwareIndex: number, u: number, v: number) => void
  onDragThruster: (hardwareIndex: number, u: number, v: number) => void
  onDragBoresight: (hardwareIndex: number, u: number, v: number) => void
  spin: boolean
  busGroupRef: React.RefObject<THREE.Group | null>
  controlsRef: React.RefObject<OrbitControlsImpl | null>
  draggingAnyRef: React.RefObject<boolean>
  comM: Vec3 | null
}) {
  const [hoverFace, setHoverFace] = useState<number | null>(null)

  // Idle turntable spin pauses while placing a NEW component (existing
  // behavior) and, just as importantly, while dragging an ALREADY-placed
  // one (draggingAnyRef) -- the bus rotating out from under an in-progress
  // drag was a second real contributor to the "buggy" feel, on top of the
  // OrbitControls conflict and the local/world math bug fixed above. Rate
  // slowed 0.18 -> 0.05 rad/s (direct user feedback: too fast to read the
  // vehicle while it idles).
  useFrame((_, dt) => {
    if (spin && !draggingAnyRef.current && busGroupRef.current) busGroupRef.current.rotation.z += dt * 0.05
  })

  const busSize = Math.max(...busDimsM)
  const busGeom = useMemo(() => new THREE.BoxGeometry(busDimsM[0], busDimsM[1], busDimsM[2]), [busDimsM])

  return (
    <group
      ref={busGroupRef}
      onPointerMissed={() => onSelect(null)}
    >
      <mesh geometry={busGeom}>
        <meshStandardMaterial color="#9aa3b5" metalness={0.35} roughness={0.55} />
        <lineSegments>
          <edgesGeometry args={[busGeom]} />
          <lineBasicMaterial color="#2a3346" />
        </lineSegments>
      </mesh>

      <AxesTriad size={busSize * 0.9} />

      <MainEngineMesh busDimsM={busDimsM} />

      <FacePlanes
        busDimsM={busDimsM}
        activeFace={hoverFace}
        placing={placing}
        onHoverFace={setHoverFace}
        onClickFace={onPlaceFace}
      />

      {plates.map((p) => (
        <PlacedPanel
          key={p.hardwareIndex}
          plate={p}
          busDimsM={busDimsM}
          selected={selectedIndex === p.hardwareIndex}
          onSelect={() => onSelect(p.hardwareIndex)}
          onDrag={(u, v) => onDragPlate(p.hardwareIndex, u, v)}
          busGroupRef={busGroupRef}
          controlsRef={controlsRef}
          draggingAnyRef={draggingAnyRef}
        />
      ))}

      {thrusters.map((t) => (
        <PlacedThruster
          key={t.hardwareIndex}
          thruster={t}
          busDimsM={busDimsM}
          selected={selectedIndex === t.hardwareIndex}
          onSelect={() => onSelect(t.hardwareIndex)}
          onDrag={(u, v) => onDragThruster(t.hardwareIndex, u, v)}
          busGroupRef={busGroupRef}
          controlsRef={controlsRef}
          draggingAnyRef={draggingAnyRef}
        />
      ))}

      {boresightItems.map((item) => (
        <PlacedBoresightMarker
          key={item.hardwareIndex}
          item={item}
          busDimsM={busDimsM}
          coneHeightM={busSize * 0.6}
          selected={selectedIndex === item.hardwareIndex}
          onSelect={() => onSelect(item.hardwareIndex)}
          onDrag={(u, v) => onDragBoresight(item.hardwareIndex, u, v)}
          busGroupRef={busGroupRef}
          controlsRef={controlsRef}
          draggingAnyRef={draggingAnyRef}
        />
      ))}

      {comM && <CoMMarker comM={comM} />}
    </group>
  )
}

const DEFAULT_PLACEMENT = (faceIndex: number, u = 0, v = 0): PanelPlacement => ({
  faceIndex,
  u,
  v,
  rotXDeg: 0,
  rotYDeg: 0,
  rotZDeg: 0,
})

const DEFAULT_THRUSTER_PLACEMENT = (faceIndex: number, u = 0, v = 0): ThrusterPlacement => ({
  faceIndex,
  u,
  v,
  cantDeg: 0,
  clockDeg: 0,
})

export function VehicleViewport({
  selectedIndex,
  onSelect,
  comM,
}: {
  selectedIndex: number | null
  onSelect: (hardwareIndex: number | null) => void
  // Real centre-of-mass vector from /api/design/vehicle (StudyView's
  // useVehicleProperties, shared with VehiclePaper's Table 2) -- null
  // while the first debounced fetch hasn't resolved yet, or on error.
  comM: number[] | null
}) {
  const busDimsRaw = useMissionStore((s) => s.config.spacecraft.bus_dims_m)
  const hardware = useMissionStore((s) => s.config.spacecraft.hardware)
  const addPlacedPlate = useMissionStore((s) => s.addPlacedPlate)
  const updateHardwareAt = useMissionStore((s) => s.updateHardwareAt)
  const removeHardwareAt = useMissionStore((s) => s.removeHardwareAt)
  const reindexAfterRemoval = useVehicleUiStore((s) => s.reindexAfterRemoval)
  const placements = useVehicleUiStore((s) => s.placements)
  const setPlacement = useVehicleUiStore((s) => s.setPlacement)
  const thrusterPlacements = useVehicleUiStore((s) => s.thrusterPlacements)
  const setThrusterPlacement = useVehicleUiStore((s) => s.setThrusterPlacement)
  const reindexBoresightAfterRemoval = useVehicleBoresightUiStore((s) => s.reindexAfterRemoval)
  const boresightPlacements = useVehicleBoresightUiStore((s) => s.placements)
  const setBoresightPlacement = useVehicleBoresightUiStore((s) => s.setPlacement)

  const busDimsM = (busDimsRaw.length === 3 ? busDimsRaw : [1, 1, 1]) as Vec3
  const [placing, setPlacing] = useState<PaletteKind | null>(null)
  const busGroupRef = useRef<THREE.Group>(null)
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const draggingAnyRef = useRef(false)

  // A SolarPanel only counts as "placed" once it has real position_m/
  // normal/width_m/height_m -- a bare checked-on-in-the-sidebar panel
  // (HardwareChecklist's aggregate area_m2-only entry) has none of these
  // and is deliberately left out of the viewport/Table 3 entirely.
  function isPlacedSolarPanel(item: (typeof hardware)[number]): item is (typeof hardware)[number] & {
    type: "SolarPanel"
    position_m: number[]
    normal: number[]
    width_m: number
    height_m: number
  } {
    return (
      item.type === "SolarPanel" &&
      item.position_m != null &&
      item.normal != null &&
      item.width_m != null &&
      item.height_m != null
    )
  }

  // `placements` (vehicleUiStore) is the AUTHORITATIVE mount identity --
  // see that store's own header comment for why: once a panel is rotated,
  // its real (compiled) normal/position_m can no longer be reliably
  // reverse-engineered back into "which face, what u/v, what rotation" the
  // way an unrotated panel's could. `decomposeSolarPanel` is only a
  // FALLBACK, for a hardware index with no placement record yet (e.g. a
  // SolarPanel loaded from a preset TOML authored outside this UI) --
  // computed inline here (pure, no store write) so render always has a
  // valid value; the effect below persists that bootstrap afterward so
  // future drags/rotation edits have a real record to build on.
  const plates: PlacedPlate[] = useMemo(() => {
    const out: PlacedPlate[] = []
    hardware.forEach((item, index) => {
      if (!isPlacedSolarPanel(item)) return
      const heightM = item.height_m
      const placement =
        placements[index] ??
        (() => {
          const { faceIndex, u, v } = decomposeSolarPanel(item.normal as Vec3, item.position_m as Vec3, heightM)
          return DEFAULT_PLACEMENT(faceIndex, u, v)
        })()
      out.push({ hardwareIndex: index, widthM: item.width_m, heightM, ...placement })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware, placements])

  useEffect(() => {
    hardware.forEach((item, index) => {
      if (!isPlacedSolarPanel(item) || placements[index]) return
      const { faceIndex, u, v } = decomposeSolarPanel(item.normal as Vec3, item.position_m as Vec3, item.height_m)
      setPlacement(index, DEFAULT_PLACEMENT(faceIndex, u, v))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware])

  // Same "placed only once real fields are set" rule as isPlacedSolarPanel
  // above -- an RcsThruster is only real once it has real position_m/
  // direction (both required fields on the backend schema, but a bare
  // checked-in-sidebar entry from before this builder existed could still
  // have neither).
  function isPlacedThruster(item: (typeof hardware)[number]): item is (typeof hardware)[number] & {
    type: "RcsThruster"
    position_m: number[]
    direction: number[]
  } {
    return item.type === "RcsThruster" && item.position_m != null && item.direction != null
  }

  const thrusters: PlacedThrusterData[] = useMemo(() => {
    const out: PlacedThrusterData[] = []
    hardware.forEach((item, index) => {
      if (!isPlacedThruster(item)) return
      const placement =
        thrusterPlacements[index] ??
        (() => {
          const { faceIndex, u, v, cantDeg, clockDeg } = decomposeThruster(item.position_m as Vec3, item.direction as Vec3)
          return { faceIndex, u, v, cantDeg, clockDeg }
        })()
      out.push({ hardwareIndex: index, ...placement })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware, thrusterPlacements])

  useEffect(() => {
    hardware.forEach((item, index) => {
      if (!isPlacedThruster(item) || thrusterPlacements[index]) return
      const { faceIndex, u, v, cantDeg, clockDeg } = decomposeThruster(item.position_m as Vec3, item.direction as Vec3)
      setThrusterPlacement(index, { faceIndex, u, v, cantDeg, clockDeg })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware])

  // Boresight-cone family (star tracker/OpNav camera/lidar/comm antenna) --
  // "placed" mirrors isPlacedSolarPanel's rule above: needs both a real
  // position_m AND boresight, or it's left out of the viewport/Table 3
  // (e.g. a bare HardwareChecklist-toggled entry with neither field set).
  function isPlacedBoresight(item: (typeof hardware)[number]): item is (typeof hardware)[number] & {
    type: BoresightHardwareType
    position_m: number[]
    boresight: number[]
  } {
    return (
      (item.type === "StarTracker" ||
        item.type === "OpNavCamera" ||
        item.type === "Lidar" ||
        item.type === "CommAntenna") &&
      item.position_m != null &&
      item.boresight != null
    )
  }

  function coneAngleOf(item: (typeof hardware)[number]): number | null {
    if (item.type === "CommAntenna") return item.beamwidth_deg ?? null
    if (item.type === "StarTracker" || item.type === "OpNavCamera" || item.type === "Lidar") return item.fov_deg ?? null
    return null
  }

  const DEFAULT_BORESIGHT_PLACEMENT = (faceIndex: number, u = 0, v = 0): BoresightPlacement => ({
    faceIndex,
    u,
    v,
    tiltDeg: 0,
    spinDeg: 0,
  })

  const boresightItems: PlacedBoresight[] = useMemo(() => {
    const out: PlacedBoresight[] = []
    hardware.forEach((item, index) => {
      if (!isPlacedBoresight(item)) return
      const kind = (Object.keys(BORESIGHT_KIND_META) as BoresightKind[]).find(
        (k) => BORESIGHT_KIND_META[k].hardwareType === item.type,
      )
      if (!kind) return
      const placement =
        boresightPlacements[index] ??
        (() => {
          const { faceIndex, u, v } = decomposeBoresightItem(item.position_m as Vec3, busDimsM)
          return DEFAULT_BORESIGHT_PLACEMENT(faceIndex, u, v)
        })()
      out.push({ hardwareIndex: index, kind, coneHalfAngleDeg: coneAngleOf(item), ...placement })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware, boresightPlacements, busDimsM])

  useEffect(() => {
    hardware.forEach((item, index) => {
      if (!isPlacedBoresight(item) || boresightPlacements[index]) return
      const { faceIndex, u, v } = decomposeBoresightItem(item.position_m as Vec3, busDimsM)
      setBoresightPlacement(index, DEFAULT_BORESIGHT_PLACEMENT(faceIndex, u, v))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardware])

  const busDist = Math.max(...busDimsM) * 3.2

  // Real commit helper, shared by every control below and by Table 3's own
  // fields (VehiclePaper.tsx does the identical thing) -- one place
  // re-clamps the anchor and computes/sends the real normal/position_m/
  // articulation.
  function commitPlacement(hardwareIndex: number, next: PanelPlacement, widthM: number, heightM: number) {
    const face = FACES[next.faceIndex]
    const { u, v } = clampToFace(face, next.u, next.v, busDimsM, overhangMarginM(widthM, heightM))
    const clamped = { ...next, u, v, ...clampRotationDeg(next.rotXDeg, next.rotYDeg, next.rotZDeg) }
    const { normal, positionM, articulation } = compileSolarPanel(
      face,
      u,
      v,
      busDimsM,
      heightM,
      clamped.rotXDeg,
      clamped.rotYDeg,
      clamped.rotZDeg,
    )
    updateHardwareAt(hardwareIndex, {
      normal,
      position_m: positionM,
      width_m: widthM,
      height_m: heightM,
      area_m2: widthM * heightM,
      articulation,
    })
    setPlacement(hardwareIndex, clamped)
  }

  // Real commit helper for a thruster -- mirrors commitPlacement above,
  // sharing the same shape (re-clamp, compile, write both the real backend
  // fields and the authoritative placement record) but calling
  // compileThruster/clampThrusterAnglesDeg instead, since a thruster has no
  // width/height and only two rotation angles, not three. Shared by this
  // viewport's own controls AND VehiclePaper's Table 3 thruster rows.
  function commitThrusterPlacement(hardwareIndex: number, next: ThrusterPlacement) {
    const face = FACES[next.faceIndex]
    const { u, v } = clampToFace(face, next.u, next.v, busDimsM, THRUSTER_OVERHANG_MARGIN_M)
    const { cantDeg, clockDeg } = clampThrusterAnglesDeg(next.cantDeg, next.clockDeg)
    const clamped = { ...next, u, v, cantDeg, clockDeg }
    const { positionM, direction } = compileThruster(face, u, v, busDimsM, cantDeg, clockDeg)
    updateHardwareAt(hardwareIndex, { position_m: positionM, direction })
    setThrusterPlacement(hardwareIndex, clamped)
  }

  // Boresight-family commit/place/drag -- parallel to commitPlacement/
  // handlePlaceFace/handleDragPlate above, kept as separate functions
  // (not merged into the panel ones) since the compiled fields differ
  // (boresight vector instead of normal+articulation, plus a per-type
  // cone-angle field name).
  function commitBoresightPlacement(hardwareIndex: number, next: BoresightPlacement, coneHalfAngleDeg: number | null) {
    const face = FACES[next.faceIndex]
    const { u, v } = clampToFace(face, next.u, next.v, busDimsM, BORESIGHT_OVERHANG_MARGIN_M)
    const clamped = { ...next, u, v, ...clampBoresightAnglesDeg(next.tiltDeg, next.spinDeg) }
    const { boresight, positionM } = compileBoresightItem(face, u, v, busDimsM, clamped.tiltDeg, clamped.spinDeg)
    const item = hardware[hardwareIndex]
    // Branched on a literal-checked `item.type`, not a computed property
    // name, so TS can narrow the patch object against the right HardwareItem
    // variant (CommAntenna's beamwidth_deg is required/non-null; the other
    // three's fov_deg is nullable).
    if (item?.type === "CommAntenna") {
      updateHardwareAt(hardwareIndex, { boresight, position_m: positionM, beamwidth_deg: coneHalfAngleDeg ?? BORESIGHT_KIND_META.commantenna.defaultConeDeg })
    } else {
      updateHardwareAt(hardwareIndex, { boresight, position_m: positionM, fov_deg: coneHalfAngleDeg })
    }
    setBoresightPlacement(hardwareIndex, clamped)
  }

  function handlePlaceBoresightFace(faceIndex: number, kind: BoresightKind) {
    const face = FACES[faceIndex]
    const newIndex = hardware.length
    const meta = BORESIGHT_KIND_META[kind]
    const { boresight, positionM } = compileBoresightItem(face, 0, 0, busDimsM, 0, 0)
    if (kind === "startracker") {
      addPlacedPlate({ type: "StarTracker", position_m: positionM, boresight, fov_deg: meta.defaultConeDeg })
    } else if (kind === "opnavcamera") {
      addPlacedPlate({ type: "OpNavCamera", position_m: positionM, boresight, fov_deg: meta.defaultConeDeg })
    } else if (kind === "lidar") {
      addPlacedPlate({ type: "Lidar", position_m: positionM, boresight, fov_deg: meta.defaultConeDeg })
    } else {
      addPlacedPlate({ type: "CommAntenna", position_m: positionM, boresight, beamwidth_deg: meta.defaultConeDeg })
    }
    setBoresightPlacement(newIndex, DEFAULT_BORESIGHT_PLACEMENT(faceIndex))
    setPlacing(null)
  }

  function handleDragBoresight(hardwareIndex: number, u: number, v: number) {
    const item = boresightItems.find((b) => b.hardwareIndex === hardwareIndex)
    if (!item) return
    commitBoresightPlacement(hardwareIndex, { faceIndex: item.faceIndex, u, v, tiltDeg: item.tiltDeg, spinDeg: item.spinDeg }, item.coneHalfAngleDeg)
  }

  function handleSetBoresightAngle(hardwareIndex: number, axis: "tiltDeg" | "spinDeg", deg: number) {
    const item = boresightItems.find((b) => b.hardwareIndex === hardwareIndex)
    if (!item) return
    commitBoresightPlacement(
      hardwareIndex,
      { faceIndex: item.faceIndex, u: item.u, v: item.v, tiltDeg: item.tiltDeg, spinDeg: item.spinDeg, [axis]: deg },
      item.coneHalfAngleDeg,
    )
  }

  function handleSetConeAngle(hardwareIndex: number, deg: number) {
    const item = boresightItems.find((b) => b.hardwareIndex === hardwareIndex)
    if (!item) return
    commitBoresightPlacement(
      hardwareIndex,
      { faceIndex: item.faceIndex, u: item.u, v: item.v, tiltDeg: item.tiltDeg, spinDeg: item.spinDeg },
      deg,
    )
  }

  function handlePlaceFace(faceIndex: number) {
    if (placing === "panel") {
      const face = FACES[faceIndex]
      const newIndex = hardware.length
      const { normal, positionM, articulation } = compileSolarPanel(
        face,
        0,
        0,
        busDimsM,
        DEFAULT_PANEL_HEIGHT_M,
        0,
        0,
        0,
      )
      addPlacedPlate({
        type: "SolarPanel",
        area_m2: DEFAULT_PANEL_WIDTH_M * DEFAULT_PANEL_HEIGHT_M,
        position_m: positionM,
        normal,
        width_m: DEFAULT_PANEL_WIDTH_M,
        height_m: DEFAULT_PANEL_HEIGHT_M,
        articulation,
      })
      setPlacement(newIndex, DEFAULT_PLACEMENT(faceIndex))
      setPlacing(null)
    } else if (placing === "thruster") {
      const face = FACES[faceIndex]
      const newIndex = hardware.length
      // Direction defaults to the face's own outward normal (Cant=Clock=0)
      // -- a thruster mounted on a face naturally fires outward by default,
      // same "flush rest orientation, rotate to change it" convention
      // SolarPanel's rest orientation already uses.
      const { positionM, direction } = compileThruster(face, 0, 0, busDimsM, 0, 0)
      addPlacedPlate({
        type: "RcsThruster",
        thrust_n: DEFAULT_THRUSTER_THRUST_N,
        position_m: positionM,
        direction,
      })
      setThrusterPlacement(newIndex, DEFAULT_THRUSTER_PLACEMENT(faceIndex))
      setPlacing(null)
    } else if (placing === "startracker" || placing === "opnavcamera" || placing === "lidar" || placing === "commantenna") {
      handlePlaceBoresightFace(faceIndex, placing)
    }
  }

  function handleDragPlate(hardwareIndex: number, u: number, v: number) {
    const plate = plates.find((p) => p.hardwareIndex === hardwareIndex)
    if (!plate) return
    commitPlacement(
      hardwareIndex,
      { faceIndex: plate.faceIndex, u, v, rotXDeg: plate.rotXDeg, rotYDeg: plate.rotYDeg, rotZDeg: plate.rotZDeg },
      plate.widthM,
      plate.heightM,
    )
  }

  function handleDragThruster(hardwareIndex: number, u: number, v: number) {
    const thruster = thrusters.find((t) => t.hardwareIndex === hardwareIndex)
    if (!thruster) return
    commitThrusterPlacement(hardwareIndex, {
      faceIndex: thruster.faceIndex,
      u,
      v,
      cantDeg: thruster.cantDeg,
      clockDeg: thruster.clockDeg,
    })
  }

  function handleSetThrusterAngle(hardwareIndex: number, axis: "cantDeg" | "clockDeg", deg: number) {
    const thruster = thrusters.find((t) => t.hardwareIndex === hardwareIndex)
    if (!thruster) return
    commitThrusterPlacement(hardwareIndex, {
      faceIndex: thruster.faceIndex,
      u: thruster.u,
      v: thruster.v,
      cantDeg: thruster.cantDeg,
      clockDeg: thruster.clockDeg,
      [axis]: deg,
    })
  }

  function handleRemoveSelected() {
    if (selectedIndex == null) return
    removeHardwareAt(selectedIndex)
    // Removal shifts every subsequent hardware index -- every placement
    // store is keyed off that shared index regardless of which store
    // "owns" the removed item, so all must reindex on every removal.
    reindexAfterRemoval(selectedIndex)
    reindexBoresightAfterRemoval(selectedIndex)
    onSelect(null)
  }

  // Copy/paste for EVERY placed component kind (Ctrl/Cmd+C, Ctrl/Cmd+V, and
  // a "Duplicate" button as a discoverable one-click fallback -- direct
  // "make an object copy pastable"). The clipboard holds a
  // plain data snapshot (not a live reference to the source item), so it
  // survives the source being moved, rotated, or even deleted before
  // pasting -- real copy/paste semantics, not just "duplicate in place".
  // A discriminated union, not three separate clipboards, so Ctrl+C/V and
  // Duplicate work identically regardless of which kind is selected.
  type ClipboardEntry =
    | { kind: "panel"; widthM: number; heightM: number; placement: PanelPlacement }
    | { kind: "thruster"; thrustN: number; placement: ThrusterPlacement }
    | { kind: "boresight"; boresightKind: BoresightKind; coneHalfAngleDeg: number | null; placement: BoresightPlacement }
  const clipboardRef = useRef<ClipboardEntry | null>(null)

  function pasteFromClipboard() {
    const clip = clipboardRef.current
    if (!clip) return
    const face = FACES[clip.placement.faceIndex]
    if (clip.kind === "panel") {
      // Offset from the copied position so a paste is visibly a new object,
      // not sitting exactly on top of the original -- clamped the same way
      // a drag would be, so it can't paste itself disconnected from the bus.
      const { u, v } = clampToFace(
        face,
        clip.placement.u + 0.15,
        clip.placement.v + 0.15,
        busDimsM,
        overhangMarginM(clip.widthM, clip.heightM),
      )
      const newIndex = hardware.length
      const { normal, positionM, articulation } = compileSolarPanel(
        face,
        u,
        v,
        busDimsM,
        clip.heightM,
        clip.placement.rotXDeg,
        clip.placement.rotYDeg,
        clip.placement.rotZDeg,
      )
      addPlacedPlate({
        type: "SolarPanel",
        area_m2: clip.widthM * clip.heightM,
        position_m: positionM,
        normal,
        width_m: clip.widthM,
        height_m: clip.heightM,
        articulation,
      })
      setPlacement(newIndex, { ...clip.placement, u, v })
      onSelect(newIndex)
    } else if (clip.kind === "thruster") {
      const { u, v } = clampToFace(face, clip.placement.u + 0.15, clip.placement.v + 0.15, busDimsM, THRUSTER_OVERHANG_MARGIN_M)
      const newIndex = hardware.length
      const { positionM, direction } = compileThruster(face, u, v, busDimsM, clip.placement.cantDeg, clip.placement.clockDeg)
      addPlacedPlate({ type: "RcsThruster", thrust_n: clip.thrustN, position_m: positionM, direction })
      setThrusterPlacement(newIndex, { ...clip.placement, u, v })
      onSelect(newIndex)
    } else {
      const { u, v } = clampToFace(face, clip.placement.u + 0.15, clip.placement.v + 0.15, busDimsM, BORESIGHT_OVERHANG_MARGIN_M)
      const newIndex = hardware.length
      const meta = BORESIGHT_KIND_META[clip.boresightKind]
      const { boresight, positionM } = compileBoresightItem(face, u, v, busDimsM, clip.placement.tiltDeg, clip.placement.spinDeg)
      const coneDeg = clip.coneHalfAngleDeg ?? meta.defaultConeDeg
      if (clip.boresightKind === "startracker") {
        addPlacedPlate({ type: "StarTracker", position_m: positionM, boresight, fov_deg: coneDeg })
      } else if (clip.boresightKind === "opnavcamera") {
        addPlacedPlate({ type: "OpNavCamera", position_m: positionM, boresight, fov_deg: coneDeg })
      } else if (clip.boresightKind === "lidar") {
        addPlacedPlate({ type: "Lidar", position_m: positionM, boresight, fov_deg: coneDeg })
      } else {
        addPlacedPlate({ type: "CommAntenna", position_m: positionM, boresight, beamwidth_deg: coneDeg })
      }
      setBoresightPlacement(newIndex, { ...clip.placement, u, v })
      onSelect(newIndex)
    }
  }

  function copySelectedToClipboard() {
    if (selectedIndex == null) return
    const plate = plates.find((p) => p.hardwareIndex === selectedIndex)
    if (plate) {
      clipboardRef.current = {
        kind: "panel",
        widthM: plate.widthM,
        heightM: plate.heightM,
        placement: {
          faceIndex: plate.faceIndex,
          u: plate.u,
          v: plate.v,
          rotXDeg: plate.rotXDeg,
          rotYDeg: plate.rotYDeg,
          rotZDeg: plate.rotZDeg,
        },
      }
      return
    }
    const thruster = thrusters.find((t) => t.hardwareIndex === selectedIndex)
    if (thruster) {
      const item = hardware[selectedIndex]
      clipboardRef.current = {
        kind: "thruster",
        thrustN: item?.type === "RcsThruster" ? item.thrust_n : DEFAULT_THRUSTER_THRUST_N,
        placement: {
          faceIndex: thruster.faceIndex,
          u: thruster.u,
          v: thruster.v,
          cantDeg: thruster.cantDeg,
          clockDeg: thruster.clockDeg,
        },
      }
      return
    }
    const boresightItem = boresightItems.find((b) => b.hardwareIndex === selectedIndex)
    if (boresightItem) {
      clipboardRef.current = {
        kind: "boresight",
        boresightKind: boresightItem.kind,
        coneHalfAngleDeg: boresightItem.coneHalfAngleDeg,
        placement: {
          faceIndex: boresightItem.faceIndex,
          u: boresightItem.u,
          v: boresightItem.v,
          tiltDeg: boresightItem.tiltDeg,
          spinDeg: boresightItem.spinDeg,
        },
      }
    }
  }

  function handleDuplicateSelected() {
    copySelectedToClipboard()
    pasteFromClipboard()
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement | null
      // Don't hijack normal text copy/paste inside Table 3's inline number
      // fields or anywhere else a text input might have focus.
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
      if (e.key === "c" || e.key === "C") {
        if (selectedIndex == null) return
        copySelectedToClipboard()
      } else if (e.key === "v" || e.key === "V") {
        if (!clipboardRef.current) return
        e.preventDefault()
        pasteFromClipboard()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, plates, thrusters, boresightItems, hardware, busDimsM])

  function handleSetRotation(hardwareIndex: number, axis: "rotXDeg" | "rotYDeg" | "rotZDeg", deg: number) {
    const plate = plates.find((p) => p.hardwareIndex === hardwareIndex)
    if (!plate) return
    commitPlacement(
      hardwareIndex,
      { faceIndex: plate.faceIndex, u: plate.u, v: plate.v, rotXDeg: plate.rotXDeg, rotYDeg: plate.rotYDeg, rotZDeg: plate.rotZDeg, [axis]: deg },
      plate.widthM,
      plate.heightM,
    )
  }

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [busDist * 0.75, busDist * 0.55, busDist * 0.75], fov: 42, near: 0.01, far: 1000 }}
        onPointerMissed={() => !placing && onSelect(null)}
      >
        <PauseWhenHidden tool="study" />
        <color attach="background" args={["#04060c"]} />
        <IdleSpinPauseOnAnyPointer draggingAnyRef={draggingAnyRef} />
        <ambientLight intensity={0.9} color="#9aa3b8" />
        <CameraHeadlight />
        <directionalLight position={[4, 5, 3]} intensity={1.4} color="#fff2dd" />
        <directionalLight position={[-4, -2, -3]} intensity={0.5} color="#88aaff" />
        <BusScene
          busDimsM={busDimsM}
          plates={plates}
          thrusters={thrusters}
          boresightItems={boresightItems}
          placing={placing != null}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onPlaceFace={handlePlaceFace}
          onDragPlate={handleDragPlate}
          onDragThruster={handleDragThruster}
          onDragBoresight={handleDragBoresight}
          spin={placing == null}
          busGroupRef={busGroupRef}
          controlsRef={controlsRef}
          draggingAnyRef={draggingAnyRef}
          comM={comM && comM.length === 3 ? (comM as Vec3) : null}
        />
        <OrbitControls
          ref={controlsRef}
          enableDamping
          dampingFactor={0.08}
          minDistance={busDist * 0.15}
          maxDistance={busDist * 8}
        />
        {/* Fixed screen-corner body-axes indicator, 
 -- the existing in-scene AxesTriad (BusScene, above)
            rotates and scales with the model and can end up hard to read
            once zoomed in on one component; this stays put and readable
            regardless of camera orbit. Same X/Y/Z color convention as
            AxesTriad below AND WheelClusterDiagram/ThrusterDiagram's own
            triads, so all of this app's body-frame axis indicators agree
            with each other. */}
        <GizmoHelper alignment="bottom-left" margin={[64, 64]} onUpdate={() => controlsRef.current?.update()}>
          <GizmoViewport axisColors={["#ff6b6b", "#5fd97a", "#5fa8ff"]} labelColor="#171512" />
        </GizmoHelper>
      </Canvas>

      <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-1.5">
        {PALETTE.map((p) => (
          <button
            key={p.kind}
            type="button"
            onClick={() => setPlacing((cur) => (cur === p.kind ? null : p.kind))}
            className={
              "pointer-events-auto w-44 rounded-lg border px-3 py-2 text-left backdrop-blur-md " +
              (placing === p.kind
                ? "border-primary bg-primary/15"
                : "border-border bg-card/60 hover:border-primary/40")
            }
          >
            <div className={"text-[12px] font-semibold " + (placing === p.kind ? "text-primary" : "text-foreground")}>
              {p.label}
            </div>
            <div className="mt-0.5 text-[9px] text-muted-foreground">{p.sub}</div>
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card/60 px-4 py-1.5 text-[10.5px] text-muted-foreground backdrop-blur-md">
        {placing
          ? `Placing ${PALETTE.find((p) => p.kind === placing)?.label} — click a glowing bus face to mount it`
          : "Drag to inspect · click a placed component to select it, Table 3 for precise edits"}
      </div>

      {selectedIndex != null && (() => {
        const plate = plates.find((p) => p.hardwareIndex === selectedIndex)
        if (!plate) return null
        const axisRows: {
          key: "rotXDeg" | "rotYDeg" | "rotZDeg"
          label: string
          hint: string
          value: number
          range: [number, number]
          snaps: number[]
        }[] = [
          {
            key: "rotXDeg",
            label: "Pitch",
            hint: "swings the panel open from flush (0) to standing straight out (90) — the main hinge motion",
            value: plate.rotXDeg,
            range: PITCH_RANGE_DEG,
            snaps: [0, 45, 90],
          },
          {
            key: "rotYDeg",
            label: "Roll",
            hint: "rolls the panel about its own mounting edge — doesn't move it, only its facing",
            value: plate.rotYDeg,
            range: ROLL_RANGE_DEG,
            snaps: [-90, -45, 0, 45, 90],
          },
          {
            key: "rotZDeg",
            label: "Yaw",
            hint: "yaws the panel to face a different edge of the bus surface — only rotation, drag still only moves position",
            value: plate.rotZDeg,
            range: YAW_RANGE_DEG,
            snaps: [-90, -45, 0, 45, 90],
          },
        ]
        return (
          <div className="absolute top-3 right-3 flex flex-col gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 backdrop-blur-md">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-muted-foreground">
                Face {FACE_NAMES[plate.faceIndex]} · u {plate.u.toFixed(2)} m · v {plate.v.toFixed(2)} m
              </span>
              <div className="ml-1 flex items-center gap-1 border-l border-border pl-2">
                <button
                  type="button"
                  onClick={handleDuplicateSelected}
                  title="Duplicate (Ctrl/Cmd+C then Ctrl/Cmd+V also works)"
                  className="rounded px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:bg-primary/15 hover:text-primary"
                >
                  ⧉ Duplicate
                </button>
                <button
                  type="button"
                  onClick={handleRemoveSelected}
                  className="rounded px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                >
                  ✕ Remove
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              {axisRows.map((row) => (
                <div key={row.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      title={row.hint}
                      className="w-11 shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
                    >
                      {row.label}
                    </span>
                    <input
                      type="range"
                      min={row.range[0]}
                      max={row.range[1]}
                      step={1}
                      value={row.value}
                      onChange={(e) => handleSetRotation(selectedIndex, row.key, Number(e.target.value))}
                      className="h-1 w-32 accent-primary"
                    />
                    <span className="w-10 text-right font-mono text-[10.5px] text-muted-foreground">
                      {row.value.toFixed(0)}°
                    </span>
                  </div>
                  <div className="ml-[3.25rem] flex gap-1">
                    {row.snaps.map((snap) => (
                      <button
                        key={snap}
                        type="button"
                        onClick={() => handleSetRotation(selectedIndex, row.key, snap)}
                        className={
                          "rounded px-1.5 py-0.5 text-[9px] font-mono " +
                          (row.value === snap
                            ? "bg-primary/25 text-primary"
                            : "text-muted-foreground hover:bg-primary/10 hover:text-primary")
                        }
                      >
                        {snap}°
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {selectedIndex != null && (() => {
        const thruster = thrusters.find((t) => t.hardwareIndex === selectedIndex)
        if (!thruster) return null
        const axisRows: {
          key: "cantDeg" | "clockDeg"
          label: string
          hint: string
          value: number
          range: [number, number]
          snaps: number[]
        }[] = [
          {
            key: "cantDeg",
            label: "Cant",
            hint: "tips the thrust direction away from the face's own outward normal, 0 (straight out) to 90 (lying flat along the face)",
            value: thruster.cantDeg,
            range: CANT_RANGE_DEG,
            snaps: [0, 15, 30, 45, 90],
          },
          {
            key: "clockDeg",
            label: "Clock",
            hint: "spins the tipped thrust direction around the face's own normal — has no visible effect at Cant = 0",
            value: thruster.clockDeg,
            range: CLOCK_RANGE_DEG,
            snaps: [-90, -45, 0, 45, 90],
          },
        ]
        return (
          <div className="absolute top-3 right-3 flex flex-col gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 backdrop-blur-md">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-muted-foreground">
                Face {FACE_NAMES[thruster.faceIndex]} · u {thruster.u.toFixed(2)} m · v {thruster.v.toFixed(2)} m
              </span>
              <div className="ml-1 flex items-center gap-1 border-l border-border pl-2">
                <button
                  type="button"
                  onClick={handleDuplicateSelected}
                  title="Duplicate (Ctrl/Cmd+C then Ctrl/Cmd+V also works)"
                  className="rounded px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:bg-primary/15 hover:text-primary"
                >
                  ⧉ Duplicate
                </button>
                <button
                  type="button"
                  onClick={handleRemoveSelected}
                  className="rounded px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                >
                  ✕ Remove
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              {axisRows.map((row) => (
                <div key={row.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      title={row.hint}
                      className="w-11 shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
                    >
                      {row.label}
                    </span>
                    <input
                      type="range"
                      min={row.range[0]}
                      max={row.range[1]}
                      step={1}
                      value={row.value}
                      onChange={(e) => handleSetThrusterAngle(selectedIndex, row.key, Number(e.target.value))}
                      className="h-1 w-32 accent-primary"
                    />
                    <span className="w-10 text-right font-mono text-[10.5px] text-muted-foreground">
                      {row.value.toFixed(0)}°
                    </span>
                  </div>
                  <div className="ml-[3.25rem] flex gap-1">
                    {row.snaps.map((snap) => (
                      <button
                        key={snap}
                        type="button"
                        onClick={() => handleSetThrusterAngle(selectedIndex, row.key, snap)}
                        className={
                          "rounded px-1.5 py-0.5 text-[9px] font-mono " +
                          (row.value === snap
                            ? "bg-primary/25 text-primary"
                            : "text-muted-foreground hover:bg-primary/10 hover:text-primary")
                        }
                      >
                        {snap}°
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {selectedIndex != null && (() => {
        const item = boresightItems.find((b) => b.hardwareIndex === selectedIndex)
        if (!item) return null
        const meta = BORESIGHT_KIND_META[item.kind]
        const coneLabel = item.kind === "commantenna" ? "Beamwidth" : "FOV half-angle"
        return (
          <div className="absolute top-3 right-3 flex flex-col gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 backdrop-blur-md">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-muted-foreground">
                {meta.label} · Face {FACE_NAMES[item.faceIndex]} · u {item.u.toFixed(2)} m · v {item.v.toFixed(2)} m
              </span>
              <div className="ml-1 flex items-center gap-1 border-l border-border pl-2">
                <button
                  type="button"
                  onClick={handleDuplicateSelected}
                  title="Duplicate (Ctrl/Cmd+C then Ctrl/Cmd+V also works)"
                  className="rounded px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:bg-primary/15 hover:text-primary"
                >
                  ⧉ Duplicate
                </button>
                <button
                  type="button"
                  onClick={handleRemoveSelected}
                  className="rounded px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                >
                  ✕ Remove
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <div className="flex items-center gap-2">
                <span
                  title="tilts the boresight away from the face's own outward normal, 0 (flush) to 90 (in-plane)"
                  className="w-11 shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  Tilt
                </span>
                <input
                  type="range"
                  min={TILT_RANGE_DEG[0]}
                  max={TILT_RANGE_DEG[1]}
                  step={1}
                  value={item.tiltDeg}
                  onChange={(e) => handleSetBoresightAngle(selectedIndex, "tiltDeg", Number(e.target.value))}
                  className="h-1 w-32 accent-primary"
                />
                <span className="w-10 text-right font-mono text-[10.5px] text-muted-foreground">
                  {item.tiltDeg.toFixed(0)}°
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  title="spins the tilted boresight around the face's own normal — no effect at Tilt=0"
                  className="w-11 shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  Spin
                </span>
                <input
                  type="range"
                  min={SPIN_RANGE_DEG[0]}
                  max={SPIN_RANGE_DEG[1]}
                  step={1}
                  value={item.spinDeg}
                  onChange={(e) => handleSetBoresightAngle(selectedIndex, "spinDeg", Number(e.target.value))}
                  className="h-1 w-32 accent-primary"
                />
                <span className="w-10 text-right font-mono text-[10.5px] text-muted-foreground">
                  {item.spinDeg.toFixed(0)}°
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-11 shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {coneLabel}
                </span>
                <input
                  type="range"
                  min={1}
                  max={45}
                  step={1}
                  value={item.coneHalfAngleDeg ?? meta.defaultConeDeg}
                  onChange={(e) => handleSetConeAngle(selectedIndex, Number(e.target.value))}
                  className="h-1 w-32 accent-primary"
                />
                <span className="w-10 text-right font-mono text-[10.5px] text-muted-foreground">
                  {(item.coneHalfAngleDeg ?? meta.defaultConeDeg).toFixed(0)}°
                </span>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
