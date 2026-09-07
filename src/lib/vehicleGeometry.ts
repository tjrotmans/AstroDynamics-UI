// Pure, framework-agnostic face/placement math for the Spacecraft
// Configuration Builder (GNC phase 02) -- shared between VehicleViewport.tsx
// (Three.js) and VehiclePaper.tsx (plain numeric table editing), so both
// sides agree on what "face 2, offset (0.3, -0.1)" means without either
// duplicating the other's math. No THREE.js dependency on purpose -- this
// is just axis-aligned box geometry, plain [x,y,z] tuples throughout.
//
// A bus face is identified by an index 0-5 into FACES below. Each face has
// an outward unit normal (one axis, +1 or -1) and two in-plane tangent
// axes (u, v) -- "offset" always means a 2D (u, v) position within that
// face's own plane, in metres from the face centre.

export type Vec3 = [number, number, number]

export interface FaceDef {
  axis: 0 | 1 | 2
  sign: 1 | -1
}

export const FACES: FaceDef[] = [
  { axis: 0, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 2, sign: -1 },
]

export const FACE_NAMES = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]

function unitAxis(axis: 0 | 1 | 2, sign: number): Vec3 {
  const v: Vec3 = [0, 0, 0]
  v[axis] = sign
  return v
}

export function faceNormal(face: FaceDef): Vec3 {
  return unitAxis(face.axis, face.sign)
}

export function faceTangents(face: FaceDef): { u: Vec3; v: Vec3 } {
  const uAxis = ((face.axis + 1) % 3) as 0 | 1 | 2
  const vAxis = ((face.axis + 2) % 3) as 0 | 1 | 2
  return { u: unitAxis(uAxis, 1), v: unitAxis(vAxis, 1) }
}

