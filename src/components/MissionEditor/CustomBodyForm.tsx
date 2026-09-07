import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { MissionConfig } from "@/api/client"
import { useMissionStore } from "@/stores/missionStore"

type TargetBodyConfig = MissionConfig["target_body"]
type GravityModel = NonNullable<TargetBodyConfig["gravity_model"]>
type AtmosphereModel = NonNullable<TargetBodyConfig["atmosphere"]>

const GRAVITY_MODELS: GravityModel[] = ["PointMass", "J2", "J2J3J4"]
const ATMOSPHERE_MODELS: AtmosphereModel[] = ["None", "Exponential"]

// A real, independently-valid TargetBodyConfig shape per config.rs's manual
// Deserialize impl -- mu_m3s2/radius_m/gravity_model/atmosphere don't have
// to resolve from the /api/bodies catalog, they can all be specified
// directly. This is Design Goal #1's "Custom: User-defined via config."
export function CustomBodyForm() {
  const targetBody = useMissionStore((state) => state.config.target_body)
  const setCustomTargetBody = useMissionStore((state) => state.setCustomTargetBody)

  const gravityModel = targetBody.gravity_model ?? "PointMass"

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="custom-body-name">Name</Label>
        <Input
          id="custom-body-name"
          value={targetBody.name}
          onChange={(e) => setCustomTargetBody({ name: e.target.value })}
          placeholder="e.g. 2024 PT5"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="custom-body-mu">Gravitational parameter μ (m³/s²)</Label>
        <Input
          id="custom-body-mu"
          type="number"
          value={targetBody.mu_m3s2 ?? ""}
          onChange={(e) => setCustomTargetBody({ mu_m3s2: e.target.value === "" ? null : Number(e.target.value) })}
          placeholder="e.g. 4.89"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="custom-body-radius">Mean radius (m)</Label>
        <Input
          id="custom-body-radius"
          type="number"
          value={targetBody.radius_m ?? ""}
          onChange={(e) => setCustomTargetBody({ radius_m: e.target.value === "" ? null : Number(e.target.value) })}
          placeholder="e.g. 262"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="custom-body-gravity">Gravity model</Label>
        <Select
          value={gravityModel}
          onValueChange={(value) =>
            setCustomTargetBody({
              gravity_model: value as GravityModel,
              // PointMass carries no j2/j3/j4 -- clear them so a stale
              // value from a previous selection doesn't linger unused.
              ...(value === "PointMass" ? { j2: null, j3: null, j4: null } : {}),
              ...(value === "J2" ? { j3: null, j4: null } : {}),
            })
          }
        >
          <SelectTrigger id="custom-body-gravity" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GRAVITY_MODELS.map((gm) => (
              <SelectItem key={gm} value={gm}>
                {gm}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(gravityModel === "J2" || gravityModel === "J2J3J4") && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="custom-body-j2">J2</Label>
          <Input
            id="custom-body-j2"
            type="number"
            value={targetBody.j2 ?? ""}
            onChange={(e) => setCustomTargetBody({ j2: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
      )}
      {gravityModel === "J2J3J4" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-body-j3">J3</Label>
            <Input
              id="custom-body-j3"
              type="number"
              value={targetBody.j3 ?? ""}
              onChange={(e) => setCustomTargetBody({ j3: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-body-j4">J4</Label>
            <Input
              id="custom-body-j4"
              type="number"
              value={targetBody.j4 ?? ""}
              onChange={(e) => setCustomTargetBody({ j4: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="custom-body-atmosphere">Atmosphere</Label>
        <Select
          value={targetBody.atmosphere ?? "None"}
          onValueChange={(value) => setCustomTargetBody({ atmosphere: value as AtmosphereModel })}
        >
          <SelectTrigger id="custom-body-atmosphere" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ATMOSPHERE_MODELS.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-muted-foreground">
        No ephemeris exists for a custom body beyond what you provide here - solvers that query real ephemeris
        (every Analytical Insights solver) won't resolve this body's position. Use a catalog body for trajectory design; a
        custom body is for missions where target-body physics is being explored independently of when/where it is.
      </p>
    </div>
  )
}
