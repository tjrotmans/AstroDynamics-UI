import { useEffect, useMemo, useRef, useState } from "react"

import type { CruiseStepMsg, ModeScheduleEntryConfig, ModeTransitionReport } from "@/api/client"
import { jdToEpochString } from "@/lib/utils"
import type { FigureFocusWindow } from "./CruiseFigures"
// Real-only bands -- no eclipse/comm-outage rows, since this app has no
// real data source for either yet (no DSN pass scheduling, no eclipse
// detection). Grouped from the actual streamed active_mode/pointing_error_
// deg/wheel_sat_frac per tick, not fabricated. The pointing-error threshold
// is a placeholder (0.5 deg, the same settle convention already used for
// slew-test/mode-transition settling elsewhere) until a real per-mission
// pointing requirement field exists on the backend.
//
// colorForMode/buildRawModeSegments/POINTING_ERROR_THRESHOLD_DEG moved to
// lib/cruiseModeSegments.ts - CruiseFigures.tsx needs the exact
// same mode->color mapping ("highlight the modes in those plots"), and a
// component file re-exporting plain functions/constants trips
// react-refresh's only-export-components rule.
import { POINTING_ERROR_THRESHOLD_DEG, buildRawModeSegments, colorForMode, isManeuverMode, maneuverModeLabel } from "@/lib/cruiseModeSegments"

interface Segment {
  startFrac: number
  widthFrac: number
  color: string
  label: string
  // Raw window [s] -- kept so a segment can be focused (double-click), not
  // just rendered.
  startS: number
  endS: number
}

// Real request: "it would also be nice if i can zoom in on
// events in the bar plots" -- a mission with only a handful of brief
// maneuver events across a many-day timeline makes each one a near-
// invisible sliver at full zoom. Every segment builder below now maps a
// real t_s onto a VIEW WINDOW ([viewStartS, viewStartS+viewSpanS]) instead
// of always [0, durationS] -- CruiseTimeline owns that window as zoom
// state (see the component below) and passes it through, so zooming in
// doesn't need a second, parallel set of segment-building logic.
function toFrac(tS: number, viewStartS: number, viewSpanS: number): number {
  return viewSpanS > 0 ? (tS - viewStartS) / viewSpanS : 0
}

function buildModeSegments(steps: CruiseStepMsg[], viewStartS: number, viewSpanS: number, knownModes: string[]): Segment[] {
  if (steps.length === 0 || viewSpanS <= 0) return []
  return buildRawModeSegments(steps).map((seg) => ({
    startFrac: toFrac(seg.startS, viewStartS, viewSpanS),
    widthFrac: Math.max(0, (seg.endS - seg.startS) / viewSpanS),
    color: colorForMode(seg.mode, knownModes),
    label: seg.mode ? (isManeuverMode(seg.mode) ? maneuverModeLabel(seg.mode) : seg.mode) : "no mode (fixed hold)",
    startS: seg.startS,
    endS: seg.endS,
  }))
}

// Real request: "in the slide-bar i can not see what mode is
// supposed to be executed when... make two bars on top of each other. 1
// with the current bar... and 1 with the modes. The modes bar is basically
// the Schedule from the left page in bar form." This is the STATIC
// config (gncModesStore.schedule), not derived from streamed ticks at
// all -- what the user planned, independent of whether a maneuver or a
// TCM burn later preempted it during the actual run (that divergence is
// exactly why this is a useful SECOND bar rather than just relabeling the
// existing one).
function buildScheduleSegments(
  schedule: ModeScheduleEntryConfig[],
  viewStartS: number,
  viewSpanS: number,
  knownModes: string[],
): Segment[] {
  if (schedule.length === 0 || viewSpanS <= 0) return []
  return schedule.map((e) => ({
    startFrac: toFrac(e.start_s, viewStartS, viewSpanS),
    widthFrac: Math.max(0, (e.end_s - e.start_s) / viewSpanS),
    color: colorForMode(e.mode, knownModes),
    label: e.mode,
    startS: e.start_s,
    endS: e.end_s,
  }))
}

