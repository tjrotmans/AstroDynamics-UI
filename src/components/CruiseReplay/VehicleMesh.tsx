import { useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import type { HardwareItem } from "@/api/client"
import {
  ECLIPTIC_LEVEL_QUATERNION,
  SCENE_SCALE,
  BURN_MARKER_MAX_RADIUS_SCENE,
  BURN_MARKER_MIN_RADIUS_SCENE,
  BURN_MARKER_DISTANCE_FRACTION,
} from "@/components/scene/sceneShared"
import { MainEngineMesh } from "@/components/Vehicle/MainEngineMesh"
import { useVehicleUiStore } from "@/stores/vehicleUiStore"
import { FACES, panelOrientation, crossVec3 } from "@/lib/vehicleGeometry"

// A read-only renderer of the real Phase-02 vehicle, deliberately NOT
// reusing VehicleViewport.tsx -- that file has no exported render-only
// pieces (every mesh component there is coupled to drag/select editing
// refs/callbacks), so this is a small, separate component built straight
// off spacecraft.hardware's already-COMPILED fields (position_m/normal/
// direction/boresight). Nothing here is decomposed or edited, so
// vehicleGeometry.ts's decompose helpers aren't needed -- only plain vector
// math for orienting each mesh.
export function VehicleMesh({
  busDimsM,
  hardware,
  quaternion,
  boresightScale = 1,
  showLabels = true,
  labelsOnHover = false,
  axesGrey = false,
  distanceScaled = true,
}: {
  // (
  // hovering"): with showLabels, render each hardware label only while its
  // cone is hovered instead of always.
  labelsOnHover?: boolean
  busDimsM: number[]
  hardware: HardwareItem[]
  // Real attitude quaternion [w, x, y, z] from CruiseStepMsg.q, or null for
  // an idle/no-data state (identity orientation).
  quaternion: number[] | null
  // Real bug fixed: this component's geometry is defined in raw
  // METERS. `CruiseReplayView` mounts it inside a `SCENE_SCALE`-scaled
  // parent group (solar-system-scale coordinates, 1 scene unit = 1e9 m),
  // where raw-meter geometry renders enormous -- so THAT mount needs the
  // distance-clamped apparent-size scaling below (the default). `AttitudePip`
  // mounts it at true 1:1 scale with its own close-up, real-meters camera
  // (`MirrorCamera`'s `busDist * 1.6` position) -- applying the same
  // scaling there would wrongly shrink it to a few percent of its real
  // size. Set `false` for any mount that already provides its own
  // real-meters-scale camera/coordinate system.
  distanceScaled?: boolean
  // Real request: AttitudePip wants much larger FOV/normal
  // cones than the main trajectory view (where the vehicle renders at its
  // literal true scale next to a whole mission) -- a pure visual multiplier
  // on cone length (radius follows automatically via the real fovDeg
  // tangent), doesn't touch the vehicle's own bus/panel geometry.
  boresightScale?: number
  // Real request: the pip's in-scene Html labels overlapped
  // illegibly once zoomed to see multiple sensors at once ("OpNav bore..."
  // stacked under "star tracker boresight" in the screenshot) -- AttitudePip
  // suppresses them and shows a legend instead. the main
  // trajectory view (CruiseReplayView) now does the same -- its vehicle is
  // always the distance-exaggerated symbolic marker, so the labels stacked
  // on the same screen pixels there too. No mount passes
  // true today; kept as a prop for a future genuinely-close-up mount.
  showLabels?: boolean
  // Real request: "the SBCF axes can just be in grey" -- the
  // RGB triad reads as one more competing color set once several colored
  // boresight cones are also on screen in the pip; kept RGB in the main
  // view (matches the X/Y/Z convention used elsewhere in the app).
  axesGrey?: boolean
}) {
  // Real bug: the attitude inset was unclear about what frame
  // the s/c is displayed in relative to the 3d trajectory plot. The
  // streamed CruiseStepMsg.q/q_cmd is raw J2000/ICRF-equatorial, same as
  // every other raw ANISE vector -- but every POSITION in this scene goes
  // through sceneVecFromMeters, which applies ECLIPTIC_LEVEL_QUATERNION so
  // the ecliptic plane sits level (scene z=0). The attitude quaternion
  // never got that same correction, so the vehicle's displayed orientation
  // was rotated ~23.4 deg (Earth's obliquity) off what its real position/
  // trajectory context would suggest. Pre-multiplying by the same leveling
  // quaternion here (once, in the one shared renderer both CruiseReplayView
  // and AttitudePip use) keeps every consumer consistent automatically.
  const quat = useMemo(() => {
    if (!quaternion || quaternion.length !== 4) return new THREE.Quaternion()
    const [w, x, y, z] = quaternion
    const raw = new THREE.Quaternion(x, y, z, w)
    return ECLIPTIC_LEVEL_QUATERNION.clone().multiply(raw)
  }, [quaternion])

  const [bx, by, bz] = busDimsM
  const bodyAxisLen = Math.max(bx, by, bz) * 0.85

  // Real bug found (
  // (its larger than earth), and when i try to zoom in on the departure
  // orbit the s/c is in the way"). Root cause: every child mesh below is
  // sized in RAW METERS (bus dims, panel widths, boresight cone lengths --
  // real physical dimensions of a few meters at most), but this group's
  // PARENT (`<group position={vehiclePos}>` in CruiseReplayView.tsx) places
  // it via `sceneVecFromMeters`, which applies `SCENE_SCALE` (1e-9). So a
  // real ~2-5 m vehicle rendered as ~2-5 SCENE UNITS -- comparable to a
  // meaningful fraction of an AU (149.6 units) and far bigger than Earth's
  // own exaggerated display radius (~0.57 units, see PLANET_SIZE_
  // EXAGGERATION) -- while the real departure/parking orbit it's meant to
  // sit inside is only ~0.005-0.02 scene units across. The vehicle was
  // never actually placed AT solar-system scale at all.
  //
  // Fixed with the SAME constant-apparent-screen-size idiom BurnMarker
  // already uses (`dist * BURN_MARKER_DISTANCE_FRACTION`, clamped to the
  // same MIN/MAX radius, i.e. the same visual weight class as a burn
  // marker -- reasonable for a symbolic "here's the spacecraft, and here's
  // its real attitude" representation), but derived as a SCALE MULTIPLIER
  // on top of true SCENE_SCALE geometry rather than an absolute radius:
  // `scale = max(SCENE_SCALE, targetApparentRadius / busRadiusM)`. This
  // keeps the vehicle comfortably visible (and never bigger than a burn
  // marker) at any interplanetary/orbital-inspection distance, while the
  // `max(SCENE_SCALE, ...)` floor means it can never be exaggerated BELOW
  // its own true physical scale -- so as the camera gets close enough that
  // true scale would already exceed the apparent-size target (i.e. you're
  // now within a few real vehicle-lengths of it), the multiplier collapses
  // to SCENE_SCALE and the vehicle renders at its honest, non-blocking true
  // size, the same "true scale up close, comfortably visible from afar"
  // rule every body already follows (PlanetBody's own PLANET_SIZE_
  // EXAGGERATION ramp).
  const groupRef = useRef<THREE.Group>(null)
  const busRadiusM = useMemo(() => Math.max(Math.hypot(bx, by, bz) / 2, 0.05), [bx, by, bz])
  useFrame(({ camera }) => {
    if (!groupRef.current || !distanceScaled) return
    const worldPos = new THREE.Vector3()
    groupRef.current.getWorldPosition(worldPos)
    const dist = camera.position.distanceTo(worldPos)
    const targetApparentRadius = THREE.MathUtils.clamp(
      dist * BURN_MARKER_DISTANCE_FRACTION,
      BURN_MARKER_MIN_RADIUS_SCENE,
      BURN_MARKER_MAX_RADIUS_SCENE,
    )
    const scale = Math.max(SCENE_SCALE, targetApparentRadius / busRadiusM)
    groupRef.current.scale.setScalar(scale)
  })

  return (
    <group ref={groupRef} quaternion={quat}>
      <mesh>
        <boxGeometry args={[bx, by, bz]} />
        <meshStandardMaterial color="#9aa3b8" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh>
        <boxGeometry args={[bx * 1.002, by * 1.002, bz * 1.002]} />
        <meshBasicMaterial color="#39e6ff" wireframe transparent opacity={0.25} />
      </mesh>

      {/* Real request,: "add the body axes (SBCF) to the s/c for
          completion (in the small attitude plot)". Body-FIXED triad --
          rotates with the vehicle (inside this same quaternion'd group),
          distinct from the world/ecliptic axes drawn around it in
          AttitudePip/CruiseReplayView. Same X/Y/Z=red/green/blue
          convention used everywhere else in this app (WheelClusterDiagram,
          the Phase 02 viewport gizmo, etc). */}
      <BodyAxesTriad length={bodyAxisLen} grey={axesGrey} />

      {/* Real request,: "you can add the main engine to phase 03
          overview, but not the other actuators indeed" -- the ONE deliberate
 exception to the "no actuators here" rule below, since
          the main engine is what every maneuver/burn in this replay
          actually fires (see the Maneuver mode panel in GncModesEditor.tsx)
          -- unlike RCS/wheels, its geometry directly explains what's
          happening on screen during a burn. Shared component with
          VehicleViewport.tsx -- see MainEngineMesh.tsx's own header. */}
      <MainEngineMesh busDimsM={[bx, by, bz]} />

      {hardware.map((item, i) => (
        <HardwareMesh
          key={i}
          item={item}
          index={i}
          boresightScale={boresightScale}
          showLabels={showLabels}
          hoverOnly={labelsOnHover}
        />
      ))}
    </group>
  )
}

const AXIS_COLORS: [string, string, string] = ["#ff6b6b", "#5fd97a", "#5fa8ff"]
const AXIS_GREY = "#8a92a6"

function BodyAxesTriad({ length, grey }: { length: number; grey: boolean }) {
  const axes: [THREE.Vector3, string][] = [
    [new THREE.Vector3(length, 0, 0), grey ? AXIS_GREY : AXIS_COLORS[0]],
    [new THREE.Vector3(0, length, 0), grey ? AXIS_GREY : AXIS_COLORS[1]],
    [new THREE.Vector3(0, 0, length), grey ? AXIS_GREY : AXIS_COLORS[2]],
  ]
  return (
    <>
      {axes.map(([tip, color], i) => {
        const positions = new Float32Array([0, 0, 0, tip.x, tip.y, tip.z])
        return (
          <line key={i}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[positions, 3]} />
            </bufferGeometry>
            <lineBasicMaterial color={color} linewidth={2} />
          </line>
        )
      })}
    </>
  )
}

