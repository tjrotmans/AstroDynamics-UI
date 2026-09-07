import { useEffect } from "react"
import { AlertCircle, Loader2 } from "lucide-react"

import { MgaSequenceEditor } from "./MgaSequenceEditor"
import { PaperField, PaperFieldGrid, PaperInput } from "./paperForm"
import { useMissionStore } from "@/stores/missionStore"
import type { components } from "@/api/types"

type MgaScanConfig = components["schemas"]["MgaScanConfig"]

const DEFAULT_HORIZON_YEARS = 4
const EMPTY_BODIES: string[] = []

// The MGA sub-window's content: sequence picker (MgaSequenceEditor, at the
// top per) -> scan settings -> Run -> results. A
// ballistic grid scan over a wide departure-date window: each leg is a
// pure Lambert arc, with an impulsive burn only where needed at each flyby
// to bridge the incoming/outgoing turn angle -- no mid-leg deep-space
// maneuvers and no propagation, unlike the real optimizer below.
export function MgaScanSection({
  onRun,
  running,
  error,
}: {
  onRun: () => void
  running: boolean
  error?: string
}) {
  const flybyBodies = useMissionStore((s) => s.config.optimization?.mga?.flyby_bodies ?? EMPTY_BODIES)
  const candidateBodies = useMissionStore(
    (s) => s.config.optimization?.mga?.sequence_search?.candidate_bodies ?? EMPTY_BODIES,
  )
  const isAuto = useMissionStore((s) => s.config.optimization?.mga?.sequence_search != null)
  const scan = useMissionStore((s) => s.config.optimization?.mga?.scan)
  const setMgaScanConfig = useMissionStore((s) => s.setMgaScanConfig)

  const hasSequence = isAuto ? candidateBodies.length > 0 : flybyBodies.length > 0

  // Seed the required [optimization.mga.scan] section as soon as there's a
  // real sequence to scan -- the horizon-years default shown in the field
  // below is otherwise ONLY a display placeholder, never actually written
  // to the store, so a user who never edits a field (the common case,
  // since the defaults are usually fine) would click Run MGA scan and get
  // a real 422 ("this config has no [optimization.mga.scan] section").
  // Found live. Mirrors the existing enableOptimization() precedent for
  // auto-populating a required nested config the first time it's needed.
  useEffect(() => {
    if (hasSequence && !scan) setMgaScanConfig({ horizon_years: DEFAULT_HORIZON_YEARS })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSequence, scan])

  const horizonYears = scan?.horizon_years ?? DEFAULT_HORIZON_YEARS
  const update = (fields: Partial<MgaScanConfig>) => setMgaScanConfig({ horizon_years: horizonYears, ...scan, ...fields })

  return (
    <div className="flex flex-col gap-4">
      <MgaSequenceEditor />

      <div className="border-t border-[#dedbd2] pt-3">
        <PaperFieldGrid>
          <PaperField label="Scan horizon (years)" htmlFor="mga-scan-horizon" note="Centered on the departure epoch.">
            <PaperInput
              id="mga-scan-horizon"
              value={horizonYears}
              min={0.1}
              onChange={(v) => update({ horizon_years: v === "" ? DEFAULT_HORIZON_YEARS : Number(v) })}
            />
          </PaperField>
          <PaperField
            label="Departure step (days)"
            htmlFor="mga-scan-dep-step"
            note="Spacing between scanned departure dates. 5 means a candidate is evaluated every 5 days across the horizon window above."
          >
            <PaperInput
              id="mga-scan-dep-step"
              value={scan?.departure_step_days ?? ""}
              placeholder="5"
              onChange={(v) => update({ departure_step_days: v === "" ? undefined : Number(v) })}
            />
          </PaperField>
        </PaperFieldGrid>
        <PaperField
          label="TOF grid points per leg"
          htmlFor="mga-scan-tof-points"
          note="Spans each leg's TOF bounds set in the Optimizer's MGA fields below."
        >
          <PaperInput
            id="mga-scan-tof-points"
            value={scan?.tof_grid_points_per_leg ?? ""}
            placeholder="40"
            onChange={(v) => update({ tof_grid_points_per_leg: v === "" ? undefined : Number(v) })}
          />
        </PaperField>
        {/* Re-exposed (previously removed as "Advanced (scan
            pruning)"; the other field that lived alongside it, max_records,
            stays hidden -- it's a safety cap on stored results, not a search
            constraint) after a user found the scan reporting no ΔV
            advantage for a sequence the real Optimizer later confirmed WAS
            competitive. Root cause: this cap prunes any branch whose
            powered-flyby correction burn exceeds it, silently, before the
            branch is ever shown -- a real, direct explanation for "the scan
            can't find anything good" that the user had no way to test
            without this control. */}
        <PaperField
          label="Flyby ΔV cap (m/s)"
          htmlFor="mga-scan-flyby-dv-cap"
          note="Branches needing a bigger powered-flyby correction burn than this are silently dropped. Raise it if the scan is finding nothing competitive."
        >
          <PaperInput
            id="mga-scan-flyby-dv-cap"
            value={scan?.flyby_dv_max_ms ?? ""}
            placeholder="3000"
            onChange={(v) => update({ flyby_dv_max_ms: v === "" ? undefined : Number(v) })}
          />
        </PaperField>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRun}
            disabled={running || !hasSequence}
            className="flex items-center gap-1.5 border-[1.5px] border-[#171512] bg-[#171512] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#fbfaf6] uppercase hover:border-[#f24d00] hover:bg-[#f24d00] disabled:opacity-40"
          >
            {running && <Loader2 className="size-3.5 animate-spin" />}
            Run MGA scan
          </button>
          {!hasSequence && (
            <span className="text-[10.5px] text-[#8b877d]">Pick a candidate body above to enable.</span>
          )}
          {error && (
            <span className="inline-flex items-center gap-1 text-[10.5px] text-[#f24d00]">
              <AlertCircle className="size-3.5" /> {error}
            </span>
          )}
          {running && (
            <span className="text-[10.5px] text-[#8b877d]">
              No cancel available for this job type. The backend has no stop endpoint for it yet.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
