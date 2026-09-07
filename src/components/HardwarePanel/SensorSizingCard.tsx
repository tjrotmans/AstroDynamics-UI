import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { GncDesign } from "@/api/client"

function ReqVsAchieved({
  label,
  reqValue,
  achievedValue,
  unit,
  meetsReq,
  digits,
}: {
  label: string
  reqValue: number
  achievedValue: number
  unit: string
  meetsReq: boolean
  digits: number
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 text-sm">
        <span>
          req {reqValue.toFixed(digits)} {unit}
        </span>
        <span className="text-muted-foreground">vs</span>
        <span>
          achieved {achievedValue.toFixed(digits)} {unit}
        </span>
        <Badge variant={meetsReq ? "secondary" : "destructive"} className="ml-1">
          {meetsReq ? <CheckCircle2 data-icon="inline-start" /> : <AlertTriangle data-icon="inline-start" />}
          {meetsReq ? "OK" : "Not met"}
        </Badge>
      </div>
    </div>
  )
}

/**
 * Navigation sensor sizing: selected OpNav camera grade, and the accuracy
 * actually achieved with it vs. what the user asked for -- requirement and
 * achieved value shown side by side per axis (position from the slider above
 * this panel, velocity from `config.gnc.velocity_accuracy_req_mps`, which has
 * no editable UI yet -- see component-level note).
 */
export function SensorSizingCard({
  design,
  positionReqM,
  velocityReqMps,
}: {
  design: GncDesign
  positionReqM: number
  velocityReqMps: number
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm">
        Selected OpNav camera: <span className="font-medium">{design.selected_opnav}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ReqVsAchieved
          label="Position accuracy"
          reqValue={positionReqM}
          achievedValue={design.achieved_position_accuracy_m}
          unit="m"
          meetsReq={design.achieved_position_accuracy_m <= positionReqM}
          digits={1}
        />
        <ReqVsAchieved
          label="Velocity accuracy"
          reqValue={velocityReqMps}
          achievedValue={design.achieved_velocity_accuracy_mps}
          unit="m/s"
          meetsReq={design.achieved_velocity_accuracy_mps <= velocityReqMps}
          digits={4}
        />
      </div>
    </div>
  )
}