// Real feedback (user, on the trajectory replay's vehicle
// rendering): actuators (thrusters, wheels) don't need to be shown here --
// this view is about the mission/pointing story, not vehicle assembly
// (VehicleViewport in Phase 02 already covers that in full detail) -- but
// sensor FOV/pointing IS wanted, since that's what actually matters for
// mode/target validation. So: RcsThruster no longer renders at all here;
// wheels already weren't rendered (no case below, unchanged). The main
// engine is now a deliberate, named exception to this rule (
// see the MainEngineMesh call above) -- everything else (RCS thrusters,
// wheels) stays excluded per this same note.
//
// Real bug found (
// one from the gnc design page (solar panel for example...)"). Root cause:
// a SolarPanel's compiled `normal` field alone is NOT enough to render its
// real orientation -- the panel can also be rotated about that normal
// (Roll), which changes which way its width/height edges point but leaves
// `normal` unchanged; that roll is genuinely unrecoverable from `normal`
// alone (an under-determined inverse). The REAL authoritative mount
// identity (which face, u/v anchor, Pitch/Roll/Yaw) lives in
// useVehicleUiStore -- the same global store Phase 02's own PlacedPanel
// reads from -- so reading it here instead of guessing an arbitrary roll
// (three.js's THREE.Quaternion.setFromUnitVectors has no defined roll
// component) reproduces the EXACT same orientation Phase 02 shows, not an
// approximation. Falls back to the old normal-only approximation only for
// a hardware index with no placement record (e.g. a SolarPanel loaded from
// a preset TOML authored outside this UI, never touched in the builder).
// A boresight cone is rotationally symmetric about its own axis, so unlike
// a rectangular panel, its ROLL (tiltDeg/spinDeg's spin component) has no
// visible effect on the rendered shape -- orientationFromNormal's
// arbitrary roll choice is already geometrically correct here, no
// placement-store lookup needed (import kept for the sibling panel case).
function HardwareMesh({
  item,
  index,
  boresightScale,
  showLabels,
  hoverOnly,
}: {
  item: HardwareItem
  index: number
  boresightScale: number
  showLabels: boolean
  hoverOnly: boolean
}) {
  const panelPlacement = useVehicleUiStore((s) => s.placements[index])

  if (item.type === "SolarPanel" && item.position_m && item.normal) {
    const width = item.width_m ?? Math.sqrt(item.area_m2)
    const height = item.height_m ?? Math.sqrt(item.area_m2)
    return (
      <PlaneAt
        position={item.position_m}
        normal={item.normal}
        width={width}
        height={height}
        color="#2f6fed"
        placement={panelPlacement}
        showLabel={showLabels}
        hoverOnly={hoverOnly}
      />
    )
  }
  if (
    (item.type === "StarTracker" || item.type === "OpNavCamera" || item.type === "Lidar") &&
    item.position_m &&
    item.boresight
  ) {
    const color = item.type === "StarTracker" ? "#39e6ff" : item.type === "OpNavCamera" ? "#2e9e53" : "#d64ae0"
    const label = item.type === "StarTracker" ? "star tracker" : item.type === "OpNavCamera" ? "OpNav" : "lidar"
    return (
      <BoresightAt
        position={item.position_m}
        direction={item.boresight}
        color={color}
        fovDeg={item.fov_deg}
        label={label}
        scale={boresightScale}
        showLabel={showLabels}
        hoverOnly={hoverOnly}
      />
    )
  }
  if (item.type === "CommAntenna" && item.position_m) {
    return (
      <BoresightAt
        position={item.position_m}
        direction={item.boresight}
        color="#f2b400"
        fovDeg={item.beamwidth_deg}
        label="HGA"
        scale={boresightScale}
        showLabel={showLabels}
        hoverOnly={hoverOnly}
      />
    )
  }
  return null
}

