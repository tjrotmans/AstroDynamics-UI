import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatField } from "@/components/StatField"
import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import { buildDvLedger } from "@/lib/dvLedger"
import { useMissionStore } from "@/stores/missionStore"
import type { OptimizerApiResult } from "@/api/client"
import { DvLedgerCard } from "./DvLedger"

// Reference-only display of the survey's GA/PSO-narrowing-solver best point
// -- see BestArcCard's header comment for why this card lost its own
// hand-off actions under the Phase B study paper.
//
// two-pool ΔV ledger instead of "Budget margin" + launcher
// badge. Since backend Phase 14e the result carries the full itemized
// `dv_ledger`; the un-itemized interim (backend onboard total only,
// dv_budget_ms − budget_margin_ms) remains for cached pre-14e results.
export function OptimizerResultCard({ result }: { result: OptimizerApiResult }) {
  const spacecraft = useMissionStore((s) => s.config.spacecraft)
  const onboardTotal =
    result.dv_budget_ms != null && result.budget_margin_ms != null ? result.dv_budget_ms - result.budget_margin_ms : null
  const ledger = buildDvLedger({
    ledger: result.dv_ledger,
    launchCheck: result.launch_vehicle_check,
    wetMassKg: spacecraft.mass_kg,
    propellantMassKg: spacecraft.propellant_mass_kg,
    interim: {
      dvDepartureMs: null,
      dvArrivalMs: null,
      ispS: spacecraft.propulsion?.isp_s,
      onboardRequiredTotalMps: onboardTotal,
      dvTotalMs: result.dv_total_ms,
    },
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>{result.solver} best candidate</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatField
            label="Fitness"
            value={`${result.fitness.toFixed(2)} ${result.fitness_units === "km2/s2" ? "km²/s²" : "m/s"}`}
          />
          <StatField label="Total ΔV" value={`${result.dv_total_ms.toFixed(1)} m/s`} />
          <StatField label="C3" value={`${result.c3_km2s2.toFixed(2)} km²/s²`} />
          <StatField label="Arrival v∞" value={`${result.v_inf_arr_ms.toFixed(0)} m/s`} />
        </div>
        <DvLedgerCard ledger={ledger} />
        {result.convergence.length > 0 && (
          <Plot
            data={[
              {
                type: "scatter",
                mode: "lines",
                x: result.convergence.map((_, i) => i),
                y: result.convergence,
                line: { color: CHART_COLORS[0] },
              },
            ]}
            layout={{
              ...DARK_LAYOUT,
              margin: { t: 24, r: 24, b: 48, l: 56 },
              xaxis: { title: { text: result.solver === "GA" ? "Generation" : "Iteration" } },
              yaxis: { title: { text: "Best fitness so far" } },
              showlegend: false,
            }}
            style={{ width: "100%", height: "280px" }}
            useResizeHandler
          />
        )}
      </CardContent>
    </Card>
  )
}
