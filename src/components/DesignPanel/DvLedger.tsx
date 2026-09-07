import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react"

import type { DvLedger as Ledger } from "@/lib/dvLedger"

// Two-pool ΔV ledger card -- replaces the old "Budget margin /
// Onboard propellant req'd / <vehicle> departure feasibility" trio, which
// mixed the launcher pool into one margin number and never said how much
// of the departure the launcher actually removes from the tank. Layout:
// LAUNCHER pool on the left (departure), ONBOARD pool on the right
// (arrival always, plus DSMs and any departure remainder), each with its
// own verdict. Numbers come from the backend's dv_ledger via
// lib/dvLedger.ts (Phase 14e); partial launcher coverage ("split") is real
// since the same day -- the launcher gives its maximum C3 at this mass and
// the spacecraft tops up from the same periapsis.
const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })

export function DvLedgerCard({ ledger }: { ledger: Ledger }) {
  const { launcher: L, onboard: O } = ledger
  const launcherTone =
    L.status === "covers"
      ? "text-emerald-400"
      : L.status === "split"
        ? "text-sky-300"
        : L.status === "no_vehicle"
          ? "text-muted-foreground"
          : "text-amber-400"
  const LauncherIcon =
    L.status === "covers" || L.status === "split" ? CheckCircle2 : L.status === "exceeds_verified_c3" ? HelpCircle : AlertTriangle
  const onboardTone = O.feasible == null ? "text-muted-foreground" : O.feasible ? "text-emerald-400" : "text-red-400"
  const OnboardIcon = O.feasible === false ? AlertTriangle : CheckCircle2
  const c3 = L.requiredC3Km2s2?.toFixed(1)

  return (
    <div className="grid gap-3 sm:grid-cols-2" style={{ fontVariantNumeric: "tabular-nums" }}>
      {/* ── Launcher pool ── */}
      <div className="rounded-md border border-border p-3">
        <div className={`flex items-center gap-2 text-sm font-medium ${launcherTone}`}>
          <LauncherIcon className="size-4" />
          Launcher pool — departure
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {L.status === "no_vehicle" && "No launch vehicle selected: the departure injection is charged to the tank."}
          {L.status === "covers" &&
            `${L.vehicle} delivers ${fmt(L.spacecraftMassKg ?? 0)} kg at C3 ${c3} km²/s²${
              L.maxInjectedMassKg != null ? ` (can inject up to ${fmt(L.maxInjectedMassKg)} kg, ${fmt(L.marginKg ?? 0)} kg spare)` : ""
            } — the whole ${fmt(L.coveredMps)} m/s departure comes off the onboard budget.`}
          {L.status === "split" &&
            `${L.vehicle} cannot reach C3 ${c3} km²/s² with ${fmt(L.spacecraftMassKg ?? 0)} kg${
              L.maxC3AtMassKm2s2 != null ? ` — its maximum at this mass is ${L.maxC3AtMassKm2s2.toFixed(1)} km²/s²` : ""
            }. It still delivers ${fmt(L.coveredMps)} of the ${fmt(L.departureTotalMps)} m/s departure; the spacecraft adds the remaining ${fmt(
              O.departureFallbackMps,
            )} m/s as a perigee burn from the same parking orbit.`}
          {L.status === "mass_exceeded" &&
            (L.reason ??
              `${L.vehicle} can inject only ${fmt(L.maxInjectedMassKg ?? 0)} kg at C3 ${c3} km²/s² — ${fmt(L.spacecraftMassKg ?? 0)} kg is too heavy, so the whole departure falls to the tank.`)}
          {L.status === "exceeds_verified_c3" &&
            (L.reason ??
              `C3 ${c3} km²/s² is beyond ${L.vehicle}'s verified performance data — unknown, not impossible; no extrapolation, so the departure is charged to the tank.`)}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">Required C3</span>
          <span>{L.requiredC3Km2s2 != null ? `${L.requiredC3Km2s2.toFixed(2)} km²/s²` : "—"}</span>
          {L.maxC3AtMassKm2s2 != null && (
            <>
              <span className="text-muted-foreground">Launcher max C3 at this mass</span>
              <span>{L.maxC3AtMassKm2s2.toFixed(2)} km²/s²</span>
            </>
          )}
          <span className="text-muted-foreground">Departure covered by launcher</span>
          <span>
            {L.status === "covers"
              ? `${fmt(L.coveredMps)} m/s (all of it)`
              : L.status === "split"
                ? `${fmt(L.coveredMps)} of ${fmt(L.departureTotalMps)} m/s`
                : L.status === "no_vehicle"
                  ? "none — no launcher selected"
                  : `0 of ${fmt(L.departureTotalMps)} m/s`}
          </span>
        </div>
        {L.status === "covers" && L.reason && (
          // Seen live the
          // ledger's pool says the launcher pays the whole departure while
          // the same result's launch check says it can't lift the mass.
          // Show both rather than pick one until the backend resolves the inconsistency.
          <p className="mt-2 text-[11px] text-amber-400">
            Launch check disagrees with the ledger's pool: {L.reason}. The ledger above still charges departure to the
            launcher — treat this launcher verdict as unresolved.
          </p>
        )}
        {ledger.source === "interim" && L.status !== "covers" && L.status !== "no_vehicle" && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Cached result from an older version: launcher coverage shown all-or-nothing. Re-run the survey/optimizer for the
            backend's partial-coverage ledger.
          </p>
        )}
      </div>

      {/* ── Onboard pool ── */}
      <div className="rounded-md border border-border p-3">
        <div className={`flex items-center gap-2 text-sm font-medium ${onboardTone}`}>
          <OnboardIcon className="size-4" />
          Onboard pool — {O.feasible == null ? "tank unknown" : O.feasible ? "fits the tank" : "exceeds the tank"}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {O.departureFallbackMps > 0 && (
            <>
              <span className="text-muted-foreground">{L.status === "split" ? "Departure top-up" : "Departure (onboard)"}</span>
              <span>{fmt(O.departureFallbackMps)} m/s</span>
            </>
          )}
          {O.dsmMps > 0 && (
            <>
              <span className="text-muted-foreground">Deep-space manoeuvres</span>
              <span>{fmt(O.dsmMps)} m/s</span>
            </>
          )}
          {O.itemized ? (
            <>
              <span className="text-muted-foreground">Arrival / capture</span>
              <span>{fmt(O.arrivalMps)} m/s</span>
            </>
          ) : (
            <span className="col-span-2 text-muted-foreground">
              Per-burn split not reported for this cached result (backend total only)
            </span>
          )}
          <span className="border-t border-border pt-1 font-medium">Required onboard</span>
          <span className="border-t border-border pt-1 font-medium">{fmt(O.requiredMps)} m/s</span>
          <span className="text-muted-foreground">Tank can give (Isp·g₀·ln m_wet/m_dry)</span>
          <span>{O.availableMps != null ? `${fmt(O.availableMps)} m/s` : "— (no main engine configured)"}</span>
          <span className="text-muted-foreground">Margin</span>
          <span className={O.marginMps != null && O.marginMps < 0 ? "text-red-400" : ""}>
            {O.marginMps != null ? `${O.marginMps >= 0 ? "+" : ""}${fmt(O.marginMps)} m/s` : "—"}
          </span>
          <span className="text-muted-foreground">Propellant this needs</span>
          <span>
            {O.propellantRequiredKg != null ? `${fmt(O.propellantRequiredKg)} kg` : "—"} of {fmt(O.propellantAvailableKg)} kg
          </span>
          {O.massRatioRequired != null && (
            <>
              <span className="text-muted-foreground">Mass ratio required</span>
              <span>{O.massRatioRequired.toFixed(2)}</span>
            </>
          )}
        </div>
        {O.feasible === false && (
          <p className="mt-2 text-xs text-red-400">
            A chemical spacecraft cannot fly this: use an MGA (flyby-chain) or low-thrust design, a bigger tank/Isp, or a
            launcher that covers departure.
          </p>
        )}
      </div>
    </div>
  )
}
