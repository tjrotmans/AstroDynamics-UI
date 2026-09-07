import type { MgaParamsExt } from "@/stores/missionStore"
import type { components } from "@/api/types"

type SequenceSearchConfig = components["schemas"]["SequenceSearchConfig"]

export const DEFAULT_LEG_TOF: [number, number] = [30, 800]

export const DEFAULT_SEQUENCE_SEARCH: SequenceSearchConfig = {
  candidate_bodies: [],
  max_legs: 3,
  beam_width: 25,
  max_sequences_to_optimize: 8,
  vinf_departure_estimate_ms: 5000,
}

// Fallback base object for setMgaParams callers that need a starting point
// when optimization.mga doesn't exist yet -- shared so MgaSequenceEditor.tsx
// and MgaParamsFields.tsx agree on the same empty-state shape.
export const DEFAULT_MGA_BASE: MgaParamsExt = {
  flyby_bodies: [],
  leg_tof_days: [DEFAULT_LEG_TOF],
  sequence_search: null,
}

// Legs = [departure_body, ...flyby_bodies, target_body] pairwise, so
// there's always exactly flyby_bodies.length + 1 of them. Preserves
// existing ranges by position when the flyby count changes. Shared by
// MgaSequenceEditor.tsx (editing the route) and MgaParamsFields.tsx
// (Auto mode's leg-count-driven TOF range) -- ported from the old
// (now-deleted) MgaParamsForm.tsx, which owned this same logic.
export function syncLegTofToLegCount(existing: number[][], legCount: number): number[][] {
  const next = existing.slice(0, legCount).map((pair) => [...pair])
  while (next.length < legCount) next.push([...DEFAULT_LEG_TOF])
  return next
}
