import { PaperField, PaperHint, PaperInput, PaperSelect } from "./paperForm"
import { useMissionStore } from "@/stores/missionStore"
import type { MissionConfig } from "@/api/client"
import { SRP_MODELS } from "@/lib/srpModels"

type TargetBodyConfig = MissionConfig["target_body"]
type GravityModel = NonNullable<TargetBodyConfig["gravity_model"]>
type AtmosphereModel = NonNullable<TargetBodyConfig["atmosphere"]>
type Integrator = MissionConfig["simulation"]["integrator"]

const GRAVITY_MODELS: { value: GravityModel; hint: string }[] = [
  { value: "PointMass", hint: "Central body modeled as a point mass only -- fastest, but no oblateness perturbation." },
  { value: "J2", hint: "Adds the J2 oblateness zonal harmonic -- captures nodal/apsidal regression." },
  { value: "J2J3J4", hint: "Adds J2, J3, and J4 zonal harmonics -- higher central-body force fidelity." },
]
const ATMOSPHERE_MODELS: { value: AtmosphereModel; hint: string }[] = [
  { value: "None", hint: "No drag force applied -- correct for interplanetary cruise." },
  { value: "Exponential", hint: "Scale-height + sea-level density drag model -- fast, adequate for LEO work." },
]
const INTEGRATORS: { value: Integrator; hint: string }[] = [
  { value: "RK4", hint: "Fixed-step 4th-order Runge-Kutta -- fast, no error control." },
  { value: "DormandPrince45", hint: "Adaptive 4th/5th-order Runge-Kutta -- the standard mission-sim choice." },
  { value: "Dopri5", hint: "Adaptive 5th-order Dormand-Prince variant -- higher-fidelity validation passes." },
  { value: "Radau", hint: "Implicit 5th-order method -- appropriate for stiff problems." },
]

// Paper-native rebuild of the old PhysicsConfigFields.tsx -- same 6 fields
// (Design Goal #8, "Configurable physics"), same store read/write, new
// markup. Override-on-top-of-catalog: leaving gravity_model/atmosphere
// unset keeps whatever the body catalog resolves to server-side.
export function PhysicsFields() {
  const targetBody = useMissionStore((s) => s.config.target_body)
  const srpModel = useMissionStore((s) => s.config.spacecraft.srp_model)
  const simulation = useMissionStore((s) => s.config.simulation)
  const setCustomTargetBody = useMissionStore((s) => s.setCustomTargetBody)
  const setSrpModel = useMissionStore((s) => s.setSrpModel)
  const setIntegrator = useMissionStore((s) => s.setIntegrator)
  const setRtol = useMissionStore((s) => s.setRtol)
  const setAtol = useMissionStore((s) => s.setAtol)

  const gravityModel = targetBody.gravity_model ?? undefined
  const atmosphere = targetBody.atmosphere ?? undefined

  return (
    <div className="flex flex-col gap-3">
      <PaperField
        label="Gravity model (override)"
        htmlFor="physics-gravity-model"
        note={gravityModel ? GRAVITY_MODELS.find((g) => g.value === gravityModel)?.hint : "Leave unset to use the catalog default."}
      >
        <PaperSelect
          id="physics-gravity-model"
          value={gravityModel ?? ""}
          placeholder="Use catalog default"
          options={GRAVITY_MODELS.map((g) => ({ value: g.value, label: g.value }))}
          onChange={(value) =>
            setCustomTargetBody({
              gravity_model: value,
              ...(value === "PointMass" ? { j2: null, j3: null, j4: null } : {}),
              ...(value === "J2" ? { j3: null, j4: null } : {}),
            })
          }
        />
      </PaperField>

      <PaperField
        label="Atmosphere (override)"
        htmlFor="physics-atmosphere"
        note={atmosphere ? ATMOSPHERE_MODELS.find((a) => a.value === atmosphere)?.hint : "Leave unset to use the catalog default."}
      >
        <PaperSelect
          id="physics-atmosphere"
          value={atmosphere ?? ""}
          placeholder="Use catalog default"
          options={ATMOSPHERE_MODELS.map((a) => ({ value: a.value, label: a.value }))}
          onChange={(value) => setCustomTargetBody({ atmosphere: value })}
        />
      </PaperField>

      <PaperField label="SRP model" htmlFor="physics-srp-model" note={SRP_MODELS.find((s) => s.value === srpModel)?.hint}>
        <PaperSelect
          id="physics-srp-model"
          value={srpModel}
          options={SRP_MODELS.map((s) => ({ value: s.value, label: s.value }))}
          onChange={(value) => setSrpModel(value)}
        />
      </PaperField>

      <PaperField
        label="Integrator"
        htmlFor="physics-integrator"
        note={INTEGRATORS.find((i) => i.value === simulation.integrator)?.hint}
      >
        <PaperSelect
          id="physics-integrator"
          value={simulation.integrator}
          options={INTEGRATORS.map((i) => ({ value: i.value, label: i.value }))}
          onChange={(value) => setIntegrator(value)}
        />
      </PaperField>

      <PaperField label="Relative tolerance (rtol)" htmlFor="physics-rtol">
        <PaperInput id="physics-rtol" step="any" value={simulation.rtol} onChange={(v) => setRtol(Number(v))} />
      </PaperField>
      <PaperField label="Absolute tolerance (atol)" htmlFor="physics-atol">
        <PaperInput id="physics-atol" step="any" value={simulation.atol} onChange={(v) => setAtol(Number(v))} />
      </PaperField>
      <PaperHint>Bounds the per-step local integration error -- tighter values are more accurate, slower.</PaperHint>
    </div>
  )
}
