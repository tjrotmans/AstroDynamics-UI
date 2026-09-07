import { useState } from "react"
import { ArrowDown, ArrowUp, Loader2, Trash2 } from "lucide-react"

import type { RankedSequenceApi } from "@/api/client"
import { DEFAULT_MGA_BASE, DEFAULT_SEQUENCE_SEARCH, syncLegTofToLegCount } from "./mgaHelpers"
import { PaperField, PaperFieldGrid, PaperHint, PaperInput, PaperSectionLabel, PaperSelect } from "./paperForm"
import { useBodies, useSearchMgaSequences } from "@/hooks/useApi"
import { useMgaScanStore } from "@/stores/mgaScanStore"
import { useMissionStore } from "@/stores/missionStore"

const EMPTY: string[] = []

// The flyby-sequence picker, at the top of the MGA sub-window (
// user changed their mind twice on placement: first Mission Definition,
// then the left margin, now here -- "its better to make it the beginning
// of the MGA transfer window, where [we] explain we first have to do a
// tisserand beam search... Then, the sequence appears below it that is
// found, and its editable").
//
// "Run Tisserand search" (added once the backend support landed --
// POST /api/mga-sequence-search, the design notes "Blocked on backend" #17) runs
// just the beam search and shows every ranked candidate sequence; clicking
// one adopts it as the manual sequence via the same applySequence path the
// add/reorder/remove controls use. "Run MGA scan" below is still the only
// way to get a real ballistic-scan porkchop for a sequence -- this button
// is purely for seeing the ranked field before paying for that.
//
// Two-phase reveal, unchanged: before any scan result exists (and no
// manual sequence already exists from a preset/landing route), only the
// candidate-body checklist + Max legs show -- no sequence list yet. Once
// mgaScanStore's result exists, or a manual sequence already exists, the
// sequence list appears with add/reorder/remove controls; editing it
// converts Auto -> Manual the same way it always has.
export function MgaSequenceEditor() {
  const optimization = useMissionStore((s) => s.config.optimization)
  const setOptimizationMethod = useMissionStore((s) => s.setOptimizationMethod)
  const setMgaParams = useMissionStore((s) => s.setMgaParams)
  const scanResult = useMgaScanStore((s) => s.result)
  const { data: bodiesData } = useBodies()
  const [pendingBody, setPendingBody] = useState("")
  const sequenceSearch = useSearchMgaSequences()
  const [ranked, setRanked] = useState<RankedSequenceApi[] | null>(null)

  const departureBodyName = optimization?.departure_body ?? ""
  const targetBodyName = optimization?.target_body ?? ""
  const mga = optimization?.mga
  const search = mga?.sequence_search ?? null
  const flybyBodies = mga?.flyby_bodies ?? EMPTY
  const isManual = search == null

  const hasScanned = scanResult != null
  const showSequenceList = hasScanned || flybyBodies.length > 0

  // Real discovered sequence from the latest scan, not re-derived -- only
  // meaningful while Auto is active (a discovered sequence found under a
  // now-abandoned Auto config would be stale/misleading to keep showing).
  const discovered =
    isManual || !scanResult || scanResult.body_sequence.length <= 2 ? null : scanResult.body_sequence.slice(1, -1)
  const displayedSequence = isManual ? flybyBodies : (discovered ?? EMPTY)

  // Only the Sun is excluded -- the departure/target bodies ARE legitimate
  // intermediate (resonant-return) flybys, see VEEGA/Cassini-2 presets.
  const availableBodies = (bodiesData?.bodies ?? []).filter((b) => b.name !== "Sun")

  function applySequence(next: string[]) {
    if (optimization?.method !== "MGA") setOptimizationMethod("MGA")
    const base = useMissionStore.getState().config.optimization?.mga ?? DEFAULT_MGA_BASE
    useMissionStore.getState().setMgaParams({
      ...base,
      flyby_bodies: next,
      sequence_search: null,
      leg_tof_days: syncLegTofToLegCount(base.leg_tof_days, next.length + 1),
    })
  }

  const addBody = () => {
    if (!pendingBody) return
    applySequence([...displayedSequence, pendingBody])
    setPendingBody("")
  }
  const removeBody = (idx: number) => applySequence(displayedSequence.filter((_, i) => i !== idx))
  const moveBody = (idx: number, direction: -1 | 1) => {
    const target = idx + direction
    if (target < 0 || target >= displayedSequence.length) return
    const next = [...displayedSequence]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    applySequence(next)
  }

  const useAutoSearch = () => {
    if (optimization?.method !== "MGA") setOptimizationMethod("MGA")
    const base = useMissionStore.getState().config.optimization?.mga ?? DEFAULT_MGA_BASE
    useMissionStore.getState().setMgaParams({ ...base, flyby_bodies: [], sequence_search: DEFAULT_SEQUENCE_SEARCH })
  }

  const activeSearch = search ?? DEFAULT_SEQUENCE_SEARCH
  const toggleCandidate = (name: string) => {
    const exists = activeSearch.candidate_bodies.includes(name)
    const candidate_bodies = exists
      ? activeSearch.candidate_bodies.filter((n) => n !== name)
      : [...activeSearch.candidate_bodies, name]
    const base = mga ?? DEFAULT_MGA_BASE
    setMgaParams({ ...base, flyby_bodies: [], sequence_search: { ...activeSearch, candidate_bodies } })
  }
  const setMaxLegs = (value: string) => {
    const base = mga ?? DEFAULT_MGA_BASE
    setMgaParams({ ...base, flyby_bodies: [], sequence_search: { ...activeSearch, max_legs: value === "" ? 3 : Number(value) } })
  }

  const runSequenceSearch = () => {
    if (optimization?.method !== "MGA") setOptimizationMethod("MGA")
    const base = mga ?? DEFAULT_MGA_BASE
    setMgaParams({ ...base, sequence_search: activeSearch })
    setRanked(null)
    // Read back after the store write above so the request carries the
    // candidate pool/max_legs this click actually triggered on.
    const config = useMissionStore.getState().config
    sequenceSearch.mutate(config, { onSuccess: (result) => setRanked(result.sequences) })
  }

  const applyRankedSequence = (seq: RankedSequenceApi) => applySequence(seq.flyby_bodies)

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[62ch] text-[12px] text-[#55524b]">
        A Tisserand beam search looks for useful gravity-assist sequences from a pool of candidate bodies. Pick
        candidates below, then run the search to see every ranked candidate sequence before committing to the
        full (slower) scan below.
      </p>

      <div className="flex flex-col gap-1.5">
        <PaperSectionLabel>Candidate flyby bodies</PaperSectionLabel>
        <PaperHint>Pool the Tisserand beam search may route through. Repeated visits are allowed.</PaperHint>
        <PaperField label="Max legs" htmlFor="mga-seq-max-legs" note="Max intermediate flybys plus 1.">
          <PaperInput id="mga-seq-max-legs" min={1} value={activeSearch.max_legs} onChange={setMaxLegs} />
        </PaperField>
        <div className="grid max-h-[160px] grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto">
          {availableBodies.map((body) => (
            <label key={body.name} className="flex items-center gap-1.5 text-[11.5px] text-[#171512]">
              <input
                type="checkbox"
                checked={activeSearch.candidate_bodies.includes(body.name)}
                onChange={() => toggleCandidate(body.name)}
                className="size-[13px] accent-[#f24d00]"
              />
              {body.name}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={activeSearch.candidate_bodies.length === 0 || sequenceSearch.isPending}
          onClick={runSequenceSearch}
          className="flex w-fit items-center gap-1.5 border border-[#dedbd2] px-2.5 py-1.5 text-[10.5px] font-bold text-[#171512] uppercase hover:border-[#f24d00] hover:text-[#f24d00] disabled:opacity-30"
        >
          {sequenceSearch.isPending && <Loader2 className="size-3 animate-spin" />}
          Run Tisserand search
        </button>
        {sequenceSearch.isError && (
          <PaperHint>{(sequenceSearch.error as Error).message}</PaperHint>
        )}
        {ranked && ranked.length === 0 && <PaperHint>No candidate sequences found for this pool.</PaperHint>}
        {ranked && ranked.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-[#dedbd2] pt-1.5">
            <PaperSectionLabel>Ranked candidates</PaperSectionLabel>
            <PaperHint>
              Full route shown below (departure → target included). "v∞" is the estimated arrival excess
              velocity at your target from the Tisserand graph walk -- lower is a gentler, more resonance-matched
              arrival. "score" is this search's own ranking cost (lower = better; not a physical unit, just the
              sort key) -- both are cheap estimates to help you pick a sequence worth scanning/optimizing further,
              not a guarantee the full scan below will find a feasible trajectory.
            </PaperHint>
            {ranked.map((seq, i) => (
              <button
                key={i}
                type="button"
                onClick={() => applyRankedSequence(seq)}
                className="flex items-center justify-between gap-2 border border-transparent px-1.5 py-1 text-left text-[11.5px] text-[#171512] hover:border-[#dedbd2] hover:bg-[#f4f2ec]"
              >
                <span>
                  {/* Full chain, not just flyby_bodies -- RankedSequenceApi.flyby_bodies is
                      intermediate-only by API contract (excludes departure/target), so showing it bare made
                      e.g. flyby_bodies=["Earth","Mars"] (a resonant Earth return, then Mars) read as if the
 route skipped straight to Mars. Real user confusion, fixed. */}
                  {[departureBodyName, ...seq.flyby_bodies, targetBodyName].filter(Boolean).join(" → ")}
                </span>
                <span className="shrink-0 text-[10px] text-[#8b877d]">
                  v∞ {(seq.estimated_vinf_arr_ms / 1000).toFixed(2)} km/s &middot; score{" "}
                  {seq.tisserand_score.toFixed(2)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!showSequenceList && (
        <PaperHint>Run a Tisserand search above, or Run MGA scan below, to discover a sequence.</PaperHint>
      )}

      {showSequenceList && (
        <div className="flex flex-col gap-1.5 border-t border-[#dedbd2] pt-3">
          <div className="flex items-center justify-between">
            <PaperSectionLabel>{isManual ? "Sequence (manual)" : "Sequence (discovered)"}</PaperSectionLabel>
            {isManual && (
              <button
                type="button"
                onClick={useAutoSearch}
                className="text-[10px] font-bold text-[#8b877d] uppercase underline hover:text-[#f24d00]"
              >
                Use Auto search instead
              </button>
            )}
          </div>
          {displayedSequence.length === 0 && (
            <PaperHint>{isManual ? "No intermediate flybys, direct transfer." : "No sequence found yet."}</PaperHint>
          )}
          {displayedSequence.map((name, idx) => (
            <div key={`${name}-${idx}`} className="flex items-center gap-1.5">
              <span className="w-4 text-[10px] text-[#8b877d]">{idx + 1}.</span>
              <span className="flex-1 text-[12px] font-semibold text-[#171512]">{name}</span>
              <button
                type="button"
                disabled={idx === 0}
                onClick={() => moveBody(idx, -1)}
                className="text-[#8b877d] hover:text-[#f24d00] disabled:opacity-30"
              >
                <ArrowUp className="size-3" />
              </button>
              <button
                type="button"
                disabled={idx === displayedSequence.length - 1}
                onClick={() => moveBody(idx, 1)}
                className="text-[#8b877d] hover:text-[#f24d00] disabled:opacity-30"
              >
                <ArrowDown className="size-3" />
              </button>
              <button type="button" onClick={() => removeBody(idx)} className="text-[#8b877d] hover:text-[#f24d00]">
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
          <PaperFieldGrid>
            <div className="flex items-center gap-1.5">
              <PaperSelect
                value={pendingBody}
                placeholder="+ add a flyby"
                options={availableBodies.map((b) => ({ value: b.name, label: b.name }))}
                onChange={setPendingBody}
              />
              <button
                type="button"
                disabled={!pendingBody}
                onClick={addBody}
                className="shrink-0 border border-[#dedbd2] px-2 py-1.5 text-[10.5px] font-bold text-[#171512] uppercase hover:border-[#f24d00] hover:text-[#f24d00] disabled:opacity-30"
              >
                Add
              </button>
            </div>
          </PaperFieldGrid>
        </div>
      )}
    </div>
  )
}
