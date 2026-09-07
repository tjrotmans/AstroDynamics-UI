import { useEffect, useRef, useState } from "react"

import { ConnectionStatus } from "@/components/ConnectionStatus"
import { MissionSidebar, ToolNav } from "@/components/AppShell"
import { GncSizingStage } from "@/components/GncSizingStage"
import { LandingView } from "@/components/Landing/LandingView"
import { StudyView } from "@/components/Study/StudyView"
import { CruiseReplayPage } from "@/components/CruiseReplay/CruiseReplayPage"
import { useMissionStore } from "@/stores/missionStore"
import { useUiStore } from "@/stores/uiStore"

// Three top-level trees (Phase B redesign continued):
// - LandingView: the living-sky front door, truly conditionally rendered
//   (its Three.js canvas has nothing worth preserving across a visit).
// - StudyView: phase "01", full-bleed with its own chrome (the self-writing
//   paper + result viewport) -- replaces the old Explore/Optimize tools.
// - The GNC shell below: phase "02", the pre-existing header+sidebar+
// GncSizingStage workspace, unchanged (scope decision: GNC
//   stays exactly as it was, no restyle this pass).
// StudyView and the GNC shell both stay mounted (CSS-hidden, not
// unmounted) whenever the other is active or the user is back at the sky,
// so a running Optimize/Sim WebSocket job survives navigation.
function App() {
  const atLanding = useUiStore((state) => state.atLanding)
  const backToLanding = useUiStore((state) => state.backToLanding)
  const activeTool = useUiStore((state) => state.activeTool)
  const missionName = useMissionStore((state) => state.config.mission.name)
  const departureBody = useMissionStore((state) => state.config.trajectory.departure_body)
  const targetBody = useMissionStore((state) => state.config.target_body.name)

  // UX audit: the cut from the landing sky to a workspace was
  // instant, no transition at all. `justEntered` is true for one brief
  // window right after leaving the sky, applied as a fade-in on whichever
  // workspace just became visible -- see index.css's `.workspace-enter`.
  const [justEntered, setJustEntered] = useState(false)
  const wasAtLandingRef = useRef(atLanding)
  useEffect(() => {
    if (wasAtLandingRef.current && !atLanding) {
      setJustEntered(true)
      const t = setTimeout(() => setJustEntered(false), 450)
      wasAtLandingRef.current = atLanding
      return () => clearTimeout(t)
    }
    wasAtLandingRef.current = atLanding
  }, [atLanding])

  return (
    <>
      {atLanding && <LandingView />}

      <div
        className={
          (atLanding || activeTool !== "study" ? "hidden" : "") +
          (justEntered && activeTool === "study" ? " workspace-enter" : "")
        }
      >
        <StudyView />
      </div>

      <div
        className={
          (atLanding || activeTool !== "gnc" ? "hidden" : "flex min-h-screen flex-col") +
          (justEntered && activeTool === "gnc" ? " workspace-enter" : "")
        }
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-baseline gap-3">
            <button
              onClick={backToLanding}
              className="text-xs text-muted-foreground hover:text-primary"
              title="Back to the sky"
            >
              ← sky
            </button>
            <h1 className="font-heading text-sm font-semibold text-foreground">
              AstroDynamics <span className="text-primary">Mission Planner</span>
            </h1>
            {missionName && (
              <span className="text-xs text-muted-foreground">
                {missionName}
                {departureBody && targetBody && ` · ${departureBody} → ${targetBody}`}
              </span>
            )}
          </div>
          <ConnectionStatus />
        </header>

        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* bg-card/30 lifts the sidebar off the workspace canvas slightly --
              two zones, two surface levels, instead of one flat sheet with a
              hairline divider. */}
          <aside className="flex flex-col gap-5 border-r border-border bg-card/30 p-4 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto">
            <ToolNav />
            <MissionSidebar />
          </aside>

          <main className="p-4 lg:h-[calc(100vh-3rem)] lg:overflow-y-auto">
            <GncSizingStage />
          </main>
        </div>
      </div>

      <div
        className={
          (atLanding || activeTool !== "cruise" ? "hidden" : "") +
          (justEntered && activeTool === "cruise" ? " workspace-enter" : "")
        }
      >
        <CruiseReplayPage />
      </div>
    </>
  )
}

export default App
