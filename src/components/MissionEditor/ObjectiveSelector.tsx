import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useObjectives } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"

// Per the backend capability audit (read directly from
// simulate.rs, not just the design notes vision text):
// - Landing IS real server-side (run_landing/LandingPhase, real powered
//   descent) -- it was wrongly filtered out here. Stage 1/Analytical Insights never
//   branches on objective either way (only Stage 2's /api/simulate does),
//   so there's nothing extra to gate here for Landing.
// - Rendezvous is unconditionally hard-error rejected server-side for every
//   body, not just non-small-bodies -- the old small-body allowlist implied
//   the opposite condition from reality. Disabled outright below instead.
// - SampleReturn has no dedicated backend logic (falls through to the same
//   path as Orbit) -- left enabled, but annotated so the UI doesn't imply
//   it does more than Orbit today.
const UNIMPLEMENTED_REASON: Partial<Record<string, string>> = {
  Rendezvous: "Not implemented server-side yet (rejected for every body)",
}

const SAME_AS_ORBIT_NOTE = "Behaves identically to Orbit today - no dedicated backend logic yet"

export function ObjectiveSelector() {
  const { data, isLoading } = useObjectives()
  const objective = useMissionStore((state) => state.config.mission.objective)
  const setObjective = useMissionStore((state) => state.setObjective)

  const objectives = data?.objectives ?? []

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="objective-select">Objective</Label>
      <Select
        value={objective}
        onValueChange={(value) =>
          setObjective(value as typeof objective)
        }
      >
        <SelectTrigger id="objective-select" className="w-full">
          <SelectValue placeholder={isLoading ? "Loading…" : "Select an objective"} />
        </SelectTrigger>
        <SelectContent>
          {objectives.map((o) => {
            const disabledReason = UNIMPLEMENTED_REASON[o.id]
            return (
              <SelectItem key={o.id} value={o.id} disabled={disabledReason !== undefined}>
                {o.id} - {disabledReason ?? o.description}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      {objective === "SampleReturn" && (
        <p className="text-xs text-muted-foreground">{SAME_AS_ORBIT_NOTE}</p>
      )}
    </div>
  )
}
