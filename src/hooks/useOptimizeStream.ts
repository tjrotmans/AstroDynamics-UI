import { useCallback, useEffect, useRef } from "react"

import {
  cancelOptimize,
  getOptimizeResult,
  optimizeStreamUrl,
  startOptimize,
  type MgaSequenceContextMsg,
  type MissionConfig,
  type OptimizeStepMsg,
} from "@/api/client"
import { useOptimizeStore } from "@/stores/optimizeStore"

const DONE_MESSAGE = "__DONE__"

export function useOptimizeStream() {
  const reset = useOptimizeStore((state) => state.reset)
  const setJobId = useOptimizeStore((state) => state.setJobId)
  const setConnectionState = useOptimizeStore((state) => state.setConnectionState)
  const appendStep = useOptimizeStore((state) => state.appendStep)
  const setActiveSequence = useOptimizeStore((state) => state.setActiveSequence)
  const setResult = useOptimizeStore((state) => state.setResult)
  const setError = useOptimizeStore((state) => state.setError)

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

      try {
        const { job_id } = await startOptimize(config)
        setJobId(job_id)
        jobIdRef.current = job_id

        const ws = new WebSocket(optimizeStreamUrl(job_id))
        wsRef.current = ws

        ws.onopen = () => setConnectionState("streaming")

        ws.onmessage = (event: MessageEvent<string>) => {
          if (event.data === DONE_MESSAGE) {
            ws.close()
            setConnectionState("done")
            // Unlike /api/simulate, optimize has no /steps backfill endpoint --
            // if the WS handshake missed the early steps (fast jobs routinely
            // finish before it completes), the convergence history is just
            // sparse. Known limitation, not designed around here.
            getOptimizeResult(job_id)
              .then(setResult)
              .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to fetch result"))
            return
          }
          // The WS also sends a non-schema {"type":"connected"} handshake frame
          // before the first real step -- skip anything that isn't a real step
          // or a sequence-context announcement.
          const parsed = JSON.parse(event.data) as
            | (Partial<OptimizeStepMsg> & { type?: string; msg_type?: undefined })
            | MgaSequenceContextMsg
          if (parsed.msg_type === "mga_sequence") {
            setActiveSequence(parsed)
            return
          }
          if (typeof parsed.step !== "number" || typeof parsed.best_fitness !== "number") return
          appendStep(parsed as OptimizeStepMsg)
        }

        ws.onerror = () => {
          setConnectionState("error")
          setError("Optimization stream connection error")
        }
      } catch (err) {
        setConnectionState("error")
        setError(err instanceof Error ? err.message : "Failed to start optimization")
      }
    },
    [reset, setJobId, setConnectionState, appendStep, setActiveSequence, setResult, setError],
  )

  // Only actually stops GA/PSO within ~1 generation -- MGA's DE search has
  // no cancellation hook server-side yet (openapi.json's cancelOptimize
  // doc). Still worth calling for MGA: /status.cancelled flips true so the
  // UI can at least say "stop requested", and the job frees up once it
  // naturally finishes instead of silently lingering forever unacknowledged.
  const cancel = useCallback(() => {
    if (jobIdRef.current != null) cancelOptimize(jobIdRef.current).catch(() => {})
  }, [])

  return { start, cancel }
}
