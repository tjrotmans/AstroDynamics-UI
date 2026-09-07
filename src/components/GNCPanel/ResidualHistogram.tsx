import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"

interface ResidualHistogramProps {
  title: string
  xAxisLabel: string
  values: (number | null | undefined)[]
}

export function ResidualHistogram({ title, xAxisLabel, values }: ResidualHistogramProps) {
  const samples = values.filter((v): v is number => v != null)

  if (samples.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{title}</span>
        <p className="text-sm text-muted-foreground">Not configured this run.</p>
      </div>
    )
  }

  return (
    <Plot
      data={[{ type: "histogram", x: samples, marker: { color: CHART_COLORS[0] } }]}
      layout={{
        title: { text: title },
        ...DARK_LAYOUT,
        margin: { t: 32, r: 24, b: 48, l: 56 },
        xaxis: { title: { text: xAxisLabel } },
        yaxis: { title: { text: "Count" } },
        showlegend: false,
      }}
      style={{ width: "100%", height: "260px" }}
      useResizeHandler
    />
  )
}
