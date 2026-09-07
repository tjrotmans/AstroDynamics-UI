import { InfoTooltip } from "@/components/InfoTooltip"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useMissionStore } from "@/stores/missionStore"

// Only the 4 solvers that actually narrow a *search space* (a window scan,
// not a single-point estimate) -- Analytical Insights' job is to help narrow
// the search space for Optimize. Hohmann/Lambert/LambertThenDiffCorrect/
// DiffCorrection are real, working closed-form solvers (confirmed live via
// /api/design/trajectory) but compute one point, not a scan, so they don't
// serve that purpose here. SA/ManifoldStitch/WSB are recognized by the
// schema but hard-error -- implemented in unconnected codebases
// (OptimizationProblems / AstroProbs/LunarTrajectories), not reachable
// from this API at all.
const LIVE_SOLVERS = [
  { value: "GridSearch", label: "Porkchop / Lambert grid search" },
  { value: "MonteCarlo", label: "Monte Carlo scan" },
  { value: "GA", label: "Genetic Algorithm (GA)" },
  { value: "PSO", label: "Particle Swarm (PSO)" },
] as const

type LiveSolver = (typeof LIVE_SOLVERS)[number]["value"]

// All 4 are closed-form Lambert-proxy narrowing-stage searches over the same
// analytic fitness, not real propagated optimization -- see the file-top
// comment above. Hints below are deliberately scoped to that distinction.
const SOLVER_HINTS: Record<LiveSolver, string> = {
  GridSearch: "Uniform departure x TOF porkchop scan, each point a closed-form Lambert solve -- cheapest, most exhaustive coverage of the search box, but resolution-limited by grid spacing.",
  MonteCarlo: "Gaussian scatter of Lambert evaluations around a reference point -- for robustness/sensitivity analysis near an already-found solution, not for exploring a wide search box.",
  GA: "Genetic algorithm searching the same Lambert proxy as the grid scan -- population-based search, useful when the grid is too coarse or the search box too large for exhaustive scanning, but still no propagated dynamics in the fitness function.",
  PSO: "Particle swarm search over the same Lambert proxy -- swarm-based alternative to GA with similar narrowing-stage scope, no propagated dynamics in the fitness function.",
}

export function SolverSelector() {
  const solver = useMissionStore((state) => state.config.trajectory.solver)
  const setSolver = useMissionStore((state) => state.setSolver)

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="solver-select" className="inline-flex items-center gap-1.5">
        Solver
        <InfoTooltip>{SOLVER_HINTS[solver as LiveSolver] ?? "Closed-form narrowing-stage search method -- see the trajectory design docs for the full method list."}</InfoTooltip>
      </Label>
      <Select value={solver} onValueChange={(value) => setSolver(value as typeof solver)}>
        <SelectTrigger id="solver-select" className="w-full">
          <SelectValue placeholder="Select a solver" />
        </SelectTrigger>
        <SelectContent>
          {LIVE_SOLVERS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
