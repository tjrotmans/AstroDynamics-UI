import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { StatField } from "@/components/StatField"
import { useMissionStore } from "@/stores/missionStore"
import { buildDvLedger } from "@/lib/dvLedger"
import type { BestArcApiResult } from "@/api/client"
import { DvLedgerCard } from "./DvLedger"

// Reference-only display of the survey's analytical best point (Phase B: the
// study paper's Run optimization button seeds the real optimizer's departure
// window from this automatically, and adoption only happens post-optimize --
// see SurveyFigure -- so this card no longer carries its own hand-off
// actions the way it did under the old Explore tool).
//
// the "Budget margin" / "Onboard propellant req'd" fields and
// the launcher badge became the two-pool ΔV ledger (DvLedgerCard) -- the
// old trio mixed the launcher pool into one margin number and never said
// how much of the departure the launcher removes from the tank.
export function BestArcCard({ result }: { result: BestArcApiResult }) {
  const objective = useMissionStore((s) => s.config.mission.objective)
  const spacecraft = useMissionStore((s) => s.config.spacecraft)

  // Backend bug, confirmed by reading the Rust source directly:
  // PorkchopGrid::evaluate has no knowledge of mission.objective and always
  // prices dv_arr_ms/dv_total_ms as a real capture burn -- only the internal
  // onboard_dv_required_ms actually zeroes it for Flyby. Filed as a backend
  // ask; worked around here client-side so a Flyby result doesn't display a
  // phantom capture burn.
  const isFlyby = objective === "Flyby"
  const effectiveArrMs = isFlyby ? 0 : result.dv_arr_ms
  const totalMs =
    result.dv_dep_ms !== undefined && effectiveArrMs !== undefined ? result.dv_dep_ms + effectiveArrMs : result.dv_total_ms

  // Backend Phase 14e: dv_ledger is the ledger; the interim
  // inputs only serve a cached pre-14e result (preset snapshots).
  const ledger = buildDvLedger({
    ledger: result.dv_ledger,
    launchCheck: result.launch_vehicle_check,
    wetMassKg: spacecraft.mass_kg,
    propellantMassKg: spacecraft.propellant_mass_kg,
    interim: { dvDepartureMs: result.dv_dep_ms, dvArrivalMs: effectiveArrMs, ispS: spacecraft.propulsion?.isp_s },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Best arc</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatField label="Total ΔV" value={totalMs !== undefined ? `${totalMs.toFixed(1)} m/s` : "-"} />
          <StatField label="Time of flight" value={result.tof_days !== undefined ? `${result.tof_days.toFixed(1)} days` : "-"} />
          <StatField label="C3" value={result.c3_km2s2 !== undefined ? `${result.c3_km2s2.toFixed(2)} km²/s²` : "-"} />
          <StatField label="Departure / arrival" value={`${(result.dv_dep_ms ?? 0).toFixed(0)} / ${(effectiveArrMs ?? 0).toFixed(0)} m/s`} />
        </div>
        <DvLedgerCard ledger={ledger} />
      </CardContent>
    </Card>
  )
}
