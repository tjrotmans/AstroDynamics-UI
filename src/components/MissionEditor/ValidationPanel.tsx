import { useEffect } from "react"
import { AlertCircle, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { useValidateConfig } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"

export function ValidationPanel() {
  const config = useMissionStore((state) => state.config)
  const { mutate, data, isPending } = useValidateConfig()
  // This panel lives in the Analytical Insights tab and should only validate the
  // narrowing-relevant fields. optimization is a separate, independently
  // configured sub-stage (Optimize) -- without stripping it, a half-filled
  // optimization section (e.g. enabled but no force-model bodies checked
  // yet) surfaces "optimization.force_model.bodies must contain..." errors
  // here that have nothing to do with what this tab edits.
  const analyticalConfig = { ...config, optimization: null }
  const configJson = JSON.stringify(analyticalConfig)

  // An empty target body can't even deserialize server-side (TargetBodyConfig
  // resolves catalog fields by name), so validating it just guarantees a 400
  // on every fresh load -- wait until a target is picked.
  const hasTarget = config.target_body.name !== ""

  useEffect(() => {
    if (!hasTarget) return
    const timer = setTimeout(() => mutate(analyticalConfig), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configJson, hasTarget])

  if (!hasTarget) {
    return <p className="text-xs text-muted-foreground">Pick a target body to validate the mission.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {isPending && <Badge variant="outline">Validating…</Badge>}
        {!isPending && data?.valid && (
          <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-400">
            <CheckCircle2 data-icon="inline-start" /> Valid
          </Badge>
        )}
        {!isPending && data && !data.valid && (
          <Badge variant="destructive">
            <AlertCircle data-icon="inline-start" />
            {data.errors.length} error{data.errors.length === 1 ? "" : "s"}
          </Badge>
        )}
      </div>
      {!isPending && data && !data.valid && (
        <ul className="flex flex-col gap-1 text-sm text-destructive">
          {data.errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
