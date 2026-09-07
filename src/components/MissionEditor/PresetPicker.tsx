import { useState } from "react"

import type { MissionConfig } from "@/api/client"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { usePresets } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"

// Loads a full MissionConfig from MissionPlanner/config/'s example TOMLs
// (Mars flyby, Venus orbit, Apophis sample return, etc.) via GET /api/presets
// instead of building one from scratch. PresetEntry.config is typed `unknown`
// in the schema (server parses arbitrary TOML, doesn't guarantee it matches
// MissionConfig 1:1) -- cast on load, same trust boundary as any other
// external payload the store accepts wholesale.
export function PresetPicker() {
  const { data, isLoading, isError } = usePresets()
  const loadConfig = useMissionStore((state) => state.loadConfig)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  const selected = data?.presets.find((p) => p.id === selectedId)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Select value={selectedId} onValueChange={setSelectedId} disabled={isLoading || isError}>
          <SelectTrigger id="preset-select" className="w-full">
            <SelectValue placeholder={isLoading ? "Loading presets..." : isError ? "Presets unavailable" : "Start from a preset..."} />
          </SelectTrigger>
          <SelectContent>
            {data?.presets.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={!selected}
          onClick={() => selected && loadConfig(selected.config as MissionConfig)}
        >
          Load
        </Button>
      </div>
      {selected && <p className="text-xs text-muted-foreground">{selected.description}</p>}
    </div>
  )
}
