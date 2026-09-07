import { useState } from "react"
import { InfoTooltip } from "@/components/InfoTooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { HardwareResponse } from "@/api/client"
import type { components } from "@/api/types"
import { useHardwareCatalog } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"

type HardwareItem = components["schemas"]["HardwareItem"]
type HardwareType = HardwareItem["type"]

interface HardwareRow {
  type: HardwareType
  label: string
  catalogKey?: keyof HardwareResponse
  hint: string
}

const HARDWARE_ROWS: HardwareRow[] = [
  {
    type: "ReactionWheelCluster",
    label: "Reaction wheels",
    catalogKey: "reaction_wheels",
    hint: "Primary attitude actuator -- spins internal wheels to exchange momentum with the spacecraft, providing continuous, low-noise torque without consuming propellant. Saturates over time and needs periodic desaturation.",
  },
  {
    type: "RCS",
    label: "RCS thrusters",
    catalogKey: "thrusters",
    hint: "Thruster-based attitude control -- bang-bang torque via thruster couples, used for coarse attitude maneuvers and to desaturate reaction wheels by dumping accumulated momentum.",
  },
  {
    type: "StarTracker",
    label: "Star tracker",
    catalogKey: "star_trackers",
    hint: "Attitude determination sensor -- images star fields to provide absolute 3-axis attitude, typically the most accurate attitude reference on board.",
  },
  {
    type: "OpNavCamera",
    label: "OpNav camera",
    catalogKey: "opnav_cameras",
    hint: "Optical navigation sensor -- images the target body to provide bearing/angular-size measurements for relative position determination during proximity operations.",
  },
  {
    type: "IMU",
    label: "IMU",
    catalogKey: "imus",
    hint: "Inertial measurement unit -- measures delta-V (accelerometer) and/or angular rate (gyro) per timestep, propagating state between absolute measurement updates.",
  },
  {
    type: "SolarPanel",
    label: "Solar panels",
    hint: "Power generation -- mass/area tradeoff against the rest of the bus; sizing affects total spacecraft mass and available power for actuators/sensors/payload.",
  },
]

// These catalog categories exist in /api/hardware but are not yet part of the
// HardwareItem type union the backend accepts in MissionConfig.spacecraft.hardware.
// Shown here for reference so the user can browse available hardware grades and
// their key specs (including power draw) before the schema is extended.
interface CatalogRefRow {
  catalogKey: keyof HardwareResponse
  label: string
  hint: string
  specLabel: (item: { name: string } & Record<string, unknown>) => string
}

const CATALOG_REF_ROWS: CatalogRefRow[] = [
  {
    catalogKey: "lidars",
    label: "LIDAR altimeter",
    hint: "Laser ranging sensor -- slant-range measurement to the target body surface. Needed for terminal descent guidance and close-approach proximity operations.",
    specLabel: (item) => {
      const s = item as components["schemas"]["LidarSpec"]
      return `${s.name} - range noise ${s.range_noise_m} m, max range ${(s.max_range_m / 1000).toFixed(0)} km, ${s.power_w} W`
    },
  },
  {
    catalogKey: "landmark_sensors",
    label: "Landmark sensor",
    hint: "Stereophotoclinometry-analogue bearing sensor -- multi-landmark line-of-sight measurements to known surface features, giving 3-D position without LIDAR.",
    specLabel: (item) => {
      const s = item as components["schemas"]["LandmarkSensorSpec"]
      return `${s.name} - bearing noise ${(s.bearing_noise_rad * 1e3).toFixed(2)} mrad, ${s.catalog_size} landmarks, ${s.power_w} W`
    },
  },
  {
    catalogKey: "dsn_links",
    label: "DSN link (transponder)",
    hint: "Deep Space Network ground-link grade -- two-way range, Doppler, and Delta-DOR measurements from Earth ground stations. Mass/power describe the onboard transponder + HGA terminal.",
    specLabel: (item) => {
      const s = item as components["schemas"]["DsnLinkSpec"]
      return `${s.name} - range noise ${s.range_noise_m} m, Doppler ${s.range_rate_noise_mps} m/s, ${s.power_w} W`
    },
  },
]

// Real per-variant HardwareItem typing (openapi update) means
// `.model` only exists on ReactionWheelCluster/StarTracker -- `"model" in
// item` is the safe narrowing check for the rest, same runtime behavior
// as before (accessing a nonexistent field was always undefined here).
function hardwareItemModel(item: HardwareItem | undefined): string | undefined {
  if (!item || !("model" in item)) return undefined
  const model = item.model
  return typeof model === "string" ? model : undefined
}

