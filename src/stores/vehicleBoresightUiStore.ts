import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { safeLocalStorage } from "@/lib/persistStorage"

// Client-side placement state for the boresight-cone hardware family (star
// tracker / OpNav camera / lidar / comm antenna) in the Spacecraft
// Configuration Builder -- the direct sibling of vehicleUiStore.ts's
// PanelPlacement, kept in its OWN file rather than folded into that store,
// deliberately, to avoid touching vehicleUiStore.ts at all (a parallel
// session is extending the same builder for RCS thrusters in the same
// area). Same "authoritative mount identity, not re-derived from the
// compiled vector every render" reasoning as vehicleUiStore.ts's own header
// comment -- once tilted/spun, a boresight direction can't be reliably
// reverse-engineered back into "which face, what offset, what tilt/spin"
// either. Keyed by hardware index, same indexing missionStore.spacecraft
// .hardware itself uses.
export interface BoresightPlacement {
  faceIndex: number
  u: number
  v: number
  tiltDeg: number
  spinDeg: number
}

interface VehicleBoresightUiStore {
  placements: Record<number, BoresightPlacement>
  setPlacement: (hardwareIndex: number, placement: BoresightPlacement) => void
  reindexAfterRemoval: (removedIndex: number) => void
}

function reindexMap<T>(map: Record<number, T>, removedIndex: number): Record<number, T> {
  const next: Record<number, T> = {}
  for (const [key, value] of Object.entries(map)) {
    const i = Number(key)
    if (i === removedIndex) continue
    next[i > removedIndex ? i - 1 : i] = value
  }
  return next
}

export const useVehicleBoresightUiStore = create<VehicleBoresightUiStore>()(
  persist(
    (set) => ({
      placements: {},
      setPlacement: (hardwareIndex, placement) =>
        set((state) => ({ placements: { ...state.placements, [hardwareIndex]: placement } })),
      reindexAfterRemoval: (removedIndex) =>
        set((state) => ({ placements: reindexMap(state.placements, removedIndex) })),
    }),
    {
      name: "vehicle-boresight-ui-storage-v1",
      storage: createJSONStorage(() => safeLocalStorage),
    },
  ),
)
