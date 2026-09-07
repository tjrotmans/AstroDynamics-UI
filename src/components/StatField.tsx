// Label-over-value stat, shared by the result cards (three components used
// to each define an identical private `Field`). The value is deliberately
// the loudest element -- on a results card the numbers ARE the content --
// and tabular-nums keeps digit columns aligned across a grid of stats.
export function StatField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-heading text-base font-medium text-foreground tabular-nums">{value}</span>
    </div>
  )
}
