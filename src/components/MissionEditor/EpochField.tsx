import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { datetimeLocalToEpoch, epochToDatetimeLocal } from "@/lib/utils"

// The backend expects "YYYY-MM-DDTHH:MM:SS UTC" (parse_epoch, hifitime).
// A native datetime-local input gives "YYYY-MM-DDTHH:MM" (optionally with
// seconds) -- convert both ways via lib/utils' epochToDatetimeLocal/
// datetimeLocalToEpoch so no other component has to know the wire format
// (the Study paper's inline date editor shares the same two helpers).
// Replaces the old free-text inputs, which were the app's most error-prone
// field (any typo = an opaque parse error at run time).

export function EpochField({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: string | null | undefined
  onChange: (epoch: string | null) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="datetime-local"
        step={1}
        value={epochToDatetimeLocal(value)}
        onChange={(e) => onChange(datetimeLocalToEpoch(e.target.value))}
      />
      <span className="text-xs text-muted-foreground">UTC</span>
    </div>
  )
}
