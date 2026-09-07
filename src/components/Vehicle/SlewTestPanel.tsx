import { useRef, useState } from "react"

import type { SlewTestInitialStateRequest, SlewTestResult } from "@/api/client"
import { useMissionStore } from "@/stores/missionStore"
import { useDesignSlewTest } from "@/hooks/useApi"
import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"
import { AttitudeReplayCanvas } from "@/components/Vehicle/AttitudeReplayCanvas"
import type { Vec3 } from "@/lib/vehicleGeometry"

function randomUnitAxis(): number[] {
  const v = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return v.map((x) => x / n)
}

const AXIS_LAYOUT = {
  ...DARK_LAYOUT,
  margin: { t: 20, r: 20, b: 44, l: 56 },
  showlegend: false,
} as const

// A fast, real closed-loop attitude-step test against the CURRENT config's
// actual placed hardware -- POST /api/design/slew-test (spacecraft-builder
// the backend design, backend-side wired into a real per-thruster
// allocation over placed RcsThruster geometry backend-side --
// see the design notes
// verification trail before assuming this). This is the "static torque-
// authority check" a level up: that check (VehiclePaper's own panel, just
// above this one in Table 3b) only asks "can this layout reach every
// torque direction at all" from pure geometry; this one actually RUNS the
// real quaternion-PD control law + allocation for a canned 90deg step and
// reports whether it genuinely settles.
//
// The animated 3D tumble/hold replay (AttitudeReplayCanvas) is real,
// unblocked once the backend added q/omega_radps to
// SlewTestSample -- every frame's orientation is a slerp between two
// consecutive REAL samples from the backend's own SixDofState, not an
// approximation invented client-side.
// controlMode is lifted to VehiclePaper so SlewTestMonteCarlo,
// mounted right below this panel, shares the exact same actuator-mode
// selection instead of duplicating the toggle -- Monte Carlo validation is
// "run many of the SAME test," not a separately-configured workflow.
export function SlewTestPanel({
  controlMode,
  setControlMode,
}: {
  controlMode: "WheelsPrimary" | "ThrustersPrimary" | "ThrustersOnly"
  setControlMode: (mode: "WheelsPrimary" | "ThrustersPrimary" | "ThrustersOnly") => void
}) {
  const config = useMissionStore((s) => s.config)
  const mutation = useDesignSlewTest()

  // Continuous re-pointing loop (a refinement round -- direct user
  // ask: "the pointing vector keeps on changing... after 10 seconds it
  // changes again, is that doable?"). Chains real slew-test calls, each
  // seeded via `initial_state` from the PREVIOUS call's actual ending
  // q/omega_radps -- the body's own motion stays continuous across the
  // seam (it starts each new segment exactly where it really left off);
  // only the TARGET jumps to a fresh random offset, which is exactly "a
  // new pointing command arrived" and not a fabricated animation. Timed to
  // fire the next call when THIS segment's 12s compressed playback visibly
  // finishes (AttitudeReplayCanvas's onPlaybackComplete), not on the
  // (near-instant) network response -- firing on response alone would
  // cycle through results faster than a human can watch.
  const [continuous, setContinuous] = useState(false)
  const continuousRef = useRef(false)
  const pendingSeedRef = useRef<SlewTestInitialStateRequest | null>(null)
  const [chainLeg, setChainLeg] = useState(1)

  function setContinuousBoth(next: boolean) {
    continuousRef.current = next
    setContinuous(next)
  }

  // Initial spin, per axis (a refinement round, backend-side -
  // direct user ask: "add some initial spin to the s/c too... on each
  // axis"). A real diagnostic tool, not decoration: a step test from REST
  // can settle "successfully" on a rank-deficient layout purely because
  // the missing axis's initial error happened to start near zero -- an
  // initial RATE along a genuinely uncontrollable axis persists (or
  // free-drifts) instead, which is what actually exposes the gap. Per-axis
  // (not axis+magnitude like initial_error_deg/axis) so a suspected single
  // axis can be probed in isolation, matching the intended framing.
  // Only applies to a fresh (non-chained) run -- initial_state's own real
  // omega_radps always wins outright once a chain is running (the
  // backend's own documented priority, not summed).
  const [initialSpinDegS, setInitialSpinDegS] = useState<[number, number, number]>([0, 0, 0])

  const busDimsMRaw = config.spacecraft.bus_dims_m
  const busDimsM = (busDimsMRaw.length === 3 ? busDimsMRaw : [1, 1, 1]) as Vec3
  // Order here IS the order rcs_from_hardware() builds its actuator list in
  // (both iterate config.spacecraft.hardware in the same order, filtering
  // to RcsThruster) -- that identity is what lets index i here line up with
  // SlewTestSample.thruster_duty_cycles[i] for the fire-highlight below.
  const thrusterVisuals = config.spacecraft.hardware.flatMap((item) => {
    if (item.type !== "RcsThruster" || item.position_m == null || item.direction == null) return []
    return [{ positionM: item.position_m as Vec3, direction: item.direction as Vec3 }]
  })

  function runTest(seed?: SlewTestInitialStateRequest) {
    mutation.mutate(
      {
        // Real bug, found and fixed (:
        // "I just increased the mass x10kg and I don't see different
        // behavior, which makes me suspicious"). Root cause: missionStore's
        // spacecraft.inertia_diag_kgm2 is a hardcoded [100,100,100] default
        // -- there is no setter for it anywhere in this app, so it NEVER
        // reflects a mass/hardware edit. Table 2's own "Inertia diag
        // (derived)" row is a DIFFERENT, real, live-recomputed value from
        // /api/design/vehicle -- shown for information, but never written
        // back into config.spacecraft.inertia_diag_kgm2, which is what the
        // sim actually integrates against. Setting
        // derive_inertia_from_geometry here (backend-side
        //) makes the live sim use that SAME real derived
        // diagonal instead of the disconnected placeholder -- the fix is
        // one flag, not a new field to keep in sync by hand.
        config: { ...config, spacecraft: { ...config.spacecraft, derive_inertia_from_geometry: true } },
        control_mode: controlMode,
        ...(seed
          ? { initial_state: seed, initial_error_deg: 30 + Math.random() * 90, axis: randomUnitAxis() }
          : { initial_omega_radps: initialSpinDegS.map((d) => (d * Math.PI) / 180) }),
      },
      {
        onSuccess: (data: SlewTestResult) => {
          const last = data.samples[data.samples.length - 1]
          pendingSeedRef.current = last ? { q: last.q, omega_radps: last.omega_radps } : null
        },
      },
    )
  }

  function handleManualRun() {
    setChainLeg(1)
    runTest()
  }

  function handlePlaybackComplete() {
    if (!continuousRef.current || !pendingSeedRef.current) return
    setChainLeg((n) => n + 1)
    runTest(pendingSeedRef.current)
  }

  const result = mutation.data

  return (
    <div className="mt-6">
      <table className="w-full border-collapse text-[12px]">
        <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
          Slew test — real closed-loop 90° attitude step
        </caption>
      </table>
      <p className="mt-1 max-w-[62ch] text-[11px] text-[#8b877d]">
        Runs the actual quaternion-PD control law and actuator allocation against this vehicle's real placed
        hardware (thrusters, wheels, derived mass properties) for a fixed 90° pointing offset — a fast pre-check
        before committing to a full mission simulation. Fixed reference scenario (700 km circular Earth orbit), not
        this mission's real trajectory.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <span className="text-[10px] font-bold tracking-[0.1em] text-[#8b877d] uppercase">Actuators</span>
        <div className="flex overflow-hidden rounded border border-[#dedbd2]">
          {(["ThrustersOnly", "ThrustersPrimary", "WheelsPrimary"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setControlMode(mode)}
              className={
                "px-2.5 py-1 text-[10.5px] font-semibold " +
                (controlMode === mode ? "bg-[#171512] text-[#fbfaf6]" : "bg-white text-[#55524b] hover:bg-[#f5f3ee]")
              }
            >
              {mode === "ThrustersOnly" ? "RCS only" : mode === "ThrustersPrimary" ? "RCS + wheels dump" : "Reaction wheels"}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[10.5px] text-[#8b877d]">
        {controlMode === "ThrustersOnly"
          ? "Wheels contribute zero torque, full stop — the genuine \"can these thrusters alone hold pointing\" isolation test."
          : controlMode === "ThrustersPrimary"
            ? "RCS delivers the commanded torque, but wheels are still actively driven toward zero speed every tick (a real reaction torque) — not a true isolation test."
            : "Wheels deliver the full commanded torque; RCS only fires if a wheel saturates — a thruster-layout change may have little or no visible effect in this mode."}
      </p>

      <div className="mt-3 flex items-center gap-3">
        <span className="text-[10px] font-bold tracking-[0.1em] text-[#8b877d] uppercase">Initial spin [°/s]</span>
        {(["X", "Y", "Z"] as const).map((label, i) => (
          <label key={label} className="flex items-center gap-1 text-[10.5px] font-semibold text-[#55524b]">
            {label}
            <input
              type="number"
              step={0.5}
              value={initialSpinDegS[i]}
              onChange={(e) => {
                const v = parseFloat(e.target.value) || 0
                setInitialSpinDegS((cur) => {
                  const next = [...cur] as [number, number, number]
                  next[i] = v
                  return next
                })
              }}
              className="w-14 rounded border border-[#dedbd2] bg-white px-1.5 py-0.5 text-[10.5px] text-[#171512]"
            />
          </label>
        ))}
      </div>
      <p className="mt-1 text-[10.5px] text-[#8b877d]">
        A body-frame rate on a fresh run (ignored once continuous re-pointing is chaining, which carries the real
        previous rate instead). A step test from rest can settle "successfully" on a rank-deficient axis purely
        because it never got excited — a real initial rate on a suspected axis is what actually tests it.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={handleManualRun}
          disabled={mutation.isPending}
          className="flex items-center gap-1.5 border-[1.5px] border-[#171512] bg-[#171512] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#fbfaf6] uppercase hover:border-[#f24d00] hover:bg-[#f24d00] disabled:opacity-40"
        >
          {mutation.isPending ? "Running…" : "Run slew test"}
        </button>
        <label className="flex items-center gap-1.5 text-[10.5px] font-semibold text-[#55524b]">
          <input type="checkbox" checked={continuous} onChange={(e) => setContinuousBoth(e.target.checked)} />
          Continuous re-pointing
        </label>
        {continuous && result && (
          <span className="font-mono text-[10.5px] text-[#8b877d]">leg {chainLeg}</span>
        )}
      </div>
      <p className="mt-1 text-[10.5px] text-[#8b877d]">
        When on, a new random target is commanded every time the replay below finishes a segment — the vehicle's
        real ending attitude/rate carries over (no jump-cut), only the target changes, simulating a new pointing
        command arriving.
      </p>

      {mutation.isError && (
        <p className="mt-2 text-[11px] text-[#c23b2a]">
          Request failed — check the backend connection or the mission config's validity.
        </p>
      )}

      {result && (
        <div className="mt-3">
          <div
            className={
              "rounded border px-3 py-2 text-[11px] " +
              (result.settling_time_s != null
                ? "border-[#2e9e53]/40 bg-[#2e9e53]/10 text-[#1f6b39]"
                : "border-[#c23b2a]/40 bg-[#c23b2a]/10 text-[#8a2a1e]")
            }
          >
            <div className="font-bold">
              {result.settling_time_s != null
                ? `Settled to ${result.settle_threshold_deg}° within ${result.settling_time_s.toFixed(0)} s`
                : `Did not settle to ${result.settle_threshold_deg}° within ${result.duration_s.toFixed(0)} s`}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[10.5px] opacity-80 sm:grid-cols-3">
              <span>final error {result.final_error_deg.toFixed(2)}°</span>
              <span>overshoot {result.overshoot_deg != null ? `${result.overshoot_deg.toFixed(2)}°` : "—"}</span>
              <span>mode {result.control_mode}</span>
              <span>peak wheel momentum {result.max_wheel_momentum_nms.toFixed(3)} N·m·s</span>
              <span>RCS propellant used {result.rcs_propellant_kg_used.toFixed(4)} kg</span>
              <span>{result.wall_clock_ms.toFixed(0)} ms server time</span>
            </div>
          </div>

          <div className="mt-3 border border-[#171512] bg-white p-3 pb-2">
            <Plot
              data={[
                {
                  type: "scatter",
                  mode: "lines",
                  x: result.samples.map((s) => s.t_s),
                  y: result.samples.map((s) => s.error_deg),
                  line: { color: CHART_COLORS[1] },
                  name: "Pointing error",
                },
              ]}
              layout={{
                ...AXIS_LAYOUT,
                xaxis: { title: { text: "Time [s]" } },
                yaxis: { title: { text: "Pointing error [deg]" }, automargin: true },
                shapes: [
                  {
                    type: "line",
                    x0: 0,
                    x1: result.duration_s,
                    y0: result.settle_threshold_deg,
                    y1: result.settle_threshold_deg,
                    line: { color: "#8b877d", dash: "dot", width: 1 },
                  },
                ],
              }}
              style={{ width: "100%", height: "200px" }}
              useResizeHandler
              config={{ displayModeBar: false }}
            />
          </div>
          <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
            Dotted line is the settle threshold ({result.settle_threshold_deg}°).
          </p>

          {result.samples.length > 0 && result.samples[0].q != null && (
            <>
              <AttitudeReplayCanvas
                key={mutation.submittedAt}
                busDimsM={busDimsM}
                thrusters={thrusterVisuals}
                samples={result.samples}
                qCommand={result.q_command}
                onPlaybackComplete={handlePlaybackComplete}
              />
              <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
                Real attitude replay — every frame is interpolated between actual samples from the backend's own
                6DOF state, not an approximation. Compressed to a fixed 12&nbsp;s playback regardless of the test's
                real {result.duration_s.toFixed(0)}&nbsp;s duration. Green is the target, cyan is the vehicle's
                actual pointing — each drawn as TWO rays (long = body +X, short = body +Y) so roll about the main
                axis is visible too; a single arrow can look "converged" while <code>error_deg</code> stays high if
                only roll is off. The gold line between the two main tips shrinks as that number converges. Each
                thruster's line glows brighter while it's actually firing that frame (real per-actuator data, not a
                guess at which one "should" fire).
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
