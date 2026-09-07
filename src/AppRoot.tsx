import App from "./App"
import { GlobalErrorBoundary } from "./components/GlobalErrorBoundary"
import { useHealth } from "./hooks/useApi"

// Small wrapper so GlobalErrorBoundary's resetKey can come from useHealth()
// -- see that component's header comment for why the reset trigger is a
// prop change (tied to the health poll succeeding) rather than an internal
// timer. Its own file (not main.tsx) since react-refresh/only-export-
// components requires component files to only export components.
export function AppRoot() {
  const { dataUpdatedAt } = useHealth()
  return (
    <GlobalErrorBoundary resetKey={dataUpdatedAt}>
      <App />
    </GlobalErrorBoundary>
  )
}
