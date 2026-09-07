import { useEffect } from "react"
import { AlertCircle, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { useDesignGnc } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"
import { EkfSizingCard } from "./EkfSizingCard"
import { PropellantBudgetCard } from "./PropellantBudgetCard"
import { SensorSizingCard } from "./SensorSizingCard"
import { TorqueBudgetChart } from "./TorqueBudgetChart"
import { WheelSizingCard } from "./WheelSizingCard"

function SliderRow({
  id,
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string
  label: string
  unit: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-sm text-muted-foreground">
          {value.toFixed(step < 1 ? 1 : 0)} {unit}
        </span>
      </div>
      <Slider id={id} value={[value]} min={min} max={max} step={step} onValueChange={([next]) => onChange(next)} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      {children}
    </div>
  )
}

// Mass and target orbit radius are now exclusively Stage 1 (Trajectory
// Design) concerns, edited once there and carried over -- only the
// genuinely GNC-specific accuracy requirement lives here, so the two
// stages can't drift out of sync over the same fields.
//
// `config.gnc.velocity_accuracy_req_mps` has no slider/setter anywhere in
// the app yet (missionStore.ts has no `setVelocityAccuracyReq` -- out of
// scope for this pass, which only touches HardwarePanel/), so it's shown
// read-only here at whatever value the store defaults to.
export function HardwarePanel() {
  const config = useMissionStore((state) => state.config)
  const setPositionAccuracyReq = useMissionStore((state) => state.setPositionAccuracyReq)

  const { mutate, data, isPending, error } = useDesignGnc()
  const configJson = JSON.stringify(config)

  useEffect(() => {
    const timer = setTimeout(() => mutate(config), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configJson])

  const positionReqM = config.gnc.position_accuracy_req_m ?? 1000
  const velocityReqMps = config.gnc.velocity_accuracy_req_mps ?? 1

  return (
    <Card>
      <CardHeader>
        <CardTitle>GNC Hardware Sizing</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <SliderRow
          id="tradeoff-position-accuracy-slider"
          label="Required position accuracy"
          unit="m"
          value={positionReqM}
          min={10}
          max={10_000}
          step={10}
          onChange={setPositionAccuracyReq}
        />

        <div className="flex items-center gap-2">
          {isPending && (
            <Badge variant="outline">
              <Loader2 className="animate-spin" data-icon="inline-start" /> Computing…
            </Badge>
          )}
          {error && (
            <Badge variant="destructive">
              <AlertCircle data-icon="inline-start" />
              {error.message}
            </Badge>
          )}
        </div>

        {data && (
          <div className="flex flex-col gap-5">
            <Separator />
            <Section title="Disturbance torque budget">
              <TorqueBudgetChart design={data} />
            </Section>

            <Separator />
            <Section title="Reaction wheel sizing">
              <WheelSizingCard design={data} />
            </Section>

            <Separator />
            <Section title="Propellant / RCS budget">
              <PropellantBudgetCard design={data} propellantBudgetKg={config.spacecraft.propellant_mass_kg} />
            </Section>

            <Separator />
            <Section title="Navigation sensor sizing">
              <SensorSizingCard design={data} positionReqM={positionReqM} velocityReqMps={velocityReqMps} />
            </Section>

            <Separator />
            <Section title="EKF sizing">
              <EkfSizingCard design={data} />
            </Section>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
