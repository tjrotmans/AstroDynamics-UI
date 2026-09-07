// Must stay the first import -- see devPerfShim.ts (dev-only React
// instrumentation that froze the Phase 03 page for seconds per commit).
import './devPerfShim'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { AppRoot } from './AppRoot'
import { ConnectionLostOverlay } from './components/ConnectionLostOverlay'

const queryClient = new QueryClient()

// ConnectionLostOverlay is a SIBLING of AppRoot, outside GlobalErrorBoundary,
// on purpose -- it must keep working even if App's own render
// tree crashes, so a backend outage during a frontend render error still
// shows a clear status instead of two failure modes fighting for the same
// overlay.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionLostOverlay />
      <AppRoot />
    </QueryClientProvider>
  </StrictMode>,
)
