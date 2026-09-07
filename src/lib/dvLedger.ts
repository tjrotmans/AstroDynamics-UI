import type { DvLedgerApiResult, LaunchVehicleCheckApiResult } from "@/api/client"

// The two-pool ΔV ledger (the launcher windows were
// "unclear, incorrect, and not showing me enough info. I need to know how
// much dv the launcher can take out of the departure dv. The arrival is
// something separate and should be handled so, regardless of launcher").
//
// LAUNCHER pool: the departure injection, priced against the vehicle's
// verified C3-vs-mass curve. Since backend Phase 14e coverage
// is PARTIAL, not all-or-nothing: a vehicle short of the required C3 still
// delivers its maximum at this mass (`max_c3_at_mass_km2s2`) and the
// spacecraft tops up from the same periapsis (`departure_dv_pool: "split"`).
//
// ONBOARD pool: arrival/capture (ALWAYS onboard) + DSMs + any departure
// remainder, against Isp·g₀·ln(m_wet/m_dry), and the propellant that needs.
//
// This module is a thin VIEW ADAPTER over the backend's `dv_ledger`
// (`DvLedgerApiResult`, one shared helper for BestArc/Optimizer/Optimize
// results, so the three are directly comparable) -- no ΔV arithmetic of its
// own on that path. The `interim` branch below is the pre-14e client-side
// arithmetic, kept ONLY for results captured before `dv_ledger` existed
// (the landing-page preset snapshots carry `launch_vehicle_check` but no
// `dv_ledger`; the Mercury one is the frozen Phase 01 regression baseline
// and must keep rendering). Any result from a live backend has the field.
const G0 = 9.80665

export type LauncherStatus = "covers" | "split" | "mass_exceeded" | "exceeds_verified_c3" | "no_vehicle"

export interface DvLedger {
  /** "backend": straight from dv_ledger. "interim": computed here from the result's own dv fields + launch check -- pre-snapshots only. */
  source: "backend" | "interim"
  launcher: {
    status: LauncherStatus
    vehicle: string | null
    requiredC3Km2s2: number | null
    /** Max C3 the vehicle gives THIS wet mass (partial coverage); null when it can't lift the mass to any escape energy, or interim. */
    maxC3AtMassKm2s2: number | null
    maxInjectedMassKg: number | null
    spacecraftMassKg: number | null
    marginKg: number | null
    /** Departure ΔV taken out of the onboard budget by the launcher [m/s]. */
    coveredMps: number
    /** Full departure burn before any split [m/s] -- "covered X of Y". */
    departureTotalMps: number
    /** Backend's own explanation when the launcher doesn't fully cover departure; null when it does. */
    reason: string | null
  }
  onboard: {
    /** False only on the interim path for OptimizerApiResult (no dep/arr split on that legacy result): rows unknown, only requiredMps real. */
    itemized: boolean
    departureFallbackMps: number
    dsmMps: number
    arrivalMps: number
    requiredMps: number
    availableMps: number | null
    marginMps: number | null
    propellantRequiredKg: number | null
    propellantAvailableKg: number
    /** m_wet/m_dry the requirement demands (chemical stages top out ~10-15); backend path only. */
    massRatioRequired: number | null
    feasible: boolean | null
  }
}

// Map the backend's pool + launch check onto the card's launcher verdict.
// `reason` strings come from design.rs (tested there): "can inject at most
// ... kg" (mass-limited) vs "verified performance range" / "no verified"
// (C3 beyond the data) -- matched loosely, never parsed for numbers.
function launcherStatus(
  pool: DvLedgerApiResult["departure_dv_pool"] | null,
  launchCheck: LaunchVehicleCheckApiResult | null | undefined,
): LauncherStatus {
  if (!launchCheck) return "no_vehicle"
  if (pool === "launcher" || (pool == null && launchCheck.feasible)) return "covers"
  if (pool === "split") return "split"
  const reason = launchCheck.reason ?? ""
  if (/verified/i.test(reason) || (reason === "" && launchCheck.max_injected_mass_kg == null)) return "exceeds_verified_c3"
  return "mass_exceeded"
}

export interface InterimLedgerInputs {
  dvDepartureMs: number | null | undefined
  /** Objective-aware arrival ΔV (0 for Flyby). */
  dvArrivalMs: number | null | undefined
  dsmMs?: number | null
  ispS: number | null | undefined
  /** Backend's own onboard total (dv_budget_ms − budget_margin_ms) when no dep/arr split exists -- used verbatim as requiredMps, rows un-itemized. */
  onboardRequiredTotalMps?: number | null
  /** Mission total ΔV; with onboardRequiredTotalMps, the launcher-covered departure is total − onboard. */
  dvTotalMs?: number | null
}