// Half-extents of the face's own plane, and the bus's half-depth along the
// face normal (how far the face sits from the bus centre).
export function faceHalfExtents(face: FaceDef, busDimsM: Vec3): { halfU: number; halfV: number; halfN: number } {
  const uAxis = (face.axis + 1) % 3
  const vAxis = (face.axis + 2) % 3
  return { halfU: busDimsM[uAxis] / 2, halfV: busDimsM[vAxis] / 2, halfN: busDimsM[face.axis] / 2 }
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
export const crossVec3 = cross

// Body-frame centre_offset_m for a component mounted flush against
// `face`, at in-plane position (u, v) -- the backend's real placement
// representation for a CustomPlate.
export function centerOffsetForPlacement(face: FaceDef, u: number, v: number, busDimsM: Vec3): Vec3 {
  const n = faceNormal(face)
  const { u: uAxis, v: vAxis } = faceTangents(face)
  const { halfN } = faceHalfExtents(face, busDimsM)
  return add(add(scale(n, halfN), scale(uAxis, u)), scale(vAxis, v))
}

// Inverse of the above: given a real center_offset_m + normal already on
// the config, recover which face it's mounted on and its (u, v) -- needed
// so Table 3 / the viewport can render an existing CustomPlate without
// re-deriving placement state from scratch. Matches by whichever face
// normal the stored normal is closest to (handles a normal that wasn't
// exactly axis-aligned, e.g. a hand-edited TOML).
export function decomposePlacement(normal: Vec3, centerOffsetM: Vec3): { faceIndex: number; u: number; v: number } {
  let bestIdx = 0
  let bestDot = -Infinity
  FACES.forEach((f, i) => {
    const n = faceNormal(f)
    const d = dot(n, normal)
    if (d > bestDot) {
      bestDot = d
      bestIdx = i
    }
  })
  const face = FACES[bestIdx]
  const { u: uAxis, v: vAxis } = faceTangents(face)
  return { faceIndex: bestIdx, u: dot(centerOffsetM, uAxis), v: dot(centerOffsetM, vAxis) }
}

// The anchor (u, v) is the component's real mounting point on the bus
// surface -- clamped to the face's own rectangle, WIDENED by marginM on
// every side so it can be dragged partway past an edge (a corner/T-shape,
// or just "give me the whole face, not just what's inside the rectangle" --
//: "the panels dont have the full space of
// one side of the bus to go to... it can not be dragged over the edge").
// History: an earlier version had a real overhang margin like this one,
// removed in favor of a stricter "always exactly on the
// rectangle" rule tied to the hinge-anchor concept at the time -- now that
// position and rotation are fully decoupled again, that
// stricter rule no longer serves its original purpose and just blocks
// ordinary dragging. marginM should be sized to the component's own
// footprint by the caller (e.g. half its shorter side) so the anchor can
// never be pushed so far that the whole component floats beside the bus,
// disconnected -- the specific regression an even earlier version had.
export function clampToFace(face: FaceDef, u: number, v: number, busDimsM: Vec3, marginM = 0): { u: number; v: number } {
  const { halfU, halfV } = faceHalfExtents(face, busDimsM)
  return {
    u: Math.max(-halfU - marginM, Math.min(halfU + marginM, u)),
    v: Math.max(-halfV - marginM, Math.min(halfV + marginM, v)),
  }
}

// The overhang margin to pass to clampToFace above, sized to the
// component's OWN footprint so the anchor can never be dragged so far past
// an edge that the whole component ends up floating beside the bus with
// nothing touching it. Widened (same day
// as the margin was first added back) from half the SHORTER side to the
// FULL longer side -- half the shorter side was too tight to reach a real
// corner/T-shape placement by dragging alone, forcing Yaw to be used
// instead ("this is currently only possible by using yaw to rotate it...
// i prefer dragging"). Still bounded to the component's own real size, not
// unlimited, so it can't be dragged arbitrarily far from the bus.
export function overhangMarginM(widthM: number, heightM: number): number {
  return Math.max(widthM, heightM)
}

// Articulated (hinge-mounted) placement, unified into ONE 3-axis rotation
// control -- replacing an earlier
// two-part design (a discrete hinge-axis picker "u"/"v" + a deploy angle,
// PLUS a separate purely-cosmetic in-plane spin button) that felt like two
// different bolted-together mechanisms.
//
// Position and orientation are FULLY DECOUPLED (
// reverting a same-day detour): dragging the anchor (u, v)
// never changes which way the panel faces, and rotating the panel never
// moves the anchor. Two earlier same-day attempts tied the rest facing
// direction to wherever the anchor was dragged (first a discrete pick
// among the face's 4 edges, then a continuous version to remove that
// pick's jarring snap) -- both were rejected outright ("we dont want this
// auto flipping at all, even if continuous... the user can only drag, and
// then you can rotate it yourself"). So the rest orientation is a FIXED
// convention again -- normal = the face's own flush normal, offsetDir =
// the face's v-tangent -- and Pitch/Roll/Yaw (renamed from Tilt/Twist/
// Spin, same request) are the only way to reorient it, same as the
// original pre-auto-pick design. The anchor itself never moves during a
// rotation -- it's the fixed pivot for every one of the three rotations,
// so "one end stays on the bus" holds for any combination of angles, not
// just a single hinge-open motion.
//
// What each axis actually does (verified numerically before shipping, not
// guessed -- all three keep normal/offsetDir unit-length and mutually
// perpendicular for any input):
// - rotX ("Pitch"): swings the component open from flush against the bus
//   to standing straight out (0-90 deg only -- negative would fold the
//   panel into the bus, and past 90 just re-reaches an orientation
//   already reachable by picking a different rest edge... except the rest
//   edge is fixed now, so past 90 is genuinely unreachable this way; use
//   Yaw first to face a different edge, then Pitch to open it).
// - rotY ("Roll"): rotates the component about its OWN rest extension
//   direction (the v-tangent). Because the rest offsetDir is chosen ALONG
//   this same axis, rotY has NO effect on where the component's body sits
//   (offsetDir is invariant under rotation about itself) -- it only tilts
//   the normal, like rolling a hinged door about its own hanging edge
//   rather than swinging it open.
// - rotZ ("Yaw"): rotates the component within the bus's own tangent
//   plane about the (unrotated) face normal -- genuinely moves the body
//   sideways along the face (this also shifts position_m, i.e. it's a
//   real torque-arm change, not just a display trick), while never
//   tilting the normal itself. This is now the ONLY way to point a panel
//   toward a different edge of the face (Yaw=180 flips it to the
//   opposite edge, Yaw=+-90 to either perpendicular edge).
//
// Sign convention: rotX/rotY use a NEGATED angle before the standard
// Rodrigues rotation so a positive value opens the component AWAY from the
// bus (matches the pre-unification hinge derivation, re-verified
// numerically against this implementation before shipping).
function rotateAboutAxis(v: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  const k = dot(axis, v)
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, k * (1 - c)))
}

