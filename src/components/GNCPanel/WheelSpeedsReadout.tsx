import type { SimStepMsg } from "@/api/client"

interface WheelSpeedsReadoutProps {
  step: SimStepMsg
}

// Live per-wheel speed readout (4-wheel pyramid). WheelSaturationTimeline already
// shows the time history of the most-saturated wheel's fraction; this complements it
// with the actual per-wheel rad/s values for the latest step, which aren't plotted anywhere.
export function WheelSpeedsReadout({ step }: WheelSpeedsReadoutProps) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
      <span className="text-xs text-muted-foreground">Wheel speeds (rad/s)</span>
      <div className="grid grid-cols-4 gap-2 font-mono text-sm">
        {step.wheel_speeds_radps.map((speed, i) => (
          <div key={i} className="flex flex-col">
            <span className="text-[10px] text-muted-foreground">W{i + 1}</span>
            <span>{speed.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        Wheel momentum: {step.wheel_momentum_nms.toFixed(3)} N·m·s
      </span>
    </div>
  )
}
