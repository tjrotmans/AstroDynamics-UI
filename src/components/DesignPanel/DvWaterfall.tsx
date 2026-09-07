import type { Data } from "plotly.js"

import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import { buildDvLedger } from "@/lib/dvLedger"
import { useMissionStore } from "@/stores/missionStore"
import type { BestArcApiResult } from "@/api/client"

// @types/plotly.js doesn't model the "base" field (per-point floating-bar
// offset) on PlotData, even though plotly.js itself supports it.
function floatingBarTrace(props: Record<string, unknown>): Data {
  return props as unknown as Data
}

const LAUNCHER_COLOR = "#34d399"
const ONBOARD_COLOR = CHART_COLORS[0]
const TANK_COLOR = "#5b7fd6"
const MARGIN_OK = "#34d399"
const MARGIN_BAD = "#e04a3a"

// A manually-computed floating bar chart, NOT Plotly's "waterfall" trace
// type. Real bug, found: waterfall silently ignores a per-point
// marker.color array -- a plain "bar" trace with an explicit per-bar `base`
// reproduces the floating-bar look and supports per-bar colors.
//
// bars are grouped by POOL.
// Left: the launcher-covered departure (green, off the onboard budget).
// Then the onboard stack -- departure fallback (if any), DSMs, arrival --
// and finally what the tank can give and the resulting margin, so the
// question "does the onboard part fit the tank?" is read straight off the
// chart. The old chart's "Margin" bar used the backend's budget_margin_ms,
// which mixed the launcher pool in.
export function DvWaterfall({ result }: { result: BestArcApiResult }) {
  const objective = useMissionStore((s) => s.config.mission.objective)
  const spacecraft = useMissionStore((s) => s.config.spacecraft)

  // Flyby-zeroing workaround, see BestArcCard.
  const isFlyby = objective === "Flyby"
  const effectiveArrMs = isFlyby ? 0 : (result.dv_arr_ms ?? 0)
  const ledger = buildDvLedger({
    ledger: result.dv_ledger,
    launchCheck: result.launch_vehicle_check,
    wetMassKg: spacecraft.mass_kg,
    propellantMassKg: spacecraft.propellant_mass_kg,
    interim: { dvDepartureMs: result.dv_dep_ms, dvArrivalMs: effectiveArrMs, ispS: spacecraft.propulsion?.isp_s },
  })
  const { launcher: L, onboard: O } = ledger

  const labels: string[] = []
  const bases: number[] = []
  const heights: number[] = []
  const colors: string[] = []

  // Partial launcher coverage (backend 14e): the departure bar is two
  // stacked segments -- the launcher's share from 0, the onboard top-up on
  // top of it -- so "covered X of Y" is read straight off the chart.
  if (L.coveredMps > 0) {
    labels.push(L.status === "split" ? "Departure<br>(launcher share)" : "Departure<br>(launcher)")
    bases.push(0)
    heights.push(L.coveredMps)
    colors.push(LAUNCHER_COLOR)
  }
  let cum = 0
  const pushOnboard = (label: string, v: number) => {
    if (v <= 0) return
    labels.push(label)
    bases.push(cum)
    heights.push(v)
    colors.push(ONBOARD_COLOR)
    cum += v
  }
  if (L.status === "split" && O.departureFallbackMps > 0) {
    // The top-up sits ON the launcher's share (one physical departure burn,
    // two payers) and is also the first onboard item -- start the onboard
    // stack at its height so DSMs/arrival stack on top of it.
    labels.push("Departure<br>(onboard top-up)")
    bases.push(L.coveredMps)
    heights.push(O.departureFallbackMps)
    colors.push(ONBOARD_COLOR)
    cum = O.departureFallbackMps
  } else {
    pushOnboard("Departure<br>(onboard)", O.departureFallbackMps)
  }
  pushOnboard("DSMs<br>(onboard)", O.dsmMps)
  if (!isFlyby) pushOnboard("Arrival<br>(onboard)", O.arrivalMps)
  if (O.availableMps != null) {
    labels.push("Tank can give")
    bases.push(0)
    heights.push(O.availableMps)
    colors.push(TANK_COLOR)
    if (O.marginMps != null) {
      labels.push("Onboard margin")
      bases.push(O.marginMps >= 0 ? 0 : O.marginMps)
      heights.push(Math.abs(O.marginMps))
      colors.push(O.marginMps >= 0 ? MARGIN_OK : MARGIN_BAD)
    }
  }

  if (labels.length === 0) return null

  return (
    <Plot
      data={[
        floatingBarTrace({
          type: "bar",
          x: labels,
          y: heights,
          base: bases,
          marker: { color: colors },
          hovertemplate: "%{x}: %{y:,.0f} m/s<extra></extra>",
        }),
      ]}
      layout={{
        ...DARK_LAYOUT,
        margin: { t: 24, r: 24, b: 56, l: 56 },
        yaxis: { title: { text: "ΔV (m/s)" } },
        xaxis: { tickfont: { size: 10 } },
        showlegend: false,
      }}
      config={{ displayModeBar: false }}
      style={{ width: "100%", height: "320px" }}
      useResizeHandler
    />
  )
}