function orientationFromNormal(normal: number[]) {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize()
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
}

function PlaneAt({
  position,
  normal,
  width,
  height,
  color,
  placement,
  showLabel,
  hoverOnly = false,
}: {
  position: number[]
  normal: number[]
  width: number
  height: number
  color: string
  placement?: { faceIndex: number; rotXDeg: number; rotYDeg: number; rotZDeg: number }
  showLabel: boolean
  hoverOnly?: boolean
}) {
  const quat = useMemo(() => {
    if (placement) {
      // Exact match with Phase 02's PlacedPanel: same basis construction
      // (widthDir, offsetDir, normal) = local (X, Y, Z).
      const { normal: realNormal, offsetDir } = panelOrientation(
        FACES[placement.faceIndex],
        placement.rotXDeg,
        placement.rotYDeg,
        placement.rotZDeg,
      )
      const widthDir = crossVec3(offsetDir, realNormal)
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...widthDir),
        new THREE.Vector3(...offsetDir),
        new THREE.Vector3(...realNormal),
      )
      return new THREE.Quaternion().setFromRotationMatrix(m)
    }
    return orientationFromNormal(normal)
  }, [placement, normal])

  // Real request: "point where the solar panel normal direction
  // is pointing (for sun pointing mode)... we can also use a cone like
  // thing maybe" -- a normal indicator is now the same kind of narrow
  // direction cone the sensors use (a fixed small half-angle, not a real
  // FOV) instead of a bare line, for visual consistency with the sensor
  // cones. The panel's local +Z is its normal (plane geometry's own default
  // normal axis, unlike ConeGeometry -- see DirectionCone's own note on why
  // sensor cones need a different basis correction).
  const normalLen = Math.max(width, height) * 0.6

  return (
    <group position={[position[0], position[1], position[2]]} quaternion={quat}>
      <mesh>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial color={color} metalness={0.2} roughness={0.4} side={THREE.DoubleSide} />
      </mesh>
      <DirectionCone
        axis="z"
        length={normalLen}
        halfAngleDeg={7}
        color={color}
        label={showLabel ? "panel normal" : undefined}
        hoverOnly={hoverOnly}
      />
    </group>
  )
}