// Real bug fix -- see missionStore.ts's own comment on
// setHardwareModel's new specPatch parameter for the full story: selecting
// a wheel model here used to only ever write the `.model` LABEL, never the
// real max_speed_rads/max_torque_nm/inertia_kgm2/mass_kg the simulation
// actually integrates against (confirmed against wheel_cluster_from_
// hardware(), which never reads `.model` at all). Only ReactionWheelCluster
// gets a real patch here -- the aggregate "RCS" row has no `.model` field
// in the schema at all (superseded by the new vehicle builder's
// individually-placed RcsThruster, which gets its own real per-item model
// picker there instead), so its selection stays label-only, unchanged.
function specPatchFor(type: HardwareType, spec: Record<string, unknown>): Record<string, unknown> | undefined {
  if (type === "ReactionWheelCluster") {
    return {
      max_speed_rads: spec.max_speed_rads,
      max_torque_nm: spec.max_torque_nm,
      inertia_kgm2: spec.inertia_kgm2,
      mass_kg: spec.mass_kg,
    }
  }
  return undefined
}

export function HardwareChecklist() {
  const { data } = useHardwareCatalog()
  const hardware = useMissionStore((state) => state.config.spacecraft.hardware)
  const toggleHardware = useMissionStore((state) => state.toggleHardware)
  const setHardwareModel = useMissionStore((state) => state.setHardwareModel)

  // Local model selection for catalog-reference rows (not written to mission config).
  const [refSelection, setRefSelection] = useState<Partial<Record<string, string>>>({})

  return (
    <div className="flex flex-col gap-3">
      {HARDWARE_ROWS.map((row) => {
        const item = hardware.find((h) => h.type === row.type)
        const checked = item !== undefined
        const catalogItems = row.catalogKey
          ? (data?.[row.catalogKey] as ({ name: string } & Record<string, unknown>)[] | undefined)
          : undefined

        return (
          <div key={row.type} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id={`hw-${row.type}`}
                checked={checked}
                onCheckedChange={() => toggleHardware(row.type)}
              />
              <Label htmlFor={`hw-${row.type}`} className="inline-flex items-center gap-1.5">
                {row.label}
                <InfoTooltip>{row.hint}</InfoTooltip>
              </Label>
            </div>
            {checked && catalogItems && catalogItems.length > 0 && (
              <Select
                value={hardwareItemModel(item)}
                onValueChange={(model) => {
                  const spec = catalogItems.find((s) => s.name === model)
                  setHardwareModel(row.type, model, spec ? specPatchFor(row.type, spec) : undefined)
                }}
              >
                <SelectTrigger id={`hw-model-${row.type}`} className="ml-6 w-fit min-w-48">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {catalogItems.map((spec) => (
                    <SelectItem key={spec.name} value={spec.name}>
                      {spec.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )
      })}

      {/* Catalog-reference rows: browsable hardware grades not yet configurable
          in MissionConfig.spacecraft.hardware (HardwareItem type union doesn't
          include these yet). Shown so the user can see available options and
          power draw before the backend schema is extended. */}
      {CATALOG_REF_ROWS.map((row) => {
        const catalogItems = data?.[row.catalogKey] as ({ name: string } & Record<string, unknown>)[] | undefined
        if (!catalogItems || catalogItems.length === 0) return null
        const selected = refSelection[row.catalogKey] ?? ""
        return (
          <div key={row.catalogKey} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Label className="inline-flex items-center gap-1.5 text-muted-foreground">
                {row.label}
                <InfoTooltip>{row.hint}</InfoTooltip>
                <span className="text-[10px] text-muted-foreground/60">(catalog ref)</span>
              </Label>
            </div>
            <Select
              value={selected}
              onValueChange={(v) => setRefSelection((prev) => ({ ...prev, [row.catalogKey]: v }))}
            >
              <SelectTrigger className="w-fit min-w-48">
                <SelectValue placeholder="Browse catalog…" />
              </SelectTrigger>
              <SelectContent>
                {catalogItems.map((spec) => (
                  <SelectItem key={spec.name} value={spec.name} title={row.specLabel(spec)}>
                    {row.specLabel(spec)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}
