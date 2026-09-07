import { create } from "zustand"

import type { CruiseResult, CruiseStepMsg } from "@/api/client"

export type CruiseConnectionState = "idle" | "starting" | "streaming" | "done" | "error"

interface CruiseStore {
  jobId: number | null
  connectionState: CruiseConnectionState
  steps: CruiseStepMsg[]
  result: CruiseResult | null
  error: string | null
  reset: () => void
  setJobId: (jobId: number | null) => void
  setConnectionState: (state: CruiseConnectionState) => void
  setSteps: (steps: CruiseStepMsg[]) => void
  setResult: (result: CruiseResult | null) => void
  setError: (message: string | null) => void
}

export const useCruiseStore = create<CruiseStore>((set) => ({
  jobId: null,
  connectionState: "idle",
  steps: [],
  result: null,
  error: null,
  reset: () => set({ jobId: null, connectionState: "idle", steps: [], result: null, error: null }),
  setJobId: (jobId) => set({ jobId }),
  setConnectionState: (connectionState) => set({ connectionState }),
  // Real bug found (see useCruiseStream.ts's own comment): this
  // used to append one step at a time via a full-array spread, O(n) per
  // call -- O(n^2) total for a mission needing hundreds of thousands of
  // ticks. useCruiseStream now buffers incoming messages itself and only
  // calls setSteps with a periodic batched snapshot.
  setSteps: (steps) => set({ steps }),
  setResult: (result) => set({ result }),
  setError: (error) => set({ error }),
}))