// Shared apex-at-mount, base-flares-outward direction cone, reused for both
// sensor FOV cones and the panel-normal indicator. `axis` picks which LOCAL
// axis of the parent group the cone should point along -- "y" for
// BoresightAt (whose parent group aligns local Y to the real boresight
// direction, matching Phase 02's VehicleViewport convention exactly) and
// "z" for PlaneAt (whose parent group's local Z is the panel's own normal,
// PlaneGeometry's real default normal axis).
//
// Real bug found (screenshot: sensor cones "point sideways
// instead of forward"). Root cause: THREE.ConeGeometry's own intrinsic axis
// is ALWAYS local Y (apex at +height/2, base at -height/2), regardless of
// which axis the surrounding group's quaternion happens to align with the
// world direction -- the old BoresightAt aligned local Z to the direction
// but never rotated the cone geometry itself to match, so the cone's real
// shape stuck out along whatever local-Y-mapped-to-world direction the
// group's quaternion happened to produce, which is NOT the boresight
// direction. Fixed the same way Phase 02's own PlacedBoresightMarker
// already does it (VehicleViewport.tsx): a `rotation={[Math.PI,0,0]}` flip
// on the cone mesh itself moves its apex to local y=0, base to y=+height,
// then a middle group's position offset does that translation, all nested
// inside the axis-aligning quaternion -- so the geometry is genuinely
// pointing along the group's own local Y regardless of which world
// direction that Y then gets rotated to.
function DirectionCone({
  axis,
  length,
  halfAngleDeg,
  color,
  label,
  hoverOnly = false,
}: {
  axis: "y" | "z"
  length: number
  halfAngleDeg: number
  color: string
  label?: string
  // Show `label` only while the cone is hovered (AttitudePip's mode).
  hoverOnly?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const labelVisible = !!label && (!hoverOnly || hovered)
  const radius = length * Math.tan((halfAngleDeg * Math.PI) / 180)
  const axisCorrection = useMemo(
    () =>
      axis === "y"
        ? new THREE.Quaternion()
        : new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)),
    [axis],
  )
  // Both the centerline and the label are children of the SAME
  // axisCorrection group as the cone mesh below, so -- like the cone
  // mesh's own position offset -- they're defined in the cone's intrinsic
  // pre-correction frame (always local Y) and axisCorrection remaps all of
  // them to the real target axis uniformly. Do NOT branch these on `axis`
  // directly; that would double-apply the correction.
  const centerlinePositions = useMemo(() => new Float32Array([0, 0, 0, 0, length, 0]), [length])
  return (
    <group quaternion={axisCorrection}>
      <group position={[0, length / 2, 0]}>
        <mesh
          rotation={[Math.PI, 0, 0]}
          onPointerOver={hoverOnly ? (e) => { e.stopPropagation(); setHovered(true) } : undefined}
          onPointerOut={hoverOnly ? () => setHovered(false) : undefined}
        >
          <coneGeometry args={[radius, length, 16, 1, true]} />
          <meshStandardMaterial
            color={color}
            metalness={0.1}
            roughness={0.6}
            transparent
            opacity={hovered ? 0.6 : 0.35}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[centerlinePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} />
      </line>
      {labelVisible && (
        <Html position={[0, length, 0]} center distanceFactor={4} style={{ pointerEvents: "none" }}>
          <div style={{ color, fontSize: 9, fontWeight: 700, whiteSpace: "nowrap", textShadow: "0 0 3px #000" }}>{label}</div>
        </Html>
      )}
    </group>
  )
}

