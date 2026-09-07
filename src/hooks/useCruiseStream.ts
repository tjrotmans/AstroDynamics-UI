import { useCallback, useEffect, useRef } from "react"

import {
  cancelSimulate,
  getCruiseResult,
  getCruiseSteps,
  simulateStreamUrl,
  startSimulate,
  type CruiseStepMsg,
  type MissionConfig,
} from "@/api/client"
import { useCruiseStore } from "@/stores/cruiseStore"

const DONE_MESSAGE = "__DONE__"
// Real, severe bug found (
// physical"). Root cause, confirmed numerically (a raw-step position jump
// of 141.5 million km lined up EXACTLY with a t_s jump of ~6.66 million
// seconds in a single WS message, while every neighboring step increments
// by exactly dt_meas_s=30s): a cruise leg at tick_s=30 over an ~11.1M
// second Mercury transfer needs ~371,500 individual CruiseStepMsg
// messages. The old appendStep did `steps: [...state.steps, step]` on
// EVERY message -- an O(n) full-array copy per message, O(n^2) total
// (~371,500^2 ~ 138 BILLION element copies for this one run). That
// overwhelmed the tab badly enough that a huge middle chunk of the stream
// never got processed/rendered before the run finished -- not a real
// physical teleport, a starved consumer. Buffered here instead: incoming
// messages are pushed into a cheap mutable array (O(1) per message, no
// copying) and flushed into the Zustand store as one shallow-copied
// snapshot on a throttled interval, cutting total array-copy work from
// O(n^2) to roughly O(n * flush_count) -- a few hundred flushes instead of
// hundreds of thousands.
const STEP_FLUSH_INTERVAL_MS = 200

// Modeled directly on useSimStream.ts -- same /api/simulate job/stream/
// status/result endpoints, which already branch server-side purely on
// whether config.cruise_seed is set (no new API surface). config passed in
// here MUST have cruise_seed populated (and monte_carlo_runs left at 0 --
// cruise Monte Carlo is a separate, not-yet-built slice, the design notes "03
// layer 2") or the server falls back to the legacy body-centric path and
// every message here will fail to parse as CruiseStepMsg.
export function useCruiseStream() {
  const reset = useCruiseStore((state) => state.reset)
  const setJobId = useCruiseStore((state) => state.setJobId)
  const setConnectionState = useCruiseStore((state) => state.setConnectionState)
  const setSteps = useCruiseStore((state) => state.setSteps)
  const setResult = useCruiseStore((state) => state.setResult)
  const setError = useCruiseStore((state) => state.setError)

  const wsRef = useRef<WebSocket | null>(null)
  const jobIdRef = useRef<number | null>(null)
  const bufferRef = useRef<CruiseStepMsg[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      wsRef.current?.close()
      if (flushTimerRef.current != null) clearInterval(flushTimerRef.current)
    }
  }, [])

  const start = useCallback(
    async (config: MissionConfig) => {
      wsRef.current?.close()
      if (flushTimerRef.current != null) clearInterval(flushTimerRef.current)
      bufferRef.current = []
      reset()
      setConnectionState("starting")

      try {
        const { job_id } = await startSimulate(config)
        setJobId(job_id)
        jobIdRef.current = job_id

        const ws = new WebSocket(simulateStreamUrl(job_id))
        wsRef.current = ws

        const flush = () => {
          if (bufferRef.current.length === 0) return
          setSteps(bufferRef.current.slice())
        }
        flushTimerRef.current = setInterval(flush, STEP_FLUSH_INTERVAL_MS)

        ws.onopen = () => setConnectionState("streaming")

        ws.onmessage = (event: MessageEvent<string>) => {
          if (event.data === DONE_MESSAGE) {
            ws.close()
            if (flushTimerRef.current != null) clearInterval(flushTimerRef.current)
            setConnectionState("done")
            // Real bug found (
            // isn't physical" -- traced to a real gap in the live-streamed
            // data, a ~7-day chunk of a long cruise leg never arriving over
            // the WS stream even after fixing the O(n^2) buffering bug
            // above). The backend keeps the COMPLETE step history in memory
            // server-side regardless of what the best-effort WS broadcast
            // actually delivered (steps.rs: "Full step/run history for a
            // job... Same message shape as the WS stream"). Always fetch it
            // fresh on completion instead of trusting the live stream to
            // have been complete -- this used to only backfill when ZERO
            // messages arrived (the fast-job-finished-before-handshake
            // case), silently accepting a partial buffer otherwise.
            getCruiseSteps(job_id)
              .then((res) => setSteps(res.steps))
              .then(() => getCruiseResult(job_id))
              .then((res) => setResult(res))
              .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to fetch cruise result"))
            return
          }
          // Backend defensive check landed, built specifically
          // for the exact bug class fixed earlier
          // (monte_carlo_runs: 1 silently routing this same WS connection
          // to a completely different message shape, CruiseMcRunMsg, which
          // got blindly parsed as CruiseStepMsg and crashed reading r_m off
          // an object that never had it). msg_type now lets a consumer
          // verify that assumption at parse time instead of trusting the
          // request was built correctly.
          const parsed = JSON.parse(event.data) as CruiseStepMsg & { msg_type?: string }
          if (parsed.msg_type !== "cruise_tick") {
            setError(
              `Cruise stream sent an unexpected message shape (msg_type="${parsed.msg_type}") -- the request likely didn't set cruise_seed/monte_carlo_runs correctly.`,
            )
            ws.close()
            if (flushTimerRef.current != null) clearInterval(flushTimerRef.current)
            return
          }
          bufferRef.current.push(parsed)
        }

        ws.onerror = () => {
          if (flushTimerRef.current != null) clearInterval(flushTimerRef.current)
          setConnectionState("error")
          setError("Cruise simulation stream connection error")
        }
      } catch (err) {
        setConnectionState("error")
        setError(err instanceof Error ? err.message : "Failed to start cruise simulation")
      }
    },
    [reset, setJobId, setConnectionState, setSteps, setResult, setError],
  )

  const cancel = useCallback(() => {
    if (jobIdRef.current != null) cancelSimulate(jobIdRef.current).catch(() => {})
  }, [])

  return { start, cancel }
}
