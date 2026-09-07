import * as THREE from "three"

import type { CruiseStepMsg } from "@/api/client"

// Display-only interpolation between REPORTED ticks (
// steps are a bit too large to be meaningful for attitude control").
// CruiseStepMsg is the control-tick stream decimated by cruise_seed.
// report_stride to a ~20k-point budget -- for a months-long mission that is
// one sample every several minutes, while the control loop itself ran
// every tick_s. Between two reported samples the vehicle's real attitude is
// unknown to the frontend; spherical-linear interpolation (slerp) of q and
// q_cmd, and linear interpolation of position, gives a smooth playback
// instead of jumps. It is presentation, not physics -- the attitude view
// says so, with the real sample spacing -- and it cannot recover a slew
// that happened entirely between two samples: the proper fix is the
// backend's phase-adaptive reporting ask (dense during Slewing/Burning/
// transitions, coarse in coast). Every scalar/telemetry field is taken
// from the nearest reported sample unchanged.
export function interpolateTick(steps: CruiseStepMsg[], tS: number): CruiseStepMsg | null {
  if (steps.length === 0) return null
  let lo = 0
  let hi = steps.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (steps[mid].t_s < tS) lo = mid + 1
    else hi = mid
  }
  const next = steps[lo]
  if (lo === 0 || next.t_s <= tS) return next
  const prev = steps[lo - 1]
  const span = next.t_s - prev.t_s
  if (span <= 0) return next
  const f = Math.min(1, Math.max(0, (tS - prev.t_s) / span))
  const nearest = f < 0.5 ? prev : next

  const slerp = (a: number[], b: number[]): number[] => {
    const qa = new THREE.Quaternion(a[1], a[2], a[3], a[0]).normalize()
    const qb = new THREE.Quaternion(b[1], b[2], b[3], b[0]).normalize()
    qa.slerp(qb, f)
    return [qa.w, qa.x, qa.y, qa.z]
  }
  const lerp3 = (a: number[], b: number[]): number[] => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * f)

  return {
    ...nearest,
    t_s: tS,
    q: slerp(prev.q, next.q),
    q_cmd: slerp(prev.q_cmd, next.q_cmd),
    r_m: lerp3(prev.r_m, next.r_m),
    pointing_error_deg: prev.pointing_error_deg + (next.pointing_error_deg - prev.pointing_error_deg) * f,
    // Rate must move with the slerped attitude, not jump at the midpoint
    // with the nearest sample -- otherwise the rate arrow flips direction
    // mid-gap while the vehicle turns smoothly.
    ...(prev.omega_radps && next.omega_radps && prev.omega_radps.length === 3 && next.omega_radps.length === 3
      ? { omega_radps: lerp3(prev.omega_radps, next.omega_radps) }
      : {}),
  }
}

/** Real spacing [s] between the reported samples bracketing tS -- for the honesty label. */
export function reportedSpacingAt(steps: CruiseStepMsg[], tS: number): number | null {
  if (steps.length < 2) return null
  let lo = 0
  let hi = steps.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (steps[mid].t_s < tS) lo = mid + 1
    else hi = mid
  }
  const i = Math.max(1, lo)
  return steps[i].t_s - steps[i - 1].t_s
}
