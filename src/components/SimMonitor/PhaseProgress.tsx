import { Check } from "lucide-react"

import { cn } from "@/lib/utils"
import type { SimStepMsg } from "@/api/client"

interface PhaseProgressProps {
  steps: SimStepMsg[]
}

// phase_name is a free-form string from the backend (no fixed enum/ordered list is
// exposed by the API) -- derive the phase sequence from the order phases first appear
// in the stream itself, rather than hardcoding mission-specific phase names here.
export function PhaseProgress({ steps }: PhaseProgressProps) {
  const phases: string[] = []
  for (const step of steps) {
    if (phases[phases.length - 1] !== step.phase_name) phases.push(step.phase_name)
  }
  const currentPhase = steps[steps.length - 1]?.phase_name

  if (phases.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {phases.map((phase, i) => {
        const isCurrent = phase === currentPhase && i === phases.length - 1
        const isPast = !isCurrent
        return (
          <div key={`${phase}-${i}`} className="flex items-center gap-2">
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                isCurrent && "border-primary bg-primary/15 text-primary",
                isPast && "border-border text-muted-foreground",
              )}
            >
              {isPast && <Check className="size-3" />}
              {phase}
            </div>
            {i < phases.length - 1 && <span className="text-muted-foreground">→</span>}
          </div>
        )
      })}
    </div>
  )
}
