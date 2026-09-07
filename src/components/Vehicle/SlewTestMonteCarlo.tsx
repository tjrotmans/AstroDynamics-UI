import { useRef, useState } from "react"

import { designSlewTest, type MissionConfig, type SlewTestSample } from "@/api/client"
import { CHART_COLORS, DARK_LAYOUT, Plot } from "@/lib/plot"

const AXIS_LAYOUT = {
  ...DARK_LAYOUT,
  margin: { t: 20, r: 20, b: 44, l: 56 },
  showlegend: false,
} as const

// Batch throughput/payload were measured live before picking these numbers
// (.scratch/benchmark_mc_throughput.cjs, not guessed): real
// sustained throughput against this backend plateaus around 110-165
// req/s regardless of pushing concurrency past ~64 (the ceiling is the
// backend/network, not the browser), and a full-fidelity run (default
// duration_s=1800/tick_s=5, matching the single-run panel exactly -- no
// physics shortcuts) is ~160 KB of response each. 200 runs at concurrency
// 64 measured 1.77s / 32 MB. The user's original ask (10,000 runs, "a few
// seconds") would be ~90s and ~1.6 GB client-side at this fidelity --
// genuinely not feasible without a real server-side batch endpoint
// (aggregate-only response, real thread-level parallelism) -- planned
// backend-side. This ships a real, useful version now, capped well below
// that: MAX_BATCH keeps a full run within roughly half a minute and a
// sane memory footprint; DEFAULT_BATCH lands around ~9s.
const CONCURRENCY = 64
const DEFAULT_BATCH = 1000
const MAX_BATCH = 5000

interface RunSummary {
  finalErrorDeg: number
  settlingTimeS: number | null
  overshootDeg: number | null
  propellantKg: number
}

interface McStats {
  n: number
  converged: number
  settleTimes: number[]
  meanSettleTimeS: number | null
  meanOvershootDeg: number | null
  meanPropellantKg: number
  meanFinalErrorDeg: number
  wallClockMs: number
}

function randomInRange(bound: number): number {
  return (Math.random() * 2 - 1) * bound
}

// Real gap, found while wiring this in (not the backend's fault): the
// endpoint's own settling_time_s/overshoot_deg are POINTING-ONLY --
// `slew_test.rs` records settled the first tick error_deg drops at/under
// settle_threshold_deg, with no check on angular rate at all. A vehicle
// that's still genuinely tumbling could pass straight through the target
// angle and get counted as "settled" by that definition alone. Direct
// user ask: expose a real rate criterion too ("to what < omega"), not just
// the angle one. Computed CLIENT-SIDE from the samples array the response
// already returns (no new backend field needed) -- the combined criterion
// is "first sample where BOTH error_deg <= pointingThresholdDeg AND
// |omega_radps| <= omegaThresholdRadS," which supersedes the backend's own
// pointing-only settling_time_s for what this panel reports as "settled."
// Resolution is bounded by the response's own sample decimation (up to 300
// points over the run), not exact to the real tick -- fine for MC
// aggregate statistics, not represented as tick-exact.
function combinedSettle(
  samples: SlewTestSample[],
  pointingThresholdDeg: number,
  omegaThresholdRadS: number,
): { settleTimeS: number | null; overshootDeg: number | null } {
  let settleTimeS: number | null = null
  let peakErrorAfterSettle = 0
  for (const s of samples) {
    const omegaMag = Math.hypot(s.omega_radps[0], s.omega_radps[1], s.omega_radps[2])
    if (settleTimeS == null) {
      if (s.error_deg <= pointingThresholdDeg && omegaMag <= omegaThresholdRadS) {
        settleTimeS = s.t_s
      }
    } else {
      peakErrorAfterSettle = Math.max(peakErrorAfterSettle, s.error_deg)
    }
  }
  return {
    settleTimeS,
    overshootDeg: settleTimeS != null ? Math.max(0, peakErrorAfterSettle - pointingThresholdDeg) : null,
  }
}

