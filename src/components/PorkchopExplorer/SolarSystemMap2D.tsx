// Shared flat 2D top-down solar-system renderer: circular orbit rings, plain
// coloured dot markers (no textures), a spacecraft trail, and a current
// spacecraft marker. Reference: a user-supplied screenshot of a matplotlib-
// style mission animation (Time counter, legend, thin orbit rings, a growing
// yellow trail) -- deliberately a different rendering approach from the
// cinematic Three.js view (OptimizeTrajectoryView), not a mode flag on it.
//
// Kept generic on purpose (the design notes "Porkchop & Planetary-Alignment
// Explorer" design note): this is the one piece of render logic
// three different features will eventually share --
//   1. MgaTopDownView (this repo, built now): a finished MGA result's real
//      per-leg arc, played back over time.
//   2. Porkchop/alignment explorer (not started, blocked on a backend
//      mga-scan endpoint): a scan record's leg encounter points for a
//      slider-selected departure date.
//   3. Live-candidate replay during a running MGA job (not started, blocked
//      on richer step-stream data): a population individual's decoded
//      encounter points, resampled once/second.
// Don't add data-fetching or MGA-specific assumptions here -- keep this
// component's only job "given positions in AU, draw the map."
import { useCallback, useMemo, useState } from "react"
import type { Data, Layout, PlotRelayoutEvent } from "plotly.js"

import { DARK_LAYOUT, Plot } from "@/lib/plot"

const GRID_COLOR = "rgba(110,110,170,0.35)"
const TICK_COLOR = "#9a9aa8"
const TRAIL_COLOR = "#facc15"
const SPACECRAFT_COLOR = "#facc15"
// Orbit rings default to a lighter, whiter tone than GRID_COLOR (found
// user feedback on the Explore figure: rings were technically
// already drawn, but shared GRID_COLOR with the reference axis lines and
// blended straight into them at typical opacity -- barely perceptible as
// "a planet's orbit" rather than "background grid"). Still a thin dotted
// line, not a bold path -- "light circles," not a second trajectory.
const ORBIT_RING_COLOR = "rgba(210,212,235,0.55)"

export interface MapBody {
  name: string
  positionAu: [number, number]
  color?: string
  /** "open" renders a hollow marker (e.g. a body's position at the end of
   *  the shown span) vs the default filled marker (its starting position). */
  style?: "filled" | "open"
}

export interface OrbitRing {
  name: string
  radiusAu: number
  color?: string
}

export interface SolarSystemMap2DProps {
  bodies: MapBody[]
  orbitRings?: OrbitRing[]
  path: [number, number][]
  currentPositionAu?: [number, number]
  /** Fixed half-range for both axes [AU] -- keeps framing stable across an animation instead of autoscaling every frame. */
  rangeAu: number
  heightPx?: number
  /** Draws `path` dashed instead of solid -- used by schematic/preview callers that must never be visually confusable with a real result. */
  pathDashed?: boolean
  /** Overrides the path trace's legend name (default "Trajectory"). */
  pathName?: string
  /** Hide the legend entirely (default true) -- for callers with many bodies
   *  and a small plot area, where the legend list can occupy more space than
   *  the plot itself. Body names are still available on hover (hoverinfo
   *  stays "name"). */
  showLegend?: boolean
}

function circlePoints(radiusAu: number): { x: number[]; y: number[] } {
  const n = 128
  const x: number[] = []
  const y: number[] = []
  for (let i = 0; i <= n; i++) {
    const angle = (i / n) * 2 * Math.PI
    x.push(radiusAu * Math.cos(angle))
    y.push(radiusAu * Math.sin(angle))
  }
  return { x, y }
}

