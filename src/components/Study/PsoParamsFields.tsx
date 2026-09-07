import { PaperField, PaperFieldGrid, PaperInput } from "./paperForm"
import type { PsoParams } from "@/api/client"
import { useMissionStore } from "@/stores/missionStore"

const DEFAULT_PSO_PARAMS: PsoParams = {
  swarm_size: 50,
  iterations: 100,
  inertia_weight: 0.7,
  cognitive_weight: 1.5,
  social_weight: 1.5,
}

const FIELDS: { key: keyof PsoParams; label: string; step?: number }[] = [
  { key: "swarm_size", label: "Swarm size" },
  { key: "iterations", label: "Iterations" },
  { key: "inertia_weight", label: "Inertia weight", step: 0.05 },
  { key: "cognitive_weight", label: "Cognitive weight", step: 0.1 },
  { key: "social_weight", label: "Social weight", step: 0.1 },
]

// Paper-native rebuild of the old PsoParamsForm.tsx -- same 5 fields, same
// store read/write, new markup.
export function PsoParamsFields() {
  const params = useMissionStore((s) => s.config.optimization?.pso) ?? DEFAULT_PSO_PARAMS
  const setPsoParams = useMissionStore((s) => s.setPsoParams)

  return (
    <PaperFieldGrid>
      {FIELDS.map((f) => (
        <PaperField key={f.key} label={f.label} htmlFor={`pso-${f.key}`}>
          <PaperInput
            id={`pso-${f.key}`}
            value={params[f.key]}
            step={f.step}
            onChange={(v) => setPsoParams({ ...params, [f.key]: Number(v) })}
          />
        </PaperField>
      ))}
    </PaperFieldGrid>
  )
}
