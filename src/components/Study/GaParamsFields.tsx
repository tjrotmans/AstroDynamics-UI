import { PaperField, PaperFieldGrid, PaperInput } from "./paperForm"
import type { GaParams } from "@/api/client"
import { useMissionStore } from "@/stores/missionStore"

const DEFAULT_GA_PARAMS: GaParams = {
  population_size: 50,
  generations: 100,
  crossover_rate: 0.8,
  mutation_rate: 0.1,
  elitism_count: 2,
}

const FIELDS: { key: keyof GaParams; label: string; step?: number }[] = [
  { key: "population_size", label: "Population size" },
  { key: "generations", label: "Generations" },
  { key: "crossover_rate", label: "Crossover rate", step: 0.05 },
  { key: "mutation_rate", label: "Mutation rate (peak)", step: 0.05 },
  { key: "elitism_count", label: "Elitism count" },
]

// Paper-native rebuild of the old GaParamsForm.tsx -- same 5 fields, same
// store read/write, new markup.
export function GaParamsFields() {
  const params = useMissionStore((s) => s.config.optimization?.ga) ?? DEFAULT_GA_PARAMS
  const setGaParams = useMissionStore((s) => s.setGaParams)

  return (
    <PaperFieldGrid>
      {FIELDS.map((f) => (
        <PaperField key={f.key} label={f.label} htmlFor={`ga-${f.key}`}>
          <PaperInput
            id={`ga-${f.key}`}
            value={params[f.key]}
            step={f.step}
            onChange={(v) => setGaParams({ ...params, [f.key]: Number(v) })}
          />
        </PaperField>
      ))}
    </PaperFieldGrid>
  )
}
