import { BestArcCard } from "@/components/DesignPanel/BestArcCard"
import { DvWaterfall } from "@/components/DesignPanel/DvWaterfall"
import { PorkchopHeatmap } from "@/components/DesignPanel/PorkchopHeatmap"
import type { TrajectoryApiResult } from "@/api/client"

// "Fig. 1" -- the survey block, appearing once a Run survey search has
// produced a result. Wraps the existing analytical-search components
// (PorkchopHeatmap, BestArcCard, DvWaterfall -- unchanged, same data reads)
// in the mockup's fig-frame/figcaption chrome, rather than rebuilding any
// of their plotting/stat logic. Phase B revision: the survey
// always runs GridSearch now (no GA/PSO/Monte Carlo solver choice), so
// result.optimizer/monte_carlo are never populated -- OptimizerResultCard/
// MonteCarloPanel dropped. Reference-only: no adopt action here, see
// ResultsSection for that (the mockup's paper only offers Adopt after the
// real optimizer has run).
export function SurveyFigure({ result }: { result: TrajectoryApiResult }) {
  return (
    <figure className="mt-4">
      {result.warnings.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1 text-xs text-amber-700">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {result.porkchop.length > 0 && (
        <div className="border border-[#171512] bg-white p-3 pb-2">
          <PorkchopHeatmap
            points={result.porkchop}
            bestPoint={
              result.best_arc?.dep_offset_days !== undefined && result.best_arc?.tof_days !== undefined
                ? { depOffsetDays: result.best_arc.dep_offset_days, tofDays: result.best_arc.tof_days }
                : null
            }
          />
        </div>
      )}
      <figcaption className="mt-1.5 font-serif text-[11.5px] text-[#55524b] italic">
        <b className="mr-1.5 font-sans text-[10px] font-extrabold tracking-[0.08em] text-[#171512] uppercase not-italic">
          Fig. 1
        </b>
        Departure date × time of flight, total ΔV -- analytical grid-search survey.
      </figcaption>

      <div className="mt-4 flex flex-col gap-3">
        {result.best_arc && <BestArcCard result={result.best_arc} />}
        {result.best_arc && <DvWaterfall result={result.best_arc} />}
      </div>
    </figure>
  )
}
