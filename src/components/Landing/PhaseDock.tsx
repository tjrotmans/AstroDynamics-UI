// The landing page's only navigation, matching the design mockup's dock +
// phase-info-card interaction 1:1 (.scratch/wt-hybrid-observatory/design/
// mockup.html, rev 3's PHASES/showPhaseCard/hidePhaseCard): clicking a phase
// pill toggles a transient explanatory card above the dock rather than
// navigating immediately -- the card's own "Enter" button does that. A
// second click on the same pill, or clicking elsewhere on the sky, dismisses
// it (the sky's onPointerMissed calls onDismiss, passed down from
// LandingView). Locking is real, not decorative: 02 unlocks once a
// trajectory has actually been adopted (`designStore.selectedTrajectory`),
// 03 once a GNC design has actually been produced (`designStore.gncResult`)
// -- both fields already existed, already read by the in-workspace ToolNav
// for its own checkmark logic.
import { useDesignStore } from "@/stores/designStore"
import type { Tool } from "@/stores/uiStore"

interface Phase {
  n: string
  label: string
  tool: Tool
  body: string
}

const PHASES: Phase[] = [
  {
    n: "01",
    label: "Trajectory",
    tool: "study",
    body: "Sketch a route on the sky - or start from a preset tour. Survey the transfer window analytically first (porkchop & Lambert scans), then optimize under real dynamics: GA · PSO · MGA with multiple-shooting refinement.",
  },
  {
    n: "02",
    label: "GNC",
    tool: "gnc",
    body: "Size the spacecraft around the adopted trajectory: reaction wheels, thrusters & propellant, sensors, and estimation budgets - checked against the mission's real manoeuvre and pointing loads.",
  },
  {
    n: "03",
    label: "Simulation",
    tool: "cruise",
    body: "Fly the built vehicle and GNC design against the real trajectory, tick by tick - real attitude, mode transitions, and pointing/momentum/propellant telemetry. Feasibility-grade, not the high-fidelity software-in-the-loop stage (04, not built yet).",
  },
]

export function PhaseDock({
  shownPhase,
  onTogglePhase,
  onEnter,
}: {
  shownPhase: number | null
  onTogglePhase: (n: number) => void
  onEnter: (tool: Tool) => void
}) {
  const selectedTrajectory = useDesignStore((s) => s.selectedTrajectory)
  const gncResult = useDesignStore((s) => s.gncResult)
  const unlocked = [true, selectedTrajectory != null, gncResult != null]

  const card = shownPhase != null ? PHASES[shownPhase - 1] : null
  const cardUnlocked = shownPhase != null ? unlocked[shownPhase - 1] : false
  const enterLabel = card
    ? cardUnlocked
      ? `Enter ${card.n} →`
      : shownPhase === 2
        ? "Adopt a trajectory in 01 first"
        : "Freeze a GNC design in 02 first"
    : ""

  return (
    <div className="flex flex-col items-center gap-3">
      {card && (
        <div className="w-[380px] rounded-2xl border border-border bg-card/70 p-4 shadow-2xl backdrop-blur-md">
          <div className="flex items-baseline gap-2.5">
            <span className="text-xl font-extrabold text-primary">{card.n}</span>
            <span className="text-sm font-bold uppercase tracking-wide">{card.label}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{card.body}</p>
          <button
            onClick={() => cardUnlocked && onEnter(card.tool)}
            disabled={!cardUnlocked}
            className={
              cardUnlocked
                ? "mt-3 w-full rounded-lg bg-primary py-2 text-[10.5px] font-bold uppercase tracking-wider text-primary-foreground hover:brightness-110"
                : "mt-3 w-full rounded-lg border border-border py-2 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground"
            }
          >
            {enterLabel}
          </button>
        </div>
      )}

      <nav
        className="flex items-stretch gap-1 rounded-2xl border border-border bg-card/60 p-1.5 backdrop-blur-md"
        aria-label="Mission phases"
      >
        {PHASES.map((phase, i) => (
          <button
            key={phase.n}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePhase(i + 1)
            }}
            className={
              "flex items-baseline gap-2 rounded-xl px-4 py-2.5 text-left transition-colors " +
              (shownPhase === i + 1 ? "bg-primary/15" : "hover:bg-muted/60") +
              (unlocked[i] ? "" : " opacity-50")
            }
          >
            <span className={"text-base font-extrabold " + (unlocked[i] ? "text-muted-foreground" : "text-muted-foreground/60")}>
              {phase.n}
            </span>
            <span className="text-sm font-semibold tracking-wide">{phase.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
