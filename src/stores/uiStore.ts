import { create } from "zustand"

// Phase B ("Observatory" redesign continued): Explore and
// Optimize folded into one "study" destination -- the self-writing
// technical-memo paper + result viewport (components/Study/) -- replacing
// the old two-tool split. "study" and "gnc" are still a pipeline (study ->
// gnc) but either can be visited at any time.
export type Tool = "study" | "gnc" | "cruise"

interface UiStore {
  activeTool: Tool
  setActiveTool: (tool: Tool) => void
  // The living-sky landing page is the app's front door: a full
  // -bleed animated solar system with a phase dock (01 Trajectory / 02 GNC /
  // 03 Simulation) as its only navigation. `atLanding` starts true so a fresh
  // load always opens there; entering a phase switches to the existing
  // sidebar+workspace shell below, unchanged.
  atLanding: boolean
  enterWorkspace: (tool: Tool) => void
  backToLanding: () => void
  // Spacecraft Configuration Builder (design): "02 Vehicle &
  // GNC design" is a second VIEW of the same Study paper+viewport shell,
  // not a separate top-level tool the way the older GncSizingStage
  // ("gnc") is -- the phase rail toggles this, it doesn't navigate away.
  // Scoped narrowly for this pass: only StudyView reads it; PhaseDock's
  // own "02"/"03" pills still enter the old "gnc" tool unchanged (that
  // tool's real, working features -- Monte Carlo simulate, GNCPanel --
  // have no replacement yet, see the design notes).
  studyPhase: "01" | "02"
  setStudyPhase: (phase: "01" | "02") => void
}

export const useUiStore = create<UiStore>((set) => ({
  activeTool: "study",
  setActiveTool: (tool) => {
    set({ activeTool: tool })
    // Plotly panels in a CSS-hidden tool render at zero width; nudge them to
    // re-measure once the newly-shown tool is visible (all tools stay mounted
    // to preserve WebSocket connections).
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50)
  },
  atLanding: true,
  enterWorkspace: (tool) => {
    set({ atLanding: false, activeTool: tool })
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50)
  },
  backToLanding: () => set({ atLanding: true }),
  studyPhase: "01",
  setStudyPhase: (phase) => {
    set({ studyPhase: phase })
    setTimeout(() => window.dispatchEvent(new Event("resize")), 50)
  },
}))
