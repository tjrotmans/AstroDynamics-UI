import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"

import { safeLocalStorage } from "@/lib/persistStorage"
import type { MissionConfig } from "@/api/client"
import type { components } from "@/api/types"

type HardwareItem = components["schemas"]["HardwareItem"]
type HardwareType = HardwareItem["type"]
type CustomPlate = components["schemas"]["HardwareItemCustomPlate"]
type SolarPanel = components["schemas"]["HardwareItemSolarPanel"]
type RcsThruster = components["schemas"]["HardwareItemRcsThruster"]
// Boresight-cone hardware family -- see
// vehicleGeometry.ts's own header for the shared placement math these share.
type StarTracker = components["schemas"]["HardwareItemStarTracker"]
type OpNavCamera = components["schemas"]["HardwareItemOpNavCamera"]
type Lidar = components["schemas"]["HardwareItemLidar"]
type CommAntenna = components["schemas"]["HardwareItemCommAntenna"]
type MissionObjective = MissionConfig["mission"]["objective"]
type TrajectorySolver = MissionConfig["trajectory"]["solver"]
type OptimizationConfig = components["schemas"]["OptimizationConfig"]
type OptimizationBody = components["schemas"]["OptimizationBody"]
type GaParams = components["schemas"]["GaParams"]
type PsoParams = components["schemas"]["PsoParams"]
type MgaParams = components["schemas"]["MgaParams"]
type MgaScanConfig = components["schemas"]["MgaScanConfig"]
type CruiseConfig = components["schemas"]["CruiseConfig"]

// LandingConfig isn't in openapi.json yet -- confirmed by reading the spec
// directly: TrajectoryConfig has no "landing" property, even though
// config.rs's real LandingConfig { deorbit_radius_m, terminal_altitude_m }
// is genuinely consumed server-side by simulate.rs::run_landing. Same
// situation as the ephemeris "Anise"/"ANISE" casing mismatch below --
// a known backend schema gap, worked around here with a hand-written type
// until the schema catches up.
export interface LandingConfig {
  deorbit_radius_m?: number | null
  terminal_altitude_m?: number | null
}
type TrajectoryWithLanding = MissionConfig["trajectory"] & { landing?: LandingConfig | null }

// Same situation as LandingConfig above: SpacecraftConfig.launch_vehicle is a
// real, genuinely-consumed Rust field (config.rs -- Option<String>, checked
// against the real LaunchVehicleSpec catalog by compute_launch_vehicle_check)
// that openapi.json's SpacecraftConfig schema doesn't document yet. Hand-typed
// here until the schema catches up.
type SpacecraftWithLaunchVehicle = MissionConfig["spacecraft"] & { launch_vehicle?: string | null }

// As of the backend schema update, MgaParams itself now documents
// search_method/mbh/pruning/rp_norm_bounds/eta_max/min_solar_perihelion_m/scan
// directly -- the hand-typed extension this used to need (search_method: "De"
// | "Mbh", a partial MbhConfig) is gone; openapi.json caught up. MgaParamsExt
// is kept as a plain alias (not a real extension anymore) so MgaParamsForm.tsx
// and other call sites don't all need an import rename. Under Mbh, phase 1
// (the DE multi-restart DSM search) is SKIPPED entirely and
// de_population_size/de_generations/de_restarts are effectively inert
// (mbh.hops drives the search instead) -- the form must reflect that or the
// "Search budget" controls are lies.
export type MgaSearchMethod = NonNullable<MgaParams["search_method"]>
export type MgaParamsExt = MgaParams

// departure_epoch is optional in the schema but required for the job to
// actually run (enforced at run time, not at /api/validate) -- default to
// 30 days out so "Run Optimize" isn't blocked on an empty form.
function defaultDepartureEpoch(): string {
  const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return d.toISOString().replace(/\.\d{3}Z$/, " UTC")
}

