// Display-only Lambert solver + Kepler arc sampler.
//
// SANCTIONED EXCEPTION to the "no trajectory math in TypeScript" rule
//), user-approved the live MGA search animation needs
// curved candidate arcs, no backend endpoint returns a standalone Lambert
// arc, and waiting on one would block the feature again. Hard scope limit:
// nothing computed here may ever feed a number the user reads (ΔV, TOF,
// anything) or any request to the backend - pixels only. The real physics
// stays in Rust.
//
// The user flagged discomfort with this living in the frontend at all
// - noted, not dismissed: if this ever needs to do more than
// decorate one animation (heavier per-frame cost, more callers, correctness
// starting to matter beyond "looks like an orbit"), move it to a real
// backend endpoint instead of growing this file. Don't let scope creep
// happen here without revisiting that call.
//
// Method: classic universal-variables formulation (Curtis, "Orbital
// Mechanics for Engineering Students", Algorithms 5.2 and 3.4), z-iteration
// by bracketing + bisection for robustness over speed - this runs a handful
// of times per animation frame (one per leg every ~1.5 s), so bulletproof
// beats fast.

// IAU 2015 nominal solar GM, hardcoded-with-citation since the Sun isn't in
// the /api/bodies catalog.
export const MU_SUN_M3S2 = 1.32712440018e20

export type Vec3 = [number, number, number]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: Vec3) => Math.sqrt(dot(a, a))
const crossZ = (a: Vec3, b: Vec3) => a[0] * b[1] - a[1] * b[0]

// Stumpff functions
function stumpffC(z: number): number {
  if (z > 1e-8) return (1 - Math.cos(Math.sqrt(z))) / z
  if (z < -1e-8) return (Math.cosh(Math.sqrt(-z)) - 1) / -z
  return 1 / 2
}
function stumpffS(z: number): number {
  if (z > 1e-8) {
    const s = Math.sqrt(z)
    return (s - Math.sin(s)) / (s * s * s)
  }
  if (z < -1e-8) {
    const s = Math.sqrt(-z)
    return (Math.sinh(s) - s) / (s * s * s)
  }
  return 1 / 6
}

/**
 * Solve the prograde Lambert problem r1 -> r2 in tofS seconds. Returns the
 * departure velocity v1 [m/s], or null when the iteration fails (caller
 * falls back to a straight line -- acceptable for a decorative arc).
 */
export function lambertV1(r1: Vec3, r2: Vec3, tofS: number, mu: number = MU_SUN_M3S2): Vec3 | null {
  if (tofS <= 0) return null
  const r1n = norm(r1)
  const r2n = norm(r2)
  if (r1n === 0 || r2n === 0) return null

  const cosDt = Math.max(-1, Math.min(1, dot(r1, r2) / (r1n * r2n)))
  let dtheta = Math.acos(cosDt)
  // Prograde transfer: all our bodies orbit counterclockwise seen from +Z
  // (ecliptic north), so take the long way around when the short way would
  // be retrograde.
  if (crossZ(r1, r2) < 0) dtheta = 2 * Math.PI - dtheta

  const A = Math.sin(dtheta) * Math.sqrt((r1n * r2n) / (1 - Math.cos(dtheta)))
  if (!Number.isFinite(A) || Math.abs(A) < 1e-6) return null

  const yOf = (z: number) => r1n + r2n + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z))
  const fOf = (z: number): number => {
    const y = yOf(z)
    if (y < 0) return NaN
    const C = stumpffC(z)
    return Math.pow(y / C, 1.5) * stumpffS(z) + A * Math.sqrt(y) - Math.sqrt(mu) * tofS
  }

  // Bracket a sign change of F over z ∈ [-4π², 4π²], then bisect.
  const zMin = -4 * Math.PI * Math.PI
  const zMax = 4 * Math.PI * Math.PI
  const N_SCAN = 200
  let zLo = NaN
  let zHi = NaN
  let fLo = NaN
  for (let i = 0; i <= N_SCAN; i++) {
    const z = zMin + ((zMax - zMin) * i) / N_SCAN
    const f = fOf(z)
    if (!Number.isFinite(f)) continue
    if (Number.isFinite(fLo) && Math.sign(f) !== Math.sign(fLo)) {
      zHi = z
      break
    }
    zLo = z
    fLo = f
  }
  if (!Number.isFinite(zHi)) return null

  for (let i = 0; i < 80; i++) {
    const zMid = (zLo + zHi) / 2
    const fMid = fOf(zMid)
    if (!Number.isFinite(fMid)) return null
    if (Math.sign(fMid) === Math.sign(fLo)) {
      zLo = zMid
      fLo = fMid
    } else {
      zHi = zMid
    }
  }
  const z = (zLo + zHi) / 2
  const y = yOf(z)
  if (!Number.isFinite(y) || y < 0) return null

  const f = 1 - y / r1n
  const g = A * Math.sqrt(y / mu)
  if (Math.abs(g) < 1e-9) return null
  return [(r2[0] - f * r1[0]) / g, (r2[1] - f * r1[1]) / g, (r2[2] - f * r1[2]) / g]
}

