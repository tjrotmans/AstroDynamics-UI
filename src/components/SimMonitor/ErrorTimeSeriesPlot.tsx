import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"

interface ErrorTimeSeriesPlotProps {
  title: string
  yAxisLabel: string
  t: number[]
  error: number[]
  sigma: number[]
}

export function ErrorTimeSeriesPlot({ title, yAxisLabel, t, error, sigma }: ErrorTimeSeriesPlotProps) {
  return (
    <Plot
      data={[
        { type: "scatter", mode: "lines", name: "Error", x: t, y: error, line: { color: CHART_COLORS[0] } },
        { type: "scatter", mode: "lines", name: "1σ bound", x: t, y: sigma, line: { color: "#f59e0b", dash: "dot" } },
      ]}
      layout={{
        title: { text: title },
        ...DARK_LAYOUT,
        margin: { t: 32, r: 24, b: 48, l: 56 },
        xaxis: { title: { text: "Mission time (s)" } },
        yaxis: { title: { text: yAxisLabel } },
        legend: { orientation: "h" },
      }}
      style={{ width: "100%", height: "300px" }}
      useResizeHandler
    />
  )
}
