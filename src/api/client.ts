import type { components } from "./types"

export type HealthResponse = components["schemas"]["HealthResponse"]
export type BodiesResponse = components["schemas"]["BodiesResponse"]
export type HardwareResponse = components["schemas"]["HardwareResponse"]
export type ObjectivesResponse = components["schemas"]["ObjectivesResponse"]
export type MissionConfig = components["schemas"]["MissionConfig"]
export type ValidationResponse = components["schemas"]["ValidationResponse"]
export type TrajectoryApiResult = components["schemas"]["TrajectoryApiResult"]
export type HohmannApiResult = components["schemas"]["HohmannApiResult"]
export type BestArcApiResult = components["schemas"]["BestArcApiResult"]
export type PorkchopApiPoint = components["schemas"]["PorkchopApiPoint"]
export type MonteCarloApiResult = components["schemas"]["MonteCarloApiResult"]
export type OptimizerApiResult = components["schemas"]["OptimizerApiResult"]
export type ArcApiPoint = components["schemas"]["ArcApiPoint"]
export type GncDesign = components["schemas"]["GncDesign"]
export type VehicleRequest = components["schemas"]["VehicleRequest"]
export type VehicleProperties = components["schemas"]["VehicleProperties"]
export type ComponentContribution = components["schemas"]["ComponentContribution"]
export type VehicleSrpResult = components["schemas"]["VehicleSrpResult"]
export type SrpPlateForce = components["schemas"]["SrpPlateForce"]
export type BodyInfo = components["schemas"]["BodyInfo"]
export type StartSimResponse = components["schemas"]["StartSimResponse"]
export type JobStatusResponse = components["schemas"]["JobStatusResponse"]
export type SimStepMsg = components["schemas"]["SimStepMsg"]
export type SimResult = components["schemas"]["SimResult"]
export type StepsResponse = components["schemas"]["StepsResponse"]
export type OptimizationConfig = components["schemas"]["OptimizationConfig"]
export type OptimizationBody = components["schemas"]["OptimizationBody"]
export type GaParams = components["schemas"]["GaParams"]
export type PsoParams = components["schemas"]["PsoParams"]
export type MgaParams = components["schemas"]["MgaParams"]
export type StartOptimizeResponse = components["schemas"]["StartOptimizeResponse"]
export type OptimizeJobStatusResponse = components["schemas"]["OptimizeJobStatusResponse"]
export type OptimizeStepMsg = components["schemas"]["OptimizeStepMsg"]
export type MgaSequenceContextMsg = components["schemas"]["MgaSequenceContextMsg"]
export type OptimizeApiResult = components["schemas"]["OptimizeApiResult"]
export type BodyStateResponse = components["schemas"]["BodyStateResponse"]
export type LaunchVehicleCheckApiResult = components["schemas"]["LaunchVehicleCheckApiResult"]
export type DvLedgerApiResult = components["schemas"]["DvLedgerApiResult"]
export type LaunchGeometryApiResult = components["schemas"]["LaunchGeometryApiResult"]
export type LaunchVehicleSpec = components["schemas"]["LaunchVehicleSpec"]
export type SlewTestRequest = components["schemas"]["SlewTestRequest"]
export type SlewTestInitialStateRequest = components["schemas"]["SlewTestInitialStateRequest"]
export type SlewTestSample = components["schemas"]["SlewTestSample"]
export type SlewTestResult = components["schemas"]["SlewTestResult"]
export type McRunMsg = components["schemas"]["McRunMsg"]
export type McSummaryResult = components["schemas"]["McSummaryResult"]
export type McTrajPoint = components["schemas"]["McTrajPoint"]
export type PresetEntry = components["schemas"]["PresetEntry"]
export type PresetsResponse = components["schemas"]["PresetsResponse"]
export type StartMgaScanResponse = components["schemas"]["StartMgaScanResponse"]
export type MgaScanJobStatusResponse = components["schemas"]["MgaScanJobStatusResponse"]
export type MgaScanRecordApi = components["schemas"]["MgaScanRecordApi"]
export type MgaScanApiResult = components["schemas"]["MgaScanApiResult"]
export type RankedSequenceApi = components["schemas"]["RankedSequenceApi"]
export type SequenceSearchApiResult = components["schemas"]["SequenceSearchApiResult"]
export type CruiseSeedConfig = components["schemas"]["CruiseSeedConfig"]
export type CruiseReferencePointConfig = components["schemas"]["CruiseReferencePointConfig"]
export type GncModeConfig = components["schemas"]["GncModeConfig"]
export type PointingRuleConfig = components["schemas"]["PointingRuleConfig"]
export type PointingTargetConfig = components["schemas"]["PointingTargetConfig"]
export type ModeScheduleEntryConfig = components["schemas"]["ModeScheduleEntryConfig"]
export type BodyTrackConfig = components["schemas"]["BodyTrackConfig"]
export type PlannedBurnConfig = components["schemas"]["PlannedBurnConfig"]
export type CruiseStepMsg = components["schemas"]["CruiseStepMsg"]
export type CruiseResult = components["schemas"]["CruiseResult"]
export type CruiseStepsResponse = components["schemas"]["CruiseStepsResponse"]
export type ModeTransitionReport = components["schemas"]["ModeTransitionReport"]
export type HardwareItem = components["schemas"]["HardwareItem"]