// Real physical range for each axis, not the old blanket -180..180 (direct
//): Pitch can only usefully swing 0 (flush/
// stowed) to 90 (fully deployed, standing straight out) -- negative would
// fold the panel into the bus. Roll and Yaw are genuinely two-sided
// (there's no physical "into the bus" asymmetry for either), so they keep
// a symmetric range. Yaw was briefly kept at the full +-180 on the theory
// that it was the only way to reach the opposite edge of the face -- once
// overhangMarginM (above) was widened enough to reach a corner/T-shape by
// dragging alone, that theory no longer held (
// "for yaw we also dont need the full 180 deg if we fix this"),
// so Yaw is narrowed to +-90 too, matching Roll.
export const PITCH_RANGE_DEG: [number, number] = [0, 90]
export const ROLL_RANGE_DEG: [number, number] = [-90, 90]
export const YAW_RANGE_DEG: [number, number] = [-90, 90]

export function clampRotationDeg(rotXDeg: number, rotYDeg: number, rotZDeg: number): { rotXDeg: number; rotYDeg: number; rotZDeg: number } {
  const clamp = (v: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, v))
  return {
    rotXDeg: clamp(rotXDeg, PITCH_RANGE_DEG),
    rotYDeg: clamp(rotYDeg, ROLL_RANGE_DEG),
    rotZDeg: clamp(rotZDeg, YAW_RANGE_DEG),
  }
}

export function panelOrientation(
  face: FaceDef,
  rotXDeg: number,
  rotYDeg: number,
  rotZDeg: number,
): { normal: Vec3; offsetDir: Vec3 } {
  const n0 = faceNormal(face)
  const { u: uAxis, v: vAxis } = faceTangents(face)
  let normal = n0
  let offsetDir = vAxis
  const rx = (-rotXDeg * Math.PI) / 180
  const ry = (-rotYDeg * Math.PI) / 180
  const rz = (rotZDeg * Math.PI) / 180
  normal = rotateAboutAxis(normal, uAxis, rx)
  offsetDir = rotateAboutAxis(offsetDir, uAxis, rx)
  normal = rotateAboutAxis(normal, vAxis, ry)
  offsetDir = rotateAboutAxis(offsetDir, vAxis, ry)
  normal = rotateAboutAxis(normal, n0, rz)
  offsetDir = rotateAboutAxis(offsetDir, n0, rz)
  return { normal, offsetDir }
}

// Real backend representation of "which axes can this panel's drive
// mechanism actually move about" (HardwareItemSolarPanel.articulation,
// shipped backend-side docs/MP/GNC_MANUAL.md ss6.5) -- distinct
// from the CURRENT achieved orientation (compileSolarPanel's normal below).
// Derived deterministically from which of the two real hinge axes (Pitch/
// Roll) have ever been engaged for this panel: Yaw has no articulation
// counterpart (it's a fixed mounting choice, not a drive axis). This is a
// schema-only declaration today (not yet consumed by any solver), so the
// mapping only needs to be a reasonable, honest reflection of what the
// user has actually used -- not a separately-configured "capability" the
// UI doesn't have a control for yet.
export type PanelArticulation = { kind: "OneAxis"; axis: Vec3 } | { kind: "TwoAxis"; axis1: Vec3; axis2: Vec3 } | null

