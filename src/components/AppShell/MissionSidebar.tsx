import { useEffect } from "react"

import {
  BodySelector,
  CaptureRadiusSlider,
  EpochField,
  LaunchVehicleSelector,
  ObjectiveSelector,
  PresetPicker,
  SpacecraftMassSliders,
  ValidationPanel,
} from "@/components/MissionEditor"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useBodies } from "@/hooks/useApi"
import { captureRadiusFloorM } from "@/lib/captureRadius"
import { useMissionStore } from "@/stores/missionStore"

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>
  )
}

// The single place the mission itself is defined -- objective, bodies,
// epoch, spacecraft. Every tool reads these from the store; none of them
// re-renders its own copy of these fields (the pre-redesign app asked for
// the objective and both bodies twice, once per tool, which is exactly the
// duplication this sidebar exists to kill). Tool-specific *search* settings
// (solver choice, TOF windows, GA params, hardware) stay inside each tool.
export function MissionSidebar() {
  const objective = useMissionStore((state) => state.config.mission.objective)
  const optimizationObjective = useMissionStore((state) => state.config.optimization?.objective)
  const departureBody = useMissionStore((state) => state.config.trajectory.departure_body)
  const departureEpoch = useMissionStore((state) => state.config.trajectory.departure_epoch)
  const setTrajectoryDepartureBody = useMissionStore((state) => state.setTrajectoryDepartureBody)
  const setTrajectoryDepartureEpoch = useMissionStore((state) => state.setTrajectoryDepartureEpoch)
  const targetBody = useMissionStore((state) => state.config.target_body)
  const captureRadiusM = useMissionStore((state) => state.config.trajectory.capture?.target_orbit_radius_m ?? 0)
  const setCaptureRadius = useMissionStore((state) => state.setCaptureRadius)
  const { data: bodiesData } = useBodies()

  const showCaptureRadius = objective === "Orbit" || optimizationObjective === "MatchTargetDistance"

  // Enforced here, not just inside CaptureRadiusSlider, because the backend
  // validates target_orbit_radius_m against the real body radius whenever
  // trajectory.capture is present at all -- not only for capturing
  // objectives -- so a Flyby mission (where the slider above isn't even
  // shown) can still fail with "targets a point inside the body's physical
  // surface" if the target body's real radius exceeds the stored value.
  // Runs on every target-body/catalog change (BodySelector picks, preset
  // loads, the sky landing page's route hand-off), never lowers a
  // user-widened value.
  useEffect(() => {
    const floorM = captureRadiusFloorM(targetBody, bodiesData?.bodies)
    if (captureRadiusM > 0 && captureRadiusM < floorM) setCaptureRadius(floorM)
  }, [targetBody, bodiesData, captureRadiusM, setCaptureRadius])

  return (
    <div className="flex flex-col gap-4">
      <SectionTitle>Mission</SectionTitle>
      <PresetPicker />
      {/* No mission-name input: it added more confusion than value.
 mission.name still
          exists in the config -- presets set it and the header displays it --
          it's just not user-editable here. */}
      <ObjectiveSelector />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="departure-body-select">Departure body</Label>
        <Select value={departureBody ?? undefined} onValueChange={setTrajectoryDepartureBody}>
          <SelectTrigger id="departure-body-select" className="w-full">
            <SelectValue placeholder="Select a body" />
          </SelectTrigger>
          <SelectContent>
            {bodiesData?.bodies.map((b) => (
              <SelectItem key={b.name} value={b.name}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <BodySelector />

      <EpochField
        id="departure-epoch"
        label="Departure epoch"
        value={departureEpoch}
        onChange={setTrajectoryDepartureEpoch}
      />

      {showCaptureRadius && <CaptureRadiusSlider />}

      <Separator />
      <SectionTitle>Spacecraft</SectionTitle>
      <SpacecraftMassSliders />
      {departureBody === "Earth" && <LaunchVehicleSelector />}

      <Separator />
      <SectionTitle>Validation</SectionTitle>
      <ValidationPanel />
    </div>
  )
}
