import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useSimStore } from "@/stores/simStore"
import { CovarianceTimeSeriesPlot } from "./CovarianceTimeSeriesPlot"
import { ResidualHistogram } from "./ResidualHistogram"
import { WheelSaturationTimeline } from "./WheelSaturationTimeline"
import { WheelSpeedsReadout } from "./WheelSpeedsReadout"

export function GNCPanel() {
  const steps = useSimStore((state) => state.steps)

  if (steps.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>GNC Dashboard</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Run a simulation to see GNC telemetry here.</p>
        </CardContent>
      </Card>
    )
  }

  const t = steps.map((s) => s.t_s)
  const sigmaPos = steps.map((s) => s.sigma_pos_m)
  const sigmaVel = steps.map((s) => s.sigma_vel_mps)

  return (
    <Card>
      <CardHeader>
        <CardTitle>GNC Dashboard</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CovarianceTimeSeriesPlot title="Position covariance (1σ)" yAxisLabel="σ position (m)" t={t} y={sigmaPos} />
        <CovarianceTimeSeriesPlot
          title="Velocity covariance (1σ)"
          yAxisLabel="σ velocity (m/s)"
          t={t}
          y={sigmaVel}
          color="#34d399"
        />

        <WheelSpeedsReadout step={steps[steps.length - 1]} />
        <WheelSaturationTimeline steps={steps} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ResidualHistogram
            title="Bearing residual"
            xAxisLabel="Residual (rad)"
            values={steps.map((s) => s.bearing_residual_rad)}
          />
          <ResidualHistogram
            title="Angular size residual"
            xAxisLabel="Residual (rad)"
            values={steps.map((s) => s.angular_size_residual_rad)}
          />
          <ResidualHistogram title="LIDAR residual" xAxisLabel="Residual (m)" values={steps.map((s) => s.lidar_residual_m)} />
        </div>
      </CardContent>
    </Card>
  )
}