function defaultOptimizationConfig(targetBodyName: string): OptimizationConfig {
  // No invented fallback target: this used to default to "Mars" when the
  // mission had no target yet, which silently wrote Mars into the sidebar
  // when the Optimize tool auto-enabled -- the user ran a whole search
  // against the wrong body without noticing. An empty target
  // now blocks Run Optimize with an explicit hint instead.
  const target = targetBodyName
  return {
    objective: "MatchTargetDistance",
    method: "GA",
    departure_body: "Earth",
    target_body: target,
    departure_epoch: defaultDepartureEpoch(),
    // A fixed single date is a much harder search than it looks -- transfer
    // geometry is synodic-alignment-sensitive, and a tight target distance
    // (MatchTargetDistance, the default objective) can have NO good burn at
    // all on an unlucky date no matter how the GA tunes theta/dv/phi.
    // Confirmed directly: identical population/generations/dv/coast, only
    // toggling a 90-day window, took a real run from an 8.78M km miss down
    // to 11,115 km. Default to a real window rather than null (fixed date)
    // so a first run isn't accidentally pinned to an infeasible date.
    departure_window_days: 60,
    dv_min_ms: 2_500,
    dv_max_ms: 4_500,
    max_coast_days: 300,
    force_model: {
      integrator: "Dopri5",
      rtol: 1e-9,
      atol: 1e-12,
      // check_config requires >=1 force-model body with role
      // "CentralWhenInSoi" -- an empty list (the old default) makes every
      // Optimize run fail config validation before the GA/PSO ever starts,
      // regardless of body/epoch ("no valid candidate" was actually a 422,
      // not a search failure). Pre-populate with the target body so a
      // fresh Optimize stage is submittable without the user first
      // discovering ForceModelChecklist on their own. (Empty until a target
      // is picked -- selectCatalogBody fills it in then.)
      bodies: target ? [{ name: target, role: "CentralWhenInSoi" }] : [],
    },
    ga: { population_size: 50, generations: 100, crossover_rate: 0.8, mutation_rate: 0.1, elitism_count: 2 },
    pso: null,
    shooting: null,
    mga: null,
  }
}

// This is the Auto (sequence_search) default -- MgaParamsForm also supports a
// Manual mode (real flyby_bodies list, sequence_search: null), added
//. leg_tof_days needs one [min, max] entry in Auto mode since the
// backend falls back to its last entry for every leg once sequence_search
// resolves the real leg count.
//
// flyby_bodies: [] -- required workaround, verified: openapi.json
// documents this field as optional ("ignored when sequence_search is set"),
// but the real Rust MgaParams struct (config.rs) has no #[serde(default)]
// on it, so omitting it 400s with an opaque "JSON parse error: Failed to
// deserialize the JSON body into the target type." Flagged to the backend
// as a schema/impl mismatch; keep sending [] here until that's fixed.
function defaultMgaParams(): MgaParams {
  return {
    flyby_bodies: [],
    leg_tof_days: [[30, 800]],
    sequence_search: {
      candidate_bodies: [],
      max_legs: 3,
      beam_width: 25,
      max_sequences_to_optimize: 8,
      vinf_departure_estimate_ms: 5000,
    },
  }
}

// ReactionWheelCluster.count and SolarPanel.area_m2 are required (non-Option) fields
// on the server's HardwareItem enum, unlike the rest of each variant's fields.
function requiredHardwareFields(type: HardwareType): Record<string, unknown> {
  if (type === "ReactionWheelCluster") return { count: 1 }
  if (type === "SolarPanel") return { area_m2: 4 }
  return {}
}

const defaultConfig: MissionConfig = {
  mission: { name: "", objective: "Flyby" },
  // ANISE, not Keplerian -- every catalog body picked via BodySelector is
  // ANISE-backed real ephemeris. "Keplerian" demands a keplerian_orbit
  // section we never supply, which fails at the API with "ephemeris =
  // 'Keplerian' requires a [target_body.keplerian_orbit] section".
  target_body: { name: "", ephemeris: "Anise" },
  spacecraft: {
    mass_kg: 500,
    dry_mass_kg: 400,
    propellant_mass_kg: 100,
    bus_dims_m: [1, 1, 1],
    inertia_diag_kgm2: [100, 100, 100],
    srp_model: "Cannonball",
    propulsion: { type: "Monoprop", isp_s: 220, thrust_n: 10 },
    hardware: [],
  },
  // Without a capture target, solvers (and anything downstream that depends
  // on a real trajectory leg, including /api/simulate) return an empty
  // result -- this default makes Run Design/Run Simulation produce
  // something real out of the box. Adjustable via CaptureRadiusSlider.
  //
  // departure_epoch: backend now requires this explicitly for any solver
  // that queries real ephemeris (GridSearch/MonteCarlo/GA/PSO -- i.e. every
  // solver left in Analytical Insights' picker) rather than silently defaulting a
  // missing value to "" (that used to be the actual bug -- now it's just an
  // honest "required" error). Default it here so Run Design isn't blocked
  // on the user typing a date first; adjustable via the Departure epoch
  // input in TrajectoryStage.
  trajectory: {
    phases: ["Cruise"],
    solver: "GridSearch",
    departure_body: "Earth",
    departure_epoch: defaultDepartureEpoch(),
    capture: { target_orbit_radius_m: 7_000_000 },
    // null = use the backend's own fallbacks (deorbit_radius_m defaults to
    // capture.target_orbit_radius_m, terminal_altitude_m defaults to 50 m).
    // Only consumed by Stage 2's /api/simulate for a Landing objective.
    landing: null,
  } as TrajectoryWithLanding,
  gnc: {
    navigation_filter: "EKF",
    pointing_mode: "Nadir",
    attitude_controller: "ReactionWheelPD",
    position_accuracy_req_m: 1000,
    velocity_accuracy_req_mps: 1,
  },
  simulation: {
    integrator: "RK4",
    rtol: 1e-9,
    atol: 1e-12,
    dt_truth_s: 1,
    dt_meas_s: 1,
    monte_carlo_runs: 1,
    output_dir: "./output",
  },
}

