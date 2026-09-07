import { useMutation, useQuery } from "@tanstack/react-query"

import {
  designGnc,
  designSlewTest,
  designTrajectory,
  designVehicle,
  getBodies,
  getBodyState,
  getHardware,
  getHealth,
  getObjectives,
  getPresets,
  searchMgaSequences,
  validateConfig,
  type MissionConfig,
  type SlewTestRequest,
  type VehicleRequest,
} from "@/api/client"

// Polls /api/health so a small always-visible indicator can show backend
// reachability. retry: false + a short staleTime keep this from feeling
// laggy when the backend actually goes down -- a failed query reports
// isError immediately rather than retrying silently for a while first.
//
// Adaptive interval (: freeze + auto-resume
// on a backend outage instead of crashing/reloading -- see
// ConnectionLostOverlay): once disconnected, poll every 3s instead of 15s so
// the overlay clears within a few seconds of the backend actually coming
// back, rather than up to 15s late.
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: (query) => (query.state.status === "error" ? 3_000 : 15_000),
    retry: false,
    staleTime: 0,
  })
}

export function useBodies() {
  return useQuery({ queryKey: ["bodies"], queryFn: getBodies })
}

// Heliocentric state for one catalog body at a given epoch. 422s for bodies
// with no ANISE/DE440S ephemeris coverage (small bodies like Bennu/Apophis)
// -- by design, not a bug -- so retry: false keeps a 422 reporting isError
// quickly instead of retrying a request that can never succeed. Callers
// (e.g. a multi-body force-model scene) should treat isError as "skip this
// body," not as something to surface to the user.
export function useBodyState(name: string | null, epoch: string | null) {
  return useQuery({
    queryKey: ["bodyState", name, epoch],
    queryFn: () => getBodyState(name as string, epoch as string),
    enabled: Boolean(name && epoch),
    retry: false,
  })
}

export function useObjectives() {
  return useQuery({ queryKey: ["objectives"], queryFn: getObjectives })
}

export function usePresets() {
  return useQuery({ queryKey: ["presets"], queryFn: getPresets })
}

export function useHardwareCatalog() {
  return useQuery({ queryKey: ["hardware"], queryFn: getHardware })
}

export function useValidateConfig() {
  return useMutation({
    mutationFn: (config: MissionConfig) => validateConfig(config),
  })
}

export function useDesignTrajectory() {
  return useMutation({
    mutationFn: (config: MissionConfig) => designTrajectory(config),
  })
}

export function useDesignGnc() {
  return useMutation({
    mutationFn: (config: MissionConfig) => designGnc(config),
  })
}

// Real derived mass properties (mass/CoM/full inertia tensor/per-component
// breakdown), optionally with real per-plate SRP force vectors when a sun
// direction is given -- POST /api/design/vehicle, done backend-side
//. Callers debounce their own commits (VehiclePaper.tsx) rather
// than this hook doing it, since the debounce delay is a UI-feel choice,
// not an API concern.
export function useDesignVehicle() {
  return useMutation({
    mutationFn: (request: VehicleRequest) => designVehicle(request),
  })
}

// Plain mutation, same shape as useDesignVehicle above -- the slew test is
// synchronous server-side (no job/polling, see designSlewTest's own doc
// comment), so there's no stream/poll pair to build here.
export function useDesignSlewTest() {
  return useMutation({
    mutationFn: (request: SlewTestRequest) => designSlewTest(request),
  })
}

// Plain mutation, not a job/poll pair -- the Tisserand beam search alone
// has no propagation/Lambert solve per candidate, so the backend answers
// synchronously (see api/client.ts's searchMgaSequences doc comment).
export function useSearchMgaSequences() {
  return useMutation({
    mutationFn: (config: MissionConfig) => searchMgaSequences(config),
  })
}
