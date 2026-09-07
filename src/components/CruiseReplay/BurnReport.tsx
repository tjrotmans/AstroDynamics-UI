import { useMemo } from "react"

import type { components } from "@/api/types"
import type { CruiseStepMsg, PlannedBurnConfig } from "@/api/client"

type PlannedBurnReport = components["schemas"]["PlannedBurnReport"]

// Per-burn report card: the
// mission's verdict mostly IS its burns, so each planned burn gets a row
// comparing plan vs. what the sim actually did.
//
// Sources, in priority order:
// 1. `CruiseResult.planned_burn_reports` -- the
//    executive's OWN record per planned burn: slew start, ignition,
//    completion, and a status (Completed / MissedBurnTimeout /
//    NotReached). Authoritative when present.
// 2. Otherwise, contiguous runs of tick.tcm_phase === "Burning", matched to
//    a planned burn by the tick's `planned_burn_idx` (backend, same day)
//    when streamed, or by nearest epoch against an older server.
// Propellant is always the tcm_propellant_kg_cum delta across the burn
// window (main-engine tank). Delivered ΔV as a vector is deliberately
// absent -- not streamed; deriving it from dr/dv-vs-reference would be
// guesswork.

interface BurnWindow {
  startS: number
  endS: number
  slewStartS: number | null
  propellantKg: number
  plannedIdx: number | null
}

function findBurnWindows(steps: CruiseStepMsg[]): BurnWindow[] {
  const windows: BurnWindow[] = []
  let burnStart: number | null = null
  let burnStartIdx = 0
  for (let i = 0; i < steps.length; i++) {
    const burning = steps[i].tcm_phase === "Burning"
    if (burning && burnStart == null) {
      burnStart = steps[i].t_s
      burnStartIdx = i
    }
    if (!burning && burnStart != null) {
      windows.push(makeWindow(steps, burnStart, burnStartIdx, i))
      burnStart = null
    }
  }
  if (burnStart != null) windows.push(makeWindow(steps, burnStart, burnStartIdx, steps.length - 1))
  return windows
}

function makeWindow(steps: CruiseStepMsg[], startS: number, startIdx: number, endIdx: number): BurnWindow {
  let slewStartS: number | null = null
  for (let j = startIdx - 1; j >= 0; j--) {
    if (steps[j].tcm_phase === "Slewing") slewStartS = steps[j].t_s
    else break
  }
  const last = Math.min(endIdx, steps.length - 1)
  const propellantKg = steps[last].tcm_propellant_kg_cum - steps[Math.max(0, startIdx - 1)].tcm_propellant_kg_cum
  return { startS, endS: steps[last].t_s, slewStartS, propellantKg, plannedIdx: steps[startIdx].planned_burn_idx ?? null }
}

function propellantBetween(steps: CruiseStepMsg[], t0: number, t1: number): number | null {
  const a = steps.find((s) => s.t_s >= t0)
  let b: CruiseStepMsg | undefined
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].t_s <= t1) {
      b = steps[i]
      break
    }
  }
  if (!a || !b) return null
  return b.tcm_propellant_kg_cum - a.tcm_propellant_kg_cum
}

const fmtT = (tS: number) => `${(tS / 86_400).toFixed(2)} d`
function fmtDur(s: number): string {
  if (s < 120) return `${s.toFixed(0)} s`
  if (s < 7200) return `${(s / 60).toFixed(1)} min`
  return `${(s / 3600).toFixed(1)} h`
}

interface Row {
  label: string
  plannedS: number
  dvMps: number
  ignitionS: number | null
  slewStartS: number | null
  completedS: number | null
  propellantKg: number | null
  status: string
}

