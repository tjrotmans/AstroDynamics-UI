import { useState } from "react"
import { AlertCircle, Loader2 } from "lucide-react"

import { PaperField, PaperFieldGrid, PaperInput } from "./paperForm"
import { epochStringToJd, jdToEpochString } from "@/lib/utils"
import { useMissionStore } from "@/stores/missionStore"

type WindowInputMode = "tof" | "arrival"

// "YYYY-MM-DD" <-> Julian date, for the arrival-date window inputs below.
// Day granularity only (a native <input type="date">), consistent with the
// survey being a coarse narrowing pass, not the precise epoch fields
// elsewhere in the app.
function jdToDateInputValue(jd: number): string {
  return jdToEpochString(jd).slice(0, 10)
}
function dateInputValueToJd(value: string): number {
  return epochStringToJd(`${value}T00:00:00 UTC`)
}

// Always visible right after Mission Definition (Phase B revision,
// "add the survey input right below the Mission Definition" +
// an explanation of what it does) -- not a collapsed disclosure. No solver
// picker: confirmed: that GA/PSO/Monte Carlo don't belong
// here (all still the closed-form Lambert-proxy, no real dynamics, so they
// add complexity without much real narrowing value over the porkchop) --
// the survey always runs GridSearch.
export function SurveySection({
  onRun,
  running,
  error,
}: {
  onRun: () => void
  running: boolean
  error?: string
}) {
  const cruise = useMissionStore((s) => s.config.trajectory.cruise)
  const setTrajectoryCruise = useMissionStore((s) => s.setTrajectoryCruise)
  const departureEpoch = useMissionStore((s) => s.config.trajectory.departure_epoch)
  const [windowMode, setWindowMode] = useState<WindowInputMode>("tof")

  // Same backend field either way (trajectory.cruise.tof_days_min/max) --
  // arrival date is just an alternate way to specify the same TOF window,
  // converted through the mission's departure epoch (
  // "we want to be able to also use arrival date as input").
  const depJd = departureEpoch ? epochStringToJd(departureEpoch) : null
  const arrivalDateMin = depJd != null && cruise?.tof_days_min != null ? jdToDateInputValue(depJd + cruise.tof_days_min) : ""
  const arrivalDateMax = depJd != null && cruise?.tof_days_max != null ? jdToDateInputValue(depJd + cruise.tof_days_max) : ""
  const setArrivalDateMin = (value: string) => {
    if (depJd == null) return
    setTrajectoryCruise({ tof_days_min: value === "" ? null : dateInputValueToJd(value) - depJd })
  }
  const setArrivalDateMax = (value: string) => {
    if (depJd == null) return
    setTrajectoryCruise({ tof_days_max: value === "" ? null : dateInputValueToJd(value) - depJd })
  }

  return (
    <div>
      <p className="max-w-[62ch] text-[12px] text-[#55524b]">
        A closed-form Lambert grid-search porkchop scan over the departure-date × time-of-flight window below -
        fast, exhaustive coverage of the search box, but no propagated dynamics (gravity assists, perturbations,
        real burns). Useful for spotting a promising transfer window before committing to the expensive
        real-dynamics optimizer below.
      </p>

      <div className="flex items-center gap-2">
        {(["tof", "arrival"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setWindowMode(m)}
            disabled={m === "arrival" && depJd == null}
            className={
              "border px-2.5 py-1 text-[10px] font-bold tracking-[0.06em] uppercase disabled:opacity-30 " +
              (windowMode === m ? "border-[#f24d00] bg-[#f24d00] text-white" : "border-[#dedbd2] text-[#171512] hover:border-[#f24d00]")
            }
          >
            {m === "tof" ? "Window by TOF" : "Window by arrival date"}
          </button>
        ))}
        {depJd == null && <span className="text-[10.5px] text-[#8b877d]">Set a departure epoch to window by arrival date.</span>}
      </div>

      {windowMode === "tof" ? (
        <PaperFieldGrid>
          <PaperField label="TOF min (days)" htmlFor="cruise-tof-min">
            <PaperInput
              id="cruise-tof-min"
              value={cruise?.tof_days_min ?? ""}
              placeholder="100"
              onChange={(v) => setTrajectoryCruise({ tof_days_min: v === "" ? null : Number(v) })}
            />
          </PaperField>
          <PaperField label="TOF max (days)" htmlFor="cruise-tof-max">
            <PaperInput
              id="cruise-tof-max"
              value={cruise?.tof_days_max ?? ""}
              placeholder="400"
              onChange={(v) => setTrajectoryCruise({ tof_days_max: v === "" ? null : Number(v) })}
            />
          </PaperField>
        </PaperFieldGrid>
      ) : (
        <PaperFieldGrid>
          <PaperField label="Arrival date, earliest" htmlFor="cruise-arrival-min">
            <input
              id="cruise-arrival-min"
              type="date"
              value={arrivalDateMin}
              onChange={(e) => setArrivalDateMin(e.target.value)}
              className="w-full rounded-[3px] border border-[#dedbd2] bg-white px-2 py-1.5 text-[12.5px] text-[#171512] outline-none focus:border-[#f24d00]"
            />
          </PaperField>
          <PaperField label="Arrival date, latest" htmlFor="cruise-arrival-max">
            <input
              id="cruise-arrival-max"
              type="date"
              value={arrivalDateMax}
              onChange={(e) => setArrivalDateMax(e.target.value)}
              className="w-full rounded-[3px] border border-[#dedbd2] bg-white px-2 py-1.5 text-[12.5px] text-[#171512] outline-none focus:border-[#f24d00]"
            />
          </PaperField>
        </PaperFieldGrid>
      )}
      <PaperFieldGrid>
        <PaperField
          label="Departure window (days)"
          htmlFor="cruise-departure-window"
          note="Also used by the optimizer below -- asked once, not twice."
        >
          <PaperInput
            id="cruise-departure-window"
            value={cruise?.departure_window_days ?? ""}
            placeholder="60"
            onChange={(v) => setTrajectoryCruise({ departure_window_days: v === "" ? null : Number(v) })}
          />
        </PaperField>
        <PaperField
          label="Grid resolution (points/axis)"
          htmlFor="cruise-grid-resolution"
          note="Cost scales with the square of this -- 30 (default) is coarse, ~1 point/day needs the window's day-span here."
        >
          <PaperInput
            id="cruise-grid-resolution"
            min={2}
            value={cruise?.grid_resolution ?? ""}
            placeholder="30"
            onChange={(v) => setTrajectoryCruise({ grid_resolution: v === "" ? null : Number(v) })}
          />
        </PaperField>
      </PaperFieldGrid>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="flex items-center gap-1.5 border-[1.5px] border-[#171512] bg-[#171512] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#fbfaf6] uppercase hover:border-[#f24d00] hover:bg-[#f24d00] disabled:opacity-40"
        >
          {running && <Loader2 className="size-3.5 animate-spin" />}
          Run survey
        </button>
        {error && (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-[#f24d00]">
            <AlertCircle className="size-3.5" /> {error}
          </span>
        )}
      </div>
    </div>
  )
}
