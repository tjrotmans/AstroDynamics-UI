import { MgaAdvancedSearchSection } from "@/components/OptimizeStage/MgaAdvancedSearchSection"
import { DEFAULT_MGA_BASE } from "./mgaHelpers"
import { PaperDisclosure, PaperField, PaperFieldGrid, PaperHint, PaperInput, PaperSectionLabel, PaperSelect } from "./paperForm"
import { useMissionStore, type MgaParamsExt } from "@/stores/missionStore"

const DEFAULT_LEG_TOF: [number, number] = [30, 800]

// Paper-native rebuild of the old MgaParamsForm.tsx's core fields --
// departure/arrival v-infinity bounds, per-leg TOF, and the search-method
// select + its MBH/DE budget. The flyby SEQUENCE itself (Auto candidate
// pool / Manual body list) is edited in MgaSequenceEditor.tsx (relocated
// there next to "Run MGA scan") -- this component only shows a
// read-only summary of whatever's configured there now, no editing
// controls of its own, so there's exactly one place sequence edits happen.
// Mounts the existing MgaAdvancedSearchSection (dark, unchanged) for
// everything else -- see the plan's scope decision.
export function MgaParamsFields() {
  const params = (useMissionStore((s) => s.config.optimization?.mga) ?? DEFAULT_MGA_BASE) as MgaParamsExt
  const setMgaParams = useMissionStore((s) => s.setMgaParams)
  const departureBody = useMissionStore((s) => s.config.optimization?.departure_body)
  const targetBody = useMissionStore((s) => s.config.optimization?.target_body)

  const mode: "auto" | "manual" = params.sequence_search ? "auto" : "manual"
  const flybyBodies = params.flyby_bodies ?? []
  const [tofMin, tofMax] = params.leg_tof_days[0] ?? DEFAULT_LEG_TOF
  const legLabels = [departureBody ?? "?", ...flybyBodies, targetBody ?? "?"]

  const setLegTof = (legIdx: number, pair: [number, number]) =>
    setMgaParams({ ...params, leg_tof_days: params.leg_tof_days.map((p, i) => (i === legIdx ? pair : p)) })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <PaperSectionLabel>Sequence</PaperSectionLabel>
        {mode === "manual" ? (
          <p className="text-[12px] font-semibold text-[#171512]">
            {flybyBodies.length === 0 ? (
              <>Direct - no intermediate flybys.</>
            ) : (
              <>{[departureBody, ...flybyBodies, targetBody].filter(Boolean).join(" → ")}</>
            )}
          </p>
        ) : (
          <p className="text-[12px] font-semibold text-[#171512]">
            Auto sequence search over {params.sequence_search?.candidate_bodies.join(", ") || "no candidates picked yet"}
          </p>
        )}
        <PaperHint>Edit the sequence in "MGA scan" above, next to Run MGA scan - this reads it, not edits it.</PaperHint>
      </div>

      {mode === "auto" && (
        <PaperFieldGrid>
          <PaperField label="Leg TOF min (days)" htmlFor="mga-tof-min">
            <PaperInput id="mga-tof-min" value={tofMin} onChange={(v) => setMgaParams({ ...params, leg_tof_days: [[Number(v), tofMax]] })} />
          </PaperField>
          <PaperField label="Leg TOF max (days)" htmlFor="mga-tof-max">
            <PaperInput id="mga-tof-max" value={tofMax} onChange={(v) => setMgaParams({ ...params, leg_tof_days: [[tofMin, Number(v)]] })} />
          </PaperField>
        </PaperFieldGrid>
      )}

      {mode === "manual" && flybyBodies.length > 0 && (
        <div className="flex flex-col gap-2">
          <PaperSectionLabel>Per-leg TOF (days)</PaperSectionLabel>
          {legLabels.slice(0, -1).map((fromName, legIdx) => {
            const [min, max] = params.leg_tof_days[legIdx] ?? DEFAULT_LEG_TOF
            return (
              <div key={legIdx} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                <span className="text-[10.5px] text-[#8b877d]">
                  Leg {legIdx + 1}: {fromName} → {legLabels[legIdx + 1]}
                </span>
                <input
                  type="number"
                  className="w-20 rounded-[3px] border border-[#dedbd2] bg-white px-1.5 py-1 text-[11.5px] text-[#171512]"
                  value={min}
                  onChange={(e) => setLegTof(legIdx, [Number(e.target.value), max])}
                />
                <input
                  type="number"
                  className="w-20 rounded-[3px] border border-[#dedbd2] bg-white px-1.5 py-1 text-[11.5px] text-[#171512]"
                  value={max}
                  onChange={(e) => setLegTof(legIdx, [min, Number(e.target.value)])}
                />
              </div>
            )
          })}
        </div>
      )}

      <PaperFieldGrid>
        <PaperField label="Departure v-inf min (m/s)" htmlFor="mga-vinf-dep-min">
          <PaperInput id="mga-vinf-dep-min" value={params.departure_vinf_min_ms ?? 0} onChange={(v) => setMgaParams({ ...params, departure_vinf_min_ms: Number(v) })} />
        </PaperField>
        <PaperField label="Departure v-inf max (m/s)" htmlFor="mga-vinf-dep-max">
          <PaperInput id="mga-vinf-dep-max" value={params.departure_vinf_max_ms ?? 15000} onChange={(v) => setMgaParams({ ...params, departure_vinf_max_ms: Number(v) })} />
        </PaperField>
      </PaperFieldGrid>
      <PaperField label="Arrival v-inf max (m/s)" htmlFor="mga-vinf-arr-max">
        <PaperInput id="mga-vinf-arr-max" value={params.arrival_vinf_max_ms ?? 25000} onChange={(v) => setMgaParams({ ...params, arrival_vinf_max_ms: Number(v) })} />
      </PaperField>

      <PaperField label="Search method" htmlFor="mga-search-method">
        <PaperSelect
          id="mga-search-method"
          value={params.search_method ?? "Mbh"}
          options={[
            { value: "Mbh", label: "Monotonic Basin Hopping (default)" },
            { value: "De", label: "Differential Evolution (SHADE)" },
          ]}
          onChange={(v) => setMgaParams({ ...params, search_method: v })}
        />
      </PaperField>

      {(params.search_method ?? "Mbh") === "Mbh" ? (
        <div className="flex flex-col gap-1.5">
          <PaperSectionLabel>MBH budget</PaperSectionLabel>
          <div className="grid grid-cols-3 gap-3">
            <PaperField label="Hops/chain" htmlFor="mga-mbh-hops">
              <PaperInput id="mga-mbh-hops" min={1} value={params.mbh?.hops ?? 200} onChange={(v) => setMgaParams({ ...params, mbh: { ...params.mbh, hops: Number(v) } })} />
            </PaperField>
            <PaperField label="Kick scale" htmlFor="mga-mbh-kick">
              <PaperInput id="mga-mbh-kick" step={0.01} min={0.01} value={params.mbh?.kick_scale ?? 0.15} onChange={(v) => setMgaParams({ ...params, mbh: { ...params.mbh, kick_scale: Number(v) } })} />
            </PaperField>
            <PaperField label="RNG seed" htmlFor="mga-mbh-seed">
              <PaperInput id="mga-mbh-seed" value={params.mbh?.seed ?? 42} onChange={(v) => setMgaParams({ ...params, mbh: { ...params.mbh, seed: Number(v) } })} />
            </PaperField>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <PaperSectionLabel>DE budget</PaperSectionLabel>
          <PaperFieldGrid>
            <PaperField label="Population" htmlFor="mga-de-pop">
              <PaperInput id="mga-de-pop" min={10} value={params.de_population_size ?? 300} onChange={(v) => setMgaParams({ ...params, de_population_size: Number(v) })} />
            </PaperField>
            <PaperField label="Generations" htmlFor="mga-de-gen">
              <PaperInput id="mga-de-gen" min={10} value={params.de_generations ?? 1000} onChange={(v) => setMgaParams({ ...params, de_generations: Number(v) })} />
            </PaperField>
            <PaperField label="Restarts" htmlFor="mga-de-restarts">
              <PaperInput id="mga-de-restarts" min={1} value={params.de_restarts ?? 3} onChange={(v) => setMgaParams({ ...params, de_restarts: Number(v) })} />
            </PaperField>
            <PaperField label="RNG seed" htmlFor="mga-de-seed">
              <PaperInput id="mga-de-seed" value={params.de_seed ?? 42} onChange={(v) => setMgaParams({ ...params, de_seed: Number(v) })} />
            </PaperField>
          </PaperFieldGrid>
        </div>
      )}

      <PaperDisclosure title="Advanced (MGA search internals)">
        <MgaAdvancedSearchSection params={params} setMgaParams={setMgaParams} flybyBodies={flybyBodies} mode={mode} />
      </PaperDisclosure>
    </div>
  )
}
