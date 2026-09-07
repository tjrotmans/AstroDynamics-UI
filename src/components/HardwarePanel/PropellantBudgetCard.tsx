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
 * RCS desaturation propellant budget: selected thruster + propellant/orbit,
 * plus propellant/day and (if the spacecraft's propellant budget is known)
 * how many days of desaturation that budget lasts -- both derived client-side
 * from `orbit_period_s` and `propellant_mass_kg`, no new backend field needed.
 */
export function PropellantBudgetCard({
  design,
  propellantBudgetKg,
}: {
  design: GncDesign
  propellantBudgetKg: number | undefined
}) {
  const orbitsPerDay = 86_400 / design.orbit_period_s
  const propellantPerDayKg = design.propellant_per_orbit_kg * orbitsPerDay
  const daysOfPropellant =
    propellantBudgetKg !== undefined && propellantPerDayKg > 0
      ? propellantBudgetKg / propellantPerDayKg
      : undefined

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Field label="Selected thruster" value={design.selected_thruster} />
      <Field label="Propellant / orbit" value={`${design.propellant_per_orbit_kg.toFixed(4)} kg`} />
      <Field
        label="Propellant / day"
        value={`${propellantPerDayKg.toFixed(4)} kg  (${orbitsPerDay.toFixed(1)} orbits/day)`}
      />
      <Field
        label="RCS budget lasts"
        value={daysOfPropellant !== undefined ? `${daysOfPropellant.toFixed(0)} days` : "no propellant budget set"}
      />
    </div>
  )
}
