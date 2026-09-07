import { useState } from "react"

import { PhaseDock } from "@/components/Landing/PhaseDock"
import { VehiclePaper } from "@/components/Vehicle/VehiclePaper"
import { VehicleViewport } from "@/components/Vehicle/VehicleViewport"
import { useVehicleProperties } from "@/hooks/useVehicleProperties"
import { ResultViewport } from "./ResultViewport"
import { StudyPaper } from "./StudyPaper"
import { useUiStore, type Tool } from "@/stores/uiStore"

// Phase B's "01" destination: full-bleed, own chrome (no header/sidebar) --
// the paper on the left (58vw, per the mockup), the result viewport on the
// right, and the reused PhaseDock repositioned to sit above the viewport's
// empty state (mockup: body.paper-open .dock { left: 79vw }). Owns the two
// pieces of local state the mockup's own `theater`/`camMode` globals map to.
export function StudyView() {
  const [theater, setTheater] = useState(false)
  const [camMode, setCamMode] = useState<"follow" | "overview">("follow")
  const [shownPhase, setShownPhase] = useState<number | null>(null)
  // Below the 1260px two-column breakpoint (direct user
  // feedback: "I understand [the width requirement], but can you make it so
  // I can switch between the paper view and the viewport" instead of just
  // refusing to render at all). Both panels work fine full-width on their
  // own -- neither StudyPaper nor ResultViewport has any width assumption
  // baked in beyond the 720px min-width that lived on the WIDE layout's own
  // wrapper div below, so this is a real toggle between two already-
  // standalone-capable panels, not a new responsive redesign of either.
  const [narrowPanel, setNarrowPanel] = useState<"paper" | "viewport">("paper")

  const enterWorkspace = useUiStore((s) => s.enterWorkspace)
  const studyPhase = useUiStore((s) => s.studyPhase)
  // Which placed vehicle component (index into spacecraft.hardware) is
  // selected -- shared between VehiclePaper's Table 3 rows and
  // VehicleViewport's 3D selection so clicking either highlights the
  // other, same click<->row lockstep Table 1/Table 3 already use.
  const [selectedHardwareIndex, setSelectedHardwareIndex] = useState<number | null>(null)
  // Shared between VehiclePaper's Table 2 and VehicleViewport's 3D CoM
  // marker -- one debounced /api/design/vehicle loop, not two independent
  // ones (see useVehicleProperties.ts). Cheap enough to always run, not
  // just on phase "02" -- it's a no-op debounce timer otherwise.
  const { vehicle, isPending: vehiclePending, isError: vehicleError } = useVehicleProperties()

  function handleTogglePhase(n: number) {
    setShownPhase((cur) => (cur === n ? null : n))
  }

  function handleEnterPhase(tool: Tool) {
    setShownPhase(null)
    enterWorkspace(tool)
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#04060c]">
      {/* Real bug, found (UX audit): the paper column below has a
          hard 720px floor (min-w-[720px]) but the layout is two absolutely-
          positioned columns with no reflow at all -- below ~1240px window
          width (58vw < 720px), the paper column visually overruns the result
          viewport's own "left-[58vw]" position, producing genuinely
          overlapping, illegible text (confirmed on a 834px-wide window).
          Rather than a real responsive redesign of the two-column layout
          itself, below 1260px this renders ONE full-width panel at a time
 instead -- toggled via the pill below, never both at
          once, so nothing overlaps. */}
      <div className="absolute inset-0 flex flex-col min-[1260px]:hidden">
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-white/10 bg-[#0a0d16] py-2.5">
          {(["paper", "viewport"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setNarrowPanel(p)}
              className={
                "rounded-full border px-4 py-1.5 text-[10px] font-bold tracking-[0.14em] uppercase " +
                (narrowPanel === p
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-white/15 text-white/50 hover:text-white/80")
              }
            >
              {p === "paper" ? "Paper" : "Viewport"}
            </button>
          ))}
        </div>
        <div className="relative min-h-0 flex-1">
          <div className={narrowPanel === "paper" ? "absolute inset-0" : "hidden"}>
            {studyPhase === "01" ? (
              <StudyPaper onFullscreen={() => setNarrowPanel("viewport")} />
            ) : (
              <VehiclePaper
                onFullscreen={() => setNarrowPanel("viewport")}
                selectedIndex={selectedHardwareIndex}
                onSelect={setSelectedHardwareIndex}
                vehicle={vehicle}
                vehiclePending={vehiclePending}
                vehicleError={vehicleError}
              />
            )}
          </div>
          <div className={narrowPanel === "viewport" ? "absolute inset-0 p-3" : "hidden"}>
            {studyPhase === "01" ? (
              <ResultViewport camMode={camMode} onSetCamMode={setCamMode} />
            ) : (
              <VehicleViewport selectedIndex={selectedHardwareIndex} onSelect={setSelectedHardwareIndex} comM={vehicle?.com_m ?? null} />
            )}
          </div>
        </div>
        <div className="pointer-events-none absolute bottom-5 inset-x-0 flex justify-center">
          <div className="pointer-events-auto">
            <PhaseDock shownPhase={shownPhase} onTogglePhase={handleTogglePhase} onEnter={handleEnterPhase} />
          </div>
        </div>
      </div>
      <div className="hidden min-[1260px]:contents">
        <div
          className={
            "absolute inset-y-0 left-0 w-[58vw] min-w-[720px] shadow-[30px_0_70px_rgba(0,0,0,0.55)] transition-transform duration-500 " +
            (theater ? "-translate-x-full" : "translate-x-0")
          }
        >
          {studyPhase === "01" ? (
            <StudyPaper onFullscreen={() => setTheater(true)} />
          ) : (
            <VehiclePaper
              onFullscreen={() => setTheater(true)}
              selectedIndex={selectedHardwareIndex}
              onSelect={setSelectedHardwareIndex}
              vehicle={vehicle}
              vehiclePending={vehiclePending}
              vehicleError={vehicleError}
            />
          )}
        </div>

        <div
          className={
            "absolute inset-y-0 transition-all duration-500 " +
            (theater ? "inset-x-0" : "left-[58vw] right-0 px-4.5 pt-4.5 pb-24")
          }
        >
          {studyPhase === "01" ? (
            <ResultViewport camMode={camMode} onSetCamMode={setCamMode} onFullscreen={() => setTheater(true)} />
          ) : (
            <VehicleViewport selectedIndex={selectedHardwareIndex} onSelect={setSelectedHardwareIndex} comM={vehicle?.com_m ?? null} />
          )}
        </div>

        {theater && (
          <div className="absolute top-4.5 left-1/2 flex -translate-x-1/2 items-center gap-3.5 rounded-full border border-border bg-card/70 py-2 pr-2.5 pl-4.5 backdrop-blur-md">
            <span className="text-[10.5px] font-bold tracking-[0.18em] text-primary uppercase">Theater</span>
            <button
              type="button"
              onClick={() => setTheater(false)}
              className="rounded-full bg-primary px-3.5 py-1.5 text-[10px] font-bold tracking-[0.1em] text-primary-foreground uppercase"
            >
              Back to the study
            </button>
          </div>
        )}

        {!theater && (
          <div className="pointer-events-none absolute bottom-5 left-[58vw] right-0 flex justify-center">
            <div className="pointer-events-auto">
              <PhaseDock shownPhase={shownPhase} onTogglePhase={handleTogglePhase} onEnter={handleEnterPhase} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
