import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import type { Data } from "plotly.js"
import type { McRunMsg, McSummaryResult } from "@/api/client"

const GRID_COLOR = "rgba(110,110,170,0.22)"
const TICK_COLOR = "#9a9aa8"
const CRASHED_COLOR = "#ef4444"
const SURVIVED_COLOR = CHART_COLORS[0]

interface Props {
  runs: McRunMsg[]
  summary: McSummaryResult | null
}

export function McDispersionCloud({ runs, summary }: Props) {
  if (runs.length === 0) return null

  // Dispersion cloud: final position scatter (radius from target body center).
  // All runs contribute their final_r_m; only stride-selected runs (capped at
  // 20) carry a trajectory array -- those get their own polyline traces.
  const survived = runs.filter((r) => !r.crashed)
  const crashed = runs.filter((r) => r.crashed)

  const scatterSurvived: Data = {
    type: "scatter",
    mode: "markers",
    name: "Survived",
    x: survived.map((r) => r.run_index),
    y: survived.map((r) => r.final_r_m / 1000),
    marker: { color: SURVIVED_COLOR, size: 5, opacity: 0.7 },
    text: survived.map(
      (r) => `Run ${r.run_index}: r=${(r.final_r_m / 1000).toFixed(1)} km, ΔV=${r.total_dv_ms.toFixed(1)} m/s`,
    ),
    hovertemplate: "%{text}<extra></extra>",
  }

  const scatterCrashed: Data = {
    type: "scatter",
    mode: "markers",
    name: "Crashed",
    x: crashed.map((r) => r.run_index),
    y: crashed.map((r) => r.final_r_m / 1000),
    marker: { color: CRASHED_COLOR, size: 5, opacity: 0.7, symbol: "x" },
    text: crashed.map((r) => `Run ${r.run_index}: CRASHED, r=${(r.final_r_m / 1000).toFixed(1)} km`),
    hovertemplate: "%{text}<extra></extra>",
  }

  // Trajectory lines for the stride-selected subset (trajectory != null).
  const trajTraces: Data[] = runs
    .filter((r) => r.trajectory && r.trajectory.length > 0)
    .map((r) => ({
      type: "scatter" as const,
      mode: "lines" as const,
      name: `Run ${r.run_index}`,
      x: r.trajectory!.map((p) => p.t_s / 86400),
      y: r.trajectory!.map((p) => Math.sqrt(p.r_truth_m.reduce((s, v) => s + v * v, 0)) / 1000),
      line: { color: r.crashed ? CRASHED_COLOR : SURVIVED_COLOR, width: 1 },
      opacity: 0.4,
      showlegend: false,
      hoverinfo: "skip" as const,
    }))

  const axisStyle = (title: string) => ({
    title: { text: title, font: { size: 11, color: TICK_COLOR } },
    color: TICK_COLOR,
    gridcolor: GRID_COLOR,
    zerolinecolor: GRID_COLOR,
    tickfont: { size: 9, color: TICK_COLOR },
  })

  const layout = {
    ...DARK_LAYOUT,
    margin: { l: 55, r: 20, t: 10, b: 45 },
    height: 220,
    showlegend: true,
    legend: { font: { size: 10, color: TICK_COLOR }, bgcolor: "transparent" },
    xaxis: axisStyle("Run index"),
    yaxis: axisStyle("Final range to body center (km)"),
  }

  const trajectoryLayout = {
    ...layout,
    height: 200,
    xaxis: axisStyle("Time (days)"),
    yaxis: axisStyle("Range (km)"),
  }

  return (
    <div className="flex flex-col gap-3">
      <Plot
        data={[scatterSurvived, scatterCrashed]}
        layout={layout}
        config={{ displayModeBar: false, responsive: true }}
        style={{ width: "100%" }}
      />

      {trajTraces.length > 0 && (
        <Plot
          data={trajTraces}
          layout={trajectoryLayout}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: "100%" }}
        />
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Runs completed</span>
            <span>{summary.n_runs}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Crashes</span>
            <span className={summary.n_crashed > 0 ? "text-red-400" : ""}>{summary.n_crashed}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Mean final range</span>
            <span>{(summary.mean_final_r_m / 1000).toFixed(1)} km</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Range spread</span>
            <span>
              {(summary.min_r_m / 1000).toFixed(1)}–{(summary.max_r_m / 1000).toFixed(1)} km
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Mean total ΔV</span>
            <span>{summary.mean_dv_total_ms.toFixed(1)} m/s</span>
          </div>
        </div>
      )}
    </div>
  )
}
