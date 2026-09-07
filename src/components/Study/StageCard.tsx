import type { ReactNode } from "react"

// Bordered card per pipeline stage (Survey / MGA scan / Optimizer),
// direct user feedback: without a visible boundary the three
// stages read as one continuous flow of paragraphs, not clearly separate
// steps. Deliberately subtler than the page's big orange "01 Trajectory
// design" band -- that's the phase-level header; this is one level down,
// scoping a stage within it.
export function StageCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-6 border border-[#dedbd2]">
      <div className="border-b border-[#dedbd2] bg-[#f5f3ee] px-3 py-1.5 text-[10px] font-bold tracking-[0.14em] text-[#171512] uppercase">
        {label}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

// A labeled sub-window inside a StageCard -- direct user
// feedback: Direct transfer and MGA both belong under one "Survey"
// stage, as two sub-windows, not two separate stage cards. Lighter weight
// than StageCard's own header (no border/background), just enough to read
// as a distinct block within the card.
export function StageSubSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[9.5px] font-bold tracking-[0.14em] text-[#8b877d] uppercase">{label}</div>
      {children}
    </div>
  )
}
