import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { safeLocalStorage } from "@/lib/persistStorage"
import type { MgaSequenceContextMsg, OptimizeApiResult, OptimizeStepMsg } from "@/api/client"

export type OptimizeConnectionState = "idle" | "starting" | "streaming" | "done" | "error"

// Every step is stamped with the sequence that was active when it arrived
// (Phase 9k "step-stream context": the backend interleaves an
// MgaSequenceContextMsg before each candidate sequence's own steps under
// Auto/sequence_search mode). null for GA/PSO and for MGA's fixed-sequence
// (non-auto) path, where there's only ever one implicit sequence.
export interface TaggedStep extends OptimizeStepMsg {
  seqIdx: number | null
}

interface OptimizeStore {
  jobId: number | null
  connectionState: OptimizeConnectionState
  steps: TaggedStep[]
  activeSequence: MgaSequenceContextMsg | null
  result: OptimizeApiResult | null
  error: string | null
  reset: () => void
  setJobId: (jobId: number | null) => void
  setConnectionState: (state: OptimizeConnectionState) => void
  appendStep: (step: OptimizeStepMsg) => void
  setActiveSequence: (seq: MgaSequenceContextMsg) => void
  setResult: (result: OptimizeApiResult | null) => void
  setError: (message: string | null) => void
}

// Persisted result only ("I lose everything" feedback) -- a real
// optimizer run can take minutes of real propagated dynamics. `steps` (the
// live per-generation stream) and connectionState/jobId are transient run
// state tied to a live WebSocket that won't exist after a reload, so they're
// deliberately NOT persisted -- rehydrating them would show a stale
// "streaming" UI with no connection actually feeding it. Only the finished
// `result` survives.
export const useOptimizeStore = create<OptimizeStore>()(
  persist(
    (set) => ({
      jobId: null,
      connectionState: "idle",
      steps: [],
      activeSequence: null,
      result: null,
      error: null,
      reset: () => set({ jobId: null, connectionState: "idle", steps: [], activeSequence: null, result: null, error: null }),
      setJobId: (jobId) => set({ jobId }),
      setConnectionState: (connectionState) => set({ connectionState }),
      appendStep: (step) =>
        set((state) => ({ steps: [...state.steps, { ...step, seqIdx: state.activeSequence?.seq_idx ?? null }] })),
      setActiveSequence: (activeSequence) => set({ activeSequence }),
      setResult: (result) => set({ result }),
      setError: (error) => set({ error }),
    }),
    {
      name: "astrodynamics-optimize",
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ result: state.result }),
    },
  ),
)
