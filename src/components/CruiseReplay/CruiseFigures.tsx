import { useMemo, useState } from "react"

import type { CruiseStepMsg, HardwareItem, ModeScheduleEntryConfig } from "@/api/client"
import { DARK_LAYOUT, Plot } from "@/lib/plot"
import { POINTING_ERROR_THRESHOLD_DEG, colorForMode, isManeuverMode, maneuverModeLabel, buildRawModeSegments } from "@/lib/cruiseModeSegments"
import { decimateTrace } from "@/lib/lttb"

const S_PER_DAY = 86_400

type PlotData = React.ComponentProps<typeof Plot>["data"]
type PlotLayout = React.ComponentProps<typeof Plot>["layout"]

// Real request: "highlight the modes in those plots" -- reuses
// the exact same mode->color grouping the timeline already computes
// (buildRawModeSegments/colorForMode from CruiseTimeline.tsx), rendered as
// a translucent full-height background rect per mode run rather than a
// second, possibly-disagreeing color scheme.
//
// Real follow-up (
// unclear, so i still cant properly see the phases there"): the full-height
// tint alone was only 12% opacity, which is legible for tracing where a
// mode's REGION is but far too faint to tell adjacent modes apart at a
// glance, especially in a compact 130px-tall figure. Two shapes per segment
// now: the same faint full-height tint (kept, for at-a-glance "which
// region"), plus a second, much more saturated slim strip pinned to the
// TOP of the plot (paper y in [0.9, 1.0]) -- reads like a small ruler of
// mode color right under the plot title, unambiguous even for two adjacent
// modes with similar hues, without heavily tinting the data line itself.
// Freeze fix #3: each segment is TWO SVG shapes in EACH of six
// figures. A run whose TCM executive flips Slewing/Burning/Coast hundreds
// of times produces thousands of segments -- tens of thousands of SVG
// rects per relayout, which is what pins the main thread the moment a
// zoom lands. Bounded here: segments are coalesced (same mode adjacent
// runs merged; runs narrower than 1/400 of the visible span dropped, they
// were sub-pixel anyway) and hard-capped; above the cap only the slim top
// strip is drawn (the full-height tint is the expendable half).
const MAX_BAND_SEGMENTS = 120
function modeBandShapes(steps: CruiseStepMsg[], knownModes: string[]): object[] {
  const raw = buildRawModeSegments(steps)
  if (raw.length === 0) return []
  const spanS = raw[raw.length - 1].endS - raw[0].startS
  const minWidthS = spanS / 400
  const merged: typeof raw = []
  for (const seg of raw) {
    const last = merged[merged.length - 1]
    if (last && last.mode === seg.mode) last.endS = seg.endS
    else merged.push({ ...seg })
  }
  let segments = merged.filter((seg) => seg.endS - seg.startS >= minWidthS)
  const tintToo = segments.length <= MAX_BAND_SEGMENTS
  if (segments.length > MAX_BAND_SEGMENTS * 2) {
    // Keep the widest ones -- they are what a human can actually see.
    segments = [...segments].sort((a, b) => b.endS - b.startS - (a.endS - a.startS)).slice(0, MAX_BAND_SEGMENTS * 2)
  }
  const fullHeight = (tintToo ? segments : []).map((seg) => ({
    type: "rect" as const,
    x0: seg.startS / S_PER_DAY,
    x1: seg.endS / S_PER_DAY,
    y0: 0,
    y1: 1,
    yref: "paper" as const,
    fillcolor: colorForMode(seg.mode, knownModes),
    opacity: 0.14,
    line: { width: 0 },
    layer: "below" as const,
  }))
  const topStrip = segments.map((seg) => ({
    type: "rect" as const,
    x0: seg.startS / S_PER_DAY,
    x1: seg.endS / S_PER_DAY,
    y0: 0.9,
    y1: 1,
    yref: "paper" as const,
    fillcolor: colorForMode(seg.mode, knownModes),
    opacity: 0.85,
    line: { width: 0 },
    layer: "below" as const,
  }))
  return [...fullHeight, ...topStrip]
}

const FIG_HEIGHT = 130
const FIG_MARGIN = { l: 48, r: 12, t: 8, b: 28 }

