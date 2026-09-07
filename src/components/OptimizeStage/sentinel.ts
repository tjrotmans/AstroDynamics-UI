// The backend uses f64::MAX as a "no valid candidate found yet" sentinel --
// during early generations/iterations before anything feasible is found,
// and in the final result if the search never converged. Not a real
// fitness value, never display or plot it as one.
export const NO_SOLUTION_SENTINEL = Number.MAX_VALUE

export function isNoSolutionFitness(value: number): boolean {
  return value >= NO_SOLUTION_SENTINEL
}

// Real bug, found (: a live MGA run showed "105000.00
// km/s best total ΔV", a physically nonsensical value -- a third of light
// speed). Traced to `mga.rs`'s OWN infeasibility grading, not a units bug:
// `INFEASIBLE_BASE_MS = 1.0e8` (+ `INFEASIBLE_PER_LEG_MS = 1.0e6` per
// remaining leg) is what `infeasible_fitness_ms` returns for a chromosome
// that fails outright (no Lambert solution / Kepler non-convergence /
// missing body state) -- a real, intentional graded sentinel so DE/MBH can
// still rank two failures against each other, per that function's own doc
// comment, but it's a different magnitude than `f64::MAX` and
// `isNoSolutionFitness` never caught it. 1e7 m/s (10,000 km/s) is the cutoff:
// comfortably above any real interplanetary MGA total ΔV (never remotely
// close to even 100 km/s) and comfortably below the smallest real
// infeasibility grade (1e8 m/s for zero legs completed).
//
// MGA-only, deliberately not folded into `isNoSolutionFitness` above: GA's
// own phase-1 `best_fitness` is a closest-approach distance in KM (see
// OptimizeMonitor.tsx's method-aware doc comment), which can legitimately
// be a large number (tens of millions of km) for a genuinely bad early
// candidate -- applying this MGA-specific m/s threshold there would wrongly
// discard real GA data, not just sentinels.
export const MGA_INFEASIBLE_GRADE_FLOOR_MS = 1e7

export function isMgaInfeasibleGrade(value: number): boolean {
  return isNoSolutionFitness(value) || value >= MGA_INFEASIBLE_GRADE_FLOOR_MS
}
