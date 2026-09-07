import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { useMissionStore } from "@/stores/missionStore"
import type { LandingConfig } from "@/stores/missionStore"

// Landing-specific config only matters at the Stage 2 hand-off -- Stage 1/
// Analytical Insights' trajectory design never branches on objective (only Stage 2's
// /api/simulate -> simulate.rs::run_landing does). Both fields are optional
// server-side with real fallbacks (deorbit_radius_m defaults to
// capture.target_orbit_radius_m, terminal_altitude_m defaults to 50 m) --
// leave blank to use those.
export function LandingConfigFields() {
  const objective = useMissionStore((state) => state.config.mission.objective)
  const landing = useMissionStore(
    (state) => (state.config.trajectory as { landing?: LandingConfig | null }).landing,
  )
  const setLandingDeorbitRadius = useMissionStore((state) => state.setLandingDeorbitRadius)
  const setLandingTerminalAltitude = useMissionStore((state) => state.setLandingTerminalAltitude)

  if (objective !== "Landing") return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="landing-deorbit-radius">Deorbit burn radius (m)</Label>
        <Input
          id="landing-deorbit-radius"
          type="number"
          value={landing?.deorbit_radius_m ?? ""}
          placeholder="Defaults to capture orbit radius"
          onChange={(e) =>
            setLandingDeorbitRadius(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="landing-terminal-altitude">Terminal altitude (m)</Label>
        <Input
          id="landing-terminal-altitude"
          type="number"
          value={landing?.terminal_altitude_m ?? ""}
          placeholder="Defaults to 50 m"
          onChange={(e) =>
            setLandingTerminalAltitude(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Powered descent ends and reports a handoff once the spacecraft reaches this altitude above the surface.
      </p>
    </div>
  )
}
