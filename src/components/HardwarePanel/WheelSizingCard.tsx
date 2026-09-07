import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { GncDesign } from "@/api/client"

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  )
}

/**
 * Reaction wheel sizing: selected wheel + count, peak per-orbit momentum vs.
 * worst-case torque, and a hard-to-miss flag when the catalog has no wheel
 * with enough margin -- `wheel_torque_margin_ok === false` means the design
 * as configured doesn't close, not a minor warning.
 */
export function WheelSizingCard({ design }: { design: GncDesign }) {
  return (
    <div className="flex flex-col gap-3">
      {!design.wheel_torque_margin_ok && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            No catalog reaction wheel has enough torque/momentum margin for this disturbance
            environment -- the largest available wheel is shown, but this design does not close.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Selected wheel" value={design.selected_wheel} />
        <Field label="Wheel count" value={String(design.wheel_count)} />
        <Field label="Peak momentum / orbit" value={`${design.peak_momentum_nms.toFixed(3)} N·m·s`} />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Torque margin</span>
          <Badge
            variant={design.wheel_torque_margin_ok ? "secondary" : "destructive"}
            className="w-fit"
          >
            {design.wheel_torque_margin_ok ? (
              <CheckCircle2 data-icon="inline-start" />
            ) : (
              <AlertTriangle data-icon="inline-start" />
            )}
            {design.wheel_torque_margin_ok ? "OK" : "Exceeded"}
          </Badge>
        </div>
      </div>
    </div>
  )
}
