import { PaperCheckbox, PaperHint, PaperSectionLabel } from "./paperForm"
import type { OptimizationBody } from "@/api/client"
import { useBodies } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"

// Paper-native rebuild of the old ForceModelChecklist.tsx -- same v1
// simplification (no per-row role picker: departure/target auto-assigned
// CentralWhenInSoi, everything else checked is AlwaysThirdBody), same
// store read/write, new markup. Hidden for MGA by OptimizerSection (MGA's
// own body selection already IS the propagation body set).
export function ForceModelFields() {
  const { data } = useBodies()
  const optimization = useMissionStore((s) => s.config.optimization)
  const setOptimizationBodies = useMissionStore((s) => s.setOptimizationBodies)

  if (!optimization) return null
  const bodies = optimization.force_model.bodies
  const { departure_body: departureBody, target_body: targetBody } = optimization

  // Real UX finding (audit): MGA's candidate/flyby list and this
  // checklist read/write the SAME optimization.force_model.bodies field (a
  // deliberate choice -- setMgaParams rebuilds it directly, see
  // missionStore.ts) -- so switching Method from MGA to GA/PSO silently
  // carries over whatever MGA candidates were checked as GA's third-body
  // perturbers, a different concept to a user even though it's the same
  // field. Surface it rather than leave it silent: flag whenever a
  // currently-checked perturber also appears in the MGA config's own
  // candidate/flyby lists, regardless of which method is active now.
  const mga = optimization.mga
  const mgaBodyNames = new Set([...(mga?.flyby_bodies ?? []), ...(mga?.sequence_search?.candidate_bodies ?? [])])
  const carriedOver = bodies
    .filter((b) => b.role === "AlwaysThirdBody" && mgaBodyNames.has(b.name))
    .map((b) => b.name)

  const toggleBody = (name: string) => {
    const exists = bodies.some((b) => b.name === name)
    const next: OptimizationBody[] = exists
      ? bodies.filter((b) => b.name !== name)
      : [...bodies, { name, role: name === departureBody || name === targetBody ? "CentralWhenInSoi" : "AlwaysThirdBody" }]
    setOptimizationBodies(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <PaperSectionLabel>Force model bodies</PaperSectionLabel>
      <PaperHint>
        Departure/target body become the central body when the spacecraft is in their SOI; everything else checked
        is a point-mass third-body perturber.
      </PaperHint>
      {carriedOver.length > 0 && (
        <PaperHint>
          {carriedOver.join(", ")} {carriedOver.length === 1 ? "is" : "are"} checked because{" "}
          {carriedOver.length === 1 ? "it's" : "they're"} also in your MGA candidate/flyby list -- the two pickers
          share this same list. Uncheck here if you don't want {carriedOver.length === 1 ? "it" : "them"} perturbing
          this method's search too.
        </PaperHint>
      )}
      <div className="flex flex-col gap-1">
        {data?.bodies.map((body) => (
          <PaperCheckbox
            key={body.name}
            id={`force-model-body-${body.name}`}
            checked={bodies.some((b) => b.name === body.name)}
            onChange={() => toggleBody(body.name)}
            label={body.name}
            note={(body.name === departureBody || body.name === targetBody) && "(central when in SOI)"}
          />
        ))}
      </div>
    </div>
  )
}