export function articulationFor(face: FaceDef, rotXDeg: number, rotYDeg: number): PanelArticulation {
  const { u: uAxis, v: vAxis } = faceTangents(face)
  if (rotYDeg !== 0) return { kind: "TwoAxis", axis1: uAxis, axis2: vAxis }
  if (rotXDeg !== 0) return { kind: "OneAxis", axis: uAxis }
  return null
}

// Compiles a placement (mount face + anchor + 3-axis rotation + real
// width/height) into the real `normal`/`position_m` a SolarPanel actually
// sends to the backend -- the one function both VehicleViewport's drag/
// rotation handlers and VehiclePaper's Table 3 fields call, so the
// rendered position and the persisted physical value are always computed
// the identical way. Always uses the edge-mounted convention (anchor = the
// component's real attachment edge, per panelOrientation above) -- not
// just when "hinged" -- since that's what makes "one end always stays on
// the bus" true unconditionally, for any rotation including (0, 0, 0).
export function compileSolarPanel(
  face: FaceDef,
  u: number,
  v: number,
  busDimsM: Vec3,
  heightM: number,
  rotXDeg: number,
  rotYDeg: number,
  rotZDeg: number,
): { normal: Vec3; positionM: Vec3; articulation: PanelArticulation } {
  const anchor = centerOffsetForPlacement(face, u, v, busDimsM)
  const { normal, offsetDir } = panelOrientation(face, rotXDeg, rotYDeg, rotZDeg)
  return {
    normal,
    positionM: add(anchor, scale(offsetDir, heightM / 2)),
    articulation: articulationFor(face, rotXDeg, rotYDeg),
  }
}

// Bootstrap-only inverse of compileSolarPanel, for a SolarPanel loaded with
// real position_m/normal but no vehicleUiStore placement record yet (e.g.
// from a preset TOML authored outside this UI). Only exact for the REST
// orientation (rotX=rotY=rotZ=0, offsetDir=vAxis) -- a real rotated preset
// panel will bootstrap into a slightly-off (u,v) and get treated as
// unrotated, correctable by a single drag/rotation edit afterward. Matches
// decomposePlacement's own "closest-normal-match" approximation, which
// already ignores true rotation for the same reason.
export function decomposeSolarPanel(normal: Vec3, positionM: Vec3, heightM: number): { faceIndex: number; u: number; v: number } {
  const { faceIndex } = decomposePlacement(normal, positionM)
  const face = FACES[faceIndex]
  const { v: vAxis } = faceTangents(face)
  const anchor: Vec3 = [
    positionM[0] - vAxis[0] * (heightM / 2),
    positionM[1] - vAxis[1] * (heightM / 2),
    positionM[2] - vAxis[2] * (heightM / 2),
  ]
  return decomposePlacement(normal, anchor)
}