export function BurnReport({
  plannedBurns,
  steps,
  reports,
  onSeek,
}: {
  // Already rebased onto the mission timeline (t=0 at reference[0]).
  plannedBurns: PlannedBurnConfig[]
  steps: CruiseStepMsg[]
  reports: PlannedBurnReport[]
  onSeek: (tS: number) => void
}) {
  const windows = useMemo(() => findBurnWindows(steps), [steps])

  const { rows, reactive } = useMemo(() => {
    const used = new Set<number>()
    const rows: Row[] = plannedBurns.map((b, i) => {
      const [dx, dy, dz] = b.dv_inertial_mps
      const dvMps = Math.hypot(dx, dy, dz)
      const label = (b.label ?? `burn ${i + 1}`).replace(/\s*\(interim.*\)$/, " (interim ΔV)")
      const report = reports.find((r) => r.index === i)
      if (report) {
        // Mark the matching tick window as consumed so it isn't also
        // counted as a reactive burn.
        const wi = windows.findIndex((w) => w.plannedIdx === i || (report.ignition_s != null && Math.abs(w.startS - report.ignition_s) < 1))
        if (wi >= 0) used.add(wi)
        const propellantKg =
          report.ignition_s != null ? propellantBetween(steps, report.ignition_s, report.completed_s ?? steps[steps.length - 1].t_s) : null
        return {
          label,
          plannedS: report.configured_epoch_s,
          dvMps,
          ignitionS: report.ignition_s ?? null,
          slewStartS: report.slew_start_s ?? null,
          completedS: report.completed_s ?? null,
          propellantKg,
          status: report.status,
        }
      }
      // No backend report: tick-derived fallback, planned_burn_idx first.
      let wi = windows.findIndex((w, k) => !used.has(k) && w.plannedIdx === i)
      if (wi < 0) {
        let best = Infinity
        windows.forEach((w, k) => {
          if (used.has(k) || w.plannedIdx != null) return
          const d = Math.abs(w.startS - b.epoch_s)
          if (d < best) {
            best = d
            wi = k
          }
        })
      }
      if (wi >= 0) used.add(wi)
      const w = wi >= 0 ? windows[wi] : null
      return {
        label,
        plannedS: b.epoch_s,
        dvMps,
        ignitionS: w?.startS ?? null,
        slewStartS: w?.slewStartS ?? null,
        completedS: w?.endS ?? null,
        propellantKg: w?.propellantKg ?? null,
        status: w ? "Completed" : "never fired",
      }
    })
    const reactive = windows.filter((w, k) => !used.has(k) && w.plannedIdx == null)
    return { rows, reactive }
  }, [plannedBurns, windows, reports, steps])

  if (plannedBurns.length === 0 && windows.length === 0) return null

  return (
    <div className="mt-6">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Burn report — planned vs. executed{reports.length > 0 ? "" : " (tick-derived; server sent no planned_burn_reports)"}
      </div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[11px]" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr className="border-b border-border text-left text-[9px] uppercase tracking-wider text-muted-foreground">
              <th className="px-2 py-1.5 font-semibold">burn</th>
              <th className="px-2 py-1.5 font-semibold">planned t</th>
              <th className="px-2 py-1.5 font-semibold">planned |ΔV|</th>
              <th className="px-2 py-1.5 font-semibold">ignition</th>
              <th className="px-2 py-1.5 font-semibold">delay</th>
              <th className="px-2 py-1.5 font-semibold">slew</th>
              <th className="px-2 py-1.5 font-semibold">burn</th>
              <th className="px-2 py-1.5 font-semibold">propellant</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const fired = r.ignitionS != null
              const delay = fired ? r.ignitionS! - r.plannedS : null
              return (
                <tr
                  key={i}
                  className="cursor-pointer border-b border-border/50 hover:bg-orange-500/10"
                  onClick={() => onSeek(r.ignitionS ?? r.slewStartS ?? r.plannedS)}
                  title="Click to seek the replay here"
                >
                  <td className="px-2 py-1.5">{r.label}</td>
                  <td className="px-2 py-1.5">{fmtT(r.plannedS)}</td>
                  <td className="px-2 py-1.5">{r.dvMps.toFixed(1)} m/s</td>
                  {!fired && r.status.startsWith("Completed") ? (
                    // e.g. "Completed (external stage)": an impulsive
                    // launcher-delivered injection -- no slew/ignition window
                    // of its own, no propellant draw.
                    <td className="px-2 py-1.5 text-white/70" colSpan={5}>
                      {r.status} — impulsive at the planned epoch, no onboard propellant
                    </td>
                  ) : fired ? (
                    <>
                      <td className="px-2 py-1.5">{fmtT(r.ignitionS!)}</td>
                      <td className={`px-2 py-1.5 ${Math.abs(delay!) > 3600 ? "text-amber-400" : ""}`}>
                        {fmtDur(Math.abs(delay!))}
                        {delay! < 0 ? " early" : " late"}
                      </td>
                      <td className="px-2 py-1.5">{r.slewStartS != null ? fmtDur(r.ignitionS! - r.slewStartS) : "—"}</td>
                      <td className="px-2 py-1.5">{r.completedS != null ? fmtDur(r.completedS - r.ignitionS!) : "—"}</td>
                      <td className="px-2 py-1.5">{r.propellantKg != null ? `${r.propellantKg.toFixed(2)} kg` : "—"}</td>
                    </>
                  ) : (
                    <td className="px-2 py-1.5 font-semibold text-red-400" colSpan={5}>
                      {r.status === "MissedBurnTimeout"
                        ? `missed — attitude never settled within the go/no-go window${r.slewStartS != null ? ` (slew began ${fmtT(r.slewStartS)})` : ""}`
                        : r.status === "NotReached"
                          ? "not reached — leg ended before the burn window"
                          : "never fired"}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {reactive.length > 0 && (
        <p className="mt-1 text-[10px] text-white/40">
          + {reactive.length} reactive TCM burn{reactive.length > 1 ? "s" : ""} (dispersion-triggered, not planned),{" "}
          {reactive.reduce((a, w) => a + w.propellantKg, 0).toFixed(2)} kg total — first at{" "}
          <button className="underline hover:text-orange-400" onClick={() => onSeek(reactive[0].startS)}>
            {fmtT(reactive[0].startS)}
          </button>
        </p>
      )}
    </div>
  )
}
