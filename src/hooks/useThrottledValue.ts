import { useEffect, useRef, useState } from "react"

// Returns `value`, but updated at most once per `intervalMs` (trailing edge
// guaranteed, so the final value always lands). Freeze fix: the
// cruise stream appends a tick to `steps` per WebSocket message -- hundreds
// per second -- and every append re-rendered six Plotly figures, the burn
// report and the timeline with O(n) work each, pinning the main thread
// until the tab stopped responding. The heavy consumers now read a
// throttled snapshot; the cheap ones (tick counter, viewport) keep the live
// array. `intervalMs = 0` passes the value straight through.
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value)
  const lastRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (intervalMs <= 0) {
      setThrottled(value)
      return
    }
    const now = performance.now()
    const wait = Math.max(0, intervalMs - (now - lastRef.current))
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      lastRef.current = performance.now()
      setThrottled(value)
    }, wait)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [value, intervalMs])
  return throttled
}
