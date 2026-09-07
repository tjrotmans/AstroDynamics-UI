import { useState } from "react"

import { useUiStore } from "@/stores/uiStore"
import { useDesignStore } from "@/stores/designStore"
import { useMissionStore } from "@/stores/missionStore"
import { assessPropellantFeasibility } from "@/lib/propellantFeasibility"

// The "02 GNC" band, revealed once a trajectory has been adopted. Updated
// (the separate "Continue to GNC sizing" button next to
// "Adopt trajectory → 02" was confusing -- adopting now navigates to 02
// itself), so this band is a status record in the paper, not the entry
// point; the whole 02 band is clickable as a plain navigation shortcut for
// anyone scrolling back through 01 later. Renders the mockup's gray "03
// locked" note, static -- Stage 3 has no dedicated tool yet.
//
// propellant feasibility gate (backend Phase 03 validation:
// the Mercury Orbiter's capture needs 18,130 m/s; the configured vehicle's
// tank gives 481 m/s -- what looked like a control failure downstream was
// an infeasible design). The hand-off to 02 stays possible but only behind
// an explicit acknowledgement, with the numbers and the honest way out
// (MGA / low thrust) stated here, at the source.
export function GncHandoffBand() {
  const setStudyPhase = useUiStore((s) => s.setStudyPhase)
  const trajectory = useDesignStore((s) => s.selectedTrajectory)
  const spacecraft = useMissionStore((s) => s.config.spacecraft)
  const [acknowledged, setAcknowledged] = useState(false)

  const feasibility =
    trajectory &&
    assessPropellantFeasibility({
      trajectory,
      wetMassKg: spacecraft.mass_kg,
      propellantMassKg: spacecraft.propellant_mass_kg,
      ispS: spacecraft.propulsion?.isp_s,
    })
  const blocked = !!feasibility && !feasibility.feasible && !acknowledged

  return (
    <div className="mt-6">
      {feasibility && !feasibility.feasible && (
        <div className="mb-3 border-l-4 border-[#c23b2a] bg-[#fbeeec] px-3.5 py-2.5 text-[12px] text-[#5a1d16]">
          <p className="font-bold">
            Propellant infeasible: this trajectory needs {feasibility.requiredMps.toFixed(0)} m/s onboard; the vehicle's tank
            gives {feasibility.availableMps.toFixed(0)} m/s ({feasibility.ratio.toFixed(1)}× short).
          </p>
          <p className="mt-1">
            {feasibility.departureByLauncher
              ? "The launcher covers departure; "
              : feasibility.departurePool === "split"
                ? `The launcher covers part of departure, the onboard top-up ${feasibility.onboardDepartureMps.toFixed(0)} m/s, `
                : `Departure ${feasibility.onboardDepartureMps.toFixed(0)} m/s, `}
            {feasibility.dsmMps > 0 ? `DSMs ${feasibility.dsmMps.toFixed(0)} m/s, ` : ""}
            arrival/capture {feasibility.arrivalMps.toFixed(0)} m/s must come from the tank (Isp·g₀·ln(m_wet/m_dry) ={" "}
            {feasibility.availableMps.toFixed(0)} m/s). For a chemical spacecraft this mission needs an <b>MGA</b> (flyby-chain)
            design or <b>low thrust</b> — select that method above and re-optimize.
          </p>
          {!acknowledged && (
            <button
              type="button"
              onClick={() => setAcknowledged(true)}
              className="mt-2 border border-[#c23b2a] px-2.5 py-1 text-[11px] font-bold tracking-[0.08em] text-[#c23b2a] uppercase hover:bg-[#c23b2a] hover:text-white"
            >
              Proceed anyway (design will run out of propellant in 03)
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => !blocked && setStudyPhase("02")}
        disabled={blocked}
        className={`flex w-full items-baseline gap-3.5 px-3.5 py-2 text-left text-white ${
          blocked ? "cursor-not-allowed bg-[#b4b0a5]" : "bg-[#2e9e53] hover:bg-[#278847]"
        }`}
        title={blocked ? "Acknowledge the propellant infeasibility above to continue" : "Open 02 Vehicle & GNC design"}
      >
        <span className="text-[21px] font-extrabold">02</span>
        <span className="text-[13px] font-bold tracking-[0.14em] uppercase">GNC systems design</span>
        <span className="ml-auto text-[11px] font-bold tracking-[0.1em] uppercase">{blocked ? "gated" : "open →"}</span>
      </button>
      <p className="mt-3 max-w-[62ch] text-[12px] text-[#55524b]">
        Trajectory adopted. Size the spacecraft around it: reaction wheels, thrusters and propellant, sensors, and
        estimation budgets, checked against the mission's real manoeuvre and pointing loads.
      </p>

      <div className="mt-6.5 flex items-baseline gap-3.5 bg-[#b4b0a5] px-3.5 py-2 text-white">
        <span className="text-[21px] font-extrabold">03</span>
        <span className="text-[13px] font-bold tracking-[0.14em] uppercase">High-accuracy simulation</span>
      </div>
      <p className="mt-3 font-serif text-[12px] text-[#8b877d] italic">
        Unlocks when the GNC design is frozen, full 6-DOF Monte-Carlo with the chosen hardware in the loop.
      </p>
    </div>
  )
}
