import { create } from "zustand"

import type { McRunMsg, McSummaryResult, SimResult, SimStepMsg } from "@/api/client"

export type SimConnectionState = "idle" | "starting" | "streaming" | "done" | "error"

interface SimStore {
  jobId: number | null
  connectionState: SimConnectionState
  // Single-run job state
  isMcJob: boolean
  steps: SimStepMsg[]
  result: SimResult | null
  // Monte Carlo job state (isMcJob = true)
  mcRuns: McRunMsg[]
  mcSummary: McSummaryResult | null
  error: string | null
  reset: () => void
  setJobId: (jobId: number | null) => void
  setConnectionState: (state: SimConnectionState) => void
  setIsMcJob: (isMc: boolean) => void
  appendStep: (step: SimStepMsg) => void
  setSteps: (steps: SimStepMsg[]) => void
  setResult: (result: SimResult | null) => void
  appendMcRun: (run: McRunMsg) => void
  setMcSummary: (summary: McSummaryResult | null) => void
  setError: (message: string | null) => void
}

export const useSimStore = create<SimStore>((set) => ({
  jobId: null,
  connectionState: "idle",
  isMcJob: false,
  steps: [],
  result: null,
  mcRuns: [],
  mcSummary: null,
  error: null,
  reset: () =>
    set({
      jobId: null,
      connectionState: "idle",
      isMcJob: false,
      steps: [],
      result: null,
      mcRuns: [],
      mcSummary: null,
      error: null,
    }),
  setJobId: (jobId) => set({ jobId }),
  setConnectionState: (connectionState) => set({ connectionState }),
  setIsMcJob: (isMcJob) => set({ isMcJob }),
  appendStep: (step) => set((state) => ({ steps: [...state.steps, step] })),
  setSteps: (steps) => set({ steps }),
  setResult: (result) => set({ result }),
  appendMcRun: (run) => set((state) => ({ mcRuns: [...state.mcRuns, run] })),
  setMcSummary: (mcSummary) => set({ mcSummary }),
  setError: (error) => set({ error }),
}))
