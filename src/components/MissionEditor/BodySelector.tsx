import { useState } from "react"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useBodies } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"
import { CustomBodyForm } from "./CustomBodyForm"

const CUSTOM_VALUE = "__custom__"

// Design Goal #1's "Custom: User-defined via config" -- an alternative to
// picking from the /api/bodies catalog. Selecting "Custom..." reveals
// CustomBodyForm instead of just setting target_body.name; picking a real
// catalog body clears any custom overrides via selectCatalogBody.
export function BodySelector() {
  const { data, isLoading } = useBodies()
  const bodyName = useMissionStore((state) => state.config.target_body.name)
  const selectCatalogBody = useMissionStore((state) => state.selectCatalogBody)
  const setCustomTargetBody = useMissionStore((state) => state.setCustomTargetBody)

  const isCatalogBody = data?.bodies.some((b) => b.name === bodyName) ?? false
  // A name matching the catalog always means catalog mode, even if
  // target_body also carries explicit mu_m3s2/radius_m/etc. -- several MGA
  // benchmark presets (veega_flyby, cassini2_gtop, evj_flyby,
  // venus_saturn_auto, earth_neptune_auto) restate the target body's real
  // physical constants inline in the TOML, with a citation comment (e.g.
  // "Jacobson et al. 2013 (JUP310)"), for documentation/reproducibility --
  // not as a deliberate per-field override. Loading one used to force
  // "Custom..." mode on a perfectly ordinary catalog body (found:
  // loading evj_flyby showed target body as "Custom: Jupiter" with its own
  // catalog values restated back at it). Only an unmatched name -- a body
  // genuinely outside the catalog -- means Custom now.
  const [forcedCustom, setForcedCustom] = useState(false)
  const isCustom = forcedCustom || (bodyName !== "" && !isCatalogBody)

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="body-select">Target body</Label>
      <Select
        value={isCustom ? CUSTOM_VALUE : bodyName || undefined}
        onValueChange={(value) => {
          if (value === CUSTOM_VALUE) {
            setForcedCustom(true)
            setCustomTargetBody({})
          } else {
            setForcedCustom(false)
            selectCatalogBody(value)
          }
        }}
      >
        <SelectTrigger id="body-select" className="w-full">
          <SelectValue placeholder={isLoading ? "Loading…" : "Select a body"} />
        </SelectTrigger>
        <SelectContent>
          {data?.bodies.map((body) => (
            <SelectItem key={body.name} value={body.name}>
              {body.name}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_VALUE}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && <CustomBodyForm />}
    </div>
  )
}
