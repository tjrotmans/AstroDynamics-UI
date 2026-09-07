import type { Data } from "plotly.js"

import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import type { GncDesign } from "@/api/client"

// Same waterfall-trace escape hatch as DesignPanel/DvWaterfall.tsx -
// @types/plotly.js doesn't model measure/increasing/totals/connector.
function waterfallTrace(props: Record<string, unknown>): Data {
  return props as unknown as Data
}

/** Disturbance torque budget: gravity-gradient + SRP -> total, as a waterfall. */
export function TorqueBudgetChart({ design }: { design: GncDesign }) {
  return (
    <Plot
      data={[
        waterfallTrace({
          type: "waterfall",
          x: ["Gravity-gradient", "SRP", "Total"],
          y: [design.gravity_gradient_torque_nm, design.srp_torque_nm, design.total_disturbance_torque_nm],
          measure: ["relative", "relative", "total"],
          connector: { line: { color: "#3a3a3a" } },
          increasing: { marker: { color: CHART_COLORS[0] } },
          totals: { marker: { color: "#34d399" } },
        }),
      ]}
      layout={{
        ...DARK_LAYOUT,
        margin: { t: 24, r: 24, b: 48, l: 64 },
        yaxis: { title: { text: "Torque (N·m)" } },
        showlegend: false,
      }}
      style={{ width: "100%", height: "280px" }}
      useResizeHandler
    />
  )
}
