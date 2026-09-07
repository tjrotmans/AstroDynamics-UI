import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import type { SimStepMsg } from "@/api/client"

export function WheelSaturationTimeline({ steps }: { steps: SimStepMsg[] }) {
  const t = steps.map((s) => s.t_s)
  const satFrac = steps.map((s) => s.wheel_sat_frac)
  const desatT = steps.filter((s) => s.desat_fired).map((s) => s.t_s)
  const desatY = steps.filter((s) => s.desat_fired).map((s) => s.wheel_sat_frac)

  return (
    <Plot
      data={[
        { type: "scatter", mode: "lines", name: "Wheel saturation", x: t, y: satFrac, line: { color: CHART_COLORS[0] } },
        {
          type: "scatter",
          mode: "markers",
          name: "Desat fired",
          x: desatT,
          y: desatY,
          marker: { color: "#f59e0b", size: 9, symbol: "x" },
        },
      ]}
      layout={{
        title: { text: "Wheel saturation" },
        ...DARK_LAYOUT,
        margin: { t: 32, r: 24, b: 48, l: 56 },
        xaxis: { title: { text: "Mission time (s)" } },
        yaxis: { title: { text: "Saturation fraction" }, range: [0, 1] },
        legend: { orientation: "h" },
      }}
      style={{ width: "100%", height: "280px" }}
      useResizeHandler
    />
  )
}
