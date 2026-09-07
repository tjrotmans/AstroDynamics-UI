import { useHealth } from "@/hooks/useApi"
import { cn } from "@/lib/utils"

// Small always-visible backend-reachability indicator for the header.
// useHealth() polls /api/health every 15s with retry disabled, so isError
// reflects a genuinely unreachable backend quickly rather than after a
// long silent retry sequence.
export function ConnectionStatus() {
  const { data, isError, isLoading } = useHealth()
  const connected = !isLoading && !isError && data?.ok === true

  const label = isLoading ? "Connecting..." : connected ? "Backend connected" : "Backend unreachable"

  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground"
      title={label}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          isLoading && "bg-muted-foreground",
          connected && "bg-primary",
          !isLoading && !connected && "bg-destructive",
        )}
      />
      {label}
    </div>
  )
}