function buildOverlaySegments(
  steps: CruiseStepMsg[],
  viewStartS: number,
  viewSpanS: number,
  predicate: (s: CruiseStepMsg) => boolean,
): Segment[] {
  if (steps.length === 0 || viewSpanS <= 0) return []
  const segments: Segment[] = []
  let runStart: number | null = null
  for (let i = 0; i < steps.length; i++) {
    const hit = predicate(steps[i])
    if (hit && runStart === null) runStart = steps[i].t_s
    if (!hit && runStart !== null) {
      segments.push({
        startFrac: toFrac(runStart, viewStartS, viewSpanS),
        widthFrac: (steps[i].t_s - runStart) / viewSpanS,
        color: "",
        label: "",
        startS: runStart,
        endS: steps[i].t_s,
      })
      runStart = null
    }
  }
  if (runStart !== null) {
    segments.push({
      startFrac: toFrac(runStart, viewStartS, viewSpanS),
      widthFrac: (steps[steps.length - 1].t_s - runStart) / viewSpanS,
      color: "",
      label: "",
      startS: runStart,
      endS: steps[steps.length - 1].t_s,
    })
  }
  return segments
}

// Real request: "make a distinction between labels/colors of
// the top bar and of the bottom bar" -- both bars share one unioned
// mode->color mapping (see knownModes below) so a mode's HUE is identical
// everywhere on the page, which is deliberate and stays. What was missing
// was a way to tell the two bars apart at a glance beyond their (easy to
// miss) text labels. A diagonal hatch reuses the same "pattern = planned/
// derived, solid = measured/real" convention the pointing-error overlay
// below already established (that one is a horizontal hatch over the
// ACTUAL bar for a real streamed threshold-exceedance -- diagonal here so
// the two hatches don't read as the same thing) -- solid fill stays
// reserved for what the vehicle actually did.
function hatchBackground(color: string): string {
  return `repeating-linear-gradient(45deg, ${color} 0px, ${color} 3px, transparent 3px, transparent 7px)`
}

function findingText(tr: ModeTransitionReport): string {
  const head = tr.from_mode ? `${tr.from_mode} → ${tr.to_mode}` : `Entered ${tr.to_mode}`
  const settle =
    tr.settling_time_s != null ? `attitude settled in ${tr.settling_time_s.toFixed(0)} s` : "attitude never settled"
  return `${head} — ${settle}, ${tr.rcs_propellant_kg_used.toFixed(3)} kg RCS used, peak wheel momentum ${tr.max_wheel_momentum_nms.toFixed(3)} N·m·s`
}

function fmtDuration(s: number): string {
  if (s < 3600) return `${(s / 60).toFixed(0)} min`
  if (s < 86_400) return `${(s / 3600).toFixed(1)} h`
  return `${(s / 86_400).toFixed(1)} d`
}

// A zoomed-in window still needs enough real span to be legible -- a
// zero-or-near-zero window (e.g. zooming to an instantaneous event) would
// divide-by-near-zero every frac above.
const MIN_ZOOM_SPAN_S = 600

