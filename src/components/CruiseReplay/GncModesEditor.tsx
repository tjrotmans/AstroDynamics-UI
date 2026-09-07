import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

import type {
  GncModeConfig,
  HardwareItem,
  ModeScheduleEntryConfig,
  MissionConfig,
  PointingRuleConfig,
  PointingTargetConfig,
} from "@/api/client"
import { InfoTooltip } from "@/components/InfoTooltip"
import { fmtVec, hardwareLabel, hardwarePointingVector } from "@/lib/hardwarePointing"

type PropulsionConfig = MissionConfig["spacecraft"]["propulsion"]
const PROPULSION_TYPES: PropulsionConfig["type"][] = ["Monoprop", "Biprop", "Electric", "Cold Gas"]

// Real design session (see the design notes):
// this used to be a read-only preview of deriveDefaultModes()'s output.
// Now a real editor over gncModesStore's state, seeded from that same
// function as a starting point. Two things deliberately NOT built here,
// both discussed and written down rather than guessed at:
// - No "Maneuver Mode" entry in the modes list -- unplanned correction
//   burns are already fully automatic backend-side (see the "Main engine
//   & maneuver mode" disclosure below), and planned-DSM maneuver pointing
//   has no backend representation at all yet (cruise_seed carries no
//   burn-event list).
// - Only the target body is offered as a "Body" pointing target -- that's
//   the only body cruise_seed.body_tracks actually carries today
//   (CruiseReplayPage only fetches one track). A departure-body or
//   flyby-body Body target would need a real track fetched for it first;
//   not built, the picker says so rather than offering a name that would
//   422 at request time.
//
// Redesigned direct user feedback ("too much text and boxes
// and numbers... looks messy/chaotic"): everything used to render fully
// expanded at once. Now a compact always-visible summary line plus three
// collapsed-by-default disclosures (same collapse/expand idiom as the
// Study paper's PaperDisclosure, reimplemented locally here in this
// panel's dark palette rather than that component's light-paper one) --
// long italic explanatory paragraphs became InfoTooltips next to their
// control instead of permanent text blocks, so the common case (defaults
// already look right, nothing to change) reads as three short headers,
// not a wall of inputs.
function fmtDays(s: number): string {
  return `${(s / 86_400).toFixed(1)}d`
}

const TARGET_TYPE_LABELS: Record<PointingTargetConfig["type"], string> = {
  Sun: "Sun",
  Body: "Named body",
  Velocity: "Velocity vector",
  Inertial: "Fixed inertial direction",
}

function defaultTargetForType(type: PointingTargetConfig["type"], targetBodyName: string | null): PointingTargetConfig {
  if (type === "Sun") return { type: "Sun" }
  if (type === "Velocity") return { type: "Velocity" }
  if (type === "Inertial") return { type: "Inertial", direction: [1, 0, 0] }
  return { type: "Body", name: targetBodyName ?? "" }
}

function eligibleHardware(hardware: HardwareItem[]): { index: number; item: HardwareItem }[] {
  return hardware.map((item, index) => ({ index, item })).filter(({ item }) => hardwarePointingVector(item) != null)
}

function priorityLabel(index: number): { text: string; className: string } {
  if (index === 0) return { text: "primary", className: "text-orange-400" }
  if (index === 1) return { text: "secondary", className: "text-white/60" }
  return { text: "evaluated only — cannot control attitude", className: "text-amber-500" }
}

function Disclosure({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded border border-white/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-semibold text-white/85 hover:text-orange-400"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span>{title}</span>
        {!open && summary && <span className="ml-2 truncate text-[10px] font-normal text-white/40">{summary}</span>}
      </button>
      {open && <div className="border-t border-white/10 p-2">{children}</div>}
    </div>
  )
}

