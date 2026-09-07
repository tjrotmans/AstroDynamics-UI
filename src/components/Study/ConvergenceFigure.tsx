import { OptimizeMonitor } from "@/components/OptimizeStage/OptimizeMonitor"

// "Fig. 3" -- appears once an optimization job has started streaming.
// Wraps the existing OptimizeMonitor (already method-aware for GA/PSO/MGA)
// unchanged. The live 2D candidate replay (MGA) lives only in
// ResultViewport now, not duplicated here -- the paper shows the
// convergence trace, the viewport shows the search happening on the sky,
// same split as the mockup's Fig. 2/3 (a line chart) vs. its viewport panel.
export function ConvergenceFigure() {
  return (
    <figure className="mt-4">
      <div className="border border-[#171512] bg-white p-3 pb-2">
        <OptimizeMonitor />
      </div>
      <figcaption className="mt-1.5 font-serif text-[11.5px] text-[#55524b] italic">
        <b className="mr-1.5 font-sans text-[10px] font-extrabold tracking-[0.08em] text-[#171512] uppercase not-italic">
          Fig. 3
        </b>
        Real-dynamics optimization progress -- the viewport at right shows candidates as they are evaluated.
      </figcaption>
    </figure>
  )
}
