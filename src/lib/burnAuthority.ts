import type { HardwareItem } from "@/api/client"
import type { components } from "@/api/types"

type PropulsionConfig = components["schemas"]["PropulsionConfig"]

// design review finding E-iv / task E5, frontend half (
// prompted by a live report: "the s/c is tumbling during thrusting"). A
// STATIC feasibility check: can the placed RCS layout hold attitude against
// the main engine's disturbance torque during a burn?
//
// Every quantity mirrors what the backend actually computes -- verified
// against the source, not the doc comments:
// - engine disturbance torque: cruise.rs::main_engine_thrust_offset_body_m
//   = mount(-bus_x/2, 0, 0) - com_m, crossed with the +X thrust force
// (BurnConfig::body_dir = +X; the backend wires it into every Burning tick).
// - per-thruster torque: attitude_control::rcs::Thruster::torque() =
//   pos × (dir · thrust_n), with pos used AS PLACED (geometric-center-
// relative; the CoM re-centering is an open backend item).
// - what actually fires for a commanded torque: rcs::thruster_selection
//   fires EVERY thruster whose own torque has a positive dot with the
//   command, at one common duty cycle = |τ_cmd| / |Σ τ_fired| clamped to
//   [0, 1] (sim_engine::control::allocate, ThrustersPrimary).
// So the realizable torque along a unit axis â is (Σ_{τ_i·â>0} τ_i)·â, the
// fired set's net torque can point AWAY from â (cross-coupling -- the
// "cube-corner" direction error the backend's own comments name), and the
// duty-cycle clamp means any disturbance beyond that full-duty authority
// is simply not countered.
//
// This is analysis of the config only -- it does not claim to reproduce the
// closed-loop run. It answers "is this layout physically able to hold
// attitude through this burn," which the backend's static-check half of E5
// will eventually report authoritatively.

type Vec3 = [number, number, number]

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

export interface AxisAuthority {
  axis: string
  /** Realizable torque along this axis with every helpful thruster at full duty [N·m]. */
  authorityNm: number
  /** |perpendicular component| / |along-axis component| of the fired set's net torque -- 0 = clean, ≥1 = the fired set torques mostly off-axis. */
  crossCoupling: number
}

export interface BurnAuthorityReport {
  placedThrusterCount: number
  /** Engine thrust arm (mount − CoM) [m], body frame. */
  thrustOffsetM: Vec3
  /** Disturbance torque the burn applies [N·m], body frame, and its magnitude. */
  disturbanceNm: Vec3
  disturbanceMagNm: number
  /** Realizable RCS torque along the disturbance's own direction (i.e. what's available to cancel it) [N·m]. */
  counterAuthorityNm: number
  /** counterAuthorityNm / disturbanceMagNm; < 1 = the layout cannot hold attitude through the burn. Infinity when the disturbance is ~0. */
  margin: number
  /** Per ±axis authority. */
  axes: AxisAuthority[]
  /** Rank of the span of thruster torques (3 = full 3-axis control possible). */
  torqueRank: number
  /** Axes with no authority at all (uncontrollable direction). */
  deadAxes: string[]
}

function realizable(taus: Vec3[], a: Vec3): { along: number; cross: number } {
  const fired = taus.filter((t) => dot(t, a) > 0)
  const net = fired.reduce((acc, t) => add(acc, t), [0, 0, 0] as Vec3)
  const along = dot(net, a)
  const perp = norm(sub(net, scale(a, along)))
  return { along, cross: along > 1e-12 ? perp / along : perp > 1e-12 ? Infinity : 0 }
}

function rank3(vs: Vec3[]): number {
  // Gram-Schmidt on the torque vectors -- count how many independent
  // directions the layout can torque about.
  const basis: Vec3[] = []
  for (const v of vs) {
    let r: Vec3 = [...v] as Vec3
    for (const b of basis) r = sub(r, scale(b, dot(r, b)))
    const n = norm(r)
    if (n > 1e-9 * Math.max(1, norm(v))) basis.push(scale(r, 1 / n))
    if (basis.length === 3) break
  }
  return basis.length
}

export function analyzeBurnAuthority(params: {
  hardware: HardwareItem[]
  busDimsM: number[]
  comM: number[]
  propulsion: PropulsionConfig | null | undefined
}): BurnAuthorityReport | null {
  const { hardware, busDimsM, comM, propulsion } = params
  const thrustN = propulsion?.thrust_n ?? 0
  const mount: Vec3 = [-busDimsM[0] / 2, 0, 0]
  const com: Vec3 = [comM[0] ?? 0, comM[1] ?? 0, comM[2] ?? 0]
  const thrustOffsetM = sub(mount, com)
  const engineForce: Vec3 = [thrustN, 0, 0]
  const disturbanceNm = cross(thrustOffsetM, engineForce)
  const disturbanceMagNm = norm(disturbanceNm)

  const taus: Vec3[] = []
  for (const h of hardware) {
    if (h.type !== "RcsThruster") continue
    const d = h.direction as Vec3
    const dn = norm(d)
    if (dn < 1e-12) continue
    const force = scale(d, h.thrust_n / dn)
    taus.push(cross(h.position_m as Vec3, force))
  }
  if (taus.length === 0) return null

  const axesDef: [string, Vec3][] = [
    ["+X", [1, 0, 0]],
    ["-X", [-1, 0, 0]],
    ["+Y", [0, 1, 0]],
    ["-Y", [0, -1, 0]],
    ["+Z", [0, 0, 1]],
    ["-Z", [0, 0, -1]],
  ]
  const axes: AxisAuthority[] = axesDef.map(([axis, a]) => {
    const r = realizable(taus, a)
    return { axis, authorityNm: r.along, crossCoupling: r.cross }
  })
  const deadAxes = axes.filter((a) => a.authorityNm < 1e-9).map((a) => a.axis)

  let counterAuthorityNm = 0
  let margin = Infinity
  if (disturbanceMagNm > 1e-9) {
    const counterDir = scale(disturbanceNm, -1 / disturbanceMagNm)
    counterAuthorityNm = realizable(taus, counterDir).along
    margin = counterAuthorityNm / disturbanceMagNm
  }

  return {
    placedThrusterCount: taus.length,
    thrustOffsetM,
    disturbanceNm,
    disturbanceMagNm,
    counterAuthorityNm,
    margin,
    axes,
    torqueRank: rank3(taus),
    deadAxes,
  }
}
