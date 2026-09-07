import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { useBodies } from "@/hooks/useApi"
import { captureRadiusFloorM, realTargetBodyRadiusM } from "@/lib/captureRadius"
import { useMissionStore } from "@/stores/missionStore"

const MAX_KM = 100_000

export function CaptureRadiusSlider() {
  const radiusM = useMissionStore((state) => state.config.trajectory.capture?.target_orbit_radius_m ?? 0)
  const objective = useMissionStore((state) => state.config.mission.objective)
  const targetBody = useMissionStore((state) => state.config.target_body)
  const setCaptureRadius = useMissionStore((state) => state.setCaptureRadius)
  const { data: bodiesData } = useBodies()

  // The actual enforcement (bumping a stale/default value up to this floor)
  // lives in MissionSidebar, which -- unlike this component -- is always
  // mounted regardless of mission.objective; see that file for why.
  const realRadiusM = realTargetBodyRadiusM(targetBody, bodiesData?.bodies)
  const minKm = captureRadiusFloorM(targetBody, bodiesData?.bodies) / 1000

  const radiusKm = radiusM / 1000
  // Same trajectory.capture.target_orbit_radius_m field either way -- the
  // backend just interprets it differently per mission.objective (Orbit mode
  // computes a real capture burn from it, Flyby mode targets it as a miss
  // distance with zero capture burn).
  const label = objective === "Flyby" ? "Flyby closest-approach distance" : "Orbit insertion radius"

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor="capture-radius-slider">{label}</Label>
        <span className="text-sm text-muted-foreground">{radiusKm.toFixed(0)} km</span>
      </div>
      <Slider
        id="capture-radius-slider"
        value={[radiusKm]}
        min={minKm}
        max={MAX_KM}
        step={100}
        onValueChange={([km]) => setCaptureRadius(km * 1000)}
      />
      <p className="text-xs text-muted-foreground">
        Closed-orbit target radius around the target body - required for the trajectory solver and simulation to
        produce a real result (e.g. Orbit/Landing objectives). Not used for a pure Flyby.
        {realRadiusM != null && ` Minimum clamped to ${(realRadiusM / 1000).toFixed(0)} km (the body's own radius) plus margin.`}
      </p>
    </div>
  )
}
