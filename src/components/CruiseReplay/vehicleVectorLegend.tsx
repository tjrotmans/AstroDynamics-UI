import type { HardwareItem } from "@/api/client"

// Single source of truth for the vehicle constraint-vector colors shown as
// a LEGEND (colored dot + text) next to a rendered VehicleMesh. Extracted
// from AttitudePip so CruiseReplayView's main viewport can reuse
// the exact same entries: its in-scene per-cone Html labels (VehicleMesh's
// showLabels) all collapsed onto the same few screen pixels at mission zoom
// — the vehicle there is ALWAYS the distance-exaggerated symbolic marker
// (a real ~2-5 m vehicle at true scale is sub-pixel at any reachable camera
// distance), so per-cone labels can never separate legibly and a corner
// legend is the only honest treatment, same as the pip already concluded
// on.
//
// These colors MUST match VehicleMesh.tsx's HardwareMesh exactly — this is
// a real legend for what VehicleMesh actually renders, not an independent
// color choice, so any future color change there has to be mirrored here.
export const PANEL_NORMAL_COLOR = "#2f6fed"

export const SENSOR_LEGEND: { type: HardwareItem["type"]; label: string; color: string }[] = [
  { type: "StarTracker", label: "star tracker boresight", color: "#39e6ff" },
  { type: "OpNavCamera", label: "OpNav boresight", color: "#2e9e53" },
  { type: "Lidar", label: "lidar boresight", color: "#d64ae0" },
  { type: "CommAntenna", label: "HGA boresight", color: "#f2b400" },
]

// The dot+text legend rows for whatever constraint vectors the given
// hardware list actually renders (panel normal + each present sensor kind).
// Font size is inherited from the parent container deliberately — the pip
// and the main viewport use different sizes for the same entries.
export function VehicleVectorLegendEntries({ hardware }: { hardware: HardwareItem[] }) {
  const presentTypes = new Set(hardware.map((h) => h.type))
  const hasPanel = hardware.some((h) => h.type === "SolarPanel")
  return (
    <>
      {hasPanel && (
        <span className="flex items-center gap-1" style={{ color: PANEL_NORMAL_COLOR }}>
          <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: PANEL_NORMAL_COLOR }} />
          panel normal
        </span>
      )}
      {SENSOR_LEGEND.filter((s) => presentTypes.has(s.type)).map((s) => (
        <span key={s.type} className="flex items-center gap-1" style={{ color: s.color }}>
          <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </>
  )
}
