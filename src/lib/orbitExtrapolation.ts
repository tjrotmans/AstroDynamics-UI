// Cheap circular-orbit position extrapolation, for the live MGA search
// animation only - same sanctioned-exception status as lib/lambert.ts (see
// its header): pixels only, never a number the user reads or a value sent
// back to the backend. Matches the fidelity choice the backend's own
// `plot_mga_animation.py` already makes for its planet background: "each
// planet is propagated forward using a circular orbit approximation:
// theta(t) = theta_0 + omega*t, omega = sqrt(mu_sun/a^3)".
//
// Why this exists: the first cut of the animation called
// `/api/bodies/{name}/state` once per body per redraw (~every 1.5s), each
// call reloading full ANISE kernels server-side with no caching - under
// sustained polling plus the resonance-family branch search running
// concurrently, this crashed the backend (`memory allocation ... failed`,
// verified from the server's own crash log, not a guess). Fetching each
// body's real state ONCE per run and extrapolating every other epoch from
// it analytically eliminates that load almost entirely: N unique bodies →
// N real network calls total, not N calls every frame.
import { MU_SUN_M3S2, type Vec3 } from "./lambert"

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a))
}

/**
 * Propagate a real (r0, v0) state forward by dtS seconds using a circular
 * approximation: keep the real orbital plane (from the angular-momentum
 * direction) and radius, rotate by the mean circular angular rate at that
 * radius (vis-viva semi-major axis). Eccentricity/inclination-rate effects
 * are ignored on purpose - this is a decorative background, not a
 * propagator; see file header.
 */
export function propagateCircular(r0: Vec3, v0: Vec3, dtS: number, mu: number = MU_SUN_M3S2): Vec3 {
  const r0n = norm(r0)
  if (r0n === 0) return r0
  const v0n = norm(v0)
  const h = cross(r0, v0)
  const hn = norm(h)
  if (hn < 1e-6) return r0 // degenerate (radial) state -- nothing sensible to rotate

  // Vis-viva semi-major axis; fall back to r0n (treat as already circular)
  // if the energy equation is degenerate.
  const invA = 2 / r0n - (v0n * v0n) / mu
  const a = invA > 1e-20 ? 1 / invA : r0n
  const omega = Math.sqrt(mu / Math.pow(Math.max(a, 1), 3))
  const theta = omega * dtS

  // Rodrigues' rotation formula: rotate r0 about the unit axis k = h/|h|.
  const k: Vec3 = [h[0] / hn, h[1] / hn, h[2] / hn]
  const cosT = Math.cos(theta)
  const sinT = Math.sin(theta)
  const kCrossR = cross(k, r0)
  const kDotR = dot(k, r0)
  return [
    r0[0] * cosT + kCrossR[0] * sinT + k[0] * kDotR * (1 - cosT),
    r0[1] * cosT + kCrossR[1] * sinT + k[1] * kDotR * (1 - cosT),
    r0[2] * cosT + kCrossR[2] * sinT + k[2] * kDotR * (1 - cosT),
  ]
}
