import { create } from "zustand"

import type { GncModeConfig, ModeScheduleEntryConfig } from "@/api/client"

// Client-side authoring state for Phase 03's GNC modes editor (the design notes
// "Maneuver Mode" design session). Deliberately its own store,
// not component-local useState -- same reasoning as vehicleUiStore.ts:
// deriveDefaultModes() computes a fresh auto-derived starting point from
// missionStore every render (hardware/target changes), but once a user has
// actually edited a mode/schedule/safe-mode/TCM value, later hardware edits
// must NOT silently clobber their work. `touched` is the guard -- mirrors
// the "mgaTouched" latch pattern already established in this codebase (see
// the design notes "Survey/MGA restructure" note on the render-time-latch bug)
// rather than a useEffect-driven overwrite.
interface GncModesState {
  modes: GncModeConfig[]
  schedule: ModeScheduleEntryConfig[]
  safeMode: string | null
  // Meters. null = TCM correction burns disabled (the pre-existing,
  // TCM-never-configured behavior).
  tcmThresholdM: number | null
  touched: boolean
  // Called every render from CruiseReplayPage with deriveDefaultModes()'s
  // current output -- a no-op once the user has touched anything, so this
  // is safe to call unconditionally rather than needing its own dirty-check
  // at the call site.
  seedIfUntouched: (defaults: { modes: GncModeConfig[]; mode_schedule: ModeScheduleEntryConfig[]; safe_mode: string | null }) => void
  setModes: (modes: GncModeConfig[]) => void
  setSchedule: (schedule: ModeScheduleEntryConfig[]) => void
  setSafeMode: (name: string | null) => void
  setTcmThresholdM: (v: number | null) => void
  // Explicit "throw away my edits, go back to what deriveDefaultModes()
  // says" -- re-arms the touched guard so future hardware/target edits
  // resume auto-tracking until the user diverges again.
  resetToAuto: (defaults: { modes: GncModeConfig[]; mode_schedule: ModeScheduleEntryConfig[]; safe_mode: string | null }) => void
}

export const useGncModesStore = create<GncModesState>((set, get) => ({
  modes: [],
  schedule: [],
  safeMode: null,
  tcmThresholdM: null,
  touched: false,
  seedIfUntouched: (defaults) => {
    if (get().touched) return
    set({ modes: defaults.modes, schedule: defaults.mode_schedule, safeMode: defaults.safe_mode })
  },
  setModes: (modes) => set({ modes, touched: true }),
  setSchedule: (schedule) => set({ schedule, touched: true }),
  setSafeMode: (safeMode) => set({ safeMode, touched: true }),
  setTcmThresholdM: (tcmThresholdM) => set({ tcmThresholdM, touched: true }),
  resetToAuto: (defaults) =>
    set({ modes: defaults.modes, schedule: defaults.mode_schedule, safeMode: defaults.safe_mode, tcmThresholdM: null, touched: false }),
}))
