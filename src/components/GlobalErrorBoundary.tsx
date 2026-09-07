import { Component, type ReactNode } from "react"

// Global safety net (: "if the frontend
// crashes... it remains on the original page but frozen... and unfreezes
// when it works" -- see ConnectionLostOverlay for the backend-outage half of
// that ask). An uncaught render error normally unmounts the whole React tree
// to a blank page, which is what forced a manual browser reload before --
// and since mission state now persists (missionStore/designStore/etc.'s
// `persist` middleware), a reload isn't even destructive anymore, but this
// avoids needing one at all for a transient/recoverable render error.
//
// Reset is driven by a `resetKey` PROP, not an internal setTimeout -- tried
// that first and it doesn't work: React 18 has its own internal recovery
// pass for a thrown render error (it unmounts the boundary and everything
// below it almost immediately after componentDidCatch runs, to attempt a
// clean synchronous re-render), which destroys an in-flight `setTimeout`
// before it ever fires. A parent-driven prop change survives that because
// the parent (see main.tsx's usage) isn't part of what gets torn down.
// main.tsx ties `resetKey` to the backend health poll's `dataUpdatedAt` --
// most real crashes this app hits in practice trace back to a backend
// outage/malformed response (see the design notes),
// so "try again the next time the backend confirms healthy" is a
// deterministic, bounded retry cadence rather than a blind timer.
const MAX_AUTO_RETRIES = 3

interface Props {
  children: ReactNode
  resetKey: unknown
}

interface State {
  hasError: boolean
  retryCount: number
  lastResetKey: unknown
}

export class GlobalErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, retryCount: 0, lastResetKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("GlobalErrorBoundary caught a render error:", error, info)
  }

  componentDidUpdate(prevProps: Props) {
    if (
      this.state.hasError &&
      this.props.resetKey !== prevProps.resetKey &&
      this.state.retryCount < MAX_AUTO_RETRIES
    ) {
      this.setState((s) => ({ hasError: false, retryCount: s.retryCount + 1, lastResetKey: this.props.resetKey }))
    }
  }

  render() {
    if (this.state.hasError) {
      const stillRetrying = this.state.retryCount < MAX_AUTO_RETRIES
      return (
        <div className="fixed inset-0 z-[998] flex items-center justify-center bg-background">
          <div className="flex max-w-[380px] flex-col items-center gap-3 rounded-lg border border-border bg-card px-8 py-6 text-center shadow-2xl">
            <span className="size-3 rounded-full bg-destructive" />
            <p className="text-sm font-semibold text-foreground">Something went wrong</p>
            <p className="text-xs text-muted-foreground">
              {stillRetrying
                ? "Attempting to recover automatically -- your mission data is saved and will still be here."
                : "Automatic recovery didn't work. Your mission data is still saved -- reload to continue."}
            </p>
            {!stillRetrying && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-1 rounded border border-primary bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:brightness-110"
              >
                Reload
              </button>
            )}
          </div>
        </div>
      )
    }
    // Keyed on retryCount: forces a genuine unmount+remount of the whole
    // subtree on each recovery attempt, not just a re-render in place -- a
    // bad local component/hook state that caused the crash won't survive a
    // real remount the way it might survive a bare re-render.
    return <div key={this.state.retryCount}>{this.props.children}</div>
  }
}