export function buildDvLedger(params: {
  /** The backend's ledger. Preferred whenever present. */
  ledger: DvLedgerApiResult | null | undefined
  launchCheck: LaunchVehicleCheckApiResult | null | undefined
  wetMassKg: number
  propellantMassKg: number
  /** Only consulted when `ledger` is absent (pre-14e cached result). */
  interim: InterimLedgerInputs
}): DvLedger {
  const { ledger, launchCheck, wetMassKg, propellantMassKg, interim } = params
  const launcherCommon = {
    vehicle: launchCheck?.vehicle ?? null,
    requiredC3Km2s2: launchCheck?.required_c3_km2s2 ?? null,
    maxC3AtMassKm2s2: launchCheck?.max_c3_at_mass_km2s2 ?? null,
    maxInjectedMassKg: launchCheck?.max_injected_mass_kg ?? null,
    spacecraftMassKg: launchCheck?.spacecraft_mass_kg ?? null,
    marginKg: launchCheck?.margin_kg ?? null,
    reason: launchCheck?.reason ?? null,
  }

  if (ledger) {
    const status = launcherStatus(ledger.departure_dv_pool, launchCheck)
    const available = ledger.onboard_dv_available_ms ?? null
    return {
      source: "backend",
      launcher: {
        ...launcherCommon,
        status,
        coveredMps: ledger.launcher_dv_ms,
        departureTotalMps: ledger.departure_dv_ms,
      },
      onboard: {
        itemized: true,
        departureFallbackMps: ledger.onboard_departure_dv_ms,
        dsmMps: ledger.onboard_dsm_dv_ms,
        arrivalMps: ledger.onboard_arrival_dv_ms,
        requiredMps: ledger.onboard_dv_required_ms,
        availableMps: available,
        marginMps: ledger.budget_margin_ms ?? (available != null ? available - ledger.onboard_dv_required_ms : null),
        propellantRequiredKg: ledger.onboard_propellant_required_kg ?? null,
        propellantAvailableKg: propellantMassKg,
        massRatioRequired: ledger.mass_ratio_required ?? null,
        feasible: ledger.propellant_feasible ?? (available != null ? ledger.onboard_dv_required_ms <= available : null),
      },
    }
  }

  // ── Interim (pre-14e result): all-or-nothing launcher, rocket equation here ──
  const { dvDepartureMs, dvArrivalMs, dsmMs, ispS, onboardRequiredTotalMps, dvTotalMs } = interim
  const itemized = onboardRequiredTotalMps == null
  const dep = itemized
    ? (dvDepartureMs ?? 0)
    : dvTotalMs != null
      ? Math.max(0, dvTotalMs - (onboardRequiredTotalMps ?? 0))
      : 0
  const arr = dvArrivalMs ?? 0
  const dsm = Math.max(0, dsmMs ?? 0)
  const status = launcherStatus(null, launchCheck)
  const covers = status === "covers"
  const coveredMps = covers ? dep : 0
  const departureFallbackMps = covers ? 0 : dep
  const requiredMps = itemized ? departureFallbackMps + dsm + arr : Math.max(0, onboardRequiredTotalMps ?? 0)
  const canRocketEq = ispS != null && ispS > 0 && wetMassKg > propellantMassKg && propellantMassKg > 0
  const availableMps = canRocketEq ? ispS * G0 * Math.log(wetMassKg / (wetMassKg - propellantMassKg)) : null
  const propellantRequiredKg = ispS != null && ispS > 0 ? wetMassKg * (1 - Math.exp(-requiredMps / (ispS * G0))) : null

  return {
    source: "interim",
    launcher: { ...launcherCommon, status, coveredMps, departureTotalMps: dep },
    onboard: {
      itemized,
      departureFallbackMps: itemized ? departureFallbackMps : 0,
      dsmMps: itemized ? dsm : 0,
      arrivalMps: itemized ? arr : 0,
      requiredMps,
      availableMps,
      marginMps: availableMps != null ? availableMps - requiredMps : null,
      propellantRequiredKg,
      propellantAvailableKg: propellantMassKg,
      massRatioRequired: null,
      feasible: availableMps != null ? requiredMps <= availableMps : null,
    },
  }
}
