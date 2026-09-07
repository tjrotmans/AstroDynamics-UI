import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { useMissionStore } from "@/stores/missionStore"

const BUS_DIM_LABELS = ["Length", "Width", "Height"]

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
      <Slider
        id={id}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      />
    </div>
  )
}

// Bus dimensions feed inertia/attitude dynamics, not trajectory ΔV -- a GNC
// Sizing concern. Mass/propellant (translational) are in SpacecraftMassSliders.
export function SpacecraftBusSliders() {
  const busDims = useMissionStore((state) => state.config.spacecraft.bus_dims_m)
  const setBusDim = useMissionStore((state) => state.setBusDim)

  return (
    <div className="flex flex-col gap-4">
      {BUS_DIM_LABELS.map((label, index) => (
        <SliderRow
          key={label}
          id={`bus-dim-${index}`}
          label={`Bus ${label.toLowerCase()}`}
          unit="m"
          value={busDims[index] ?? 0}
          min={0.1}
          max={5}
          step={0.1}
          onChange={(value) => setBusDim(index, value)}
        />
      ))}
    </div>
  )
}
