import { useEffect, useState } from "react"

import { useHealth } from "@/hooks/useApi"

// Global "connection lost" freeze overlay (:
// "if the frontend crashes... it remains on the original page but frozen...
// and unfreezes when it works"). Mounted as a SIBLING of <App/> in main.tsx,
// not inside it, so it keeps working even if App's own render tree crashes
// (see GlobalErrorBoundary, which wraps App but not this). useHealth()
// already polls /api/health (adaptively faster while erroring, see its own
// header); this renders a blocking scrim + status card over the last-
// rendered UI while the backend is unreachable, instead of nothing (today
// only the GNC header's small ConnectionStatus badge reflects this), and
// disappears the instant a poll succeeds again -- no page reload, no lost
// state, since the page never actually unmounts anything underneath.
//
// Real limitation, can't be worked around from a browser tab: this cannot
// actually restart a crashed backend process (mission-server.exe) -- that
// needs something running outside the browser, no JS in a page has OS
// process control. This only detects the outage and waits/retries; someone
// still has to bring the backend back up (cargo run, or
// scripts/start-servers.ps1) for the overlay to actually clear.
export function ConnectionLostOverlay() {
  const { isError, isLoading, dataUpdatedAt } = useHealth()

  // A ticking "Xs ago" readout -- computed from a state tick + timestamp,
  // not Date.now() called directly during render (this project's
  // react-hooks/purity lint rule forbids impure calls in the render body).
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!isError) return
    const id = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [isError])

  if (isLoading || !isError) return null

  const secondsSinceLastOk = dataUpdatedAt ? Math.round((nowMs - dataUpdatedAt) / 1000) : null

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/60 backdrop-blur-[1px]">
      <div className="flex max-w-[380px] flex-col items-center gap-3 rounded-lg border border-white/15 bg-[#111] px-8 py-6 text-center shadow-2xl">
        <span className="size-3 animate-pulse rounded-full bg-destructive" />
        <p className="text-sm font-semibold text-foreground">Backend connection lost</p>
        <p className="text-xs text-muted-foreground">
          Your work is safe — this page hasn't reloaded and nothing is lost. Retrying automatically every few
          seconds.
          {secondsSinceLastOk != null && ` Last connected ${secondsSinceLastOk}s ago.`}
        </p>
        <p className="text-[10.5px] text-muted-foreground/70">
          If this doesn't clear on its own, the backend process needs restarting (cargo run --bin mission-server, or
          scripts/start-servers.ps1).
        </p>
      </div>
    </div>
  )
}
