import type { SelectedTrajectory } from "@/stores/designStore"

// Propellant feasibility of an adopted trajectory for the configured
// vehicle (backend → frontend message after the Phase 03
// end-to-end validation): "the Mercury Orbiter's capture needs 18,130 m/s;
// the vehicle's tank gives 220·9.81·ln(500/400) = 481 m/s. No chemical
// vehicle can do that" -- the run that looked like a control failure was
// an infeasible design.
//
// Source of truth: the adopted result's own `dv_ledger` (backend Phase 14e,
//) -- the ΔV REQUIREMENT split (departure remainder / DSMs /
// arrival, `onboard_dv_required_ms`) is a property of the trajectory and is
// read verbatim. What the tank can GIVE depends on the vehicle, and the
// vehicle is editable in Phase 02 AFTER adoption (mass, propellant, Isp),
// so: when the current vehicle still matches the one the result was
// computed with (`dvLedgerVehicle`, captured at adoption) the backend's
// `onboard_dv_available_ms`/`propellant_feasible` are used as-is; when it
// has been edited, the available ΔV is re-evaluated from the current masses
// with the same rocket equation the backend documents for that field
// (Isp·g₀·ln(m_wet/m_dry)) and `source` says so -- the requirement side is
// still the backend's. `interim` (whole thing computed here from dv_dep/
// dv_arr + launch_vehicle_check) only applies to adoptions predating
// `dv_ledger`, i.e. the pre-preset snapshots.
const G0 = 9.80665

export interface PropellantFeasibility {
  availableMps: number
  requiredMps: number
  onboardDepartureMps: number
  arrivalMps: number
  dsmMps: number
  /** True when the launcher covers the WHOLE departure (pool "launcher"). A "split" pool still leaves onboardDepartureMps > 0. */
  departureByLauncher: boolean
  departurePool: "launcher" | "onboard" | "split" | null
  feasible: boolean
  /** required / available -- the mass-ratio shortfall factor when > 1. */
  ratio: number
  source: "backend" | "backend-requirement+edited-vehicle" | "interim"
}

export function assessPropellantFeasibility(params: {
  trajectory: SelectedTrajectory
  wetMassKg: number
  propellantMassKg: number
  ispS: number | null | undefined
}): PropellantFeasibility | null {
  const { trajectory, wetMassKg, propellantMassKg, ispS } = params
  if (trajectory.kind !== "optimizer") return null
  const canRocketEq = ispS != null && ispS > 0 && wetMassKg > propellantMassKg && propellantMassKg > 0
  const currentAvailable = canRocketEq ? ispS * G0 * Math.log(wetMassKg / (wetMassKg - propellantMassKg)) : null

  const L = trajectory.dvLedger
  if (L) {
    const v = trajectory.dvLedgerVehicle
    const vehicleUnchanged =
      v != null && v.massKg === wetMassKg && v.propellantMassKg === propellantMassKg && (v.ispS ?? null) === (ispS ?? null)
    const backendAvailable = L.onboard_dv_available_ms ?? null
    const availableMps = vehicleUnchanged && backendAvailable != null ? backendAvailable : currentAvailable
    if (availableMps == null) return null
    const requiredMps = L.onboard_dv_required_ms
    const useBackendVerdict = vehicleUnchanged && backendAvailable != null && L.propellant_feasible != null
    return {
      availableMps,
      requiredMps,
      onboardDepartureMps: L.onboard_departure_dv_ms,
      arrivalMps: L.onboard_arrival_dv_ms,
      dsmMps: L.onboard_dsm_dv_ms,
      departureByLauncher: L.departure_dv_pool === "launcher",
      departurePool: L.departure_dv_pool,
      feasible: useBackendVerdict ? (L.propellant_feasible as boolean) : requiredMps <= availableMps,
      ratio: availableMps > 0 ? requiredMps / availableMps : Infinity,
      source: useBackendVerdict ? "backend" : "backend-requirement+edited-vehicle",
    }
  }

  // Interim: adoption predates dv_ledger.
  const dep = trajectory.dvDepartureMs ?? null
  const arr = trajectory.dvArrivalMs ?? null
  if (dep == null || arr == null || currentAvailable == null) return null
  const departureByLauncher = trajectory.launchVehicleFeasible === true
  const dsmMps = Math.max(0, trajectory.dv_total_ms - dep - arr)
  const onboardDepartureMps = departureByLauncher ? 0 : dep
  const requiredMps = onboardDepartureMps + dsmMps + arr
  return {
    availableMps: currentAvailable,
    requiredMps,
    onboardDepartureMps,
    arrivalMps: arr,
    dsmMps,
    departureByLauncher,
    departurePool: departureByLauncher ? "launcher" : "onboard",
    feasible: requiredMps <= currentAvailable,
    ratio: currentAvailable > 0 ? requiredMps / currentAvailable : Infinity,
    source: "interim",
  }
}