async function errorMessageFromBody(res: Response): Promise<string | undefined> {
  const body: unknown = await res.json().catch(() => undefined)
  if (typeof body !== "object" || body === null) return undefined
  const record = body as Record<string, unknown>
  if (Array.isArray(record.errors)) return record.errors.join("; ")
  if (typeof record.error === "string") return record.error
  return undefined
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const message = await errorMessageFromBody(res)
    throw new Error(message ?? `${init?.method ?? "GET"} ${url} failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/api/health")
}

export function getBodies(): Promise<BodiesResponse> {
  return fetchJson<BodiesResponse>("/api/bodies")
}

export function getHardware(): Promise<HardwareResponse> {
  return fetchJson<HardwareResponse>("/api/hardware")
}

// 422s for bodies with no ANISE/DE440S ephemeris coverage (small bodies like
// Bennu/Apophis) -- by design, not a bug. Callers wanting to render a "best
// effort" multi-body scene should catch and skip that body, not surface an
// error to the user.
export function getBodyState(name: string, epoch: string): Promise<BodyStateResponse> {
  return fetchJson<BodyStateResponse>(`/api/bodies/${encodeURIComponent(name)}/state?epoch=${encodeURIComponent(epoch)}`)
}

export function getObjectives(): Promise<ObjectivesResponse> {
  return fetchJson<ObjectivesResponse>("/api/objectives")
}

export function getPresets(): Promise<PresetsResponse> {
  return fetchJson<PresetsResponse>("/api/presets")
}

export function validateConfig(config: MissionConfig): Promise<ValidationResponse> {
  return fetchJson<ValidationResponse>("/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
}

export function designTrajectory(config: MissionConfig): Promise<TrajectoryApiResult> {
  return fetchJson<TrajectoryApiResult>("/api/design/trajectory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
}

export function designGnc(config: MissionConfig): Promise<GncDesign> {
  return fetchJson<GncDesign>("/api/design/gnc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
}

export function designVehicle(request: VehicleRequest): Promise<VehicleProperties> {
  return fetchJson<VehicleProperties>("/api/design/vehicle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
}

// Synchronous, no job/polling -- a cheap canned 90deg attitude-step test
// against the submitted config's real vehicle/actuator/gain values
//. See
// SlewTestRequest's own generated doc comment (types.ts) for the governing
// control law/allocation math and server-side clamps.
export function designSlewTest(request: SlewTestRequest): Promise<SlewTestResult> {
  return fetchJson<SlewTestResult>("/api/design/slew-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
}

export function startSimulate(config: MissionConfig): Promise<StartSimResponse> {
  return fetchJson<StartSimResponse>("/api/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
}

export function getSimulateStatus(jobId: number): Promise<JobStatusResponse> {
  return fetchJson<JobStatusResponse>(`/api/simulate/${jobId}/status`)
}

export function getSimulateResult(jobId: number): Promise<SimResult | McSummaryResult> {
  return fetchJson<SimResult | McSummaryResult>(`/api/simulate/${jobId}/result`)
}

export function getSimulateSteps(jobId: number): Promise<StepsResponse> {
  return fetchJson<StepsResponse>(`/api/simulate/${jobId}/steps`)
}

// Idempotent -- cancelling an already-finished job is a harmless no-op. For
// a Monte Carlo job (monte_carlo_runs > 0) this only affects /status
// reporting; the already-dispatched run batch isn't actually interruptible
// (thread::scope-based, a documented backend limitation, not a bug here).
export function cancelSimulate(jobId: number): Promise<void> {
  return fetchJson<void>(`/api/simulate/${jobId}/cancel`, { method: "POST" })
}

export function simulateStreamUrl(jobId: number): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  return `${protocol}://${window.location.host}/api/simulate/${jobId}/stream`
}

// Same /api/simulate/{id}/steps and /result endpoints as the body-centric
// path above -- they return a different shape when the job was started with
// cruise_seed set (CruiseStepsResponse/CruiseResult instead of
// StepsResponse/SimResult), so these are separately-typed callers of the
// same URLs, not new routes.
export function getCruiseSteps(jobId: number): Promise<CruiseStepsResponse> {
  return fetchJson<CruiseStepsResponse>(`/api/simulate/${jobId}/steps`)
}

export function getCruiseResult(jobId: number): Promise<CruiseResult> {
  return fetchJson<CruiseResult>(`/api/simulate/${jobId}/result`)
}

export function startOptimize(config: MissionConfig): Promise<StartOptimizeResponse> {
  return fetchJson<StartOptimizeResponse>("/api/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
}

export function getOptimizeStatus(jobId: number): Promise<OptimizeJobStatusResponse> {
  return fetchJson<OptimizeJobStatusResponse>(`/api/optimize/${jobId}/status`)
}

export function getOptimizeResult(jobId: number): Promise<OptimizeApiResult> {
  return fetchJson<OptimizeApiResult>(`/api/optimize/${jobId}/result`)
}

export function optimizeStreamUrl(jobId: number): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  return `${protocol}://${window.location.host}/api/optimize/${jobId}/stream`
}

// Idempotent. Honored by GA/PSO within roughly one generation. NOT honored
// by MGA -- its DE search has no cancellation hook yet; `cancelled` still
// flips true on /status, but the job runs to completion regardless.
export function cancelOptimize(jobId: number): Promise<void> {
  return fetchJson<void>(`/api/optimize/${jobId}/cancel`, { method: "POST" })
}

export function startMgaScan(config: MissionConfig): Promise<StartMgaScanResponse> {
  return fetchJson<StartMgaScanResponse>("/api/mga-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
}

export function getMgaScanStatus(jobId: number): Promise<MgaScanJobStatusResponse> {
  return fetchJson<MgaScanJobStatusResponse>(`/api/mga-scan/${jobId}/status`)
}

export function getMgaScanResult(jobId: number): Promise<MgaScanApiResult> {
  return fetchJson<MgaScanApiResult>(`/api/mga-scan/${jobId}/result`)
}

// Plain synchronous request -- the Tisserand beam search alone has no
// propagation/Lambert solve per candidate, so unlike /api/mga-scan there's
// no job/polling pattern here.
export function searchMgaSequences(config: MissionConfig): Promise<SequenceSearchApiResult> {
  return fetchJson<SequenceSearchApiResult>("/api/mga-sequence-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  })
}