// Independent per-axis sampling, ("+/- 90 on
// each axis", "+/- 5 rpm on each axis") -- NOT a random-unit-axis +
// magnitude pair (a different, more common MC convention, but not what was
// asked for here). A rotation VECTOR with independently-bounded components
// converted to the existing axis+initial_error_deg request shape needs no
// new backend field -- angleBoundDeg=90 on all 3 axes can compose to a
// total rotation up to ~156 deg (sqrt(3)*90) in the worst case, which is
// expected and correct for this sampling scheme, not a bug.
function sampleInitialCondition(spinBoundRpm: number, angleBoundDeg: number) {
  const spinBoundRadS = (spinBoundRpm * 2 * Math.PI) / 60
  const omega = [randomInRange(spinBoundRadS), randomInRange(spinBoundRadS), randomInRange(spinBoundRadS)]
  const rot = [randomInRange(angleBoundDeg), randomInRange(angleBoundDeg), randomInRange(angleBoundDeg)]
  const angleDeg = Math.hypot(rot[0], rot[1], rot[2])
  const axis = angleDeg > 1e-6 ? rot.map((v) => v / angleDeg) : [0, 0, 1]
  return { omega, axis, angleDeg }
}

// A fast statistical health-check of the CURRENT vehicle+gains combination
// -- not "does this one slew converge," but "what fraction of a real
// spread of plausible initial conditions converge, and how well." Direct
// user idea: "as soon as I make a change to the s/c and the
// inertia and mass change, we run a monte carlo for different initial
// rotations and pointing vectors... it feels like a super powerful
// immediate validation of a GNC and spacecraft design, even before
// checking mission constraints." This is a real, named technique in
// spacecraft GNC verification (Monte Carlo dispersion analysis over
// initial tip-off rate/attitude for detumble and acquisition convergence)
// -- not invented for this app, confirmed via a live search before
// building rather than assumed.
export function SlewTestMonteCarlo({ config, controlMode }: { config: MissionConfig; controlMode: "WheelsPrimary" | "ThrustersPrimary" | "ThrustersOnly" }) {
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH)
  const [spinBoundRpm, setSpinBoundRpm] = useState(5)
  const [angleBoundDeg, setAngleBoundDeg] = useState(90)
  // Acceptance criteria, direct user ask: "when does it need
  // to be settled, to what < pointing, to what < omega." settleByS maps
  // straight to the real duration_s request field (a run that never meets
  // both criteria within this window is "not converged," same semantics
  // duration_s already had); pointingThresholdDeg maps to the real
  // settle_threshold_deg field; omegaThresholdDegS is the new client-
  // computed rate criterion (see combinedSettle's own comment for why).
  const [settleByS, setSettleByS] = useState(1800)
  const [pointingThresholdDeg, setPointingThresholdDeg] = useState(0.5)
  const [omegaThresholdDegS, setOmegaThresholdDegS] = useState(0.1)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [stats, setStats] = useState<McStats | null>(null)
  const cancelledRef = useRef(false)

  async function runOne(): Promise<RunSummary> {
    const { omega, axis, angleDeg } = sampleInitialCondition(spinBoundRpm, angleBoundDeg)
    const result = await designSlewTest({
      config: { ...config, spacecraft: { ...config.spacecraft, derive_inertia_from_geometry: true } },
      control_mode: controlMode,
      initial_error_deg: angleDeg,
      axis,
      initial_omega_radps: omega,
      duration_s: settleByS,
      settle_threshold_deg: pointingThresholdDeg,
    })
    const omegaThresholdRadS = (omegaThresholdDegS * Math.PI) / 180
    const { settleTimeS, overshootDeg } = combinedSettle(result.samples, pointingThresholdDeg, omegaThresholdRadS)
    // Deliberately keep ONLY the scalar summary -- discarding `samples`
    // immediately (after extracting the combined settle time above) is
    // what keeps a 1000+-run batch's memory footprint sane (each
    // response's own samples array is ~100-300 points of q/omega/duty-
    // cycle data, useless once the run-level summary is extracted).
    return {
      finalErrorDeg: result.final_error_deg,
      settlingTimeS: settleTimeS,
      overshootDeg,
      propellantKg: result.rcs_propellant_kg_used,
    }
  }

  async function runBatch() {
    cancelledRef.current = false
    setStats(null)
    const n = Math.max(1, Math.min(MAX_BATCH, Math.round(batchSize)))
    setProgress({ done: 0, total: n })
    const summaries: RunSummary[] = []
    let nextIndex = 0
    let doneCount = 0
    const wallStart = performance.now()

    async function worker() {
      while (nextIndex < n && !cancelledRef.current) {
        nextIndex++
        try {
          const s = await runOne()
          summaries.push(s)
        } catch {
          // A single failed run (e.g. a transient network hiccup) doesn't
          // abort the whole batch -- it's just excluded from the stats.
        }
        doneCount++
        if (doneCount % 10 === 0 || doneCount === n) {
          setProgress({ done: doneCount, total: n })
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

    const wallClockMs = performance.now() - wallStart
    const converged = summaries.filter((s) => s.settlingTimeS != null)
    const settleTimes = converged.map((s) => s.settlingTimeS as number)
    const overshoots = converged.map((s) => s.overshootDeg as number)
    setStats({
      n: summaries.length,
      converged: converged.length,
      settleTimes,
      meanSettleTimeS: settleTimes.length > 0 ? settleTimes.reduce((a, b) => a + b, 0) / settleTimes.length : null,
      meanOvershootDeg: overshoots.length > 0 ? overshoots.reduce((a, b) => a + b, 0) / overshoots.length : null,
      meanPropellantKg: summaries.length > 0 ? summaries.reduce((a, s) => a + s.propellantKg, 0) / summaries.length : 0,
      meanFinalErrorDeg: summaries.length > 0 ? summaries.reduce((a, s) => a + s.finalErrorDeg, 0) / summaries.length : 0,
      wallClockMs,
    })
    setProgress(null)
  }

  function cancel() {
    cancelledRef.current = true
  }

  return (
    <div className="mt-6">
      <table className="w-full border-collapse text-[12px]">
        <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
          Monte Carlo — statistical validation across many initial conditions
        </caption>
      </table>
      <p className="mt-1 max-w-[62ch] text-[11px] text-[#8b877d]">
        Runs the same real closed-loop slew test many times over a spread of random initial pointing offsets and
        spin rates, then reports what fraction converge and how well — a fast statistical health-check of the
        current vehicle + gains combination in general, not just one slew. Uses the actuator mode selected above (
        <code>{controlMode}</code>).
      </p>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-[#55524b]">
          Batch size (max {MAX_BATCH})
          <input
            type="number"
            min={1}
            max={MAX_BATCH}
            step={100}
            value={batchSize}
            onChange={(e) => setBatchSize(parseInt(e.target.value, 10) || 1)}
            className="rounded border border-[#dedbd2] bg-white px-1.5 py-1 text-[11px] text-[#171512]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-[#55524b]">
          Spin bound [±rpm/axis]
          <input
            type="number"
            min={0}
            step={0.5}
            value={spinBoundRpm}
            onChange={(e) => setSpinBoundRpm(parseFloat(e.target.value) || 0)}
            className="rounded border border-[#dedbd2] bg-white px-1.5 py-1 text-[11px] text-[#171512]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-[#55524b]">
          Angle bound [±°/axis]
          <input
            type="number"
            min={0}
            max={180}
            step={5}
            value={angleBoundDeg}
            onChange={(e) => setAngleBoundDeg(parseFloat(e.target.value) || 0)}
            className="rounded border border-[#dedbd2] bg-white px-1.5 py-1 text-[11px] text-[#171512]"
          />
        </label>
      </div>

      <p className="mt-3 text-[10px] font-bold tracking-[0.1em] text-[#8b877d] uppercase">Acceptance criteria</p>
      <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-[#55524b]">
          Settle by [s]
          <input
            type="number"
            min={1}
            step={60}
            value={settleByS}
            onChange={(e) => setSettleByS(parseFloat(e.target.value) || 1)}
            className="rounded border border-[#dedbd2] bg-white px-1.5 py-1 text-[11px] text-[#171512]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-[#55524b]">
          Pointing &lt; [°]
          <input
            type="number"
            min={0}
            step={0.1}
            value={pointingThresholdDeg}
            onChange={(e) => setPointingThresholdDeg(parseFloat(e.target.value) || 0)}
            className="rounded border border-[#dedbd2] bg-white px-1.5 py-1 text-[11px] text-[#171512]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-[#55524b]">
          Rate &lt; [°/s]
          <input
            type="number"
            min={0}
            step={0.01}
            value={omegaThresholdDegS}
            onChange={(e) => setOmegaThresholdDegS(parseFloat(e.target.value) || 0)}
            className="rounded border border-[#dedbd2] bg-white px-1.5 py-1 text-[11px] text-[#171512]"
          />
        </label>
      </div>
      <p className="mt-1 text-[10.5px] text-[#8b877d]">
        "Converged" below means BOTH pointing error and angular rate are under these thresholds simultaneously,
        within the settle-by window — not pointing alone. The backend's own settle check only looks at pointing
        error, which can mark a still-tumbling vehicle "settled" if it happens to pass through the target angle;
        this panel applies the rate criterion itself from the real per-sample data.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={runBatch}
          disabled={progress != null}
          className="flex items-center gap-1.5 border-[1.5px] border-[#171512] bg-[#171512] px-4.5 py-2 text-[10.5px] font-bold tracking-[0.12em] text-[#fbfaf6] uppercase hover:border-[#f24d00] hover:bg-[#f24d00] disabled:opacity-40"
        >
          {progress ? `Running… ${progress.done} / ${progress.total}` : `Run ${Math.min(MAX_BATCH, Math.max(1, Math.round(batchSize)))} runs`}
        </button>
        {progress && (
          <button
            type="button"
            onClick={cancel}
            className="border-[1.5px] border-[#c23b2a] px-3 py-2 text-[10.5px] font-bold tracking-[0.1em] text-[#c23b2a] uppercase hover:bg-[#c23b2a]/10"
          >
            Cancel
          </button>
        )}
      </div>

      {stats && (
        <div className="mt-3">
          <div
            className={
              "rounded border px-3 py-2 text-[11px] " +
              (stats.converged / Math.max(1, stats.n) > 0.9
                ? "border-[#2e9e53]/40 bg-[#2e9e53]/10 text-[#1f6b39]"
                : stats.converged / Math.max(1, stats.n) > 0.5
                  ? "border-[#e0a020]/40 bg-[#e0a020]/10 text-[#7a5c10]"
                  : "border-[#c23b2a]/40 bg-[#c23b2a]/10 text-[#8a2a1e]")
            }
          >
            <div className="font-bold">
              {stats.converged} / {stats.n} runs converged ({((stats.converged / Math.max(1, stats.n)) * 100).toFixed(1)}%)
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[10.5px] opacity-80 sm:grid-cols-3">
              <span>mean settle time {stats.meanSettleTimeS != null ? `${stats.meanSettleTimeS.toFixed(0)} s` : "—"}</span>
              <span>mean overshoot {stats.meanOvershootDeg != null ? `${stats.meanOvershootDeg.toFixed(2)}°` : "—"}</span>
              <span>mean final error {stats.meanFinalErrorDeg.toFixed(2)}°</span>
              <span>mean propellant {stats.meanPropellantKg.toFixed(5)} kg</span>
              <span>{(stats.wallClockMs / 1000).toFixed(1)} s wall clock</span>
              <span>{(stats.n / (stats.wallClockMs / 1000)).toFixed(0)} runs/s</span>
            </div>
          </div>

          {stats.settleTimes.length > 0 && (
            <div className="mt-3 border border-[#171512] bg-white p-3 pb-2">
              <Plot
                data={[
                  {
                    type: "histogram",
                    x: stats.settleTimes,
                    marker: { color: CHART_COLORS[1] },
                  },
                ]}
                layout={{
                  ...AXIS_LAYOUT,
                  xaxis: { title: { text: "Settle time [s]" } },
                  yaxis: { title: { text: "Runs" }, automargin: true },
                }}
                style={{ width: "100%", height: "180px" }}
                useResizeHandler
                config={{ displayModeBar: false }}
              />
            </div>
          )}
          <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
            {stats.n - stats.converged > 0 &&
              `${stats.n - stats.converged} run(s) did not settle within the test duration — excluded from the settle-time/overshoot means above, included in propellant/final-error means.`}
          </p>
        </div>
      )}
    </div>
  )
}