// RCS thruster placement -- a point (position_m) + a free direction vector
// (direction), NOT a flat plate on a face. Simpler than a SolarPanel's
// mounting model: no width/height, no Pitch/Roll/Yaw-about-an-edge. The
// natural interaction is still palette -> click a face to snap the
// thruster's POSITION to that face's surface (reusing
// centerOffsetForPlacement/clampToFace above, same u/v-on-a-face idea), but
// the direction needs only two angles instead of three:
//   - Cant: how far the EXHAUST direction tips away from the face's own
//     outward normal, 0 (exhaust points straight out) to 90 (exhaust grazes
//     tangentially along the face). `direction` itself (the FORCE on the
//     spacecraft, per RcsThruster's own field doc comment) is always the
//     opposite of the exhaust, by Newton's third law.
//   - Clock: azimuthal spin of that tipped exhaust direction AROUND the
//     face's original (unrotated) normal, -180..180 -- has no effect at
//     Cant=0 (spinning "straight out" about itself does nothing), which is
//     expected and matches how a real gimbal ring works.
// Real bug found and fixed (: "the cone goes
// into the bus... cant be fixed with the 90 deg angle"): an earlier version
// of this function started `dir` at the face's OUTWARD normal and called
// that the FORCE direction -- meaning the exhaust (-direction) pointed
// INWARD, through the bus, at Cant=0, and Cant's [0,90] range can never
// reach the 180 deg flip that would fix it (by construction: Cant only
// tips AWAY from its own starting vector, it can't reverse it). `dir` now
// starts at the face's INWARD normal (physically, a thruster's force on
// the spacecraft is the reaction to its exhaust, which must exit AWAY from
// the bus) so exhaust is `faceNormal` at rest -- the only orientation a
// real, flush-mounted nozzle can physically have -- and Cant sweeps it
// through the outward hemisphere (0 = straight out, 90 = tangential graze),
// which by construction can never point the exhaust back into the bus for
// any angle in range. Verified numerically before shipping (not guessed):
// direction stays unit-length for every (cant, clock) pair; exhaust dotted
// with the face's own outward normal is >=0 (never inward) across the full
// Cant range; Cant=90 always lands exactly perpendicular to the face normal
// (fully in the tangent plane); Clock never changes the angle between
// exhaust and the face normal, only spins within it.
export const CANT_RANGE_DEG: [number, number] = [0, 90]
export const CLOCK_RANGE_DEG: [number, number] = [-180, 180]

// A thruster has no width/height of its own to size a drag-overhang margin
// from the way overhangMarginM does for a panel -- a small fixed margin
// keeps the anchor draggable slightly past a face's own edge, same idea,
// just not derived from a footprint that doesn't exist for a point. Shared
// constant (not redefined separately in VehicleViewport.tsx/VehiclePaper.tsx)
// so the viewport's drag clamp and Table 3's numeric-field clamp always
// agree exactly.
export const THRUSTER_OVERHANG_MARGIN_M = 0.1

export function clampThrusterAnglesDeg(cantDeg: number, clockDeg: number): { cantDeg: number; clockDeg: number } {
  const clamp = (v: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, v))
  return { cantDeg: clamp(cantDeg, CANT_RANGE_DEG), clockDeg: clamp(clockDeg, CLOCK_RANGE_DEG) }
}

export function thrusterDirection(face: FaceDef, cantDeg: number, clockDeg: number): Vec3 {
  const n0 = faceNormal(face)
  const nInward: Vec3 = [-n0[0], -n0[1], -n0[2]]
  const { u: uAxis } = faceTangents(face)
  const cant = (cantDeg * Math.PI) / 180
  const clock = (clockDeg * Math.PI) / 180
  let dir = nInward
  dir = rotateAboutAxis(dir, uAxis, cant)
  dir = rotateAboutAxis(dir, n0, clock)
  return dir
}

// Compiles a thruster placement (mount face + anchor + Cant/Clock) into the
// real `position_m`/`direction` a RcsThruster sends to the backend -- the
// one function both VehicleViewport's drag/rotation handlers and
// VehiclePaper's Table 3 fields call, mirroring compileSolarPanel's role
// for panels. position_m sits exactly on the face surface (no standoff
// offset needed -- a thruster is a point, not a plate with real thickness).
export function compileThruster(
  face: FaceDef,
  u: number,
  v: number,
  busDimsM: Vec3,
  cantDeg: number,
  clockDeg: number,
): { positionM: Vec3; direction: Vec3 } {
  return {
    positionM: centerOffsetForPlacement(face, u, v, busDimsM),
    direction: thrusterDirection(face, cantDeg, clockDeg),
  }
}

