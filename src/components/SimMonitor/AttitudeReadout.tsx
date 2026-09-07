import type { SimStepMsg } from "@/api/client"

interface AttitudeReadoutProps {
  step: SimStepMsg
}

// Quaternion convention per SimStepMsg.q: [w, x, y, z], body -> inertial/Hill frame.
export function AttitudeReadout({ step }: AttitudeReadoutProps) {
  const [w, x, y, z] = step.q

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
      <span className="text-xs text-muted-foreground">Attitude quaternion (body → inertial)</span>
      <div className="grid grid-cols-4 gap-2 font-mono text-sm">
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground">w</span>
          <span>{w.toFixed(4)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground">x</span>
          <span>{x.toFixed(4)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground">y</span>
          <span>{y.toFixed(4)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground">z</span>
          <span>{z.toFixed(4)}</span>
        </div>
      </div>
    </div>
  )
}
