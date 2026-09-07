import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { HardwareResponse } from "@/api/client"
import type { components } from "@/api/types"
import { useHardwareCatalog } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"

type HardwareItem = components["schemas"]["HardwareItem"]
type HardwareType = HardwareItem["type"]

// Maps each HardwareItem type to the catalog array that holds its power_w.
// SolarPanel has no catalog representation in HardwareResponse (no solar_panels
// key) -- it's configured via bus dimensions, not a catalog selection, so it's
// excluded here. IMU/OpNavCamera/StarTracker/RCS/ReactionWheelCluster all have
// catalog specs with power_w.
const CATALOG_KEY_FOR_TYPE: Partial<Record<HardwareType, keyof HardwareResponse>> = {
  ReactionWheelCluster: "reaction_wheels",
  RCS: "thrusters",
  StarTracker: "star_trackers",
  OpNavCamera: "opnav_cameras",
  IMU: "imus",
}

function lookupPowerW(
  item: HardwareItem,
  catalog: HardwareResponse,
): number | null {
  const key = CATALOG_KEY_FOR_TYPE[item.type]
  if (!key) return null
  const specs = catalog[key] as { name: string; power_w: number }[]
  // Real per-variant HardwareItem typing (openapi update) means
  // `.model` no longer exists on every variant -- only ReactionWheelCluster
  // and StarTracker declare it. `"model" in item` is the safe narrowing
  // check; RCS/IMU/OpNavCamera/etc. simply have no model to look up (same
  // runtime behavior as before, just now provably correct instead of
  // relying on the old untyped Record<string, unknown> shape).
  const model = "model" in item && typeof item.model === "string" ? item.model : undefined
  if (!model) return null
  const spec = specs.find((s) => s.name === model)
  return spec?.power_w ?? null
}

export function PowerBudgetCard() {
  const { data: catalog } = useHardwareCatalog()
  const hardware = useMissionStore((state) => state.config.spacecraft.hardware)

  if (!catalog) return null

  const rows: { label: string; powerW: number }[] = []
  let totalW = 0

  for (const item of hardware) {
    const w = lookupPowerW(item, catalog)
    if (w == null) continue
    const model = "model" in item && typeof item.model === "string" ? item.model : undefined
    rows.push({ label: item.type + (model ? ` (${model})` : ""), powerW: w })
    totalW += w
  }

  if (rows.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Power budget</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="tabular-nums">{row.powerW} W</span>
            </div>
          ))}
          <div className="mt-2 flex items-center justify-between gap-4 border-t border-border pt-2 text-sm font-medium">
            <span>Total</span>
            <span className="tabular-nums">{totalW.toFixed(0)} W</span>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Nominal operating draw for selected catalog models. Excludes solar panels and unselected hardware.
        </p>
      </CardContent>
    </Card>
  )
}
