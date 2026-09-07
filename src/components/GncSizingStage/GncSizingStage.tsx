import { HardwareChecklist, LandingConfigFields, SpacecraftBusSliders } from "@/components/MissionEditor"
import { ToolHeader } from "@/components/AppShell"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { InfoTooltip } from "@/components/InfoTooltip"
import { GNCPanel } from "@/components/GNCPanel"
import { HardwarePanel } from "@/components/HardwarePanel"
import { SimMonitor } from "@/components/SimMonitor"
import { PowerBudgetCard } from "./PowerBudgetCard"
import { useDesignStore } from "@/stores/designStore"
import { useMissionStore } from "@/stores/missionStore"
import { useUiStore } from "@/stores/uiStore"

// Stage 2: takes the trajectory locked in during Trajectory Design and adds
// hardware + full 6DOF attitude control on top of it. Control algorithms/
// filters stay backend-only -- there's deliberately no picker for those here.
export function GncSizingStage() {
  const selectedTrajectory = useDesignStore((state) => state.selectedTrajectory)
  const setActiveTool = useUiStore((state) => state.setActiveTool)
  const objective = useMissionStore((state) => state.config.mission.objective)
  const monteCarloRuns = useMissionStore((state) => state.config.simulation.monte_carlo_runs)
  const setMonteCarloRuns = useMissionStore((state) => state.setMonteCarloRuns)

  const header = (
    <ToolHeader title="GNC Sizing">
      Size the spacecraft's guidance, navigation and control hardware against the locked trajectory: pick
      components below, then re-run the mission with full 6-DOF attitude simulation to check pointing accuracy,
      propellant use, and the power budget. Add Monte Carlo runs for dispersion statistics.
    </ToolHeader>
  )

  if (!selectedTrajectory) {
    return (
      <div className="flex flex-col">
        {header}
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6">
            <p className="text-sm text-muted-foreground">
              Lock in a trajectory first - run the trajectory study and press "Adopt trajectory" on a converged
              result.
            </p>
            <Button variant="outline" className="self-start" onClick={() => setActiveTool("study")}>
              Go to the study
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {header}
      <Card>
        <CardHeader>
          <CardTitle>Trajectory in use</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{selectedTrajectory.label}</span>
            <span className="text-xs text-muted-foreground">
              Total ΔV: {selectedTrajectory.dv_total_ms.toFixed(1)} m/s
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setActiveTool("study")}>
            Change trajectory
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Spacecraft bus</CardTitle>
            </CardHeader>
            <CardContent>
              <SpacecraftBusSliders />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Hardware</CardTitle>
            </CardHeader>
            <CardContent>
              <HardwareChecklist />
            </CardContent>
          </Card>

          <PowerBudgetCard />

          <Card>
            <CardHeader>
              <CardTitle>Simulation options</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mc-runs" className="inline-flex items-center gap-1.5">
                  Monte Carlo runs
                  <InfoTooltip>
                    Number of Monte Carlo runs for robustness analysis. 1 = single deterministic run (the default).
                    More runs give dispersion statistics (range spread, crash rate) by adding noise to initial
                    conditions each run. Stream sends one result per completed run; the dispersion cloud appears
                    below after the job finishes.
                  </InfoTooltip>
                </Label>
                <Input
                  id="mc-runs"
                  type="number"
                  min={1}
                  max={500}
                  step={1}
                  value={monteCarloRuns}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v >= 1) setMonteCarloRuns(v)
                  }}
                  className="w-28"
                />
              </div>
            </CardContent>
          </Card>

          {objective === "Landing" && (
            <Card>
              <CardHeader>
                <CardTitle>Landing</CardTitle>
              </CardHeader>
              <CardContent>
                <LandingConfigFields />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <HardwarePanel />
          <SimMonitor />
          <GNCPanel />
        </div>
      </div>
    </div>
  )
}
