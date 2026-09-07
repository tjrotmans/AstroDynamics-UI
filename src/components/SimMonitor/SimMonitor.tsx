import { useState } from "react"
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useSimStream } from "@/hooks/useSimStream"
import { useMissionStore } from "@/stores/missionStore"
import { useSimStore } from "@/stores/simStore"
import { AttitudeReadout } from "./AttitudeReadout"
import { ErrorTimeSeriesPlot } from "./ErrorTimeSeriesPlot"
import { McDispersionCloud } from "./McDispersionCloud"
import { PhaseProgress } from "./PhaseProgress"

function vectorErrorMagnitude(truth: number[], estimate: number[]): number {
  let sumSq = 0
  for (let i = 0; i < truth.length; i++) {
    const d = truth[i] - estimate[i]
    sumSq += d * d
  }
  return Math.sqrt(sumSq)
}

export function SimMonitor() {
  const config = useMissionStore((state) => state.config)
  const { start, cancel } = useSimStream()
  const [cancelRequested, setCancelRequested] = useState(false)

  const connectionState = useSimStore((state) => state.connectionState)
  const isMcJob = useSimStore((state) => state.isMcJob)
  const steps = useSimStore((state) => state.steps)
  const result = useSimStore((state) => state.result)
  const mcRuns = useSimStore((state) => state.mcRuns)
  const mcSummary = useSimStore((state) => state.mcSummary)
  const error = useSimStore((state) => state.error)

  const isRunning = connectionState === "starting" || connectionState === "streaming"

  const t = steps.map((s) => s.t_s)
  const posError = steps.map((s) => vectorErrorMagnitude(s.r_truth_m, s.r_ekf_m))
  const sigmaPos = steps.map((s) => s.sigma_pos_m)
  const velError = steps.map((s) => vectorErrorMagnitude(s.v_truth_mps, s.v_ekf_mps))
  const sigmaVel = steps.map((s) => s.sigma_vel_mps)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Simulation Monitor</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Button
            onClick={() => {
              setCancelRequested(false)
              start(config)
            }}
            disabled={isRunning}
          >
            {isRunning && <Loader2 className="animate-spin" data-icon="inline-start" />}
            Run Simulation
          </Button>
          {isRunning && (
            <Button variant="outline" onClick={() => { cancel(); setCancelRequested(true) }} disabled={cancelRequested}>
              {cancelRequested ? "Stop requested…" : "Stop"}
            </Button>
          )}
          {cancelRequested && isMcJob && (
            <span className="text-xs text-muted-foreground">
              Monte Carlo runs already dispatched can't be interrupted mid-batch -- status will update once they finish.
            </span>
          )}
          {connectionState === "streaming" && (
            isMcJob
              ? <Badge variant="outline">Run {mcRuns.length}</Badge>
              : <Badge variant="outline">Step {steps.length}</Badge>
          )}
          {connectionState === "done" && (
            <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-400">
              <CheckCircle2 data-icon="inline-start" /> Done
            </Badge>
          )}
          {connectionState === "error" && error && (
            <Badge variant="destructive">
              <AlertCircle data-icon="inline-start" />
              {error}
            </Badge>
          )}
        </div>

        {steps.length === 0 && mcRuns.length === 0 && connectionState !== "error" && (
          <p className="text-sm text-muted-foreground">Run a simulation to see live navigation accuracy here.</p>
        )}

        {/* Single-run job: live navigation accuracy plots */}
        {!isMcJob && steps.length > 0 && (
          <div className="flex flex-col gap-4">
            <PhaseProgress steps={steps} />
            <AttitudeReadout step={steps[steps.length - 1]} />
            <ErrorTimeSeriesPlot title="Position error" yAxisLabel="Position error (m)" t={t} error={posError} sigma={sigmaPos} />
            <ErrorTimeSeriesPlot
              title="Velocity error"
              yAxisLabel="Velocity error (m/s)"
              t={t}
              error={velError}
              sigma={sigmaVel}
            />
          </div>
        )}

        {!isMcJob && result && (
          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Phases completed</span>
                <span className="text-sm">{result.phases_completed.join(", ")}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Final position</span>
                <span className="text-sm">
                  {result.final_r_m.map((v) => (v / 1000).toFixed(1)).join(", ")} km
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Final velocity</span>
                <span className="text-sm">
                  {result.final_v_mps.map((v) => (v / 1000).toFixed(3)).join(", ")} km/s
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Total ΔV</span>
                <span className="text-sm">{result.dv_total_mps.toFixed(1)} m/s</span>
              </div>
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>Output: {result.nav_csv_path}</span>
              <span>Output: {result.attitude_csv_path}</span>
              <span>Output: {result.maneuvers_csv_path}</span>
            </div>
          </div>
        )}

        {/* Monte Carlo job: dispersion cloud + summary stats */}
        {isMcJob && mcRuns.length > 0 && (
          <McDispersionCloud runs={mcRuns} summary={mcSummary} />
        )}
      </CardContent>
    </Card>
  )
}