// Bootstrap-only inverse of compileThruster, for an RcsThruster loaded with
// real position_m/direction but no vehicleUiStore placement record yet
// (e.g. a preset TOML authored outside this UI). Recovers the mounting
// face from position_m the same "closest normal match" way
// decomposePlacement already does for a SolarPanel's normal (position_m
// for a thruster IS a point on the face plane, close enough to that face's
// own normal direction from the bus centre for a box-shaped bus). Cant/
// Clock are only approximately recovered -- exact for a direction that's a
// real (cant, clock) pair from this same compiler, off for a hand-authored
// direction that isn't (falls back to Cant=0/Clock=0, i.e. "points straight
// out", the safest default), same honesty tradeoff decomposeSolarPanel
// already accepts for rotation.
export function decomposeThruster(positionM: Vec3, direction: Vec3): { faceIndex: number; u: number; v: number; cantDeg: number; clockDeg: number } {
  // Match the face whose normal direction from the bus origin is closest to
  // position_m's own direction (same idea decomposePlacement uses, just
  // matching against a POSITION instead of an already-known normal).
  const posLen = norm(positionM)
  const posDir: Vec3 = posLen > 1e-9 ? scale(positionM, 1 / posLen) : [0, 0, 1]
  const { faceIndex, u, v } = decomposePlacement(posDir, positionM)
  const face = FACES[faceIndex]
  const n0 = faceNormal(face)
  const { u: uAxis } = faceTangents(face)
  const dLen = norm(direction)
  const dUnit: Vec3 = dLen > 1e-9 ? scale(direction, 1 / dLen) : [-n0[0], -n0[1], -n0[2]]
  // direction (force) is at the face's INWARD normal at Cant=0 (see
  // thrusterDirection's own header for why) -- so cant is recovered from
  // the angle to the INWARD normal, not the outward one.
  const cosCant = Math.max(-1, Math.min(1, -dot(dUnit, n0)))
  const cantDeg = (Math.acos(cosCant) * 180) / Math.PI
  // Clock: angle, about n0, between uAxis and the direction's own
  // in-tangent-plane component -- 0 at Cant=0 by convention (undefined
  // geometrically, harmless default).
  const tangentComp = add(dUnit, scale(n0, -dot(dUnit, n0)))
  const tLen = norm(tangentComp)
  let clockDeg = 0
  if (tLen > 1e-6) {
    const tUnit = scale(tangentComp, 1 / tLen)
    const cosClock = Math.max(-1, Math.min(1, dot(tUnit, uAxis)))
    const sinClock = dot(cross(n0, uAxis), tUnit)
    clockDeg = (Math.atan2(sinClock, cosClock) * 180) / Math.PI
  }
  return { faceIndex, u, v, cantDeg, clockDeg }
}

function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a))
}

// Static 3-axis torque-authority check for placed RCS thrusters -- "can
// this layout produce net torque about every body axis at all," the
// already-flagged-but-unbuilt "per-thruster r×F torque arrows + group
// residual check" TODO, reframed as a pass/fail summary rather than a
// per-thruster visualization. Purely geometric (which torque directions
// the CURRENT set of always-available thrusters can reach by combining
// them at various throttle levels), not a real allocation/controllability
// analysis of the closed-loop 6DOF sim -- the backend does not yet consume
// individually-placed RcsThruster entries at all
// -- so this can only ever be an honest geometric
// pre-check, never a real "will it hold pointing" answer. That fuller
// question is the separate, backend-blocked "attitude-stability preview"
// idea.
//
// Method: build tau_i = r_i x F_i for every thruster (r_i = its position
// relative to the real centre of mass, F_i = its real force vector), then
// look at A = sum(tau_i tau_i^T), a real 3x3 symmetric positive-semi-
// definite matrix. Its eigenvalues' square roots are exactly the singular
// values of the (3 x N) matrix whose columns are the tau_i -- rank(A) is
// therefore the number of independent torque directions the layout can
// reach in combination, and the condition number (largest/smallest
// singular value) says how EVENLY it can reach them (a layout can be rank
// 3 -- technically "full" -- while still being extremely weak about one
// axis relative to the other two). Closed-form eigenvalues via the
// standard symmetric-3x3 trigonometric solution (Smith 1961), not an
// iterative solver -- exact for this always-real-symmetric input, no
// convergence tolerance to tune. Verified numerically before shipping
// (.scratch/verify_torque_authority.cjs, not guessed): matches known
// closed-form eigenvalues for a diagonal and a tridiagonal test matrix,
// cross-checked against power iteration for a general (non-orthogonal-
// basis) matrix, correctly recovers rank 1 for a single outer product and
// rank 2 (not 3) when a third torque vector is a linear combination of the
// first two.
function symmetricEigenvalues3(a11: number, a12: number, a13: number, a22: number, a23: number, a33: number): [number, number, number] {
  const p1 = a12 * a12 + a13 * a13 + a23 * a23
  if (p1 === 0) {
    return [a11, a22, a33].sort((a, b) => b - a) as [number, number, number]
  }
  const q = (a11 + a22 + a33) / 3
  const p2 = (a11 - q) ** 2 + (a22 - q) ** 2 + (a33 - q) ** 2 + 2 * p1
  const p = Math.sqrt(p2 / 6)
  const b11 = (a11 - q) / p
  const b22 = (a22 - q) / p
  const b33 = (a33 - q) / p
  const b12 = a12 / p
  const b13 = a13 / p
  const b23 = a23 / p
  const detB = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13)
  const r = Math.max(-1, Math.min(1, detB / 2))
  const phi = Math.acos(r) / 3
  const eig1 = q + 2 * p * Math.cos(phi)
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
  const eig2 = 3 * q - eig1 - eig3
  return [eig1, eig2, eig3].sort((a, b) => b - a) as [number, number, number]
}