interface MissionStore {
  config: MissionConfig
  // Real bug fixed (
  // GA optimizer part are automatically set... despite my own input"):
  // StudyPaper's survey-derived ΔV-bounds auto-seed was gated only on a
  // component-local `hasSeededRef` -- reset on every mount/reload -- so the
  // first Run of EVERY session silently clobbered whatever the user had
  // typed into the dv min/max fields beforehand. This persisted flag is the
  // real guard: set by any manual edit (setOptimizationDvRange, the input
  // fields' own path), checked by the auto-seed (seedOptimizationDvRange),
  // which becomes a permanent no-op once the user has ever touched the
  // fields. Same touched-guard idiom gncModesStore already uses.
  dvRangeTouched: boolean
  loadConfig: (config: MissionConfig) => void
  setMissionName: (name: string) => void
  setObjective: (objective: MissionObjective) => void
  setBodyName: (name: string) => void
  selectCatalogBody: (name: string) => void
  setCustomTargetBody: (fields: Partial<MissionConfig["target_body"]>) => void
  setSolver: (solver: TrajectorySolver) => void
  setTrajectoryDepartureBody: (name: string) => void
  setTrajectoryDepartureEpoch: (epoch: string | null) => void
  setTrajectoryCruise: (fields: Partial<CruiseConfig>) => void
  setLandingDeorbitRadius: (meters: number | null) => void
  setLandingTerminalAltitude: (meters: number | null) => void
  enableOptimization: () => void
  seedOptimizationDeparture: (epoch: string, windowDays: number) => void
  disableOptimization: () => void
  setOptimizationObjective: (objective: OptimizationConfig["objective"]) => void
  setOptimizationMethod: (method: OptimizationConfig["method"]) => void
  setOptimizationDepartureBody: (name: string) => void
  setOptimizationTargetBody: (name: string) => void
  setOptimizationDepartureEpoch: (epoch: string | null) => void
  setOptimizationDepartureWindow: (days: number | null) => void
  setOptimizationDvRange: (minMs: number, maxMs: number) => void
  /** Survey-derived auto-seed of the ΔV bounds -- a silent no-op forever
   * once the user has manually edited either bound (see dvRangeTouched). */
  seedOptimizationDvRange: (minMs: number, maxMs: number) => void
  /** Configurable angle search ranges: burn-location theta
   * [0..360] and out-of-plane phi [-90..90], degrees. Partial update --
   * pass only the fields being edited. */
  setOptimizationAngleRanges: (fields: {
    theta_min_deg?: number | null
    theta_max_deg?: number | null
    phi_min_deg?: number | null
    phi_max_deg?: number | null
  }) => void
  setOptimizationMaxCoastDays: (days: number) => void
  setOptimizationBodies: (bodies: OptimizationBody[]) => void
  setGaParams: (params: GaParams) => void
  setPsoParams: (params: PsoParams) => void
  setMgaParams: (params: MgaParamsExt) => void
  setMgaScanConfig: (scan: MgaScanConfig | null) => void
  setMass: (massKg: number) => void
  setPropellantMass: (propellantMassKg: number) => void
  setBusDim: (index: number, valueM: number) => void
  setCaptureRadius: (radiusM: number) => void
  setPositionAccuracyReq: (meters: number) => void
  toggleHardware: (type: HardwareType) => void
  // Real bug found and fixed (direct user ask: "we need to be
  // able to add different types/size of thrusters or wheels... which is
  // dependent on the exact design"). The original signature only ever
  // wrote the `.model` LABEL string -- confirmed against
  // wheel_cluster_from_hardware() (backend) that the actual simulated
  // torque/momentum/speed capacity NEVER consulted `.model` at all,
  // always falling back to ReactionWheelSpec::medium() regardless of
  // which catalog grade was "selected" -- selecting RW-Small vs RW-Large
  // was cosmetic everywhere in the app, not just missing from the new
  // vehicle builder. `specPatch` is the real numeric fields resolved from
  // the chosen catalog entry (the caller already has the full spec object
  // from useHardwareCatalog()), merged alongside the label so selecting a
  // model actually changes what the sim integrates against.
  setHardwareModel: (type: HardwareType, name: string, specPatch?: Record<string, unknown>) => void
  setSrpModel: (model: MissionConfig["spacecraft"]["srp_model"]) => void
  // Spacecraft Configuration Builder (GNC phase 02 design).
  // Index-based, not type-based like toggleHardware/setHardwareModel above,
  // since a mission can have many placed plates/panels at once (those two
  // dedupe by type on purpose, for the single-instance hardware they
  // manage). Accepts a CustomPlate (other flat-plate hardware -- antenna
  // dishes, instrument covers), a SolarPanel with real placement fields set
  // (position_m/normal/width_m/height_m -- the backend's own purpose-built
  // placed-panel representation, shipped), an RcsThruster with
  // real position_m/direction set (shipped, the backend schema work --
  // see vehicleGeometry.ts's compileThruster), or one of the boresight-cone
  // sensor/antenna types (StarTracker/OpNavCamera/Lidar/CommAntenna,
  // shipped, the backend schema work -- see vehicleGeometry.ts's
  // compileBoresightItem).
  addPlacedPlate: (
    item: CustomPlate | SolarPanel | RcsThruster | StarTracker | OpNavCamera | Lidar | CommAntenna,
  ) => void
  updateHardwareAt: (index: number, patch: Partial<HardwareItem>) => void
  removeHardwareAt: (index: number) => void
  setIntegrator: (integrator: MissionConfig["simulation"]["integrator"]) => void
  setRtol: (rtol: number) => void
  setAtol: (atol: number) => void
  setPropulsion: (propulsion: MissionConfig["spacecraft"]["propulsion"]) => void
  setLaunchVehicle: (name: string | null) => void
  // Backend Phase 14a: [trajectory.departure].mode -- ParkingOrbit
  // (spacecraft starts in an orbit, fires its own departure burn) or Launch
  // (from a launch site; the launcher's upper stage injects, the search's
  // departure genes become the asymptote v∞/RLA/DLA and the parking orbit is
  // derived closed-form). check_config requires spacecraft.launch_vehicle
  // and a launch_site for Launch. Additive: every existing config stays
  // byte-identical (no `departure` object written until one of these runs).
  setDepartureMode: (mode: "ParkingOrbit" | "Launch") => void
  setLaunchSite: (site: { name?: string; lat_deg: number; lon_deg?: number } | null) => void
  setDepartureInclination: (deg: number | null) => void
  setMonteCarloRuns: (runs: number) => void
}

