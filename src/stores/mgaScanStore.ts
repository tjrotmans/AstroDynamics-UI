import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { safeLocalStorage } from "@/lib/persistStorage"
import type { MgaScanApiResult } from "@/api/client"

export type MgaScanState = "idle" | "starting" | "running" | "done" | "error"

interface MgaScanStore {
  jobId: number | null
  state: MgaScanState
  result: MgaScanApiResult | null
  error: string | null
  reset: () => void
  setJobId: (jobId: number | null) => void
  setState: (state: MgaScanState) => void
  setResult: (result: MgaScanApiResult | null) => void
  setError: (message: string | null) => void
}

// Mirrors optimizeStore's shape -- mga-scan is the same async-job pattern
// (start -> poll/stream -> result), just polled instead of streamed (the
// backend has no /stream for this job kind). Lifecycle lives here, not
// designStore, matching the existing convention that designStore holds only
// finished results, no job/connection state.
//
// Persisted result only ("I lose everything" feedback) -- a scan
// can run for minutes and evaluate hundreds of thousands of legs, genuinely
// expensive to redo. jobId/state/error are transient run state tied to a
// live poll loop that won't exist after a reload, so they're deliberately
// NOT persisted -- only the finished result survives.
export const useMgaScanStore = create<MgaScanStore>()(
  persist(
    (set) => ({
      jobId: null,
      state: "idle",
      result: null,
      error: null,
      reset: () => set({ jobId: null, state: "idle", result: null, error: null }),
      setJobId: (jobId) => set({ jobId }),
      setState: (state) => set({ state }),
      setResult: (result) => set({ result }),
      setError: (error) => set({ error }),
    }),
    {
      name: "astrodynamics-mga-scan",
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ result: state.result }),
    },
  ),
)
