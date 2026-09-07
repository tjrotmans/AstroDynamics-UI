import { useCallback, useEffect, useRef } from "react"

import { getMgaScanResult, getMgaScanStatus, startMgaScan, type MissionConfig } from "@/api/client"
import { useMgaScanStore } from "@/stores/mgaScanStore"

const POLL_INTERVAL_MS = 1500

// mga-scan has no /stream endpoint (see client.ts) -- this mirrors
// useOptimizeStream's start/cleanup shape but polls /status instead of a
// websocket. Self-pacing (schedule the next poll only after the previous
// one resolves), NOT a fixed setInterval -- the exact same fixed-timer bug
// already documented in the design notes for LiveCandidateReplay bit this repo
// once before (requests piling up behind a slow endpoint's own latency).
export function useMgaScan() {
  const reset = useMgaScanStore((state) => state.reset)
  const setJobId = useMgaScanStore((state) => state.setJobId)
  const setState = useMgaScanStore((state) => state.setState)
  const setResult = useMgaScanStore((state) => state.setResult)
  const setError = useMgaScanStore((state) => state.setError)

  const cancelledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      cancelledRef.current = true
      if (timerRef.current != null) clearTimeout(timerRef.current)
    }
  }, [])

  const start = useCallback(
    async (config: MissionConfig) => {
      cancelledRef.current = false
      if (timerRef.current != null) clearTimeout(timerRef.current)
      reset()
      setState("starting")

      try {
        const { job_id } = await startMgaScan(config)
        setJobId(job_id)
        setState("running")

        const poll = async () => {
          if (cancelledRef.current) return
          try {
            const status = await getMgaScanStatus(job_id)
            if (cancelledRef.current) return
            if (status.running) {
              timerRef.current = setTimeout(poll, POLL_INTERVAL_MS)
              return
            }
            if (status.error) {
              setState("error")
              setError(status.error)
              return
            }
            const result = await getMgaScanResult(job_id)
            if (cancelledRef.current) return
            setResult(result)
            setState("done")
          } catch (err) {
            if (cancelledRef.current) return
            setState("error")
            setError(err instanceof Error ? err.message : "Failed to poll MGA scan status")
          }
        }
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS)
      } catch (err) {
        setState("error")
        setError(err instanceof Error ? err.message : "Failed to start MGA scan")
      }
    },
    [reset, setJobId, setState, setResult, setError],
  )

  return { start }
}