export interface ThrusterTorqueInput {
  positionM: Vec3
  direction: Vec3
  thrustN: number
}

export interface TorqueAuthorityResult {
  // Descending singular values [N·m] of the aggregated r x F matrix --
  // roughly "how much torque authority exists along each of the 3
  // principal achievable-torque directions," not aligned to the body's own
  // X/Y/Z axes.
  singularValuesNm: [number, number, number]
  rank: 0 | 1 | 2 | 3
  // largest/smallest singular value -- only defined at rank 3 (a lower
  // rank already means "cannot reach every direction," a stronger
  // statement than any condition number would add).
  conditionNumber: number | null
  fullyControllable: boolean
}

// A singular value below this fraction of the largest one is treated as
// numerically zero (i.e. that direction isn't really reachable) -- real
// zero-torque directions (e.g. two thrusters mounted on the same face
// pointing the same way) land many orders of magnitude below this after
// floating-point cross products, so a generous relative threshold still
// cleanly separates "genuinely degenerate" from "just a bit weak."
const RANK_EPS_REL = 1e-6

export function torqueAuthority(thrusters: ThrusterTorqueInput[], comM: Vec3): TorqueAuthorityResult {
  if (thrusters.length === 0) {
    return { singularValuesNm: [0, 0, 0], rank: 0, conditionNumber: null, fullyControllable: false }
  }
  let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0
  for (const t of thrusters) {
    const r: Vec3 = [t.positionM[0] - comM[0], t.positionM[1] - comM[1], t.positionM[2] - comM[2]]
    const F: Vec3 = [t.direction[0] * t.thrustN, t.direction[1] * t.thrustN, t.direction[2] * t.thrustN]
    const tau = cross(r, F)
    a11 += tau[0] * tau[0]
    a12 += tau[0] * tau[1]
    a13 += tau[0] * tau[2]
    a22 += tau[1] * tau[1]
    a23 += tau[1] * tau[2]
    a33 += tau[2] * tau[2]
  }
  const eig = symmetricEigenvalues3(a11, a12, a13, a22, a23, a33)
  const s: [number, number, number] = [Math.sqrt(Math.max(0, eig[0])), Math.sqrt(Math.max(0, eig[1])), Math.sqrt(Math.max(0, eig[2]))]
  const s1 = s[0]
  const rank = (s1 <= 0 ? 0 : s.filter((v) => v > s1 * RANK_EPS_REL).length) as 0 | 1 | 2 | 3
  const conditionNumber = rank === 3 ? s[0] / s[2] : null
  return { singularValuesNm: s, rank, conditionNumber, fullyControllable: rank === 3 }
}

