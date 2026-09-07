import { Info } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// Small inline affordance for explaining what a field/option actually does --
// added because native `title` attributes don't scale (no styling, delayed,
// easy to miss) once a page has several non-obvious selectors (propulsion
// type, gravity model, solver choice, ...). Pair with a Label: <Label>Foo
// <InfoTooltip>...</InfoTooltip></Label>.
export function InfoTooltip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="inline size-3.5 shrink-0 cursor-help text-muted-foreground align-text-top" />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}
