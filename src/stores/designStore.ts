import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { safeLocalStorage } from "@/lib/persistStorage"
import type {
  ArcApiPoint,
  DvLedgerApiResult,
  GncDesign,
  LaunchGeometryApiResult,
  LaunchVehicleCheckApiResult,
  TrajectoryApiResult,
} from "@/api/client"

export interface SelectedTrajectory {
  kind: "hohmann" | "best_arc" | "optimizer"
  label: string
  dv_total_ms: number
  arc: ArcApiPoint[]
  // Real Phase 01 burn data, carried through so Phase 03 can fire the SAME
  // burns Phase 01 actually computed instead of reconstructing/approximating
  // them -- see the design notes
  // "STANDING REQUIREMENT" sections (read those before touching any of
  // this). Only populated for an `"optimizer"`-kind adoption
  // (OptimizeApiResult); undefined otherwise (a Hohmann/best-arc adoption
  // has no equivalent real search result to carry these from).
  //
  // `preDepartureOrbitArc`/`postCaptureOrbitArc`/`achievedTofDays`
  //: the OTHER two-thirds of Phase 01's real, complete,
  // already-propagated trajectory -- `arc` alone is only the middle
  // transfer segment. All three are already in ONE consistent heliocentric
  // frame (backend Phase 12k) -- concatenate directly, no conversion. See
  // `OptimizeTrajectoryView.tsx` for the reference implementation this
  // mirrors.
  preDepartureOrbitArc?: ArcApiPoint[] | null
  postCaptureOrbitArc?: ArcApiPoint[] | null
  achievedTofDays?: number
  // Real bug found: the REAL chosen departure epoch
  // (`OptimizeApiResult.dep_jd`) is NOT always the mission config's nominal
  // `trajectory.departure_epoch` -- GA/PSO search a departure WINDOW and
  // depart on whatever day within it was optimal, so the two can genuinely
  // differ (by potentially many days, which at ~1 AU orbital speeds is
  // millions of km of real body motion). `OptimizeTrajectoryView.tsx` has
  // always used `result.dep_jd` for this reason; Phase 03 silently used the
  // nominal config value instead, since `SelectedTrajectory` never carried
  // this at all -- the real root cause of the departure body visibly not
  // lining up with the spacecraft's actual departure point.
  depJd?: number
  captureTimeS?: number | null
  captureDvInertialMps?: number[] | null
  // Real departure/injection ΔV vector (`departure_dv_inertial_mps`, backend
  //) -- carries the out-of-plane component the interim
  // `arc[0].v − pre[last].v` derivation approximated. Absent on older
  // adoptions (buildPlannedBurns falls back to the interim).
  departureDvInertialMps?: number[] | null
  // the two-pool ΔV model needs
  // to know whether the launcher covers departure (then the departure burn
  // is an EXTERNAL stage in Phase 03 -- no tank draw) and the per-burn
  // magnitudes for the propellant-feasibility gate.
  launchVehicleFeasible?: boolean | null
  dvDepartureMs?: number
  dvArrivalMs?: number
  // Backend Phase 14d/14e: the result's OWN launch-vehicle
  // check (at the optimizer's real C3 -- previously the survey's check
  // stood in), the two-pool ΔV ledger, and who pays the departure burn
  // (`departure_dv_pool`) -- Phase 03 sets `external_stage` from the pool
  // and splits the departure into a launcher stage + onboard top-up when
  // the pool is "split". `dvLedgerVehicle` is the vehicle the ledger was
  // priced for, so propellantFeasibility.ts can tell whether the backend's
  // available-ΔV verdict still applies after Phase 02 edits. Absent on
  // adoptions predating the fields (pre-preset snapshots).
  launchVehicleCheck?: LaunchVehicleCheckApiResult | null
  dvLedger?: DvLedgerApiResult | null
  dvLedgerVehicle?: { massKg: number; propellantMassKg: number; ispS: number | null } | null
  departureDvPool?: "launcher" | "onboard" | "split" | null
  // Phase 14a/14c/14d: departure mode and, in Launch mode, the closed-form
  // launch geometry (RLA/DLA, plane, azimuth, coast, injection state) --
  // DISPLAY data for the schematic ascent / stage-separation visuals; the
  // physical reference stays pre_departure_orbit_arc.
  departureMode?: "ParkingOrbit" | "Launch"
  launchGeometry?: LaunchGeometryApiResult | null
  injectionEpochJd?: number
  // MGA only. `mgaDvDsmsInertialMps` (2026-08-19/20): real per-leg inertial
  // ΔV VECTORS for each DSM -- `mga.rs`'s `v_dsm_before_mps`/
  // `v_dsm_after_mps` are now exposed on the wire (backend note in
  // the design notes 13n entry, since landed); `mgaDvDsmsMs`/`mgaDsmPositionsM`
  // are the magnitude/position-only fields kept for display use.
  mgaDvDsmsMs?: number[] | null
  mgaDvDsmsInertialMps?: number[][] | null
  mgaDsmPositionsM?: [number, number, number][] | null
  mgaLegTofsDays?: number[] | null
}

interface DesignStore {
  trajectoryResult: TrajectoryApiResult | null
  gncResult: GncDesign | null
  selectedTrajectory: SelectedTrajectory | null
  setTrajectoryResult: (result: TrajectoryApiResult | null) => void
  setGncResult: (result: GncDesign | null) => void
  setSelectedTrajectory: (trajectory: SelectedTrajectory | null) => void
}

// Persisted ("I lose everything" feedback) -- a survey/GNC
// result is expensive (a real backend call, sometimes minutes) to
// reproduce, so a crash/reload shouldn't discard it.
export const useDesignStore = create<DesignStore>()(
  persist(
    (set) => ({
      trajectoryResult: null,
      gncResult: null,
      selectedTrajectory: null,
      setTrajectoryResult: (result) => set({ trajectoryResult: result }),
      setGncResult: (result) => set({ gncResult: result }),
      setSelectedTrajectory: (trajectory) => set({ selectedTrajectory: trajectory }),
    }),
    {
      name: "astrodynamics-design",
      storage: createJSONStorage(() => safeLocalStorage),
      // Root cause of "I don't see any visual changes in the Phase 03
      // viewport": this store
      // persists across sessions with no versioning, so an adoption made
      // BEFORE `depJd`/`preDepartureOrbitArc`/per-point velocities existed
      // kept replaying forever -- every new code path has a silent
      // "stale cached data" fallback, so the app degraded to exactly the
      // old behavior no matter what shipped. The migrate below drops such
      // an adoption on first load after upgrade (survey/GNC results are
      // kept -- only the adoption must be redone, via a fresh Phase 01
      // optimize + Adopt); CruiseReplayPage additionally shows a loud
      // banner instead of silently falling back, so this class of
      // staleness can never be invisible again.
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as {
          trajectoryResult: unknown
          gncResult: unknown
          selectedTrajectory: SelectedTrajectory | null
        }
        if (version < 1 && state?.selectedTrajectory) {
          const t = state.selectedTrajectory
          const stale = t.kind === "optimizer" && (t.depJd == null || t.arc?.[0]?.vx_mps == null)
          if (stale) state.selectedTrajectory = null
        }
        return state
      },
      partialize: (state) => ({
        trajectoryResult: state.trajectoryResult,
        gncResult: state.gncResult,
        selectedTrajectory: state.selectedTrajectory,
      }),
    },
  ),
)