export function CruiseTimeline({
  steps,
  schedule,
  transitions,
  durationS,
  playheadS,
  onSeek,
  focusWindow,
  onFocusWindowChange,
  playing,
  onPlayPause,
  wallclockS,
  onWallclockChange,
  depJd,
}: {
  steps: CruiseStepMsg[]
  // The planned schedule, straight from gncModesStore -- see the file
  // header for why this is a real second bar, not folded into the first.
  schedule: ModeScheduleEntryConfig[]
  // Real request: "shouldnt [the Findings] be represented by
  // the two bars... that's what the bars should be for." Mode transitions
  // (the same data CruiseFindings.tsx used to list separately, now
  // retired) are plotted directly on the actual bar as markers instead of
  // a redundant scrolling list below it -- hover for detail, click to seek
  // exactly there.
  transitions: ModeTransitionReport[]
  durationS: number
  playheadS: number
  onSeek: (t_s: number) => void
  // UX review: the page's ONE shared time window. This
  // timeline's zoom, the figures' focus, and the "investigate this phase"
  // selection are all the same state, owned by CruiseReplayPage -- the
  // previous cut had the timeline's private zoomRange and a separate figure
  // focus, i.e. two competing zoom concepts on one page. Set here via
  // double-clicking a mode segment (either bar) or a finding tooltip's
  // zoom button; cleared via the reset pill.
  focusWindow: FigureFocusWindow | null
  onFocusWindowChange: (w: FigureFocusWindow | null) => void
  // Transport lives ON the timeline (UX review) -- one place to
  // read/control mission time, instead of a Play button in one corner, a
  // scrubber in another, and no numeric time readout anywhere.
  playing: boolean
  onPlayPause: () => void
  // Wall-clock seconds the full-mission playback takes -- exposed as a
  // speed selector.
  wallclockS: number
  onWallclockChange: (s: number) => void
  // The rebased-t0 epoch (JD) -- lets the readout show a real UTC date for
  // the playhead, not just elapsed seconds. Null when unknown (no adopted
  // trajectory).
  depJd: number | null
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [hoveredFinding, setHoveredFinding] = useState<number | null>(null)

  const viewStartS = focusWindow ? focusWindow.startS : 0
  const viewSpanS = focusWindow ? focusWindow.endS - focusWindow.startS : durationS

  // Real bug avoided here, not hit: computing knownModes separately for the
  // planned bar and the actual bar (as two independent Array.from(new
  // Set(...))'s) would assign different colors to the SAME mode name
  // across the two bars, since colorForMode's color is just an index into
  // a fixed palette -- e.g. "TargetPointing" could be blue in one bar and
  // green in the other purely because of unrelated modes/maneuver states
  // appearing in a different order. One UNIONED list, shared by both bars
  // (and the one combined legend below), keeps a mode's color identical
  // wherever it appears on this page.
  const knownModes = useMemo(() => {
    const fromSteps = steps.map((s) => s.active_mode).filter((m): m is string => Boolean(m))
    const fromSchedule = schedule.map((e) => e.mode)
    return Array.from(new Set([...fromSchedule, ...fromSteps]))
  }, [steps, schedule])

  const scheduleSegments = useMemo(
    () => buildScheduleSegments(schedule, viewStartS, viewSpanS, knownModes),
    [schedule, viewStartS, viewSpanS, knownModes],
  )
  const modeSegments = useMemo(
    () => buildModeSegments(steps, viewStartS, viewSpanS, knownModes),
    [steps, viewStartS, viewSpanS, knownModes],
  )
  const errorSegments = useMemo(
    () => buildOverlaySegments(steps, viewStartS, viewSpanS, (s) => s.pointing_error_deg > POINTING_ERROR_THRESHOLD_DEG),
    [steps, viewStartS, viewSpanS],
  )
  const satSegments = useMemo(
    () => buildOverlaySegments(steps, viewStartS, viewSpanS, (s) => s.wheel_sat_frac >= 1),
    [steps, viewStartS, viewSpanS],
  )

  const playheadFrac = toFrac(playheadS, viewStartS, viewSpanS)

  function handlePointer(e: React.PointerEvent) {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(viewStartS + frac * viewSpanS)
  }

  function zoomToEvent(tS: number) {
    // A window proportional to the mission's own length reads sensibly
    // whether the mission is hours or months long -- floored so a very
    // short mission still gets a legible window, and clamped to the real
    // [0, durationS] bounds.
    const half = Math.max(MIN_ZOOM_SPAN_S, durationS * 0.03)
    onFocusWindowChange({ startS: Math.max(0, tS - half), endS: Math.min(durationS, tS + half), label: "event", seekToStart: true })
    setHoveredFinding(null)
  }

  function focusSegment(seg: Segment) {
    const endS = Math.max(seg.endS, seg.startS + MIN_ZOOM_SPAN_S)
    onFocusWindowChange({ startS: seg.startS, endS, label: seg.label, seekToStart: true })
  }

  // Wheel on the bar = zoom the shared window around the cursor's time
  // (ask: "can we somehow allow to zoom in on specific
  // parts too there?"). Zooming out past the full span clears the focus.
  // Attached as a native non-passive listener -- React's own onWheel is
  // registered passively, so e.preventDefault() (needed to keep the page
  // from scrolling under the gesture) has no effect there.
  const wheelStateRef = useRef({ viewStartS, viewSpanS, durationS })
  wheelStateRef.current = { viewStartS, viewSpanS, durationS }
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const { viewStartS, viewSpanS, durationS } = wheelStateRef.current
      if (durationS <= 0 || viewSpanS <= 0) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const cursorT = viewStartS + frac * viewSpanS
      const factor = e.deltaY > 0 ? 1.35 : 1 / 1.35
      let span = viewSpanS * factor
      if (span >= durationS) {
        onFocusWindowChange(null)
        return
      }
      span = Math.max(MIN_ZOOM_SPAN_S, span)
      let start = cursorT - frac * span
      start = Math.max(0, Math.min(durationS - span, start))
      onFocusWindowChange({ startS: start, endS: start + span, label: "zoom window" })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
    // onFocusWindowChange is a stable useCallback from the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Playhead readout: elapsed mission time + the real UTC calendar date.
  const playheadDate = depJd != null ? jdToEpochString(depJd + playheadS / 86_400) : null

  return (
    <div className="rounded border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-full border border-white/25 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/80 hover:border-orange-500 hover:text-orange-500"
          onClick={onPlayPause}
        >
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <select
          className="rounded border border-white/15 bg-transparent px-1 py-0.5 text-[9px] font-semibold text-white/60"
          value={wallclockS}
          onChange={(e) => onWallclockChange(Number(e.target.value))}
          title="How long the full-mission playback takes in wall-clock time"
        >
          <option className="bg-[#12151f]" value={50}>0.5× (50 s)</option>
          <option className="bg-[#12151f]" value={25}>1× (25 s)</option>
          <option className="bg-[#12151f]" value={12}>2× (12 s)</option>
          <option className="bg-[#12151f]" value={6}>4× (6 s)</option>
        </select>
        <span className="font-mono text-[10px] text-amber-300/90">
          t = {(playheadS / 86_400).toFixed(2)} d{playheadDate ? ` · ${playheadDate.slice(0, 16).replace("T", " ")} UTC` : ""}
        </span>
        {/* The "phase view":
            every real mode segment, as a compact picker instead of a wall
            of chips -- pick one to focus all figures on it and seek there. */}
        {modeSegments.length > 1 && (
          <select
            className="rounded border border-white/15 bg-transparent px-1 py-0.5 text-[9px] font-semibold text-white/60"
            value=""
            onChange={(e) => {
              const seg = modeSegments[Number(e.target.value)]
              if (seg) focusSegment(seg)
            }}
            title="Focus all figures on one phase and seek the replay to its start"
          >
            <option className="bg-[#12151f]" value="">
              focus phase…
            </option>
            {modeSegments.map((seg, i) => (
              <option key={i} className="bg-[#12151f]" value={i}>
                {seg.label} · {(seg.startS / 86_400).toFixed(2)}–{(seg.endS / 86_400).toFixed(2)} d
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto text-[9px] text-white/30">
          {focusWindow
            ? `focused: ${focusWindow.label} (${fmtDuration(viewSpanS)})`
            : durationS > 0
              ? `full mission: ${fmtDuration(durationS)} · drag = slide time · wheel = zoom · double-click a segment = focus`
              : ""}
        </span>
        {focusWindow && (
          <button
            type="button"
            className="rounded border border-white/15 px-1.5 py-0.5 text-[9px] font-semibold text-white/70 hover:border-orange-400 hover:text-orange-400"
            onClick={() => onFocusWindowChange(null)}
          >
            ↺ full mission
          </button>
        )}
      </div>
      {scheduleSegments.length > 0 && (
        <>
          <div className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/35">
            <span className="inline-block h-1.5 w-2.5 rounded-[1px]" style={{ backgroundImage: hatchBackground("#fff") }} />
            planned (schedule)
          </div>
          <div className="relative mb-2 h-3 overflow-hidden rounded bg-[#0a0d16]">
            {scheduleSegments.map((seg, i) => (
              <div
                key={`sched-${i}`}
                className="absolute inset-y-0 cursor-pointer"
                style={{ left: `${seg.startFrac * 100}%`, width: `${seg.widthFrac * 100}%`, backgroundImage: hatchBackground(seg.color) }}
                title={`${seg.label} — double-click to focus`}
                onDoubleClick={() => focusSegment(seg)}
              />
            ))}
            {playheadFrac >= 0 && playheadFrac <= 1 && (
              <div className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-amber-300/70" style={{ left: `${playheadFrac * 100}%` }} />
            )}
          </div>
          <div className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-white/70">
            <span className="inline-block h-1.5 w-2.5 rounded-[1px] bg-white/70" />
            actual
          </div>
        </>
      )}
      <div
        ref={trackRef}
        className="relative mt-2.5 h-6 cursor-pointer overflow-hidden rounded bg-[#0a0d16]"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          handlePointer(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) handlePointer(e)
        }}
      >
        {modeSegments.map((seg, i) => (
          <div
            key={`mode-${i}`}
            className="absolute inset-y-0"
            style={{ left: `${seg.startFrac * 100}%`, width: `${seg.widthFrac * 100}%`, background: seg.color }}
            title={`${seg.label} — double-click to focus this phase`}
            onDoubleClick={() => focusSegment(seg)}
          />
        ))}
        {errorSegments.map((seg, i) => (
          <div
            key={`err-${i}`}
            className="absolute inset-y-0 bg-[repeating-linear-gradient(90deg,rgba(224,160,32,0.6),rgba(224,160,32,0.6)_5px,rgba(224,160,32,0.25)_5px,rgba(224,160,32,0.25)_10px)]"
            style={{ left: `${seg.startFrac * 100}%`, width: `${seg.widthFrac * 100}%` }}
            title={`pointing error > ${POINTING_ERROR_THRESHOLD_DEG} deg`}
          />
        ))}
        {satSegments.map((seg, i) => (
          <div
            key={`sat-${i}`}
            className="absolute inset-y-0 bg-red-600/70"
            style={{ left: `${seg.startFrac * 100}%`, width: `${seg.widthFrac * 100}%` }}
            title="wheel saturated"
          />
        ))}
        {playheadFrac >= 0 && playheadFrac <= 1 && (
          <div
            className="absolute -top-1 -bottom-1 w-0.5 bg-amber-300 shadow-[0_0_6px_rgba(255,213,74,0.8)]"
            style={{ left: `${playheadFrac * 100}%` }}
          />
        )}
        {viewSpanS > 0 &&
          transitions.map((tr, i) => {
            const frac = toFrac(tr.t_s, viewStartS, viewSpanS)
            if (frac < -0.02 || frac > 1.02) return null
            return (
              // A generously-sized invisible hit target carries the pointer
              // handlers -- the visible diamond alone (8x8px) was too thin a
              // target to reliably hover/click, same "small marker needs a
              // bigger hit area" idea used for hardware markers in the 3D
              // viewports.
              <div
                key={`finding-${i}`}
                className="group absolute -top-4 z-10 flex h-4 w-4 -translate-x-1/2 cursor-pointer items-center justify-center"
                style={{ left: `${frac * 100}%` }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  onSeek(tr.t_s)
                }}
                onPointerEnter={() => setHoveredFinding(i)}
                onPointerLeave={() => setHoveredFinding((cur) => (cur === i ? null : cur))}
              >
                <div className="h-2 w-2 rotate-45 border border-black/40 bg-white shadow-[0_0_3px_rgba(0,0,0,0.6)] group-hover:bg-orange-400" />
                {hoveredFinding === i && (
                  <div className="absolute bottom-full left-1/2 z-20 mb-1.5 w-64 -translate-x-1/2 rounded border border-white/15 bg-[#12151f] p-2 text-[10px] leading-snug text-white/80 shadow-xl">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-[9px] text-orange-400">t = {tr.t_s.toFixed(0)} s</span>
                      <button
                        type="button"
                        className="rounded border border-white/20 px-1 py-0.5 text-[9px] font-semibold text-white/70 hover:border-orange-400 hover:text-orange-400"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          zoomToEvent(tr.t_s)
                        }}
                      >
                        🔍 zoom in
                      </button>
                    </div>
                    {findingText(tr)}
                  </div>
                )}
              </div>
            )
          })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-white/50">
        {knownModes.map((mode) => (
          <span key={mode} className="flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: colorForMode(mode, knownModes) }} />
            {isManeuverMode(mode) ? maneuverModeLabel(mode) : mode}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-amber-500/60" />
          pointing error over {POINTING_ERROR_THRESHOLD_DEG}&deg; (placeholder threshold)
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2 w-2 rounded-sm bg-red-600/70" />
          wheel saturated
        </span>
        {transitions.length > 0 && (
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-2 rotate-45 border border-black/40 bg-white" />
            mode transition — hover for detail/zoom, click to seek ("settled" = attitude only, see caption below)
          </span>
        )}
      </div>
    </div>
  )
}
