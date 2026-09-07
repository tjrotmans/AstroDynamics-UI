import { useEffect, useRef } from "react"

import { useDesignVehicle } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"

const VEHICLE_DEBOUNCE_MS = 500

// Shared debounced /api/design/vehicle loop -- extracted from VehiclePaper
// (which owned it alone until VehicleViewport also needed the same real
// com_m for its own 3D CoM marker) so both consumers see the identical,
// single in-flight fetch rather than each debouncing/fetching separately.
// Fires ~500ms after the spacecraft config settles (bus dims, mass, or any
// hardware placement/edit), not on every keystroke/drag frame -- same
// debounce discipline already used for the porkchop heatmap's Max dV field
// elsewhere in this app.
export function useVehicleProperties() {
  const config = useMissionStore((s) => s.config)
  const vehicleMutation = useDesignVehicle()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      // An empty default mission (no target body yet -- the landing page
      // before any preset/route is chosen) is rejected by the server with
      // a 400 "failed to deserialize"; found in the instrumented
      // repro, two rejected requests on every cold load. Nothing to size.
      if (!config.target_body.name) return
      vehicleMutation.mutate({ config })
    }, VEHICLE_DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.spacecraft])
  return { vehicle: vehicleMutation.data, isPending: vehicleMutation.isPending, isError: vehicleMutation.isError }
}
