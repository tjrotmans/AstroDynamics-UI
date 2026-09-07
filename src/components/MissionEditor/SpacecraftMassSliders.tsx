import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { useMissionStore } from "@/stores/missionStore"

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

// Mass/propellant drive ΔV budget feasibility -- a translational concern, so
// these live in Trajectory Design. Bus dimensions (attitude/inertia-relevant)
// are in SpacecraftBusSliders, part of GNC Sizing instead.
export function SpacecraftMassSliders() {
  const spacecraft = useMissionStore((state) => state.config.spacecraft)
  const setMass = useMissionStore((state) => state.setMass)
  const setPropellantMass = useMissionStore((state) => state.setPropellantMass)

  return (
    <div className="flex flex-col gap-4">
      <SliderRow
        id="mass-slider"
        label="Wet mass"
        unit="kg"
        value={spacecraft.mass_kg}
        min={1}
        max={2000}
        step={1}
        onChange={setMass}
      />
      <SliderRow
        id="propellant-slider"
        label="Propellant mass"
        unit="kg"
        value={spacecraft.propellant_mass_kg}
        min={0}
        max={1000}
        step={1}
        onChange={setPropellantMass}
      />
      <p className="text-xs text-muted-foreground">
        Dry mass: {spacecraft.dry_mass_kg.toFixed(0)} kg (derived)
      </p>
    </div>
  )
}
