import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"

interface CovarianceTimeSeriesPlotProps {
  title: string
  yAxisLabel: string
  t: number[]
  y: number[]
  color?: string
}

export function CovarianceTimeSeriesPlot({ title, yAxisLabel, t, y, color = CHART_COLORS[0] }: CovarianceTimeSeriesPlotProps) {
  return (
    <Plot
      data={[{ type: "scatter", mode: "lines", x: t, y, line: { color } }]}
      layout={{
        title: { text: title },
        ...DARK_LAYOUT,
        margin: { t: 32, r: 24, b: 48, l: 64 },
        xaxis: { title: { text: "Mission time (s)" } },
        yaxis: { title: { text: yAxisLabel } },
        showlegend: false,
      }}
      style={{ width: "100%", height: "260px" }}
      useResizeHandler
    />
  )
}
