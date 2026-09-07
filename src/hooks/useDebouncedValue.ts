import { useEffect, useState } from "react"

// Returns `value` only after it has stopped changing for `delayMs`
// (trailing-edge, timer reset on every change). Distinct from
// useThrottledValue: a throttle still fires DURING a continuous gesture at
// the interval, which for a wheel-zoom that costs ~1 s of Plotly relayout
// per fire is still a freeze -- a debounce fires once, after the gesture.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    if (delayMs <= 0) {
      setDebounced(value)
      return
    }
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
