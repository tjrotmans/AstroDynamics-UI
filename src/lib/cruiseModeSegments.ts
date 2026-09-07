import type { CruiseStepMsg } from "@/api/client"

// Shared between CruiseTimeline.tsx (the mode-color bands) and
// CruiseFigures.tsx ("highlight the modes in those plots" too)
// -- kept in a non-component module so both can import it without tripping
// react-refresh's only-export-components rule, same convention as
// src/lib/srpModels.ts.
export const POINTING_ERROR_THRESHOLD_DEG = 0.5

// Real bug found (
// pointing error is too much alike now") -- this palette used to include
// an orange (#c98a3a) and a red (#c95a5a), both close enough to the
// pointing-error-overlay's amber and the wheel-saturated overlay's red
// (both below) to be genuinely hard to tell apart once overlaid on the
// same bar. Amber/orange/red are now reserved entirely for the warning
// overlays and the maneuver-mode family below -- ordinary user-authored
// modes get blue/green/purple/cyan/pink instead, none of which compete.
const MODE_PALETTE = ["#5b7fd6", "#3aa66b", "#a566c9", "#3ab8c9", "#d669a6"]

// Real design decision ("Maneuver Mode" session): cruise.rs's
// TCM executive already reports active_mode as literally "Slewing"/
// "Burning" while a correction burn is in progress (cruise.rs's
// `TcmPhase::label()`) -- confirmed by reading the source, not guessed.
// These two ARE the user's "Maneuver Mode" concept in every way that
// matters (thrust-axis correction, then fire), just not under that name.
// Given a fixed, always-the-same maneuver color (not the cycling
// MODE_PALETTE, whose index depends on which OTHER mode names happen to
// exist in a given run) so a maneuver reads as visually distinct from
// whatever user-authored modes are also present, consistently across runs.
//
// `RcsCorrecting` added (backend item #4, same day): a real
// bug found live-testing -- the backend's TCM executive grew a third
// phase (an RCS-only correction that doesn't slew) but this file was never
// updated, so it fell through to being treated as an ordinary user mode
// with a cycling palette color instead of reading as a maneuver at all --
// a real, concrete part of "I still don't see the maneuver modes."
const MANEUVER_MODE_NAMES = new Set(["Slewing", "Burning", "RcsCorrecting"])
const MANEUVER_COLORS: Record<string, string> = { Slewing: "#e0a020", Burning: "#e04a3a", RcsCorrecting: "#c9793a" }

export function isManeuverMode(mode: string | null | undefined): boolean {
  return mode != null && MANEUVER_MODE_NAMES.has(mode)
}

// User-facing label -- "Slewing"/"Burning"/"RcsCorrecting" alone reads as
// an internal state name, not as the mission-level concept it represents.
export function maneuverModeLabel(mode: string): string {
  if (mode === "Slewing") return "Maneuver — aligning thrust axis"
  if (mode === "Burning") return "Maneuver — burning"
  return "Maneuver — RCS correction (no slew)"
}

export function colorForMode(mode: string | null | undefined, knownModes: string[]): string {
  if (!mode) return "#6b6f80"
  if (isManeuverMode(mode)) return MANEUVER_COLORS[mode]
  const idx = knownModes.indexOf(mode)
  return MODE_PALETTE[idx % MODE_PALETTE.length] ?? "#6b6f80"
}

export interface RawModeSegment {
  startS: number
  endS: number
  mode: string | null
}

// Real segment build, in real t_s units -- both the timeline (which needs
// fractions of durationS for its percentage-based CSS layout) and the
// figures (which need real t_s/days for Plotly x-axis shapes) derive their
// own representation from this one grouping pass.
export function buildRawModeSegments(steps: CruiseStepMsg[]): RawModeSegment[] {
  if (steps.length === 0) return []
  const segments: RawModeSegment[] = []
  let runStart = steps[0].t_s
  let runMode = steps[0].active_mode ?? null
  for (let i = 1; i <= steps.length; i++) {
    const s = steps[i]
    const mode = s ? (s.active_mode ?? null) : null
    if (!s || mode !== runMode) {
      const endS = s ? s.t_s : steps[steps.length - 1].t_s
      segments.push({ startS: runStart, endS, mode: runMode })
      if (s) {
        runStart = s.t_s
        runMode = mode
      }
    }
  }
  return segments
}