// One mode segment's time window, for focusing every figure's x-axis on it
// at once (direct user ask: "during the first manoeuvre phase,
// i'd like to see all the figures on the left focused on that phase").
// Owned by CruiseReplayPage as the page's ONE shared time window -- the
// timeline's own zoom and the figures' focus are the same state (two
// parallel zoom concepts on one page was the UX-review finding
// that killed the first-cut chip row), and selecting a window also seeks
// the replay so the viewport/attitude pip show the same moment.
export interface FigureFocusWindow {
  startS: number
  endS: number
  label: string
  // True for a deliberate "investigate this phase" selection (the page then
  // also seeks the replay to startS); false/absent for a pure view zoom
  // (wheel on the timeline), which must NOT move the playhead.
  seekToStart?: boolean
}

// second interaction round: the
// first cut made dragging INSIDE a figure scrub the playhead, which killed
// Plotly's own box-zoom. Reverted -- inside the plots, drag = ordinary
// Plotly zoom again (plus wheel zoom via scrollZoom, kept across playback
// re-renders by uirevision); sliding through time is the BOTTOM BAR's job,
// exclusively.
const FIG_CONFIG = { displayModeBar: false, scrollZoom: true } as const
const FIG_STYLE = { width: "100%" } as const

// FREEZE FIX (
// (without error, just not responding anymore)"). Root cause: the playhead
// cursor used to be a Plotly SHAPE inside each figure's layout, and every
// figure's data arrays were rebuilt inline in JSX -- so each playback
// commit (~12/s) and each streamed tick handed react-plotly six brand-new
// data/layout objects, forcing six full Plotly.react redraws of ~20k-point
// traces per commit. That is hundreds of ms of main-thread work per
// frame; the tab stopped responding. Now: (1) every figure's `data` and
// `layout` are memoized on the DATA only (steps, focus, options) -- never
// on the playhead -- so react-plotly's reference check skips Plotly
// entirely during playback; (2) the cursor is this cheap DOM overlay,
// positioned from the figure's current x-range (tracked via onRelayout,
// which only fires on a real user zoom). Streaming is throttled upstream
// (useThrottledValue in CruiseReplayPage).
function CursorPlot({
  data,
  layout,
  height,
  fallbackRangeDays,
  rangeResetKey,
  playheadDays,
}: {
  data: PlotData
  layout: PlotLayout
  height: number
  fallbackRangeDays: [number, number]
  rangeResetKey: string
  playheadDays: number
}) {
  const [range, setRange] = useState<{ key: string; r: [number, number] } | null>(null)
  const current: [number, number] = range && range.key === rangeResetKey ? range.r : fallbackRangeDays
  const span = current[1] - current[0]
  const frac = span > 0 ? (playheadDays - current[0]) / span : -1
  const { l, r, t, b } = FIG_MARGIN
  return (
    <div className="relative">
      <Plot
        data={data}
        layout={layout}
        config={FIG_CONFIG}
        style={FIG_STYLE}
        onRelayout={(ev) => {
          const rec = ev as Record<string, unknown>
          const r0 = rec["xaxis.range[0]"]
          const r1 = rec["xaxis.range[1]"]
          if (typeof r0 === "number" && typeof r1 === "number") setRange({ key: rangeResetKey, r: [r0, r1] })
          else if (rec["xaxis.autorange"]) setRange(null)
        }}
      />
      {frac >= 0 && frac <= 1 && (
        <div
          className="pointer-events-none absolute border-l border-dotted border-[#c23b2a]"
          style={{
            top: t,
            bottom: b,
            left: `calc(${l}px + (100% - ${l + r}px) * ${frac})`,
            height: height - t - b,
          }}
        />
      )}
    </div>
  )
}

const FIG_TITLE = "mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"