// Persisted (direct user feedback: "the frontend sometimes
// fails/crashes, I then need to reload and lose everything I did") -- the
// mission config is the one place every field the user has hand-edited
// lives (Table 1's inline edits, solver/method/param forms, hardware
// checklist, etc.), all cheap to lose relative to a real backend run but
// still real, sometimes lengthy, manual setup work. Only `config` is
// persisted -- every other field on this store is an action function, not
// data.
export const useMissionStore = create<MissionStore>()(
  persist(
    (set) => ({
      config: defaultConfig,
      dvRangeTouched: false,

  // Wholesale replace the config -- used by the preset-mission picker.
  // PresetEntry.config is `unknown` in the schema (parsed from arbitrary
  // TOML server-side, not a typed passthrough), so this is the one place
  // in the store that trusts an external MissionConfig shape rather than
  // building one field-by-field from the current state.
  //
  // Real bug (found, TODO "Presets can load a config Explore
  // can't run"): some presets (e.g. apophis_orbit.toml -- a Phase 2 GNC
  // sizing test case, not meant to run a Lambert search at all) omit
  // trajectory.departure_epoch entirely, since it's optional in the schema
  // and irrelevant to that preset's own Hohmann sizing estimate. A fresh
  // mission gets `defaultDepartureEpoch()` from `defaultConfig` above; a
  // loaded preset bypassed that fill and left the field genuinely empty,
  // which the Survey/Optimizer sections then hit as a runtime "required"
  // error with no obvious cause. Same 30-days-out fallback, applied only
  // when the preset itself didn't set one.
  loadConfig: (config) =>
    set({
      config: {
        ...config,
        trajectory: {
          ...config.trajectory,
          departure_epoch: config.trajectory.departure_epoch ?? defaultDepartureEpoch(),
        },
      },
    }),

  setMissionName: (name) =>
    set((state) => ({
      config: { ...state.config, mission: { ...state.config.mission, name } },
    })),

  setObjective: (objective) =>
    set((state) => ({
      config: { ...state.config, mission: { ...state.config.mission, objective } },
    })),

  setBodyName: (name) =>
    set((state) => ({
      config: { ...state.config, target_body: { ...state.config.target_body, name } },
    })),

  selectCatalogBody: (name) =>
    set((state) => ({
      // Picking a catalog body clears any custom overrides from a previous
      // "Custom..." selection -- TargetBodyConfig's manual Deserialize impl
      // (config.rs) resolves any omitted field from the body_models catalog
      // by name, so leaving these as null/undefined is exactly "use the
      // catalog value."
      //
      // The mission sidebar is the single place the target is picked, so the
      // optimization config's own target_body field follows it (when
      // optimization is enabled) rather than having its own Select. The
      // force_model's central-body entry follows too -- optimization can be
      // auto-enabled before any target exists (empty bodies list), and
      // check_config requires >=1 CentralWhenInSoi body to run.
      config: {
        ...state.config,
        target_body: { name, ephemeris: "Anise" },
        optimization: state.config.optimization
          ? {
              ...state.config.optimization,
              target_body: name,
              force_model: {
                ...state.config.optimization.force_model,
                bodies: [
                  { name, role: "CentralWhenInSoi" as const },
                  ...state.config.optimization.force_model.bodies.filter(
                    (b) => b.name !== name && b.name !== state.config.optimization?.target_body,
                  ),
                ],
              },
            }
          : state.config.optimization,
      },
    })),

  setCustomTargetBody: (fields) =>
    set((state) => ({
      config: {
        ...state.config,
        target_body: { ...state.config.target_body, ...fields },
      },
    })),

  setSolver: (solver) =>
    set((state) => ({
      config: { ...state.config, trajectory: { ...state.config.trajectory, solver } },
    })),

  // Departure body/epoch are mission-level facts defined once in the sidebar;
  // trajectory.* and optimization.* each carry their own copy backend-side
  // (openapi: optimization's epoch is "NOT derived from trajectory's"), so
  // the store keeps them in lockstep the same way setOptimizationTargetBody
  // already does for the target.
  setTrajectoryDepartureBody: (name) =>
    set((state) => ({
      config: {
        ...state.config,
        trajectory: { ...state.config.trajectory, departure_body: name },
        optimization: state.config.optimization
          ? { ...state.config.optimization, departure_body: name }
          : state.config.optimization,
      },
    })),

  setTrajectoryDepartureEpoch: (epoch) =>
    set((state) => ({
      config: {
        ...state.config,
        trajectory: { ...state.config.trajectory, departure_epoch: epoch },
        optimization: state.config.optimization
          ? { ...state.config.optimization, departure_epoch: epoch }
          : state.config.optimization,
      },
    })),

  // CruiseConfig is the search-space window (TOF range + departure window)
  // for the narrowing-stage solvers -- all fields optional, omitted ones
  // fall back to the backend's own defaults (100-400 day TOF, 60-day
  // window), which don't bracket a valid transfer for many real bodies.
  //
  // departure_window_days also mirrors into optimization.departure_window_days
  // (Phase B revision: the study paper asks for a departure
  // window once, in the Survey section, not a second time in the Optimizer
  // section) -- same lockstep pattern setTrajectoryDepartureBody/
  // setTrajectoryDepartureEpoch already use for their fields.
  setTrajectoryCruise: (fields) =>
    set((state) => ({
      config: {
        ...state.config,
        trajectory: {
          ...state.config.trajectory,
          cruise: { ...state.config.trajectory.cruise, ...fields },
        },
        optimization:
          state.config.optimization && fields.departure_window_days !== undefined
            ? { ...state.config.optimization, departure_window_days: fields.departure_window_days }
            : state.config.optimization,
      },
    })),

  setLandingDeorbitRadius: (meters) =>
    set((state) => {
      const trajectory = state.config.trajectory as TrajectoryWithLanding
      return {
        config: {
          ...state.config,
          trajectory: {
            ...trajectory,
            landing: { ...trajectory.landing, deorbit_radius_m: meters },
          } as TrajectoryWithLanding,
        },
      }
    }),

  setLandingTerminalAltitude: (meters) =>
    set((state) => {
      const trajectory = state.config.trajectory as TrajectoryWithLanding
      return {
        config: {
          ...state.config,
          trajectory: {
            ...trajectory,
            landing: { ...trajectory.landing, terminal_altitude_m: meters },
          } as TrajectoryWithLanding,
        },
      }
    }),

  enableOptimization: () =>
    set((state) => {
      const base = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      // Optimization inherits the mission-level facts (departure body/epoch)
      // already defined in the sidebar, rather than starting from unrelated
      // defaults the user then has to re-enter.
      const optimization = {
        ...base,
        departure_body: state.config.trajectory.departure_body ?? base.departure_body,
        departure_epoch: base.departure_epoch ?? state.config.trajectory.departure_epoch,
      }
      // Same fix as setOptimizationTargetBody: the optimization config's own
      // target_body (defaulted to "Mars" if nothing was picked yet) must be
      // reflected onto the top-level target_body.name immediately on enable,
      // not just when the user later changes the Select -- otherwise a user
      // who never picked a target in the sidebar first runs with
      // target_body.name still "", which fails deserialization with an
      // opaque 400 (see setOptimizationTargetBody's comment).
      const target_body =
        state.config.target_body.name === ""
          ? { name: optimization.target_body, ephemeris: "Anise" as const }
          : state.config.target_body
      return { config: { ...state.config, target_body, optimization } }
    }),

  // The Explore -> Optimize hand-off: an analytical result's best departure
  // date becomes Optimize's search center, with a window around it. Enables
  // optimization if it isn't yet (inheriting mission fields like
  // enableOptimization does). Also updates the mission-level epoch
  // (trajectory.departure_epoch) -- the sidebar is the single source of
  // truth, so the two copies must not silently diverge after a seed.
  seedOptimizationDeparture: (epoch, windowDays) =>
    set((state) => {
      const base = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      const optimization = {
        ...base,
        departure_body: state.config.trajectory.departure_body ?? base.departure_body,
        departure_epoch: epoch,
        // Never NARROW a window the user (or the cruise-field mirror, which
        // is user input too) already set wider -- same
        // silent-override theme as the ΔV-bounds seed: this used to
        // unconditionally reset a configured 60-day window down to the
        // 30-day refine default on the first run. Seeding may still WIDEN
        // an unset/smaller window (the original hand-off intent).
        departure_window_days: Math.max(windowDays, base.departure_window_days ?? 0),
      }
      const target_body =
        state.config.target_body.name === ""
          ? { name: optimization.target_body, ephemeris: "Anise" as const }
          : state.config.target_body
      return {
        config: {
          ...state.config,
          target_body,
          trajectory: { ...state.config.trajectory, departure_epoch: epoch },
          optimization,
        },
      }
    }),

  disableOptimization: () =>
    set((state) => ({ config: { ...state.config, optimization: null } })),

  setOptimizationObjective: (objective) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, objective } } }
    }),

  setOptimizationMethod: (method) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      // Switching to MGA needs optimization.mga populated -- it's required
      // when method = "MGA" (server-side check_config rejects a null mga),
      // and unlike ga/pso it isn't pre-populated by defaultOptimizationConfig
      // since GA is the default method.
      const mga = method === "MGA" ? (optimization.mga ?? defaultMgaParams()) : optimization.mga
      return { config: { ...state.config, optimization: { ...optimization, method, mga } } }
    }),

  setOptimizationDepartureBody: (name) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, departure_body: name } } }
    }),

  setOptimizationTargetBody: (name) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      // Also sync the top-level target_body.name -- this is a *separate*
      // field from optimization.target_body (the backend's TargetBodyConfig
      // custom Deserialize impl resolves mu_m3s2/radius_m/etc. from this
      // top-level name, not from optimization.target_body). Leaving it at
      // its default empty string when a user goes straight to the Optimize
      // tab without first visiting Analytical Insights/BodySelector made
      // every Optimize run fail deserialization with an opaque 400 (the
      // backend's JsonRejection doesn't surface the real "name not in
      // catalog" detail) -- keep them in lockstep instead.
      return {
        config: {
          ...state.config,
          target_body: { name, ephemeris: "Anise" },
          optimization: { ...optimization, target_body: name },
        },
      }
    }),

  setOptimizationDepartureEpoch: (epoch) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, departure_epoch: epoch } } }
    }),

  setOptimizationDepartureWindow: (days) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, departure_window_days: days } } }
    }),

  setOptimizationDvRange: (minMs, maxMs) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return {
        // Manual path (the dv min/max input fields) -- marks the range as
        // user-owned so the survey auto-seed below never overrides it again.
        dvRangeTouched: true,
        config: {
          ...state.config,
          optimization: { ...optimization, dv_min_ms: minMs, dv_max_ms: maxMs },
        },
      }
    }),

  seedOptimizationDvRange: (minMs, maxMs) =>
    set((state) => {
      if (state.dvRangeTouched) return state
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return {
        config: {
          ...state.config,
          optimization: { ...optimization, dv_min_ms: minMs, dv_max_ms: maxMs },
        },
      }
    }),

  setOptimizationAngleRanges: (fields) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, ...fields } } }
    }),

  setOptimizationMaxCoastDays: (days) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, max_coast_days: days } } }
    }),

  setOptimizationBodies: (bodies) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return {
        config: {
          ...state.config,
          optimization: { ...optimization, force_model: { ...optimization.force_model, bodies } },
        },
      }
    }),

  setGaParams: (params) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, ga: params } } }
    }),

  setPsoParams: (params) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      return { config: { ...state.config, optimization: { ...optimization, pso: params } } }
    }),

  setMgaParams: (params) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      // The MGA body selection (manual flyby sequence or sequence-search
      // candidates) IS the propagation body set -- 
      // only selected bodies should be taken into account in the propagation.
      // Rebuild force_model.bodies from it (target = central-when-in-SOI,
      // everything else third-body) instead of keeping a separate checklist
      // for MGA. NOTE: the backend's MGA re-propagation currently ignores
      // force_model entirely (Sun-only point-mass, mga.rs::reprop_mga_arc) --
      // the config sent is correct, honoring it is planned backend-side.
      const selected = new Set([
        ...(params.flyby_bodies ?? []),
        ...(params.sequence_search?.candidate_bodies ?? []),
      ])
      selected.delete(optimization.target_body)
      const force_model = {
        ...optimization.force_model,
        bodies: [
          { name: optimization.target_body, role: "CentralWhenInSoi" as const },
          ...[...selected].map((name) => ({ name, role: "AlwaysThirdBody" as const })),
        ],
      }
      return { config: { ...state.config, optimization: { ...optimization, mga: params, force_model } } }
    }),

  // Deliberately separate from setMgaParams -- that action rebuilds
  // force_model.bodies wholesale as a side effect, which is correct for a
  // flyby-sequence edit but irrelevant (and needlessly coupled) for a
  // scan-only settings edit.
  setMgaScanConfig: (scan) =>
    set((state) => {
      const optimization = state.config.optimization ?? defaultOptimizationConfig(state.config.target_body.name)
      const mga = optimization.mga ?? defaultMgaParams()
      return { config: { ...state.config, optimization: { ...optimization, mga: { ...mga, scan } } } }
    }),

  setMass: (massKg) =>
    set((state) => {
      const propellant = state.config.spacecraft.propellant_mass_kg
      return {
        config: {
          ...state.config,
          spacecraft: {
            ...state.config.spacecraft,
            mass_kg: massKg,
            dry_mass_kg: Math.max(massKg - propellant, 0),
          },
        },
      }
    }),

  setPropellantMass: (propellantMassKg) =>
    set((state) => {
      const mass = state.config.spacecraft.mass_kg
      return {
        config: {
          ...state.config,
          spacecraft: {
            ...state.config.spacecraft,
            propellant_mass_kg: propellantMassKg,
            dry_mass_kg: Math.max(mass - propellantMassKg, 0),
          },
        },
      }
    }),

  setBusDim: (index, valueM) =>
    set((state) => {
      const busDims = [...state.config.spacecraft.bus_dims_m]
      busDims[index] = valueM
      return {
        config: {
          ...state.config,
          spacecraft: { ...state.config.spacecraft, bus_dims_m: busDims },
        },
      }
    }),

  setCaptureRadius: (radiusM) =>
    set((state) => ({
      config: {
        ...state.config,
        trajectory: { ...state.config.trajectory, capture: { ...state.config.trajectory.capture, target_orbit_radius_m: radiusM } },
      },
    })),

  setPositionAccuracyReq: (meters) =>
    set((state) => ({
      config: { ...state.config, gnc: { ...state.config.gnc, position_accuracy_req_m: meters } },
    })),

  toggleHardware: (type) =>
    set((state) => {
      const hardware = state.config.spacecraft.hardware
      const exists = hardware.some((item) => item.type === type)
      const nextHardware = exists
        ? hardware.filter((item) => item.type !== type)
        : [...hardware, { type, ...requiredHardwareFields(type) } as HardwareItem]
      return {
        config: {
          ...state.config,
          spacecraft: { ...state.config.spacecraft, hardware: nextHardware },
        },
      }
    }),

  setHardwareModel: (type, model, specPatch) =>
    set((state) => {
      const hardware = state.config.spacecraft.hardware
      const exists = hardware.some((item) => item.type === type)
      const patch = { model, ...specPatch }
      const nextHardware = exists
        ? hardware.map((item) => (item.type === type ? { ...item, ...patch } : item))
        : [...hardware, { type, ...patch, ...requiredHardwareFields(type) } as HardwareItem]
      return {
        config: {
          ...state.config,
          spacecraft: { ...state.config.spacecraft, hardware: nextHardware },
        },
      }
    }),

  setSrpModel: (model) =>
    set((state) => ({
      config: { ...state.config, spacecraft: { ...state.config.spacecraft, srp_model: model } },
    })),

  addPlacedPlate: (item) =>
    set((state) => {
      const srpModel = state.config.spacecraft.srp_model
      return {
        config: {
          ...state.config,
          spacecraft: {
            ...state.config.spacecraft,
            hardware: [...state.config.spacecraft.hardware, item],
            // A placed plate does nothing physically under Cannonball (it
            // ignores geometry entirely) -- auto-switch to NPlate (the
            // general model: automatic 6 bus faces + SolarPanel entries +
            // CustomPlates) the first time a plate is placed, same
            // auto-switch pattern setOptimizationMethod("MGA") already
            // uses elsewhere. Never overrides an explicit FlatPlate choice.
            srp_model: srpModel === "Cannonball" ? "NPlate" : srpModel,
          },
        },
      }
    }),

  updateHardwareAt: (index, patch) =>
    set((state) => {
      const hardware = state.config.spacecraft.hardware.map((item, i) =>
        i === index ? ({ ...item, ...patch } as HardwareItem) : item,
      )
      return { config: { ...state.config, spacecraft: { ...state.config.spacecraft, hardware } } }
    }),

  removeHardwareAt: (index) =>
    set((state) => {
      const hardware = state.config.spacecraft.hardware.filter((_, i) => i !== index)
      return { config: { ...state.config, spacecraft: { ...state.config.spacecraft, hardware } } }
    }),

  setIntegrator: (integrator) =>
    set((state) => ({
      config: { ...state.config, simulation: { ...state.config.simulation, integrator } },
    })),

  setRtol: (rtol) =>
    set((state) => ({
      config: { ...state.config, simulation: { ...state.config.simulation, rtol } },
    })),

  setAtol: (atol) =>
    set((state) => ({
      config: { ...state.config, simulation: { ...state.config.simulation, atol } },
    })),

  setPropulsion: (propulsion) =>
    set((state) => ({
      config: { ...state.config, spacecraft: { ...state.config.spacecraft, propulsion } },
    })),

  setLaunchVehicle: (name) =>
    set((state) => {
      // Launch departure mode needs a launcher (check_config 422s without
      // one) -- removing the vehicle falls back to ParkingOrbit rather than
      // leaving an unrunnable config behind.
      const departure = state.config.trajectory.departure
      const trajectory =
        name == null && departure?.mode === "Launch"
          ? { ...state.config.trajectory, departure: { ...departure, mode: "ParkingOrbit" as const } }
          : state.config.trajectory
      return {
        config: {
          ...state.config,
          trajectory,
          spacecraft: {
            ...(state.config.spacecraft as SpacecraftWithLaunchVehicle),
            launch_vehicle: name,
          } as SpacecraftWithLaunchVehicle,
        },
      }
    }),

  setDepartureMode: (mode) =>
    set((state) => ({
      config: {
        ...state.config,
        trajectory: {
          ...state.config.trajectory,
          departure: { ...(state.config.trajectory.departure ?? {}), mode },
        },
      },
    })),

  setLaunchSite: (site) =>
    set((state) => ({
      config: {
        ...state.config,
        trajectory: {
          ...state.config.trajectory,
          departure: {
            ...(state.config.trajectory.departure ?? {}),
            mode: state.config.trajectory.departure?.mode ?? "ParkingOrbit",
            launch_site: site,
          },
        },
      },
    })),

  setDepartureInclination: (deg) =>
    set((state) => ({
      config: {
        ...state.config,
        trajectory: {
          ...state.config.trajectory,
          departure: {
            ...(state.config.trajectory.departure ?? {}),
            mode: state.config.trajectory.departure?.mode ?? "ParkingOrbit",
            inclination_deg: deg,
          },
        },
      },
    })),

  setMonteCarloRuns: (runs) =>
    set((state) => ({
      config: { ...state.config, simulation: { ...state.config.simulation, monte_carlo_runs: runs } },
    })),
    }),
    {
      name: "astrodynamics-mission",
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ config: state.config, dvRangeTouched: state.dvRangeTouched }),
    },
  ),
)