/**
 * Sample the Kepler arc from (r0, v0) over tofS seconds (universal-variable
 * propagation, Curtis Alg. 3.4). Returns nSamples+1 positions including both
 * endpoints; null on iteration failure.
 */
export function sampleKeplerArc(
  r0: Vec3,
  v0: Vec3,
  tofS: number,
  nSamples: number,
  mu: number = MU_SUN_M3S2,
): Vec3[] | null {
  const r0n = norm(r0)
  const v0n = norm(v0)
  if (r0n === 0) return null
  const vr0 = dot(r0, v0) / r0n
  const alpha = 2 / r0n - (v0n * v0n) / mu
  const sqrtMu = Math.sqrt(mu)

  const points: Vec3[] = [r0]
  for (let i = 1; i <= nSamples; i++) {
    const t = (tofS * i) / nSamples
    // Newton for the universal anomaly chi
    let chi = Math.abs(alpha) > 1e-12 ? sqrtMu * Math.abs(alpha) * t : (sqrtMu * t) / r0n
    let converged = false
    for (let iter = 0; iter < 60; iter++) {
      const z = alpha * chi * chi
      const C = stumpffC(z)
      const S = stumpffS(z)
      const F = ((r0n * vr0) / sqrtMu) * chi * chi * C + (1 - alpha * r0n) * chi * chi * chi * S + r0n * chi - sqrtMu * t
      const dF = ((r0n * vr0) / sqrtMu) * chi * (1 - alpha * chi * chi * S) + (1 - alpha * r0n) * chi * chi * C + r0n
      if (Math.abs(dF) < 1e-12) break
      const step = F / dF
      chi -= step
      if (Math.abs(step) < 1e-8 * Math.max(1, Math.abs(chi))) {
        converged = true
        break
      }
    }
    if (!converged || !Number.isFinite(chi)) return null
    const z = alpha * chi * chi
    const fF = 1 - ((chi * chi) / r0n) * stumpffC(z)
    const gF = t - (chi * chi * chi * stumpffS(z)) / sqrtMu
    points.push([fF * r0[0] + gF * v0[0], fF * r0[1] + gF * v0[1], fF * r0[2] + gF * v0[2]])
  }
  return points
}

/**
 * Convenience for the animation: the sampled prograde Lambert arc from r1 to
 * r2 in tofS seconds, or null (caller draws a straight line instead).
 */
export function lambertArcPoints(r1: Vec3, r2: Vec3, tofS: number, nSamples = 32): Vec3[] | null {
  const v1 = lambertV1(r1, r2, tofS)
  if (!v1) return null
  const arc = sampleKeplerArc(r1, v1, tofS, nSamples)
  if (!arc) return null
  // Endpoint sanity: if the propagated end misses r2 wildly (solver landed
  // on a wrong branch), the arc would visibly disconnect -- reject it.
  const err = norm([arc[arc.length - 1][0] - r2[0], arc[arc.length - 1][1] - r2[1], arc[arc.length - 1][2] - r2[2]])
  if (err > 0.05 * Math.max(norm(r1), norm(r2))) return null
  return arc
}
