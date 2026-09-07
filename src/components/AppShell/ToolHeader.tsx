import type { ReactNode } from "react"

// Every tool workspace opens with the same header shape: a real page title
// (the workspaces had none -- the tool name only existed in the nav) and one
// short paragraph on how to use the tool, per. Keep
// the copy to plain "what do I do here" guidance; deep rationale belongs in
// InfoTooltips next to the specific field it explains.
export function ToolHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-1 border-b border-border pb-4">
      <h2 className="font-heading text-lg font-semibold text-foreground">{title}</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