function BoresightAt({
  position,
  direction,
  color,
  length = 0.18,
  fovDeg,
  label,
  scale = 1,
  showLabel,
  hoverOnly = false,
}: {
  position: number[]
  direction: number[]
  color: string
  length?: number
  hoverOnly?: boolean
  /** Real half-angle [deg] -- sizes the cone's radius so it actually shows
   * the sensor's real field of view, not a fixed decorative shape. Falls
   * back to a fixed 20 deg half-angle when the hardware item doesn't carry
   * one (older/unplaced entries). */
  fovDeg?: number | null
  label?: string
  scale?: number
  showLabel: boolean
}) {
  // Matches Phase 02's own PlacedBoresightMarker convention exactly: align
  // local Y (not Z) to the real boresight direction -- see DirectionCone's
  // header comment for why this matters for a ConeGeometry specifically.
  const quat = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...(direction as [number, number, number])).normalize()),
    [direction],
  )
  const scaledLength = length * scale
  return (
    <group position={[position[0], position[1], position[2]]} quaternion={quat}>
      <DirectionCone
        axis="y"
        length={scaledLength}
        halfAngleDeg={fovDeg ?? 20}
        color={color}
        label={showLabel && label ? `${label} boresight` : undefined}
        hoverOnly={hoverOnly}
      />
    </group>
  )
}
