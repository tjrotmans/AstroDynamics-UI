import RawPlot from "react-plotly.js"
import type { ComponentType } from "react"
import type { PlotParams } from "react-plotly.js"

type PossiblyDoubleWrapped = ComponentType<PlotParams> | { default: ComponentType<PlotParams> }

// react-plotly.js is CJS; this project's dev-server CJS/ESM interop doesn't always
// unwrap `.default`, so the default import can arrive as `{ default: Component }`
// instead of the component itself. Handle both shapes in one place.
const maybeWrapped = RawPlot as unknown as PossiblyDoubleWrapped

export const Plot: ComponentType<PlotParams> =
  typeof maybeWrapped === "function" ? maybeWrapped : maybeWrapped.default

// Shared dark-theme Plotly base -- 14 panels used to each carry their own
// copy of these four fields (style review). Spread this first,
// then add panel-specific margins/axes/legend on top. Values mirror
// index.css's .dark tokens; Plotly can't read CSS variables, so they're
// duplicated here by design -- change both together.
export const DARK_LAYOUT = {
  autosize: true,
  paper_bgcolor: "#0f0f0f",
  plot_bgcolor: "#0f0f0f",
  font: { color: "#e5e5e5" },
} as const

// Categorical series palette, same order as --chart-1..5 in index.css.
// chart-1 updated: the "Observatory" redesign
// repointed --chart-1 from cyan to the new warm gold accent, but this array
// was never updated to match -- every panel below still drew its primary
// series in the old cyan, visually clashing with the rest of the app's
// palette (index.css's own .dark block flagged this exact gap as a tracked,
// not-yet-done follow-up). chart-2..5 were already correct.
export const CHART_COLORS = ["#ffc861", "#ffa94d", "#b197fc", "#63e6be", "#ff8787"] as const
