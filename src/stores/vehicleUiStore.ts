import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { safeLocalStorage } from "@/lib/persistStorage"

// Client-side placement state for the Spacecraft Configuration Builder (GNC
// phase 02), keyed by hardware index (same indexing missionStore.spacecraft
// .hardware itself uses). This is the AUTHORITATIVE mount identity -- which
// face, the (u, v) anchor point on it, and the 3-axis rotation (rotXDeg/
// rotYDeg/rotZDeg, see vehicleGeometry.ts's panelOrientation) -- deliberately
// NOT re-derived from the compiled `normal`/`position_m` on the real
// SolarPanel every render: once a panel is rotated, its real normal is a
// genuine diagonal vector (or, at some angles, coincidentally axis-aligned
// with a DIFFERENT face), so trying to reverse-engineer "which face, what
// offset, what rotation" from the compiled output becomes ambiguous or
// wrong. Keeping the mount identity as its own source of truth (and
// COMPILING the real normal/position_m from it, not the other way around)
// sidesteps that entirely. `decomposePlacement` is still used, once, as a
// bootstrap fallback for a hardware index that has no placement record yet
// (e.g. a placed SolarPanel loaded from a preset TOML authored outside this
// UI) -- see VehicleViewport.tsx. Real width_m/height_m live directly on the
// HardwareItem in missionStore (like area_m2 already did), not duplicated
// here -- unlike face/u/v/rotation, they're genuine first-class backend
// fields with nothing to reverse-engineer.
//
// Migrated from `CustomPlate` to the backend's own purpose-built
// `HardwareItem::SolarPanel` placement fields (`position_m`/`normal`/
// `width_m`/`height_m`/`articulation`), shipped backend-side -
// CustomPlate remains for other flat-plate hardware (antenna dishes,
// instrument covers), but panels now have their own real representation,
// including a real `articulation` mechanism-class declaration
// (OneAxis/TwoAxis/fixed) this store's rotXDeg/rotYDeg map onto via
// vehicleGeometry.ts's articulationFor().
//
// Unified into one 3-axis rotation --
// previously this also carried a separate `hingeAxis`/`deployDeg` pair PLUS
// an entirely separate purely-cosmetic `rotationDeg` map, which read as two
// different bolted-together mechanisms ("the combination of the Rotate
// button and the U and V hinging is very messy"). Both are gone; rotXDeg/
// rotYDeg/rotZDeg (all real, all sent to the backend via compileSolarPanel)
// replace them completely.
//
// Persisted (matching missionStore's own persistence -- "the
// frontend sometimes fails/crashes, I then need to reload and lose
// everything I did") so a placement/rotation edit survives a reload the
// same way the mission config itself does; without this, reloading would
// still keep the real, physically-correct normal/position_m (that part is
// in missionStore, already persisted) but lose the ability to keep editing
// it correctly afterward.
export interface PanelPlacement {
  faceIndex: number
  u: number
  v: number
  rotXDeg: number
  rotYDeg: number
  rotZDeg: number
}

// Authoritative mount identity for a placed RcsThruster -- same rationale
// as PanelPlacement above (a compiled direction vector can't be reliably
// reverse-engineered back into "which face, what anchor, what Cant/Clock"
// once rotated away from the rest orientation), but kept as its OWN map
// rather than folded into PanelPlacement: a thruster has no width/height/
// rotXDeg-rotYDeg-rotZDeg-about-an-edge model at all, just a free
// (cantDeg, clockDeg) direction pair -- see vehicleGeometry.ts's
// thrusterDirection/compileThruster. Keeping it separate means
// PanelPlacement's shape (and every existing SolarPanel placement already
// in a user's localStorage) stays byte-identical.
export interface ThrusterPlacement {
  faceIndex: number
  u: number
  v: number
  cantDeg: number
  clockDeg: number
}

interface VehicleUiStore {
  placements: Record<number, PanelPlacement>
  setPlacement: (hardwareIndex: number, placement: PanelPlacement) => void
  thrusterPlacements: Record<number, ThrusterPlacement>
  setThrusterPlacement: (hardwareIndex: number, placement: ThrusterPlacement) => void
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

export const useVehicleUiStore = create<VehicleUiStore>()(
  persist(
    (set) => ({
      placements: {},
      setPlacement: (hardwareIndex, placement) =>
        set((state) => ({ placements: { ...state.placements, [hardwareIndex]: placement } })),
      thrusterPlacements: {},
      setThrusterPlacement: (hardwareIndex, placement) =>
        set((state) => ({ thrusterPlacements: { ...state.thrusterPlacements, [hardwareIndex]: placement } })),
      reindexAfterRemoval: (removedIndex) =>
        set((state) => ({
          placements: reindexMap(state.placements, removedIndex),
          thrusterPlacements: reindexMap(state.thrusterPlacements, removedIndex),
        })),
    }),
    {
      // v2: the schema changed shape (hingeAxis/deployDeg + a separate
      // rotationDeg map -> a single rotXDeg/rotYDeg/rotZDeg per placement,
      //) -- a new storage key avoids loading stale-shaped
      // records from local dev testing with undefined rotation fields.
      // thrusterPlacements is a purely additive field on the same v2 key
      // -- an existing v2 record just loads with an empty
      // {} for it, no migration needed.
      name: "vehicle-ui-storage-v2",
      storage: createJSONStorage(() => safeLocalStorage),
    },
  ),
)
