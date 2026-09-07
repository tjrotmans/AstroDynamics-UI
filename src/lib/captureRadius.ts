import type { BodyInfo, MissionConfig } from "@/api/client"

// Real bug (found, live-testing the new MGA sequence-search
// button against the Voyager 2 preset -> Neptune): the old flat 500 km
// floor sits inside Jupiter/Saturn/Uranus/Neptune's real radius, which
// trips the backend's own config validation
// ("target_orbit_radius_m is smaller than target_body.radius_m") the
// moment a real capture-radius value is set, regardless of
// mission.objective (the check in config.rs runs whenever
// trajectory.capture is present at all, not just for capturing
// objectives).
export const CAPTURE_RADIUS_FALLBACK_MIN_M = 500_000
export const CAPTURE_RADIUS_SAFETY_MARGIN_M = 100_000

// The config's own override wins (custom-body definitions carry a real
// radius_m); otherwise look the target body up in the real catalog. `null`
// if neither is available yet (body list still loading, or an
// unrecognized name) -- callers fall back to the flat floor in that case.
export function realTargetBodyRadiusM(
  targetBody: MissionConfig["target_body"],
  bodies: BodyInfo[] | undefined,
): number | null {
  const catalogRadiusM = bodies?.find((b) => b.name === targetBody.name)?.radius_m
  return targetBody.radius_m ?? catalogRadiusM ?? null
}

export function captureRadiusFloorM(
  targetBody: MissionConfig["target_body"],
  bodies: BodyInfo[] | undefined,
): number {
  const realRadiusM = realTargetBodyRadiusM(targetBody, bodies)
  return realRadiusM != null
    ? Math.max(CAPTURE_RADIUS_FALLBACK_MIN_M, realRadiusM + CAPTURE_RADIUS_SAFETY_MARGIN_M)
    : CAPTURE_RADIUS_FALLBACK_MIN_M
}