export function SolarSystemMap2D({
  bodies,
  orbitRings = [],
  path,
  currentPositionAu,
  rangeAu,
  heightPx = 480,
  pathDashed = false,
  pathName = "Trajectory",
  showLegend = true,
}: SolarSystemMap2DProps) {
  // Real bug, found (Explore-mode figure,: dragging
  // the departure-date slider after manually zooming snapped the zoom back
  // out). `uirevision` alone (see the layout comment below) turned out NOT
  // to be enough here: this axis pair also sets `scaleanchor: "y"` for a
  // locked 1:1 AU aspect ratio, and Plotly recomputes an anchored axis's
  // own range from the anchor axis on every `Plotly.react` redraw -- a
  // known interaction where an explicit `range` in the new layout can win
  // over the preserved interactive one, even under a stable uirevision.
  // Tracking the user's own zoom/pan explicitly and feeding it back in as
  // the layout's `range` (instead of the freshly-computed `rangeAu` once
  // the user has taken over) sidesteps that interaction entirely -- this is
  // the standard, robust react-plotly.js pattern for "don't reset on data
  // updates," not reliant on uirevision's own edge cases.
  const [manualRange, setManualRange] = useState<{ x: [number, number]; y: [number, number] } | null>(null)

  const handleRelayout = useCallback((event: PlotRelayoutEvent) => {
    const e = event as Record<string, number | boolean | undefined>
    // Double-click (or the toolbar's autoscale) sends an explicit
    // autorange -- that's the user's own "reset zoom" gesture, so hand
    // control back to the computed rangeAu instead of continuing to pin a
    // stale manual range.
    if (e["xaxis.autorange"] || e["yaxis.autorange"]) {
      setManualRange(null)
      return
    }
    const x0 = e["xaxis.range[0]"]
    const x1 = e["xaxis.range[1]"]
    const y0 = e["yaxis.range[0]"]
    const y1 = e["yaxis.range[1]"]
    if (typeof x0 === "number" && typeof x1 === "number" && typeof y0 === "number" && typeof y1 === "number") {
      setManualRange({ x: [x0, x1], y: [y0, y1] })
    }
  }, [])

  const xRange = useMemo<[number, number]>(
    () => manualRange?.x ?? [-rangeAu, rangeAu],
    [manualRange, rangeAu],
  )
  const yRange = useMemo<[number, number]>(
    () => manualRange?.y ?? [-rangeAu, rangeAu],
    [manualRange, rangeAu],
  )

  const data: Data[] = [
    ...orbitRings.map((ring): Data => {
      const { x, y } = circlePoints(ring.radiusAu)
      return {
        type: "scatter",
        mode: "lines",
        x,
        y,
        line: { color: ring.color ?? ORBIT_RING_COLOR, width: 1, dash: "dot" },
        opacity: 0.75,
        name: `${ring.name} orbit`,
        hoverinfo: "skip",
        showlegend: false,
      }
    }),
    {
      type: "scatter",
      mode: "lines",
      x: path.map((p) => p[0]),
      y: path.map((p) => p[1]),
      line: { color: TRAIL_COLOR, width: 2.5, dash: pathDashed ? "dash" : "solid" },
      name: pathName,
      hoverinfo: "skip",
    },
    ...(currentPositionAu
      ? [{
          type: "scatter" as const,
          mode: "markers" as const,
          x: [currentPositionAu[0]],
          y: [currentPositionAu[1]],
          marker: { color: SPACECRAFT_COLOR, size: 10, symbol: "circle" },
          name: "S/C",
          hoverinfo: "skip" as const,
        }]
      : []),
    ...bodies.map((b): Data => ({
      type: "scatter",
      mode: "markers",
      x: [b.positionAu[0]],
      y: [b.positionAu[1]],
      marker: {
        color: b.color ?? "#8899bb",
        size: 12,
        symbol: b.style === "open" ? "circle-open" : "circle",
        line: b.style === "open" ? { width: 2 } : undefined,
      },
      name: b.name,
      showlegend: showLegend && b.style !== "open",
      hoverinfo: "name" as const,
    })),
  ]

  const layout: Partial<Layout> = {
    ...DARK_LAYOUT,
    // Real bug (found): every animation frame passed a brand-new
    // layout object with the SAME fixed xaxis/yaxis range, and react-plotly.js
    // calls Plotly.react on every prop change -- which reapplies that range
    // wholesale, silently discarding any zoom/pan the user had just done by
    // dragging. `uirevision` is Plotly's documented escape hatch: as long as
    // this key stays the same across updates, Plotly preserves interactively-
    // set UI state (zoom/pan) instead of snapping back to the layout's own
    // range -- kept as a second line of defense, but xRange/yRange (see
    // above) are what actually keep this stable across data updates now.
    uirevision: "solar-system-map",
    margin: { t: 24, r: 24, b: 24, l: 48 },
    showlegend: showLegend,
    legend: { font: { color: TICK_COLOR, size: 10 }, bgcolor: "rgba(0,0,0,0)" },
    xaxis: {
      title: { text: "x [AU]", font: { size: 10, color: TICK_COLOR } },
      range: xRange,
      gridcolor: GRID_COLOR,
      zerolinecolor: GRID_COLOR,
      tickfont: { size: 9, color: TICK_COLOR },
      scaleanchor: "y",
    },
    yaxis: {
      title: { text: "y [AU]", font: { size: 10, color: TICK_COLOR } },
      range: yRange,
      gridcolor: GRID_COLOR,
      zerolinecolor: GRID_COLOR,
      tickfont: { size: 9, color: TICK_COLOR },
    },
  }

  return (
    <Plot
      data={data}
      layout={layout}
      config={{ displayModeBar: false, responsive: true }}
      style={{ width: "100%", height: heightPx }}
      useResizeHandler
      onRelayout={handleRelayout}
    />
  )
}