export function GncModesEditor({
  hardware,
  targetBodyName,
  legDurationS,
  modes,
  schedule,
  safeMode,
  tcmThresholdM,
  propulsion,
  onModesChange,
  onScheduleChange,
  onSafeModeChange,
  onTcmThresholdChange,
  onPropulsionChange,
  onResetToAuto,
}: {
  hardware: HardwareItem[]
  targetBodyName: string | null
  legDurationS: number | null
  modes: GncModeConfig[]
  schedule: ModeScheduleEntryConfig[]
  safeMode: string | null
  tcmThresholdM: number | null
  propulsion: PropulsionConfig
  onModesChange: (modes: GncModeConfig[]) => void
  onScheduleChange: (schedule: ModeScheduleEntryConfig[]) => void
  onSafeModeChange: (name: string | null) => void
  onTcmThresholdChange: (v: number | null) => void
  onPropulsionChange: (propulsion: PropulsionConfig) => void
  onResetToAuto: () => void
}) {
  const eligible = eligibleHardware(hardware)

  function updateMode(i: number, next: GncModeConfig) {
    onModesChange(modes.map((m, idx) => (idx === i ? next : m)))
  }
  function removeMode(i: number) {
    const removedName = modes[i]?.name
    onModesChange(modes.filter((_, idx) => idx !== i))
    // A mode name referenced by the schedule/safe_mode after removal would
    // 422 at request time with no visible reason -- clean both up here
    // instead of leaving a dangling reference for the user to debug later.
    onScheduleChange(schedule.filter((e) => e.mode !== removedName))
    if (safeMode === removedName) onSafeModeChange(null)
  }
  function addMode() {
    const base = "NewMode"
    let name = base
    let n = 2
    while (modes.some((m) => m.name === name)) {
      name = `${base}${n}`
      n += 1
    }
    onModesChange([...modes, { name, rules: [], pointing_locked: false }])
  }

  function updateRule(modeIdx: number, ruleIdx: number, next: PointingRuleConfig) {
    const mode = modes[modeIdx]
    const rules = mode.rules.map((r, idx) => (idx === ruleIdx ? next : r))
    updateMode(modeIdx, { ...mode, rules })
  }
  function removeRule(modeIdx: number, ruleIdx: number) {
    const mode = modes[modeIdx]
    updateMode(modeIdx, { ...mode, rules: mode.rules.filter((_, idx) => idx !== ruleIdx) })
  }
  function moveRule(modeIdx: number, ruleIdx: number, dir: -1 | 1) {
    const mode = modes[modeIdx]
    const target = ruleIdx + dir
    if (target < 0 || target >= mode.rules.length) return
    const rules = [...mode.rules]
    ;[rules[ruleIdx], rules[target]] = [rules[target], rules[ruleIdx]]
    updateMode(modeIdx, { ...mode, rules })
  }
  function addRule(modeIdx: number) {
    if (eligible.length === 0) return
    const mode = modes[modeIdx]
    updateMode(modeIdx, {
      ...mode,
      rules: [...mode.rules, { hardware_index: eligible[0].index, target: defaultTargetForType("Sun", targetBodyName) }],
    })
  }

  function updateScheduleEntry(i: number, next: ModeScheduleEntryConfig) {
    onScheduleChange(schedule.map((e, idx) => (idx === i ? next : e)))
  }
  function removeScheduleEntry(i: number) {
    onScheduleChange(schedule.filter((_, idx) => idx !== i))
  }
  // Real bug found live defaulting end_s to legDurationS
  // produced a zero-width entry (backend 422: "start_s must be < end_s")
  // whenever the existing schedule already spanned the whole leg -- the
  // common case, since deriveDefaultModes() always covers 0..legDurationS.
  // A fixed default width (1 day) is never zero regardless of where
  // lastEnd already sits; the user edits the real end value afterward.
  const DEFAULT_SCHEDULE_ENTRY_WIDTH_S = 86_400
  function addScheduleEntry() {
    const lastEnd = schedule.length > 0 ? schedule[schedule.length - 1].end_s : 0
    onScheduleChange([
      ...schedule,
      { start_s: lastEnd, end_s: lastEnd + DEFAULT_SCHEDULE_ENTRY_WIDTH_S, mode: modes[0]?.name ?? "" },
    ])
  }

  const modesSummary = modes.length === 0 ? "none — SunPointing hold" : `${modes.length} mode${modes.length === 1 ? "" : "s"}`
  const scheduleSummary =
    schedule.length === 0
      ? "no entries"
      : `${schedule.length} entr${schedule.length === 1 ? "y" : "ies"}${safeMode ? `, safe mode: ${safeMode}` : ""}`
  const engineSummary = `${propulsion.type}, ${propulsion.isp_s}s Isp, ${propulsion.thrust_n}N — maneuver ${
    tcmThresholdM != null ? `trigger at ${(tcmThresholdM / 1000).toFixed(0)} km` : "off"
  }`

  return (
    <div className="mb-6 rounded border border-border bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-white/85">GNC modes &amp; constraints</div>
        <button type="button" className="text-[10px] text-muted-foreground underline hover:text-orange-400" onClick={onResetToAuto}>
          Reset to auto-derived
        </button>
      </div>
      <p className="mb-3 text-[10px] text-white/40">
        {modesSummary} · schedule: {scheduleSummary} · engine: {engineSummary}
      </p>

      <div className="space-y-1.5">
        <Disclosure title={`Modes & rules (${modes.length})`} summary={modesSummary} defaultOpen={modes.length === 0}>
          {modes.length === 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              No modes defined — falls back to a fixed SunPointing hold for the whole leg. Add a mode below, or place a
              solar panel / star tracker / OpNav camera and reset to auto-derived.
            </p>
          )}

          <div className="space-y-3">
            {modes.map((mode, modeIdx) => (
              <div key={modeIdx} className="rounded border border-white/10 p-2">
                <div className="mb-1.5 flex items-center gap-2">
                  <input
                    className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-xs font-semibold text-white"
                    value={mode.name}
                    onChange={(e) => updateMode(modeIdx, { ...mode, name: e.target.value })}
                  />
                  <button
                    type="button"
                    className="ml-auto text-xs text-muted-foreground hover:text-red-400"
                    onClick={() => removeMode(modeIdx)}
                  >
                    remove mode
                  </button>
                </div>

                <div className="space-y-1.5">
                  {mode.rules.map((rule, ruleIdx) => {
                    const item = hardware[rule.hardware_index]
                    const prio = priorityLabel(ruleIdx)
                    return (
                      <div key={ruleIdx} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className={`w-40 shrink-0 text-[10px] font-semibold ${prio.className}`}>{prio.text}</span>
                        <select
                          className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-xs text-white"
                          value={rule.hardware_index}
                          onChange={(e) => updateRule(modeIdx, ruleIdx, { ...rule, hardware_index: Number(e.target.value) })}
                        >
                          {eligible.map(({ index, item: hw }) => (
                            <option key={index} value={index}>
                              {hardwareLabel(hw, index)} — aim {fmtVec(hardwarePointingVector(hw))}
                            </option>
                          ))}
                        </select>
                        <span className="text-muted-foreground">→</span>
                        <select
                          className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-xs text-white"
                          value={rule.target.type}
                          onChange={(e) =>
                            updateRule(modeIdx, ruleIdx, {
                              ...rule,
                              target: defaultTargetForType(e.target.value as PointingTargetConfig["type"], targetBodyName),
                            })
                          }
                        >
                          {(Object.keys(TARGET_TYPE_LABELS) as PointingTargetConfig["type"][]).map((t) => (
                            <option key={t} value={t}>
                              {TARGET_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                        {rule.target.type === "Body" && (
                          <>
                            <select
                              className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-xs text-white"
                              value={rule.target.name ?? ""}
                              onChange={(e) => updateRule(modeIdx, ruleIdx, { ...rule, target: { type: "Body", name: e.target.value } })}
                            >
                              {targetBodyName ? (
                                <option value={targetBodyName}>{targetBodyName}</option>
                              ) : (
                                <option value="">no target body set</option>
                              )}
                            </select>
                            <InfoTooltip>Only the target body is trackable today.</InfoTooltip>
                          </>
                        )}
                        {rule.target.type === "Inertial" && (
                          <span className="flex items-center gap-1">
                            {[0, 1, 2].map((axis) => (
                              <input
                                key={axis}
                                type="number"
                                step="0.1"
                                className="w-14 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-xs text-white"
                                value={rule.target.direction?.[axis] ?? 0}
                                onChange={(e) => {
                                  const dir = [...(rule.target.direction ?? [1, 0, 0])]
                                  dir[axis] = Number(e.target.value)
                                  updateRule(modeIdx, ruleIdx, { ...rule, target: { type: "Inertial", direction: dir } })
                                }}
                              />
                            ))}
                          </span>
                        )}
                        <span className="ml-auto flex gap-1">
                          <button type="button" className="text-muted-foreground hover:text-white" onClick={() => moveRule(modeIdx, ruleIdx, -1)}>
                            ↑
                          </button>
                          <button type="button" className="text-muted-foreground hover:text-white" onClick={() => moveRule(modeIdx, ruleIdx, 1)}>
                            ↓
                          </button>
                          <button type="button" className="text-muted-foreground hover:text-red-400" onClick={() => removeRule(modeIdx, ruleIdx)}>
                            ✕
                          </button>
                        </span>
                        {item && (
                          <div className="w-full pl-[10.5rem] text-[10px] text-muted-foreground">
                            {hardwareLabel(item, rule.hardware_index)}, real aim {fmtVec(hardwarePointingVector(item))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                <button
                  type="button"
                  className="mt-1.5 text-[10px] text-muted-foreground underline hover:text-orange-400 disabled:opacity-40"
                  onClick={() => addRule(modeIdx)}
                  disabled={eligible.length === 0}
                >
                  + add rule
                </button>
              </div>
            ))}
          </div>

          <button type="button" className="mt-2 text-[10px] text-muted-foreground underline hover:text-orange-400" onClick={addMode}>
            + add mode
          </button>
        </Disclosure>

        {modes.length > 0 && (
          <Disclosure title="Schedule & safe mode" summary={scheduleSummary}>
            <div className="space-y-1">
              {schedule.map((entry, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="number"
                    step="0.1"
                    className="w-16 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white"
                    value={(entry.start_s / 86_400).toFixed(2)}
                    onChange={(e) => updateScheduleEntry(i, { ...entry, start_s: Number(e.target.value) * 86_400 })}
                  />
                  <span className="text-muted-foreground">–</span>
                  <input
                    type="number"
                    step="0.1"
                    className="w-16 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white"
                    value={(entry.end_s / 86_400).toFixed(2)}
                    onChange={(e) => updateScheduleEntry(i, { ...entry, end_s: Number(e.target.value) * 86_400 })}
                  />
                  <span className="text-muted-foreground">days:</span>
                  <select
                    className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white"
                    value={entry.mode}
                    onChange={(e) => updateScheduleEntry(i, { ...entry, mode: e.target.value })}
                  >
                    {modes.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="ml-auto text-muted-foreground hover:text-red-400" onClick={() => removeScheduleEntry(i)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="mt-1.5 text-[10px] text-muted-foreground underline hover:text-orange-400" onClick={addScheduleEntry}>
              + add schedule entry
            </button>
            {legDurationS != null && (
              <p className="mt-1 text-[10px] italic text-muted-foreground">leg duration: {fmtDays(legDurationS)}</p>
            )}

            <div className="mt-2 flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">safe mode (used for any tick not covered above):</span>
              <select
                className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white"
                value={safeMode ?? ""}
                onChange={(e) => onSafeModeChange(e.target.value || null)}
              >
                <option value="">none</option>
                {modes.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </Disclosure>
        )}

        <Disclosure title="Main engine & maneuver mode" summary={engineSummary}>
          {/* PropulsionFields.tsx (the shadcn
              equivalent of this control) had zero importers anywhere in the
              app -- every mission silently used missionStore's hardcoded
              default (Monoprop, 220s, 10N) with no way to change it. This is
              the ONE actuator that fires every translational maneuver (see
              the maneuver-mode fields below), so it's mounted here rather
              than rebuilding PropulsionFields' shadcn styling inside this
              dark inset panel -- same fields, same setPropulsion action,
              styled to match the rest of this editor instead. */}
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Main engine</div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-muted-foreground">
              type
              <select
                className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white"
                value={propulsion.type}
                onChange={(e) => onPropulsionChange({ ...propulsion, type: e.target.value as PropulsionConfig["type"] })}
              >
                {PROPULSION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              Isp
              <input
                type="number"
                className="w-16 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white"
                value={propulsion.isp_s}
                onChange={(e) => onPropulsionChange({ ...propulsion, isp_s: Number(e.target.value) })}
              />
              s
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              thrust
              <input
                type="number"
                className="w-16 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white"
                value={propulsion.thrust_n}
                onChange={(e) => onPropulsionChange({ ...propulsion, thrust_n: Number(e.target.value) })}
              />
              N
            </label>
          </div>

          <div className="mt-3 border-t border-white/10 pt-2">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <i className="inline-block h-2 w-2 rounded-sm" style={{ background: "#e04a3a" }} />
              Maneuver mode
              {/* Real correction,: this used to say "no mode needed
                  for this, it's automatic" -- checked directly against
                  cruise.rs (TcmPhase::Slewing/Burning, desired_quaternion_
                  cruise's CruisePointingMode::BurnAttitude) and confirmed the
                  backend ALREADY implements exactly the maneuver mode
                  described here: body +X (the assumed main-engine mounting axis)
                  slews to align with the computed burn direction, THEN
                  spacecraft.propulsion fires. It IS a real mode -- cruise.rs
                  reports active_mode as "Slewing"/"Burning" while it's active
                  (see the timeline/attitude-pip legend for "Maneuver — ..."
                  bands using this same data) -- it's just not something you
                  author here the way SunPointing/TargetPointing are, because
                  there's no PointingRuleConfig target type meaning "the
                  currently computed burn direction," and the main engine
                  isn't a hardware_index-addressable item the way
                  sensors/panels are. This panel controls the ONE thing
                  that's real and user-facing today: when a maneuver triggers
                  at all. */}
              <InfoTooltip>
                What happens once triggered: the spacecraft slews its body +X axis (the engine's assumed mounting
                axis) to align with the computed Δv direction, then fires the main engine configured above (RCS is
                confirmed attitude-only in this backend — it never produces translational Δv, so this is the real
                maneuvering engine). This preempts whichever mode is scheduled for the whole maneuver — real
                spacecraft ops don't run a comm pass mid-burn.
                <br />
                <br />
                Real gaps, not fixable from this page: no secondary panel-to-Sun pointing is held during the burn.
                More significantly — no PLANNED burn is executed at all here, only unplanned corrective burns
                triggered by the threshold below. That includes deep-space maneuvers on an MGA route, but also the
                arrival/capture burn on this mission: the replay currently ends the moment the spacecraft would
                enter the target body's sphere of influence, before any capture burn would fire.
              </InfoTooltip>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {/* Default 2,000 km (was 50 km),: measured on the
                  Mars example, a 100 km threshold fired 134 reactive burns
                  costing 90.5 kg of main-engine propellant before arrival
                  (the capture then ran the tank dry), while the cruise only
                  needs holding to ~10,000 km for the capture re-solve to
                  absorb the rest. The backend's interpolation floor is
                  ~12 km, so anything below a few hundred km mostly chases
                  noise and short-burn attitude transients. */}
              <input type="checkbox" checked={tcmThresholdM != null} onChange={(e) => onTcmThresholdChange(e.target.checked ? 2_000_000 : null)} />
              Trigger a correction burn once position dispersion exceeds
              <input
                type="number"
                step="1"
                disabled={tcmThresholdM == null}
                className="w-16 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-white disabled:opacity-40"
                value={tcmThresholdM != null ? (tcmThresholdM / 1000).toFixed(0) : ""}
                onChange={(e) => onTcmThresholdChange(Number(e.target.value) * 1000)}
              />
              km
            </label>
            {tcmThresholdM != null && tcmThresholdM < 500_000 && (
              <p className="mt-1 text-[10px] text-amber-400">
                A threshold this tight fires very frequently (measured: 100 km → 134 burns and ~90 kg of main-engine
                propellant over a Mars cruise) and short engine burns cost attitude transients. 1,000–5,000 km is a
                realistic cruise tolerance; the capture burn is re-solved at arrival and absorbs the remainder.
              </p>
            )}
          </div>
        </Disclosure>
      </div>
    </div>
  )
}
