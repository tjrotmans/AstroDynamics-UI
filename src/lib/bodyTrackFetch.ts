import { getBodyState, type BodyTrackConfig } from "@/api/client"
import { jdToEpochString } from "@/lib/utils"

// design review finding B: `cruise.rs::reference_guidance.rs`
// interpolates LINEARLY between body-track samples -- the old fixed
// sampleCount=8 default meant ~20-28 days between samples for a Mercury
// Orbiter-length mission, against Mercury's own 88-day period, putting the
// interpolated body tens of millions of km from its real position for most
// of the mission (wrong third-body gravity, wrong SOI-capture trigger,
// wrong TargetPointing direction, wrong rendered planet position). At least
// 1 sample/day, floored at 16 (short missions still get a few real ANISE
// queries, not the previous fixed 8), capped at 1,000 (~1,000 HTTP calls
// against the local server for the longest realistic mission is fine; the
// caller batches them with Promise.all).
export function sampleCountForDuration(durationS: number): number {
  const perDay = Math.ceil(durationS / 86_400)
  return Math.min(1_000, Math.max(16, perDay))
}

// A GncModeConfig rule that targets a Body needs a real position TRACK (not
// just one state) for cruise.rs to interpolate a pointing direction across
// the whole leg -- see BodyTrackConfig's doc comment ("Only r_m is
// consulted; v_mps is accepted but ignored"). This fetches a modest number
// of real ANISE-queried samples spread across the leg (not one per tick --
// same "fetch sparse real samples, not per-frame" discipline already used
// elsewhere in this app, e.g. LiveCandidateReplay.tsx/orbitExtrapolation.ts),
// real state at each, no client-side propagation/approximation of the
// body's own position.
//
// depJd is the departure epoch's Julian date corresponding to t_s = 0 in
// the cruise reference. NOTE: for an adopted trajectory this is taken from
// missionStore's trajectory.departure_epoch, not a per-result dep_jd
// (SelectedTrajectory doesn't carry one) -- a small epoch offset here is
// tolerated since this only feeds a pointing-direction computation over a
// multi-day window, not a precision ephemeris lookup.
// soiCapture: registers this
// track as a real SOI-switching central-body candidate in the cruise
// loop's PROPAGATED TRUTH, not just a pointing/perturbation source --
// without it, the truth state stays under Sun-only central gravity even
// through a real close approach, which is the confirmed root cause of a
// genuine captured orbit (e.g. around Mercury) reading as a flyby in the
// mission-validation replay (a known limitation,
// now fixed). Only pass
// true for the mission's actual capture target when the objective expects
// a real capture (Orbit/Landing) -- check_config rejects soi_capture: true
// on a track whose body resolves no mu_m3s2, so this must stay false for
// tracks that only exist for pointing (e.g. a flyby body with no capture).
export async function fetchBodyTrack(
  name: string,
  depJd: number,
  durationS: number,
  sampleCount = 8,
  soiCapture = false,
): Promise<BodyTrackConfig | null> {
  const samples = Math.max(2, sampleCount)
  const tSteps = Array.from({ length: samples }, (_, i) => (durationS * i) / (samples - 1))

  const states = await Promise.all(
    tSteps.map((tS) =>
      getBodyState(name, jdToEpochString(depJd + tS / 86_400))
        .then((s) => ({ tS, s }))
        .catch(() => null),
    ),
  )

  const track = states
    .filter((entry): entry is { tS: number; s: Awaited<ReturnType<typeof getBodyState>> } => entry !== null)
    .map(({ tS, s }) => ({ t_s: tS, r_m: [s.x_m, s.y_m, s.z_m], v_mps: [s.vx_mps, s.vy_mps, s.vz_mps] }))

  if (track.length < 2) return null
  return { name, track, soi_capture: soiCapture }
}

type TrackPoint = NonNullable<BodyTrackConfig["track"]>[number]

// Cubic-Hermite position interpolation on a fetched track (r and v are both
// real ANISE samples). Linear interpolation at ~1 sample/day spacing has a
// chord error of ~5,500 km for Earth -- comparable to a parking orbit's own
// size -- so the held boundary state below needs the better estimate.
export function trackPositionAt(track: BodyTrackConfig, tS: number): [number, number, number] {
  // `track` is optional on the wire since B2 (server-resolved tracks);
  // every track this app renders/holds is client-fetched and populated.
  const pts = track.track ?? []
  if (pts.length === 0) return [0, 0, 0]
  const r = (p: TrackPoint): [number, number, number] => [p.r_m[0], p.r_m[1], p.r_m[2]]
  if (tS <= pts[0].t_s) return r(pts[0])
  if (tS >= pts[pts.length - 1].t_s) return r(pts[pts.length - 1])
  let hi = 1
  while (pts[hi].t_s < tS) hi++
  const a = pts[hi - 1]
  const b = pts[hi]
  const h = b.t_s - a.t_s
  const s = (tS - a.t_s) / h
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  const va = a.v_mps ?? [0, 0, 0]
  const vb = b.v_mps ?? [0, 0, 0]
  return [0, 1, 2].map((i) => h00 * a.r_m[i] + h10 * h * va[i] + h01 * b.r_m[i] + h11 * h * vb[i]) as [
    number,
    number,
    number,
  ]
}

// "Artificially keep Earth in the same place until the mission actually
// leaves it" -- the Phase-01 convention for the
// frozen-origin orbit arcs (see lib/cruiseSeed.ts's FROZEN-ORIGIN NOTE):
// the served parking orbit is a closed loop around the body's state at the
// INJECTION epoch, and the served capture orbit around the CAPTURE epoch.
// Rather than synthesizing a moving-origin trajectory (rejected -- "not
// coming from our data"), the body's own track is HELD at that frozen
// epoch's position while the orbit piece is active: before `holdBeforeS`
// (departure body, parking phase) and/or after `holdAfterS` (target body,
// captured phase). Positions are real ephemeris states, just held constant
// -- and the hold ends exactly at the epoch whose state it holds, so the
// track is continuous. Used for BOTH the rendered viewport tracks and the
// cruise_seed body_tracks, so the display and the sim's gravity/pointing
// agree with the frozen orbit geometry by construction. v_mps is zeroed on
// held samples (a held position has no velocity; the backend consults r_m
// only, per fetchBodyTrack's own header).
export function holdBodyTrack(
  track: BodyTrackConfig,
  opts: { holdBeforeS?: number | null; holdAfterS?: number | null },
): BodyTrackConfig {
  const { holdBeforeS, holdAfterS } = opts
  let pts: TrackPoint[] = track.track ?? []
  if (pts.length === 0) return track
  if (holdBeforeS != null && holdBeforeS > pts[0].t_s) {
    const held = trackPositionAt(track, holdBeforeS)
    pts = [
      ...pts.filter((p) => p.t_s < holdBeforeS).map((p) => ({ ...p, r_m: [...held], v_mps: [0, 0, 0] })),
      { t_s: holdBeforeS, r_m: [...held], v_mps: [0, 0, 0] },
      ...pts.filter((p) => p.t_s > holdBeforeS),
    ]
  }
  if (holdAfterS != null && holdAfterS < pts[pts.length - 1].t_s) {
    const held = trackPositionAt({ ...track, track: pts }, holdAfterS)
    pts = [
      ...pts.filter((p) => p.t_s < holdAfterS),
      { t_s: holdAfterS, r_m: [...held], v_mps: [0, 0, 0] },
      ...pts.filter((p) => p.t_s > holdAfterS).map((p) => ({ ...p, r_m: [...held], v_mps: [0, 0, 0] })),
    ]
  }
  return { ...track, track: pts }
}
