import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import type { OptimizeApiResult } from "@/api/client"
import { isMgaInfeasibleGrade, isNoSolutionFitness } from "./sentinel"

// GA/PSO: PopulationLogRow.params is [dep_offset_days, theta_burn_rad,
// dv_mps, phi_out_of_plane_rad] -- see optimize.rs::evaluate_candidate.
// MGA rows carry the MGA-1DSM chromosome instead (mga.rs: p[0] = departure
// offset [days], p[1] = departure v-inf [m/s], p[4+2k] = leg k's TOF
// [days], len = 5n+2 for n legs) -- feeding those through the GA labels
// produced the nonsense "theta_burn = 3665 rad" panels the user rightly
// rejected, so MGA gets its own panels with axes that mean
// something for its parameter space.
const THETA_IDX = 1
const DV_IDX = 2
const PHI_IDX = 3

const PANEL_LAYOUT = {
  ...DARK_LAYOUT,
  margin: { t: 24, r: 24, b: 48, l: 64 },
  showlegend: false,
} as const

// circle = phase 1, diamond = phase 2 -- same convention as the backend's
// plot_optimize.py.
const symbolFor = (phase: number) => (phase === 1 ? "circle" : "diamond")

// Keep Plotly responsive on big MBH/DE logs: evenly sample down to this many
// points (the shape of the explored space survives; individual points don't
// matter at that density).
const MAX_SCATTER_POINTS = 4000
function sampleEvenly<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const stride = rows.length / max
  return Array.from({ length: max }, (_, i) => rows[Math.floor(i * stride)])
}

function MgaAnalysis({ result }: { result: OptimizeApiResult }) {
  const log = result.population_log ?? []
  const feasible = sampleEvenly(
    log.filter((row) => !isMgaInfeasibleGrade(row.fitness) && row.params.length >= 6),
    MAX_SCATTER_POINTS,
  )
  const convergence = (result.convergence ?? []).filter((v) => !isMgaInfeasibleGrade(v))

  // Chromosome decode: n legs from len = 5n+2; total TOF = sum of p[4+2k].
  const totalTof = (params: number[]) => {
    const n = Math.max(1, Math.round((params.length - 2) / 5))
    let sum = 0
    for (let k = 0; k < n; k++) sum += params[4 + 2 * k] ?? 0
    return sum
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search analysis (MGA)</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {convergence.length > 0 && (
          <Plot
            data={[
              {
                type: "scatter",
                mode: "lines",
                x: convergence.map((_, i) => i),
                y: convergence.map((v) => v / 1000),
                line: { color: CHART_COLORS[0] },
              },
            ]}
            layout={{
              ...PANEL_LAYOUT,
              xaxis: { title: { text: "Optimizer iteration (winning branch, hops/generations)" } },
              yaxis: { title: { text: "Best total ΔV so far [km/s]" }, type: "log" as const },
            }}
            style={{ width: "100%", height: "320px" }}
            useResizeHandler
          />
        )}
        {feasible.length > 0 && (
          <Plot
            data={[
              {
                type: "scatter",
                mode: "markers",
                x: feasible.map((row) => row.params[0]),
                y: feasible.map((row) => totalTof(row.params)),
                text: feasible.map(
                  (row) =>
                    `dep offset ${row.params[0].toFixed(1)} d, TOF ${totalTof(row.params).toFixed(0)} d, ΔV ${(row.fitness / 1000).toFixed(2)} km/s`,
                ),
                marker: {
                  size: 5,
                  color: feasible.map((row) => row.fitness / 1000),
                  colorscale: "Viridis",
                  reversescale: true,
                  showscale: true,
                  colorbar: { title: { text: "total ΔV [km/s]" } },
                  symbol: feasible.map((row) => symbolFor(row.phase)),
                },
              },
            ]}
            layout={{
              ...PANEL_LAYOUT,
              xaxis: { title: { text: "Departure offset [days from epoch]" } },
              yaxis: { title: { text: "Total time of flight [days]" } },
            }}
            style={{ width: "100%", height: "320px" }}
            useResizeHandler
          />
        )}
        <p className="col-span-full text-xs text-muted-foreground">
          Left: objective evolution over the winning search branch's iterations (log scale - early infeasible
          penalties dwarf real ΔV values). Right: every evaluated candidate in the departure-date × flight-time
          plane, colored by total ΔV - where the dots cluster is where the search converged. Candidates from all
          search branches/sequences are pooled; per-branch separation is planned backend-side.
        </p>
      </CardContent>
    </Card>
  )
}

export function OptimizePopulationScatter({ result }: { result: OptimizeApiResult }) {
  if (result.method === "MGA") return <MgaAnalysis result={result} />

  const log = result.population_log
  if (!log || log.length === 0) return null // PSO has no population log

  const feasible = sampleEvenly(log.filter((row) => !isNoSolutionFitness(row.fitness)), MAX_SCATTER_POINTS)
  if (feasible.length === 0) return null

  const theta = feasible.map((row) => row.params[THETA_IDX])
  const phi = feasible.map((row) => row.params[PHI_IDX])
  const dv = feasible.map((row) => row.params[DV_IDX])
  const generation = feasible.map((row) => row.generation)
  const symbol = feasible.map((row) => symbolFor(row.phase))
  const hoverText = feasible.map(
    (row) => `phase ${row.phase}, gen ${row.generation}, fitness=${row.fitness.toPrecision(4)}, dv=${row.params[DV_IDX].toFixed(0)} m/s`,
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Population search (departure burn)</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Plot
          data={[
            {
              type: "scatter",
              mode: "markers",
              x: theta,
              y: phi,
              text: hoverText,
              marker: {
                size: 5,
                color: dv,
                colorscale: "Viridis",
                showscale: true,
                colorbar: { title: { text: "dv departure [m/s]" } },
                symbol,
              },
            },
          ]}
          layout={{
            ...PANEL_LAYOUT,
            xaxis: { title: { text: "theta_burn [rad]" } },
            yaxis: { title: { text: "phi_out_of_plane [rad]" } },
          }}
          style={{ width: "100%", height: "320px" }}
          useResizeHandler
        />
        <Plot
          data={[
            {
              type: "scatter",
              mode: "markers",
              x: theta,
              y: phi,
              text: hoverText,
              marker: {
                size: 5,
                color: generation,
                colorscale: "Plasma",
                showscale: true,
                colorbar: { title: { text: "generation" } },
                symbol,
              },
            },
          ]}
          layout={{
            ...PANEL_LAYOUT,
            xaxis: { title: { text: "theta_burn [rad]" } },
            yaxis: { title: { text: "phi_out_of_plane [rad]" } },
          }}
          style={{ width: "100%", height: "320px" }}
          useResizeHandler
        />
      </CardContent>
    </Card>
  )
}
