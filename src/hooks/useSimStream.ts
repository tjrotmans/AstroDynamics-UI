import { useCallback, useEffect, useRef } from "react"

import {
  cancelSimulate,
  getSimulateResult,
  getSimulateSteps,
  simulateStreamUrl,
  startSimulate,
  type McRunMsg,
  type McSummaryResult,
  type MissionConfig,
  type SimResult,
  type SimStepMsg,
} from "@/api/client"
import { useSimStore } from "@/stores/simStore"

const DONE_MESSAGE = "__DONE__"

export function useSimStream() {
  const reset = useSimStore((state) => state.reset)
  const setJobId = useSimStore((state) => state.setJobId)
  const setConnectionState = useSimStore((state) => state.setConnectionState)
  const setIsMcJob = useSimStore((state) => state.setIsMcJob)
  const appendStep = useSimStore((state) => state.appendStep)
  const setSteps = useSimStore((state) => state.setSteps)
  const setResult = useSimStore((state) => state.setResult)
  const appendMcRun = useSimStore((state) => state.appendMcRun)
  const setMcSummary = useSimStore((state) => state.setMcSummary)
  const setError = useSimStore((state) => state.setError)

  const wsRef = useRef<WebSocket | null>(null)
  const jobIdRef = useRef<number | null>(null)

  useEffect(() => {
    return () => wsRef.current?.close()
  }, [])

  const start = useCallback(
    async (config: MissionConfig) => {
      wsRef.current?.close()
      reset()
      setConnectionState("starting")

      const isMc = config.simulation.monte_carlo_runs > 1
      setIsMcJob(isMc)

      try {
        const { job_id } = await startSimulate(config)
        setJobId(job_id)
        jobIdRef.current = job_id

        const ws = new WebSocket(simulateStreamUrl(job_id))
        wsRef.current = ws
        let receivedAnyMessage = false

        ws.onopen = () => setConnectionState("streaming")

        ws.onmessage = (event: MessageEvent<string>) => {
          if (event.data === DONE_MESSAGE) {
            ws.close()
            setConnectionState("done")
            if (isMc) {
              // MC jobs: no per-step backfill (/steps only exists for single-run
              // jobs) -- fetch the final McSummaryResult from /result directly.
              getSimulateResult(job_id)
                .then((res) => setMcSummary(res as McSummaryResult))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to fetch MC result"))
            } else {
              // Broadcast channels don't replay history to late subscribers --
              // fast jobs routinely finish before the WS handshake completes,
              // so "__DONE__" with zero prior messages doesn't mean there's no
              // data, just that we missed it live. Backfill from /steps in
              // that case before fetching the final result.
              ;(receivedAnyMessage
                ? Promise.resolve()
                : getSimulateSteps(job_id).then((res) => setSteps(res.steps))
              )
                .then(() => getSimulateResult(job_id))
                .then((res) => setResult(res as SimResult))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to fetch result"))
            }
            return
          }
          receivedAnyMessage = true
          if (isMc) {
            appendMcRun(JSON.parse(event.data) as McRunMsg)
          } else {
            appendStep(JSON.parse(event.data) as SimStepMsg)
          }
        }

        ws.onerror = () => {
          setConnectionState("error")
          setError("Simulation stream connection error")
        }
      } catch (err) {
        setConnectionState("error")
        setError(err instanceof Error ? err.message : "Failed to start simulation")
      }
    },
    [reset, setJobId, setConnectionState, setIsMcJob, appendStep, setSteps, setResult, appendMcRun, setMcSummary, setError],
  )

  // Single-run jobs stop within ~1 truth step. Monte Carlo jobs only get
  // /status.cancelled flipped -- the already-dispatched run batch isn't
  // actually interruptible (thread::scope-based, a documented backend
  // limitation, not something the frontend can work around).
  const cancel = useCallback(() => {
    if (jobIdRef.current != null) cancelSimulate(jobIdRef.current).catch(() => {})
  }, [])

  return { start, cancel }
}
