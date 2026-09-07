import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatField } from "@/components/StatField"
import { DARK_LAYOUT, Plot } from "@/lib/plot"
import type { MonteCarloApiResult } from "@/api/client"

export function MonteCarloPanel({ result }: { result: MonteCarloApiResult }) {
  const samples = result.samples.filter((s) => s.dv_total_ms != null && s.tof_days !== undefined)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monte Carlo scatter</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatField label="Samples" value={`${result.n_valid} / ${result.n_samples} valid`} />
          <StatField label="Mean ΔV" value={`${result.mean_dv_total_ms.toFixed(1)} m/s`} />
          <StatField label="Std ΔV" value={`${result.std_dv_total_ms.toFixed(1)} m/s`} />
          <StatField
            label="Range"
            value={`${result.min_dv_total_ms.toFixed(1)} – ${result.max_dv_total_ms.toFixed(1)} m/s`}
          />
        </div>
        {samples.length > 0 && (
          <Plot
            data={[
              {
                type: "scatter",
                mode: "markers",
                x: samples.map((s) => s.dep_offset_days),
                y: samples.map((s) => s.tof_days),
                marker: {
                  color: samples.map((s) => s.dv_total_ms ?? 0),
                  colorscale: "Viridis",
                  colorbar: { title: { text: "ΔV total (m/s)" } },
                },
              },
            ]}
            layout={{
              ...DARK_LAYOUT,
              margin: { t: 24, r: 24, b: 48, l: 56 },
              xaxis: { title: { text: "Departure offset (days)" } },
              yaxis: { title: { text: "Time of flight (days)" } },
            }}
            style={{ width: "100%", height: "320px" }}
            useResizeHandler
          />
        )}
      </CardContent>
    </Card>
  )
}
