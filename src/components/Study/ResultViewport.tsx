import { OptimizeTrajectoryView } from "@/components/OptimizeStage/OptimizeTrajectoryView"
import { OverviewTrajectoryView } from "@/components/OptimizeStage/OverviewTrajectoryView"
import { LiveCandidateReplay } from "@/components/PorkchopExplorer/LiveCandidateReplay"
import { PlaceholderPreviewArc } from "@/components/Study/PlaceholderPreviewArc"
import { useMissionStore } from "@/stores/missionStore"
import { useOptimizeStore } from "@/stores/optimizeStore"

// The right-side result viewport: empty until a run starts, then live
// search, then the real cinematic playback -- same three states the
// mockup's rev shows. Mounts the SAME OptimizeTrajectoryView/
// OverviewTrajectoryView/LiveCandidateReplay components the old Optimize
// tool used, with the same prop derivation -- this is a new home for them,
// not a rebuild.
export function ResultViewport({
  camMode,
  onSetCamMode,
  onFullscreen,
}: {
  camMode: "follow" | "overview"
  onSetCamMode: (mode: "follow" | "overview") => void
  /** Omit entirely (rather than passing a no-op) when there's nowhere further to go -- e.g. the narrow-width
 * single-panel layout, where this viewport is already full-width. Found (UX review): a no-op here
   *  used to leave a "⛶ Fullscreen" button that did nothing on click, with nothing explaining why. */
  onFullscreen?: () => void
}) {
  const connectionState = useOptimizeStore((s) => s.connectionState)
  const result = useOptimizeStore((s) => s.result)
  const steps = useOptimizeStore((s) => s.steps)
  const optimization = useMissionStore((s) => s.config.optimization)
  const captureRadiusM = useMissionStore((s) => s.config.trajectory.capture?.target_orbit_radius_m)

  const isSearching = connectionState === "starting" || connectionState === "streaming"
  const isMga = optimization?.method === "MGA"

  if (!optimization || (!isSearching && !result)) {
    return <PlaceholderPreviewArc />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-3 rounded-full border border-border bg-card/60 px-4 py-1.5 backdrop-blur-md">
        <span className="text-[10.5px] font-bold tracking-[0.18em] text-primary uppercase">Viewport</span>
        <span className="flex-1 text-[10.5px] text-muted-foreground">
          {result ? "converged trajectory · cinematic playback" : "live search - candidates as they are evaluated"}
        </span>
        {result && (
          <>
            <button
              type="button"
              onClick={() => onSetCamMode("follow")}
              className={
                "rounded-full border px-3 py-1 text-[10px] font-bold tracking-[0.08em] uppercase " +
                (camMode === "follow"
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground")
              }
            >
              Follow
            </button>
            <button
              type="button"
              onClick={() => onSetCamMode("overview")}
              className={
                "rounded-full border px-3 py-1 text-[10px] font-bold tracking-[0.08em] uppercase " +
                (camMode === "overview"
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground")
              }
            >
              Overview
            </button>
            {onFullscreen && (
              <button
                type="button"
                onClick={onFullscreen}
                className="rounded-full border border-border px-3 py-1 text-[10px] font-bold tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
              >
                ⛶ Fullscreen
              </button>
            )}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {!result && isMga && <LiveCandidateReplay />}
        {!result && !isMga && (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-[11.5px] text-muted-foreground">
            <span className="font-heading text-2xl font-semibold text-primary tabular-nums">
              {/* The last streamed step's own generation index, NOT the raw
 message count (
                  viewport is not aligned yet with the plots") -- message
                  count exceeds the generation index (gen-0 re-emissions
                  share an index by design), so the two visibly disagreed. */}
              {steps.length > 0 ? `generation ${steps[steps.length - 1].step}` : "starting…"}
            </span>
            <span>No live 2D map for GA/PSO yet - the cinematic view opens once the run converges.</span>
          </div>
        )}
        {result && optimization && camMode === "follow" && (
          <OptimizeTrajectoryView
            result={result}
            departureBodyName={optimization.departure_body}
            targetBodyName={optimization.target_body}
            forceModelBodies={optimization.force_model.bodies
              .filter((b) => b.role === "AlwaysThirdBody")
              .map((b) => b.name)}
            captureRadiusM={captureRadiusM}
          />
        )}
        {result && optimization && camMode === "overview" && (
          <OverviewTrajectoryView
            result={result}
            departureBodyName={optimization.departure_body}
            targetBodyName={optimization.target_body}
            forceModelBodies={optimization.force_model.bodies
              .filter((b) => b.role === "AlwaysThirdBody")
              .map((b) => b.name)}
            captureRadiusM={captureRadiusM}
          />
        )}
      </div>
    </div>
  )
}