export function CruiseFigures({
  steps,
  schedule,
  playheadS,
  hardware,
  focusWindow,
  torqueCheck,
  tickS,
}: {
  steps: CruiseStepMsg[]
  // Same reasoning as CruiseTimeline.tsx's own `schedule` prop: union the
  // planned schedule's mode names into knownModes so a mode's color is
  // identical here, in the timeline's two bars, and in its legend --
  // computing this independently per component would let unrelated modes
  // shift each other's palette index differently in each place.
  schedule: ModeScheduleEntryConfig[]
  playheadS: number
  hardware: HardwareItem[]
  focusWindow: FigureFocusWindow | null
  // Backend E5 check (`/api/design/vehicle → main_engine_torque_check`) --
  // drives Fig. 6's engine-disturbance trace and RCS-authority line.
  torqueCheck: { disturbance_torque_nm: number; rcs_authority_nm: number } | null
  // Control tick [s] the run was flown at -- the wheel-unload reaction the
  // allocator hands to the RCS during a burn is h_wheel / tick_s.
  tickS: number
}) {
  // Freeze fix #2: when a focus window is set, every figure
  // carries only the samples inside it (padded 10%) -- a zoomed-in
  // relayout then touches a few hundred points instead of ~20k × 15
  // traces. `allSteps` keeps the full run for the mode legend.
  const allSteps = steps
  const viewSteps = useMemo(() => {
    if (!focusWindow) return allSteps
    const pad = (focusWindow.endS - focusWindow.startS) * 0.1
    const lo = focusWindow.startS - pad
    const hi = focusWindow.endS + pad
    return allSteps.filter((s) => s.t_s >= lo && s.t_s <= hi)
  }, [allSteps, focusWindow])
  steps = viewSteps
  const tDays = useMemo(() => steps.map((s) => s.t_s / S_PER_DAY), [steps])
  const playheadDays = playheadS / S_PER_DAY
  // Real request: "in the figures... we want to highlight what
  // mode is used when. So use different shades (with labels) for different
  // modes" -- the shaded bands (modeBandShapes, above) already existed;
  // what was missing is a legend saying which shade means which mode. This
  // must be its OWN legend, not a copy of CruiseTimeline's -- the figures
  // and the timeline are often scrolled far apart on this page.
  const knownModes = useMemo(() => {
    const fromSteps = allSteps.map((s) => s.active_mode).filter((m): m is string => Boolean(m))
    const fromSchedule = schedule.map((e) => e.mode)
    return Array.from(new Set([...fromSchedule, ...fromSteps]))
  }, [allSteps, schedule])
  const bands = useMemo(() => modeBandShapes(steps, knownModes), [steps, knownModes])

  // User-zoom persistence + phase focus, both via Plotly's uirevision
  // contract: while uirevision stays CONSTANT across re-renders, Plotly
  // preserves whatever zoom/pan the user set by hand. When a focus window
  // is picked (or cleared), the key CHANGES, which is exactly what tells
  // Plotly to adopt the new explicit range (or return to autorange).
  const focusKey = focusWindow ? `${focusWindow.startS}:${focusWindow.endS}` : "full"
  // Pad the window ~3% each side so the segment's own boundary samples
  // aren't clipped by the axis line.
  const focusRangeDays = useMemo(() => {
    if (!focusWindow) return null
    const pad = Math.max((focusWindow.endS - focusWindow.startS) * 0.03, 1)
    return [(focusWindow.startS - pad) / S_PER_DAY, (focusWindow.endS + pad) / S_PER_DAY] as [number, number]
  }, [focusWindow])
  const xaxisLayout = useMemo(
    () => ({
      title: { text: "t [days]" },
      ...(focusRangeDays ? { range: focusRangeDays, autorange: false as const } : {}),
    }),
    [focusRangeDays],
  )
  const fullRangeDays = useMemo<[number, number]>(() => [tDays[0] ?? 0, tDays[tDays.length - 1] ?? 1], [tDays])
  const fallbackRangeDays = focusRangeDays ?? fullRangeDays
  const xEnd = tDays[tDays.length - 1] ?? 0
  const xStart = tDays[0] ?? 0

  // Fig. 4's dr_m legitimately spans many orders of magnitude (km-scale
  // interpolation residue up to Gm-scale divergence when tracking fails) --
  // a linear axis hides everything below the largest excursion. Log by
  // default, toggleable.
  const [drLogScale, setDrLogScale] = useState(true)

  // Real request: "why don't you just plot angular momentum per
  // wheel?" instead of the aggregate 0-1 wheel_sat_frac. CruiseStepMsg
  // carries wheel_speeds_radps PER WHEEL; the backend's fixed 4-wheel
  // pyramid model (config.rs's own doc comment) shares one inertia_kgm2
  // across all wheels, so per-wheel momentum = speed * inertia is real, not
  // approximated. Capacity line = max_speed_rads * inertia_kgm2, the real
  // ceiling each wheel's own speed is bounded by.
  const wheelItem = hardware.find((h) => h.type === "ReactionWheelCluster")
  const inertia = wheelItem?.type === "ReactionWheelCluster" ? (wheelItem.inertia_kgm2 ?? null) : null
  const maxSpeed = wheelItem?.type === "ReactionWheelCluster" ? (wheelItem.max_speed_rads ?? null) : null
  const capacityNms = inertia != null && maxSpeed != null ? inertia * maxSpeed : null
  const wheelCount = steps[0]?.wheel_speeds_radps?.length ?? 0
  // Real fix: this palette used to reuse #e0a020 (the Slewing
  // maneuver color, the pointing-threshold dotted line, AND the old TCM-
  // burns propellant trace below) for wheel 2, and #c95a5a for wheel 4 --
  // both collided with the amber/red family now reserved for maneuver/
  // warning colors. Wheels get their own non-competing set.
  const wheelColors = ["#2f6fed", "#3aa66b", "#a566c9", "#39c6c6"]

  // Every trace is downsampled (LTTB, lib/lttb.ts) to what a figure can
  // physically display before Plotly sees it -- the measured memory/stall
  // fix from the freeze investigation; see that file's header.
  const tr = (y: (number | null | undefined)[]) => decimateTrace(tDays, y)

  const baseLayout = useMemo(
    () => ({ ...DARK_LAYOUT, height: FIG_HEIGHT, margin: FIG_MARGIN, uirevision: focusKey, xaxis: xaxisLayout }),
    [focusKey, xaxisLayout],
  )

  // ── Fig. 1 — pointing error ──────────────────────────────────────────────
  const fig1 = useMemo(
    () => ({
      data: [
        { ...tr(steps.map((s) => s.pointing_error_deg)), type: "scatter", mode: "lines", line: { color: "#f24d00", width: 1.6 } },
      ] as PlotData,
      layout: {
        ...baseLayout,
        yaxis: { title: { text: "deg" } },
        shapes: [
          ...bands,
          {
            type: "line",
            x0: xStart,
            x1: xEnd,
            y0: POINTING_ERROR_THRESHOLD_DEG,
            y1: POINTING_ERROR_THRESHOLD_DEG,
            line: { color: "#e0a020", dash: "dot" as const, width: 1 },
          },
        ],
      } as PlotLayout,
    }),
    [tDays, steps, baseLayout, bands, xStart, xEnd],
  )

  // ── Fig. 2 — wheel momentum per wheel ────────────────────────────────────
  const fig2 = useMemo(
    () => ({
      data: Array.from({ length: wheelCount }, (_, i) => ({
        ...tr(steps.map((s) => (inertia != null ? s.wheel_speeds_radps[i] * inertia : s.wheel_speeds_radps[i]))),
        type: "scatter" as const,
        mode: "lines" as const,
        name: `wheel ${i + 1}`,
        line: { color: wheelColors[i % wheelColors.length], width: 1.3 },
      })) as PlotData,
      layout: {
        ...baseLayout,
        yaxis: { title: { text: inertia != null ? "N·m·s" : "rad/s (inertia unknown)" } },
        showlegend: wheelCount > 1,
        legend: { font: { size: 9 } },
        shapes: [
          ...bands,
          ...(capacityNms != null
            ? [capacityNms, -capacityNms].map((y) => ({
                type: "line" as const,
                x0: xStart,
                x1: xEnd,
                y0: y,
                y1: y,
                line: { color: "#c23b2a", dash: "dot" as const, width: 1 },
              }))
            : []),
        ],
      } as PlotLayout,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tDays, steps, baseLayout, bands, xStart, xEnd, wheelCount, inertia, capacityNms],
  )

  // ── Fig. 3 — propellant ──────────────────────────────────────────────────
  // Real bug found (
  // propellant used plot"): tcm_propellant_kg_cum (the main-engine tank) was
  // never plotted; both tanks shown, separately labeled.
  const fig3 = useMemo(
    () => ({
      data: [
        {
          ...tr(steps.map((s) => s.rcs_propellant_kg_cum)),
          type: "scatter",
          mode: "lines",
          name: "RCS (attitude/desaturation)",
          line: { color: "#2e9e53", width: 1.6 },
        },
        {
          ...tr(steps.map((s) => s.tcm_propellant_kg_cum)),
          type: "scatter",
          mode: "lines",
          name: "main engine (TCM burns)",
          // Matches the Burning maneuver color (cruiseModeSegments.ts) --
          // this trace IS that phase's propellant cost.
          line: { color: "#e04a3a", width: 1.6 },
        },
      ] as PlotData,
      layout: {
        ...baseLayout,
        yaxis: { title: { text: "kg" } },
        showlegend: true,
        legend: { font: { size: 9 } },
        shapes: [...bands],
      } as PlotLayout,
    }),
    [tDays, steps, baseLayout, bands],
  )

  // ── Fig. 4 — trajectory-following error ──────────────────────────────────
  const fig4 = useMemo(
    () => ({
      data: [{ ...tr(steps.map((s) => s.dr_m)), type: "scatter", mode: "lines", line: { color: "#8b877d", width: 1.4 } }] as PlotData,
      layout: {
        ...baseLayout,
        uirevision: `${focusKey}:${drLogScale}`,
        yaxis: { title: { text: "|dr| vs reference [m]" }, automargin: true, type: drLogScale ? ("log" as const) : ("linear" as const) },
        shapes: [...bands],
      } as PlotLayout,
    }),
    [tDays, steps, baseLayout, bands, focusKey, drLogScale],
  )

  // ── Fig. 5 — per-wheel torque (E3; renders only when streamed) ───────────
  const wheelTorqueTicks = useMemo(
    () => (steps.length > 0 && steps[0].wheel_torque_cmd_nm != null ? steps : null),
    [steps],
  )
  const fig5 = useMemo(() => {
    if (!wheelTorqueTicks) return null
    return {
      data: Array.from({ length: wheelCount }, (_, i) => [
        {
          ...tr(wheelTorqueTicks.map((s) => s.wheel_torque_cmd_nm?.[i] ?? null)),
          type: "scatter" as const,
          mode: "lines" as const,
          name: `wheel ${i + 1} cmd`,
          line: { color: wheelColors[i % wheelColors.length], width: 1, dash: "dot" as const },
        },
        {
          ...tr(wheelTorqueTicks.map((s) => s.wheel_torque_delivered_nm?.[i] ?? null)),
          type: "scatter" as const,
          mode: "lines" as const,
          name: `wheel ${i + 1} delivered`,
          line: { color: wheelColors[i % wheelColors.length], width: 1.4 },
        },
      ]).flat() as PlotData,
      layout: {
        ...baseLayout,
        yaxis: { title: { text: "N·m" } },
        showlegend: true,
        legend: { font: { size: 8 } },
        shapes: [...bands],
      } as PlotLayout,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wheelTorqueTicks, wheelCount, tDays, baseLayout, bands])

  // ── Fig. 6 — torque budget ───────────────────────────────────────────────
  // (
  // offset and required control torques are larger than what the RCS can
  // deliver"). Streamed: |torque_cmd_body_nm| and |torque_delivered_body_nm|.
  // Derived from the backend's own E5 check: the engine-offset disturbance
  // while tcm_phase === "Burning" (the constant r×F the propagator applies
  // during a burn) and the RCS full-duty authority as a line. The
  // wheel-unload reaction (h_wheel / tick_s while Burning -- what the
  // allocator hands to the RCS when it dumps all wheel momentum in one
  // tick, sim_engine::control::allocate) is the runtime mechanism the
  // static card cannot see; wheel_momentum_nms is streamed, so this is the
  // exact magnitude.
  const FIG6_HEIGHT = FIG_HEIGHT + 20
  const fig6 = useMemo(() => {
    const torqueMag = (v: number[] | undefined) => (v && v.length === 3 ? Math.hypot(v[0], v[1], v[2]) : null)
    const hasAuthority = !!torqueCheck && torqueCheck.rcs_authority_nm > 0
    return {
      data: [
        {
          ...tr(steps.map((s) => torqueMag(s.torque_cmd_body_nm))),
          type: "scatter",
          mode: "lines",
          name: "|commanded control torque|",
          line: { color: "#f24d00", width: 1.4 },
        },
        {
          ...tr(steps.map((s) => torqueMag(s.torque_delivered_body_nm))),
          type: "scatter",
          mode: "lines",
          name: "|delivered torque|",
          line: { color: "#3aa66b", width: 1.2 },
        },
        {
          ...tr(steps.map((s) => (s.tcm_phase === "Burning" && tickS > 0 ? s.wheel_momentum_nms / tickS : null))),
          type: "scatter",
          mode: "lines",
          name: `wheel-unload reaction on RCS (h_wheel / ${tickS} s, while burning)`,
          line: { color: "#a566c9", width: 2 },
          connectgaps: false,
        },
        ...(torqueCheck && torqueCheck.disturbance_torque_nm > 0
          ? [
              {
                ...tr(steps.map((s) => (s.tcm_phase === "Burning" ? torqueCheck.disturbance_torque_nm : null))),
                type: "scatter" as const,
                mode: "lines" as const,
                name: "engine-offset disturbance (while burning)",
                line: { color: "#e04a3a", width: 2 },
                connectgaps: false,
              },
            ]
          : []),
      ] as PlotData,
      layout: {
        ...baseLayout,
        height: FIG6_HEIGHT,
        yaxis: { title: { text: "N·m (log)" }, type: "log", automargin: true },
        showlegend: true,
        legend: { font: { size: 8 } },
        shapes: [
          ...bands,
          ...(hasAuthority
            ? [
                {
                  type: "line" as const,
                  x0: xStart,
                  x1: xEnd,
                  y0: torqueCheck!.rcs_authority_nm,
                  y1: torqueCheck!.rcs_authority_nm,
                  line: { color: "#ffd54a", dash: "dash" as const, width: 1.2 },
                },
              ]
            : []),
        ],
        annotations: hasAuthority
          ? [
              {
                x: xEnd,
                y: Math.log10(torqueCheck!.rcs_authority_nm),
                xanchor: "right" as const,
                yanchor: "bottom" as const,
                text: "RCS full-duty authority",
                showarrow: false,
                font: { size: 8, color: "#ffd54a" },
              },
            ]
          : [],
      } as PlotLayout,
    }
  }, [tDays, steps, baseLayout, bands, xStart, xEnd, torqueCheck, tickS, FIG6_HEIGHT])

  const cursorProps = { fallbackRangeDays, rangeResetKey: focusKey, playheadDays }

  return (
    <div className="space-y-4">
      {knownModes.length > 0 && (
        <div className="flex flex-wrap gap-3 text-[10px] text-white/50">
          {knownModes.map((mode) => (
            <span key={mode} className="flex items-center gap-1">
              <i className="inline-block h-2 w-2 rounded-sm" style={{ background: colorForMode(mode, knownModes), opacity: 0.6 }} />
              {isManeuverMode(mode) ? maneuverModeLabel(mode) : mode}
            </span>
          ))}
        </div>
      )}
      <p className="text-[9px] italic text-white/35">
        drag on a figure = zoom · wheel = zoom · double-click = reset · slide through time on the bottom bar
        {focusWindow ? ` · focused: ${focusWindow.label}` : ""}
      </p>

      <div>
        <div className={FIG_TITLE}>Fig. 1 — pointing error vs. requirement</div>
        <CursorPlot data={fig1.data} layout={fig1.layout} height={FIG_HEIGHT} {...cursorProps} />
      </div>

      <div>
        <div className={FIG_TITLE}>Fig. 2 — wheel angular momentum per wheel</div>
        <CursorPlot data={fig2.data} layout={fig2.layout} height={FIG_HEIGHT} {...cursorProps} />
      </div>

      <div>
        <div className={FIG_TITLE}>Fig. 3 — propellant used</div>
        <CursorPlot data={fig3.data} layout={fig3.layout} height={FIG_HEIGHT} {...cursorProps} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className={FIG_TITLE.replace("mb-1 ", "")}>Fig. 4 — trajectory-following error</span>
          <button
            className="rounded border border-white/15 px-1.5 py-0.5 text-[9px] font-semibold text-white/60 hover:border-orange-400 hover:text-orange-400"
            onClick={() => setDrLogScale((v) => !v)}
            title="dr spans many orders of magnitude -- log scale shows the small-error structure a linear axis hides"
          >
            {drLogScale ? "log" : "lin"} scale
          </button>
        </div>
        <CursorPlot data={fig4.data} layout={fig4.layout} height={FIG_HEIGHT} {...{ ...cursorProps, rangeResetKey: `${focusKey}:${drLogScale}` }} />
      </div>

      {fig5 && (
        <div>
          <div className={FIG_TITLE}>Fig. 5 — per-wheel motor torque, commanded vs. delivered</div>
          <CursorPlot data={fig5.data} layout={fig5.layout} height={FIG_HEIGHT} {...cursorProps} />
        </div>
      )}

      <div>
        <div className={FIG_TITLE}>Fig. 6 — torque budget: control demand vs. engine disturbance vs. RCS authority</div>
        <CursorPlot data={fig6.data} layout={fig6.layout} height={FIG6_HEIGHT} {...cursorProps} />
        <p className="mt-0.5 text-[9px] italic text-white/35">
          Above the dashed line the allocator's duty-cycle clamp leaves the excess uncancelled — that is the tumble.
          The purple trace is the reaction the RCS must absorb while the allocator dumps all wheel momentum in one
          tick at burn start (runtime effect, invisible to the static card above).
        </p>
      </div>
    </div>
  )
}
