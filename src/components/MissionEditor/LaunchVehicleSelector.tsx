import { InfoTooltip } from "@/components/InfoTooltip"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useHardwareCatalog } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"
import type { MissionConfig } from "@/api/client"

type SpacecraftWithLaunchVehicle = MissionConfig["spacecraft"] & { launch_vehicle?: string | null }

// Only meaningful for an Earth departure -- there is no launcher at all for
// a non-Earth departure body, every burn there comes from onboard
// propellant (see the design notes). Parent decides
// whether to render this, same convention as CaptureRadiusSlider's
// objective === "Orbit" gate.
export function LaunchVehicleSelector() {
  const launchVehicle = useMissionStore(
    (state) => (state.config.spacecraft as SpacecraftWithLaunchVehicle).launch_vehicle ?? null,
  )
  const setLaunchVehicle = useMissionStore((state) => state.setLaunchVehicle)
  const { data: hardware } = useHardwareCatalog()
  const vehicles = hardware?.launch_vehicles ?? []

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="launch-vehicle-select" className="inline-flex items-center gap-1.5">
        Launch vehicle
        <InfoTooltip>
          The vehicle&apos;s real flown-mission C3 curve covers the departure burn for free, up to its
          performance limit -- anything beyond that (or none, if no vehicle is selected) comes out of the
          spacecraft&apos;s own onboard propellant instead.
        </InfoTooltip>
      </Label>
      <Select
        value={launchVehicle ?? "__none__"}
        onValueChange={(value) => setLaunchVehicle(value === "__none__" ? null : value)}
      >
        <SelectTrigger id="launch-vehicle-select" className="w-full">
          <SelectValue placeholder="None (onboard propellant only)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">None (onboard propellant only)</SelectItem>
          {vehicles.map((v) => (
            <SelectItem key={v.name} value={v.name}>
              {v.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
