import { Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { useDesignStore } from "@/stores/designStore"
import { useUiStore, type Tool } from "@/stores/uiStore"

// Phase B: Explore+Optimize folded into "study" (components/Study/), so this
// is now just a 2-item "you are here" strip -- it's only rendered inside the
// GNC tree today (StudyView has its own phase rail + the reused PhaseDock),
// not a live destination picker from within itself.
const TOOLS: { id: Tool; step: number; name: string; hint: string }[] = [
  { id: "study", step: 1, name: "Trajectory study", hint: "Survey & optimize" },
  { id: "gnc", step: 2, name: "GNC Sizing", hint: "Hardware & 6DOF sim" },
]

export function ToolNav() {
  const activeTool = useUiStore((state) => state.activeTool)
  const setActiveTool = useUiStore((state) => state.setActiveTool)
  const selectedTrajectory = useDesignStore((state) => state.selectedTrajectory)

  // Per-tool "has produced something" state, shown as a check on the step
  // number -- makes the pipeline's progress visible from anywhere.
  const done: Record<Tool, boolean> = {
    study: selectedTrajectory != null,
    gnc: selectedTrajectory != null,
    cruise: selectedTrajectory != null,
  }

  return (
    <nav className="flex flex-col gap-1" aria-label="Tools">
      {TOOLS.map((tool) => {
        const active = activeTool === tool.id
        return (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition-colors",
              active ? "border-primary/40 bg-primary/10" : "hover:bg-muted/60",
            )}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                active ? "border-primary text-primary" : "border-border text-muted-foreground",
              )}
            >
              {done[tool.id] ? <Check className="size-3.5" /> : tool.step}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className={cn("text-sm font-medium", active ? "text-primary" : "text-foreground")}>
                {tool.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {tool.id === "gnc" && selectedTrajectory
                  ? `${selectedTrajectory.label} · ${(selectedTrajectory.dv_total_ms / 1000).toFixed(2)} km/s`
                  : tool.hint}
              </span>
            </span>
          </button>
        )
      })}
    </nav>
  )
}
