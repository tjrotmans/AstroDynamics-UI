// Pure helpers shared between PorkchopHeatmap (direct-transfer survey) and
// MgaScanHeatmap (MGA window scan) -- extracted rather than unifying the two
// components themselves. PorkchopHeatmap was just stabilized across several
// rounds of live debugging (the zmin/zmax pairing bug, the max-ΔV-below-
// minimum inversion, the debounce fix); a full component merge risks
// regressing it for no user-visible gain, so only the hard-won pure math
// moves here. Each heatmap still owns its own grid-building (they bin very
// differently -- one keys on exact survey grid points, the other
// min-reduces a sparse, irregular set of feasible scan branches) and its own
// JSX.
import type { Data } from "plotly.js"

export const CONTOUR_LEVEL_COUNT = 5

export const selectClass = "rounded border border-white/15 bg-black/40 px-1.5 py-0.5 text-[11px] text-foreground"
export const numberInputClass = "w-24 rounded border border-white/15 bg-black/40 px-1.5 py-0.5 text-[11px] text-foreground"

export function jdToIsoDate(jd: number): string {
  return new Date((jd - 2440587.5) * 86_400_000).toISOString()
}

// Real (non-null) min/max of a grid -- used both to seed the "max ΔV"
// placeholder and to space the contour levels.
export function gridRange(grid: (number | null)[][]): [number, number] | null {
  let min = Infinity
  let max = -Infinity
  for (const row of grid) {
    for (const v of row) {
      if (v == null) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null
}

// Clamped above the real minimum -- a "Max ΔV" typed below the grid's
// actual lowest value inverts zmin/zmax (and the contour start/end), which
// Plotly silently ignores rather than erroring: the colorbar clamp does
// nothing and the contour lines simply don't draw, with no visible sign
// anything is wrong. Found live: typing a low value while chasing "more
// contrast on the low ΔV side" is exactly how a user hits this.
export function clampMaxDv(rawMaxDv: number | null, range: [number, number] | null): number | null {
  if (rawMaxDv == null) return null
  const effectiveMinDv = range?.[0] ?? 0
  return Math.max(rawMaxDv, effectiveMinDv + 1)
}

// The contour trace itself, shared verbatim -- coloring:"lines" + an
// explicit line.color both needed (Plotly colours contour lines by z-value
// unless line.color overrides it), start/end/size derived from the same
// range + maxDv clamp the heatmap trace uses so the two always agree.
export function buildContourTrace(params: {
  x: (number | string)[]
  y: (number | string)[]
  z: (number | null)[][]
  range: [number, number]
  maxDv: number | null
}): Data {
  const { x, y, z, range, maxDv } = params
  return {
    type: "contour",
    x,
    y,
    z,
    contours: {
      coloring: "lines",
      showlabels: true,
      labelfont: { size: 9, color: "#f24d00" },
      start: range[0],
      end: maxDv ?? range[1],
      size: Math.max(((maxDv ?? range[1]) - range[0]) / CONTOUR_LEVEL_COUNT, 1e-6),
    },
    line: { color: "#f24d00", width: 1 },
    showscale: false,
    hoverinfo: "skip",
    name: "ΔV contours",
  } as Data
}