// Boresight-cone hardware family placement (star tracker / OpNav camera /
// lidar / HGA antenna) -- the backend schema work, shipped. Shares the
// thruster's "point + direction, no width/height" mounting model, but the
// two angles mean something different: this is a SENSOR/ANTENNA pointing
// direction, not a thrust vector, so there's no meaningful "lying flat in
// the tangent plane" case to allow the way a thruster's Cant=90 does --
// instead:
//   - Tilt: how far the boresight tips away from the face's own outward
//     normal, 0 (straight out) to 90 (grazing along the face) -- same
//     rotation math as Cant, renamed since "Cant" reads as thruster-specific
//     jargon on a sensor.
//   - Spin: azimuthal rotation of that tipped direction about the face's
//     original normal, -180..180 -- identical role to a thruster's Clock.
export const TILT_RANGE_DEG: [number, number] = [0, 90]
export const SPIN_RANGE_DEG: [number, number] = [-180, 180]

export function clampBoresightAnglesDeg(tiltDeg: number, spinDeg: number): { tiltDeg: number; spinDeg: number } {
  const clamp = (v: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, v))
  return { tiltDeg: clamp(tiltDeg, TILT_RANGE_DEG), spinDeg: clamp(spinDeg, SPIN_RANGE_DEG) }
}

export function boresightDirection(face: FaceDef, tiltDeg: number, spinDeg: number): Vec3 {
  const n0 = faceNormal(face)
  const { u: uAxis } = faceTangents(face)
  const tiltRad = (tiltDeg * Math.PI) / 180
  const spinRad = (spinDeg * Math.PI) / 180
  const tilted = rotateAboutAxis(n0, uAxis, tiltRad)
  return rotateAboutAxis(tilted, n0, spinRad)
}

// A sensor/antenna sits just off the face surface (unlike a thruster, which
// mounts flush) so its cone overlay never z-fights with the bus mesh.
export const BORESIGHT_STANDOFF_M = 0.02

// Compiles a boresight placement (mount face + anchor + Tilt/Spin) into the
// real `position_m`/`boresight` fields a StarTracker/OpNavCamera/Lidar/
// CommAntenna sends to the backend -- mirrors compileThruster's role.
export function compileBoresightItem(
  face: FaceDef,
  u: number,
  v: number,
  busDimsM: Vec3,
  tiltDeg: number,
  spinDeg: number,
): { boresight: Vec3; positionM: Vec3 } {
  const n = faceNormal(face)
  const anchor = centerOffsetForPlacement(face, u, v, busDimsM)
  return {
    boresight: boresightDirection(face, tiltDeg, spinDeg),
    positionM: add(anchor, scale(n, BORESIGHT_STANDOFF_M)),
  }
}

// Bootstrap-only inverse of compileBoresightItem, for hardware loaded with a
// real position_m but no vehicleBoresightUiStore placement record yet (e.g.
// a preset TOML authored outside this UI). Only recovers the mounting face
// from position_m (same closest-normal-match idea decomposeThruster uses) --
// Tilt/Spin aren't recovered from `boresight` here since the caller only
// ever needs the face/u/v to seed a placement record, matching how this is
// actually called.
export function decomposeBoresightItem(positionM: Vec3, busDimsM: Vec3): { faceIndex: number; u: number; v: number } {
  let bestIdx = 0
  let bestRatio = -Infinity
  FACES.forEach((f, i) => {
    const n = faceNormal(f)
    const { halfN } = faceHalfExtents(f, busDimsM)
    const proj = dot(positionM, n)
    const ratio = halfN > 0 ? proj / halfN : proj
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestIdx = i
    }
  })
  const face = FACES[bestIdx]
  const n = faceNormal(face)
  const { u: uAxis, v: vAxis } = faceTangents(face)
  const anchor = add(positionM, scale(n, -BORESIGHT_STANDOFF_M))
  return { faceIndex: bestIdx, u: dot(anchor, uAxis), v: dot(anchor, vAxis) }
}
