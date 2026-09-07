import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"

import { useDesignStore } from "@/stores/designStore"
import { useMissionStore } from "@/stores/missionStore"
import { useCruiseStore } from "@/stores/cruiseStore"
import { useUiStore } from "@/stores/uiStore"
import { useCruiseStream } from "@/hooks/useCruiseStream"
import {
  buildFullCruiseReference,
  buildFullVisualArc,
  buildPlannedBurns,
  rebasePlannedBurns,
  missionT0S,
  missionDurationS,
  buildCruiseSeed,
  deriveDefaultModes,
  isFrozenOriginOrbit,
} from "@/lib/cruiseSeed"
import { assessPropellantFeasibility } from "@/lib/propellantFeasibility"
import { fetchBodyTrack, holdBodyTrack, sampleCountForDuration, trackPositionAt } from "@/lib/bodyTrackFetch"
import { BurnReport } from "./BurnReport"
import { BurnAuthorityCard } from "./BurnAuthorityCard"
import { analyzeBurnAuthority } from "@/lib/burnAuthority"
import { useVehicleProperties } from "@/hooks/useVehicleProperties"
import { useThrottledValue } from "@/hooks/useThrottledValue"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { interpolateTick, reportedSpacingAt } from "@/lib/cruiseInterp"
import { DEBUG_FLAGS } from "@/lib/debugFlags"
import { AU_M } from "@/components/scene/sceneShared"
import { epochStringToJd } from "@/lib/utils"
import { useGncModesStore } from "@/stores/gncModesStore"
import { CruiseReplayView } from "./CruiseReplayView"
import { AttitudePip } from "./AttitudePip"
import { CruiseTimeline } from "./CruiseTimeline"
import { CruiseFigures, type FigureFocusWindow } from "./CruiseFigures"
import { GncModesEditor } from "./GncModesEditor"

// Review finding E6: 10 s is the control tick backend 13i
// actually validated; 30 s paired badly with the old fixed PD gains
// (gain/tick self-consistency is what backend E1 fixes properly). Costs
// 3x the ticks per run -- acceptable at feasibility grade; expose as an
// advanced control later if runs get too slow.
const DEFAULT_TICK_S = 10

function fmtBodyDistance(m: number): string {
  if (m >= 0.01 * AU_M) return `${(m / AU_M).toFixed(3)} AU`
  if (m >= 1e9) return `${(m / 1e9).toFixed(2)} Gm`
  if (m >= 1e6) return `${(m / 1e6).toFixed(1)} Mm`
  return `${(m / 1e3).toFixed(0)} km`
}

export function CruiseReplayPage() {
  const selectedTrajectory = useDesignStore((s) => s.selectedTrajectory)
  const config = useMissionStore((s) => s.config)
  const setPropulsion = useMissionStore((s) => s.setPropulsion)
  const setActiveTool = useUiStore((s) => s.setActiveTool)
  const backToLanding = useUiStore((s) => s.backToLanding)

  const { start, cancel } = useCruiseStream()
  const connectionState = useCruiseStore((s) => s.connectionState)
  const liveSteps = useCruiseStore((s) => s.steps)
  // Freeze fix: while streaming, the heavy consumers (six
  // Plotly figures, the burn report, the timeline's segment builders, the
  // 3D arc line) see a snapshot refreshed at most once per second instead
  // of re-rendering on every one of the hundreds of ticks/second the
  // stream delivers. Once the run is done the throttle is 0 (pass-through).
  const steps = useThrottledValue(liveSteps, connectionState === "streaming" ? 1000 : 0)
  const result = useCruiseStore((s) => s.result)
  const error = useCruiseStore((s) => s.error)

  const [playheadS, setPlayheadS] = useState(0)
  const [pipSwapped, setPipSwapped] = useState(false)
  // GNC setup auto-collapses once a run exists (see the render below).
  const [setupOpen, setSetupOpen] = useState(true)
  // Real gap: "ensure that this small [attitude] plot uses the
  // same axes and view angle as the Trajectory plot" -- one shared ref,
  // written every frame by whichever CruiseReplayView instance is
  // currently mounted (main slot or the swapped-in corner slot) and read
  // every frame by AttitudePip to mirror it. A plain mutable ref, not React
  // state, since neither side needs a re-render from it.
  const cameraDirRef = useRef(new THREE.Vector3(2.2, 1.6, 2.2).normalize())
  const [buildError, setBuildError] = useState<string | null>(null)
  // Real request ("use the correct ephemerese of the planets"):
  // the viewport used to position departure/target bodies via ONE real
  // fetched state plus a decorative circular-orbit approximation
  // (PerturberBodyFromState -> propagateCircular), which visibly drifts
  // from the truth for a real eccentric orbit over a real mission's
  // playback. Real multi-sample tracks (the SAME fetchBodyTrack(...) call
  // already used to build cruise_seed.body_tracks, reused for rendering
  // too) fixed once per run, rendered via BodyFromTrack's real
  // interpolation instead.
  const [viewportTracks, setViewportTracks] = useState<{
    departure: Awaited<ReturnType<typeof fetchBodyTrack>>
    target: Awaited<ReturnType<typeof fetchBodyTrack>>
  }>({ departure: null, target: null })

  const durationS = useMemo(() => {
    if (steps.length > 0) return steps[steps.length - 1].t_s
    return 0
  }, [steps])

  // Real gap found (
  // or modes... shouldn't there be a page/part where we can define mission
  // constraints, modes, and when the s/c should be doing what?") -- this
  // used to be a read-only preview only; now it's the SEED for the real
  // editable state in gncModesStore (see that store's own header comment
  // for the touched-guard reasoning). deriveDefaultModes silently picking
  // the FIRST StarTracker/OpNavCamera in the hardware array for
  // TargetPointing, with zero visibility into which one or its real aim
  // direction, was the real bug that motivated building this out for real.
  const derivedDefaults = useMemo(() => {
    if (!selectedTrajectory) return null
    let legDurationS: number
    try {
      // D2: derive from the SAME assembly the real run uses (departure
      // parking orbit + transfer + capture orbit, one timeline).
      // missionDurationS is timestamp-only, so no body tracks are needed
      // here -- re-anchoring never changes timing.
      legDurationS = missionDurationS({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
        achievedTofDays: selectedTrajectory.achievedTofDays,
      })
      if (legDurationS <= 0) return null
    } catch {
      return null
    }
    return {
      legDurationS,
      ...deriveDefaultModes({
        hardware: config.spacecraft.hardware,
        targetBodyName: config.target_body.name || null,
        legDurationS,
      }),
    }
  }, [selectedTrajectory, config.spacecraft.hardware, config.target_body.name])

  const gncModes = useGncModesStore()
  useEffect(() => {
    if (derivedDefaults) gncModes.seedIfUntouched(derivedDefaults)
    // gncModes itself is intentionally excluded -- seedIfUntouched's own
    // identity is stable (zustand action), and including the whole store
    // object would re-run this on every store field change, including the
    // ones this effect itself triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedDefaults])

  // Real bug found (: "doesn't work at all") --
  // playheadS was only ever moved by an explicit onSeek (drag the timeline,
  // click a finding). There was no autoplay anywhere: after a run finished
  // streaming, the viewport just sat frozen at t=0 forever unless the user
  // discovered they could drag the scrubber themselves. A compressed
  // real-time playback loop, same idea as OptimizeTrajectoryView's Play
  // button (though without that view's ~40-round-tuned event-aware
  // pacing -- linear here, a reasonable first cut): the whole mission plays
  // out over a fixed wall-clock duration, not 1:1 with simulated seconds
  // (missions run 1e5-1e7 s, which would make real-time playback useless).
  // Now user-selectable from the timeline's transport (UX
  // review) -- 25 s was a fixed constant with no way to slow down for a
  // dense maneuver or speed through a long cruise.
  const [wallclockS, setWallclockS] = useState(25)
  // Real bug found (playback "laggy/stuttery") -- this
  // loop called setPlayheadS on every requestAnimationFrame (~60/sec),
  // which re-renders the ENTIRE page on every tick: three Plotly charts
  // (each a real SVG/canvas rebuild), the timeline, and the findings list,
  // all 60 times a second. Throttled to ~12 React commits/sec (still reads
  // as smooth motion) while the underlying time integration still runs at
  // full rAF rate via a ref, so the actual playhead value stays accurate --
  // only how OFTEN it's flushed into React state changed.
  const COMMIT_INTERVAL_MS = 80
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)
  const lastFrameMsRef = useRef<number | null>(null)
  const lastCommitMsRef = useRef<number | null>(null)
  const playheadRef = useRef(0)

  useEffect(() => {
    if (!playing || durationS <= 0) return
    lastFrameMsRef.current = null
    lastCommitMsRef.current = null
    playheadRef.current = playheadS
    const tick = (nowMs: number) => {
      if (lastFrameMsRef.current == null) lastFrameMsRef.current = nowMs
      if (lastCommitMsRef.current == null) lastCommitMsRef.current = nowMs
      const dtS = (nowMs - lastFrameMsRef.current) / 1000
      lastFrameMsRef.current = nowMs
      const next = playheadRef.current + dtS * (durationS / wallclockS)
      const done = next >= durationS
      playheadRef.current = done ? durationS : next
      if (done || nowMs - lastCommitMsRef.current >= COMMIT_INTERVAL_MS) {
        lastCommitMsRef.current = nowMs
        setPlayheadS(playheadRef.current)
      }
      if (done) {
        setPlaying(false)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
    // playheadS is intentionally read once (into playheadRef) when playback
    // starts via the closure below, not tracked as a dependency -- it's not
    // meant to re-trigger this effect on every tick. wallclockS IS a dep:
    // changing speed mid-play restarts the loop from the current playhead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, durationS, wallclockS])

  // Auto-start playback the moment a run finishes streaming -- "run it and
  // watch the replay" should be the default experience, not something the
  // user has to know to trigger themselves via a hidden control.
  const autoPlayedJobRef = useRef<number | null>(null)
  const jobId = useCruiseStore((s) => s.jobId)
  useEffect(() => {
    if (connectionState === "done" && jobId != null && autoPlayedJobRef.current !== jobId) {
      autoPlayedJobRef.current = jobId
      setPlayheadS(0)
      setPlaying(true)
      setSetupOpen(false)
    }
  }, [connectionState, jobId])

  // Freeze diagnostics (three freeze reports in one session):
  // logs any main-thread task longer than 200 ms with the most recent
  // pointer/wheel target, so the NEXT report can name the exact gesture and
  // component instead of a guess. Console only; no UI.
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return
    let lastGesture = "none"
    const onGesture = (e: Event) => {
      const t = e.target as HTMLElement | null
      lastGesture = `${e.type} on <${t?.tagName?.toLowerCase() ?? "?"}${t?.className ? ` .${String(t.className).split(" ")[0]}` : ""}>`
    }
    window.addEventListener("pointerdown", onGesture, true)
    window.addEventListener("wheel", onGesture, { capture: true, passive: true })
    let observer: PerformanceObserver | null = null
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 200) {
            console.warn(`[replay] long task ${entry.duration.toFixed(0)} ms after ${lastGesture}`)
          }
        }
      })
      observer.observe({ entryTypes: ["longtask"] })
    } catch {
      observer = null
    }
    return () => {
      window.removeEventListener("pointerdown", onGesture, true)
      window.removeEventListener("wheel", onGesture, true)
      observer?.disconnect()
    }
  }, [])

  // Idle-scene bodies (ask: "make the earth 'wait' inside
  // the departure orbit until we click on play, like phase 01 also does").
  // Viewport tracks used to be fetched only inside runReplay -- before the
  // first run, the reference arc (parking orbit included) floated in empty
  // space with no departure body inside it. Fetch the same tracks eagerly
  // for display as soon as an adopted trajectory exists; at playheadS=0 the
  // bodies then sit at their real positions at the mission's rebased t=0
  // (the parking orbit's own epoch). runReplay still does its own fetch
  // (same data, same anchor) for the real cruise_seed, with real error
  // surfacing -- this one is display-only and fails silently.
  useEffect(() => {
    if (!selectedTrajectory || !derivedDefaults || viewportTracks.departure) return
    let cancelled = false
    ;(async () => {
      try {
        const depJd = selectedTrajectory.depJd ?? epochStringToJd(config.trajectory.departure_epoch ?? "")
        if (!Number.isFinite(depJd)) return
        const t0S = missionT0S({
          arc: selectedTrajectory.arc,
          preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
          postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
          achievedTofDays: selectedTrajectory.achievedTofDays,
        })
        const effectiveDepJd = depJd + t0S / 86_400
        const durationS = derivedDefaults.legDurationS
        const sampleCount = sampleCountForDuration(durationS)
        const targetName = config.target_body.name || null
        const departureRaw = await fetchBodyTrack(config.trajectory.departure_body, effectiveDepJd, durationS, sampleCount, true)
        const targetRaw = targetName
          ? await fetchBodyTrack(targetName, effectiveDepJd, durationS, sampleCount, false)
          : null
        // Hold the bodies at the frozen orbit-arc epochs (the
        // Phase-01-style convention -- see holdBodyTrack's header): Earth
        // waits at its injection-epoch position through the parking phase;
        // the target waits at its capture-epoch position through the
        // captured phase.
        const injectionS =
          selectedTrajectory.preDepartureOrbitArc?.length &&
          selectedTrajectory.arc[0] &&
          isFrozenOriginOrbit(selectedTrajectory.preDepartureOrbitArc)
            ? selectedTrajectory.arc[0].t_s - t0S
            : null
        const captureS =
          selectedTrajectory.postCaptureOrbitArc?.length &&
          selectedTrajectory.achievedTofDays != null &&
          isFrozenOriginOrbit(selectedTrajectory.postCaptureOrbitArc)
            ? selectedTrajectory.achievedTofDays * 86_400 - t0S
            : null
        const departure = departureRaw ? holdBodyTrack(departureRaw, { holdBeforeS: injectionS }) : null
        const target = targetRaw ? holdBodyTrack(targetRaw, { holdAfterS: captureS }) : null
        if (!cancelled) setViewportTracks({ departure, target })
      } catch {
        // Display-only convenience; runReplay remains the authoritative path.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    selectedTrajectory,
    derivedDefaults,
    viewportTracks.departure,
    config.trajectory.departure_body,
    config.trajectory.departure_epoch,
    config.target_body.name,
  ])

  // The full visual reference line (departure parking orbit + transfer +
  // arrival/capture orbit) -- see buildFullVisualArc's own header for why
  // this can afford to include the pre-departure segment when
  // buildFullCruiseReference (the REAL backend-facing seed, above) can't.
  const visualReferenceArc = useMemo(() => {
    if (!selectedTrajectory) return undefined
    // Served orbit pieces exactly as-is (the re-anchoring experiment was
    // rejected same-day -- see cruiseSeed.ts's FROZEN-ORIGIN NOTE); the
    // departure/target body tracks are HELD at the frozen epochs instead
    // (holdBodyTrack, applied where the tracks are fetched below).
    // t_s REBASED onto the mission clock (t=0 at the assembled
    // arc's first point -- the same timeline playheadS, steps and the
    // fetched body tracks already share), so the view can look up a body's
    // real track position at any reference point's own epoch for the
    // parking/capture display re-anchoring (see CruiseReplayView's
    // "riding ring" comment; user-approved Phase 01 equivalent).
    const params = {
      arc: selectedTrajectory.arc,
      preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
      postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
      achievedTofDays: selectedTrajectory.achievedTofDays,
    }
    const t0S = missionT0S(params)
    return buildFullVisualArc(params).map((p) => ({ ...p, t_s: p.t_s - t0S }))
  }, [selectedTrajectory])
  // How many leading/trailing points of visualReferenceArc are the
  // parking-orbit / capture-orbit segments (mirrors assembleFullArc's own
  // concatenation) -- lets the view re-anchor exactly those segments.
  const referencePreCount =
    selectedTrajectory?.preDepartureOrbitArc?.length && selectedTrajectory.arc.length > 0
      ? selectedTrajectory.preDepartureOrbitArc.length
      : 0
  const referencePostCount =
    selectedTrajectory?.postCaptureOrbitArc?.length && selectedTrajectory.achievedTofDays != null
      ? selectedTrajectory.postCaptureOrbitArc.length
      : 0

  // Honest-UI guard (stale adoptions produced no visible
  // changes in the viewport after fixes landed
  //): every recent Phase 03 fix silently falls back when the
  // adopted trajectory predates the fields it needs -- which is exactly
  // what a stale persisted adoption (or one made from the old pre-baked
  // Mercury snapshot, whose data also lacks the newer fields) does. Never
  // degrade silently again: enumerate precisely what's missing and say so
  // in a banner the user cannot miss.
  const adoptionGaps = useMemo(() => {
    const t = selectedTrajectory
    if (!t) return []
    const gaps: string[] = []
    if (t.kind !== "optimizer") {
      return [
        `this is a "${t.kind}" adoption, which carries no burn/orbit data -- Phase 03 needs a real optimizer result`,
      ]
    }
    if (t.depJd == null) gaps.push("the optimizer's real departure date (dep_jd) -- departure body will be drawn at the wrong position")
    if (!t.preDepartureOrbitArc || t.preDepartureOrbitArc.length === 0)
      gaps.push("the departure parking orbit (pre_departure_orbit_arc) -- mission cannot start in Earth orbit")
    if (t.arc[0]?.vx_mps == null)
      gaps.push("real per-point velocities (vx/vy/vz_mps) -- reference velocity will be approximated, and no departure burn can be derived")
    const expectsCapture = config.mission.objective === "Orbit" || config.mission.objective === "Landing"
    if (expectsCapture && (t.captureTimeS == null || t.captureDvInertialMps == null))
      gaps.push("the capture burn vector (capture_dv_inertial_mps) -- no arrival burn will fire")
    return gaps
  }, [selectedTrajectory, config.mission.objective])

  // Burn location markers on the reference line, same visual language as
  // Phase 01's OptimizeTrajectoryView (direct user ask: "I also
  // miss the burn location marker that we have in phase 01"). Positions are
  // the reference arc's own point nearest each planned burn's raw epoch --
  // burn epochs and visual-arc t_s are both on the arc's raw timescale, so
  // no rebase is needed here.
  const burnMarkers = useMemo(() => {
    if (!selectedTrajectory || !visualReferenceArc || visualReferenceArc.length === 0) return []
    const raw = rebasePlannedBurns(
      buildPlannedBurns({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        captureTimeS: selectedTrajectory.captureTimeS,
        captureDvInertialMps: selectedTrajectory.captureDvInertialMps,
      }),
      // visualReferenceArc's t_s is rebased onto the mission clock now
      // -- rebase the raw burn epochs the same way before
      // nearest-point matching, or every match would be off by t0S.
      missionT0S({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
        achievedTofDays: selectedTrajectory.achievedTofDays,
      }),
    )
    const planned = raw.map((b) => {
      let best = visualReferenceArc[0]
      for (const p of visualReferenceArc) {
        if (Math.abs(p.t_s - b.epoch_s) < Math.abs(best.t_s - b.epoch_s)) best = p
      }
      const [dx, dy, dz] = b.dv_inertial_mps
      return {
        label: (b.label ?? "").toLowerCase().startsWith("departure") ? "Departure burn" : "Capture burn",
        dvMs: Math.hypot(dx, dy, dz),
        x_m: best.x_m,
        y_m: best.y_m,
        z_m: best.z_m,
        // Epoch on the rebased mission clock -- the view needs it to express
        // the marker in whichever reference frame is active.
        t_s: best.t_s,
      }
    })
    // ACTUAL burn locations (ask: "the burn location marker
    // is only set on the reference trajectory... it may be interesting to
    // see the real one and compare"): the flown truth's own position at
    // each report's real ignition epoch (planned_burn_reports times are
    // already on the same rebased sim clock as steps). ΔV shown is the
    // matching planned burn's magnitude -- the report carries no delivered
    // ΔV (a backend extension would add it).
    const actual = (result?.planned_burn_reports ?? []).flatMap((rep) => {
      if (rep.ignition_s == null || steps.length === 0) return []
      const ig = rep.ignition_s
      let bestS = steps[0]
      for (const s of steps) if (Math.abs(s.t_s - ig) < Math.abs(bestS.t_s - ig)) bestS = s
      const isDep = rep.label.toLowerCase().startsWith("departure")
      const twin = planned.find((p) => (isDep ? p.label.startsWith("Departure") : p.label.startsWith("Capture")))
      return [
        {
          label: isDep ? "Departure burn (actual)" : "Capture burn (actual)",
          dvMs: twin?.dvMs ?? 0,
          x_m: bestS.r_m[0],
          y_m: bestS.r_m[1],
          z_m: bestS.r_m[2],
          t_s: ig,
        },
      ]
    })
    return [...planned, ...actual]
  }, [selectedTrajectory, visualReferenceArc, result, steps])

  const currentTick = useMemo(() => {
    if (steps.length === 0) return null
    let lo = 0
    let hi = steps.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (steps[mid].t_s < playheadS) lo = mid + 1
      else hi = mid
    }
    return steps[lo]
  }, [steps, playheadS])
  // Display-only smoothing between reported samples (see lib/cruiseInterp.ts
  // -- the stream is decimated, so attitude/position would otherwise jump
  // by minutes). Drives the viewport vehicle and the attitude view; the
  // stat strip and figures keep the real nearest sample.
  const displayTick = useMemo(() => interpolateTick(steps, playheadS), [steps, playheadS])
  const sampleSpacingS = useMemo(() => reportedSpacingAt(steps, playheadS), [steps, playheadS])

  // Manually seeking (drag the timeline, click a finding) should pause
  // autoplay -- otherwise the playback loop fights the user's own scrub a
  // frame later.
  const seekAndPause = useCallback((t_s: number) => {
    setPlaying(false)
    setPlayheadS(t_s)
  }, [])

  // Phase-focus (ask: "during the first manoeuvre phase,
  // i'd like to see all the figures on the left focused on that phase"):
  // picking a mode segment in CruiseFigures zooms every figure to that
  // window AND seeks the replay to its start, so the viewport/attitude pip
  // show the same moment -- swap the pip to the main slot from there to
  // inspect the attitude at full size.
  const [figureFocus, setFigureFocus] = useState<FigureFocusWindow | null>(null)
  // Freeze fix #2:
  // a wheel gesture on the timeline emits dozens of focus changes per
  // second, and each one re-lays-out all six figures. The timeline itself
  // follows the wheel live (cheap DOM); the figures follow only once the
  // gesture has settled.
  const figureFocusSettled = useDebouncedValue(figureFocus, 300)
  const handleFigureFocus = useCallback(
    (w: FigureFocusWindow | null) => {
      setFigureFocus(w)
      if (w?.seekToStart) seekAndPause(w.startS)
    },
    [seekAndPause],
  )

  const handlePlayPause = useCallback(() => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (playheadRef.current >= durationS || playheadS >= durationS) setPlayheadS(0)
    setPlaying(true)
  }, [playing, durationS, playheadS])

  // E5 frontend half: static burn-attitude authority from the real derived
  // CoM (same /api/design/vehicle loop Phase 02 uses) and the placed RCS.
  const { vehicle, isPending: vehiclePending } = useVehicleProperties()
  const burnAuthority = useMemo(
    () =>
      vehicle
        ? analyzeBurnAuthority({
            hardware: config.spacecraft.hardware,
            busDimsM: config.spacecraft.bus_dims_m,
            comM: vehicle.com_m,
            propulsion: config.spacecraft.propulsion,
          })
        : null,
    [vehicle, config.spacecraft.hardware, config.spacecraft.bus_dims_m, config.spacecraft.propulsion],
  )

  // Propellant feasibility of the adopted design (the real
  // issue behind "not properly controlled": a capture needing 18 km/s on a
  // 481 m/s tank). See lib/propellantFeasibility.ts.
  const propellantFeasibility = useMemo(
    () =>
      selectedTrajectory
        ? assessPropellantFeasibility({
            trajectory: selectedTrajectory,
            wetMassKg: config.spacecraft.mass_kg,
            propellantMassKg: config.spacecraft.propellant_mass_kg,
            ispS: config.spacecraft.propulsion?.isp_s,
          })
        : null,
    [selectedTrajectory, config.spacecraft.mass_kg, config.spacecraft.propellant_mass_kg, config.spacecraft.propulsion],
  )
  // A finished run whose tank hit zero before every planned burn completed
  // is an INFEASIBLE-DESIGN run, not a control failure -- label it as such
  // (backend message).
  const infeasibleRun = useMemo(() => {
    if (!result) return null
    const reports = result.planned_burn_reports ?? []
    const unfinished = reports.filter((r) => !r.status.startsWith("Completed"))
    if (result.final_propellant_remaining_kg <= 0.01 && unfinished.length > 0) {
      return `tank empty (${result.final_propellant_remaining_kg.toFixed(2)} kg left) before ${unfinished.map((r) => r.label).join(", ")} could complete`
    }
    return null
  }, [result])

  // Rebased planned burns for the burn report card -- the same values
  // runReplay sends, recomputed here so the card renders without a run
  // config in scope.
  const plannedBurnsView = useMemo(() => {
    if (!selectedTrajectory) return []
    try {
      const raw = buildPlannedBurns({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        captureTimeS: selectedTrajectory.captureTimeS,
        captureDvInertialMps: selectedTrajectory.captureDvInertialMps,
        departureDvInertialMps: selectedTrajectory.departureDvInertialMps,
        captureBodyName: config.target_body.name || null,
        departureDvPool: selectedTrajectory.departureDvPool,
        launcherDvMs: selectedTrajectory.dvLedger?.launcher_dv_ms,
        onboardDepartureDvMs: selectedTrajectory.dvLedger?.onboard_departure_dv_ms,
        launchVehicleFeasible: selectedTrajectory.launchVehicleFeasible,
      })
      const t0S = missionT0S({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
        achievedTofDays: selectedTrajectory.achievedTofDays,
      })
      return rebasePlannedBurns(raw, t0S)
    } catch {
      return []
    }
  }, [selectedTrajectory])

  // Pre-run, park the playhead at the INJECTION epoch, not t=0 (
  //
  // trajectory"): the mission clock starts at the top of the ~3 h parking
  // coast, so at t=0 Earth sits ~320,000 km short of where the heliocentric
  // transfer line and its departure-burn marker begin -- physically true,
  // but the static pre-run scene read as disconnected. At the injection
  // epoch Earth (with its riding parking ring) sits exactly at the
  // trajectory's start. Runs once per adoption, never during/after a run
  // (playback still animates from t=0 through the real coast).
  const preRunPlayheadInitRef = useRef<string | null>(null)
  useEffect(() => {
    if (steps.length > 0 || plannedBurnsView.length === 0) return
    const key = `${plannedBurnsView[0].epoch_s}`
    if (preRunPlayheadInitRef.current === key) return
    preRunPlayheadInitRef.current = key
    setPlayheadS(Math.max(0, plannedBurnsView[0].epoch_s))
  }, [steps.length, plannedBurnsView])

  // Distance from the s/c to the departure/target body at the playhead
  // (UX review: "the missing number when inspecting departure
  // and capture") -- real tick position vs. the same held ephemeris tracks
  // the viewport renders.
  const bodyDistances = useMemo(() => {
    if (!currentTick) return null
    const dist = (track: typeof viewportTracks.departure): number | null => {
      if (!track) return null
      const p = trackPositionAt(track, currentTick.t_s)
      return Math.hypot(currentTick.r_m[0] - p[0], currentTick.r_m[1] - p[1], currentTick.r_m[2] - p[2])
    }
    return { departure: dist(viewportTracks.departure), target: dist(viewportTracks.target) }
  }, [currentTick, viewportTracks])

  // The rebased-t0 epoch (JD) for the timeline's UTC readout -- same
  // computation runReplay/the eager track fetch use.
  const effectiveDepJd = useMemo(() => {
    if (!selectedTrajectory) return null
    const depJd = selectedTrajectory.depJd ?? epochStringToJd(config.trajectory.departure_epoch ?? "")
    if (!Number.isFinite(depJd)) return null
    try {
      const t0S = missionT0S({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
        achievedTofDays: selectedTrajectory.achievedTofDays,
      })
      return depJd + t0S / 86_400
    } catch {
      return depJd
    }
  }, [selectedTrajectory, config.trajectory.departure_epoch])

  const runReplay = useCallback(async () => {
    setBuildError(null)
    if (!selectedTrajectory) {
      setBuildError("No adopted trajectory -- go back to Phase 01 and adopt a result first.")
      return
    }
    try {
      const targetName = config.target_body.name || null
      // Real bug found: GA/PSO search a departure WINDOW and can
      // depart on a different day than the mission config's nominal
      // `trajectory.departure_epoch` -- `selectedTrajectory.depJd` (the
      // adopted result's own real `dep_jd`) is authoritative, matching
      // OptimizeTrajectoryView.tsx's own convention. Falls back to the
      // nominal config value only for a trajectory adopted before this
      // field existed (stale cached `SelectedTrajectory`).
      const depJd = selectedTrajectory.depJd ?? epochStringToJd(config.trajectory.departure_epoch ?? "")

      // D1: raw (unrebased, on arc's own t_s scale) planned burns first --
      // needed to mark burn discontinuities while building the reference
      // below, and to derive the real mission t0 (missionT0S), before being
      // rebased for what's actually sent to the backend. D3: now includes
      // an interim departure burn too, not just arrival/capture -- see
      // buildPlannedBurns's own header.
      const rawPlannedBurns = buildPlannedBurns({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        captureTimeS: selectedTrajectory.captureTimeS,
        captureDvInertialMps: selectedTrajectory.captureDvInertialMps,
        departureDvInertialMps: selectedTrajectory.departureDvInertialMps,
        captureBodyName: config.target_body.name || null,
        departureDvPool: selectedTrajectory.departureDvPool,
        launcherDvMs: selectedTrajectory.dvLedger?.launcher_dv_ms,
        onboardDepartureDvMs: selectedTrajectory.dvLedger?.onboard_departure_dv_ms,
        launchVehicleFeasible: selectedTrajectory.launchVehicleFeasible,
      })

      // The mission's real t=0 on the arc's raw timescale -- reference[0]'s
      // own epoch (pre_departure_orbit_arc[0] when D3's parking-orbit
      // prepend applies, arc[0] otherwise). Every timeline the backend sees
      // is rebased onto this ONE value.
      const t0S = missionT0S({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
        achievedTofDays: selectedTrajectory.achievedTofDays,
      })
      // Real bug, same class as OptimizeTrajectoryView.tsx's `arcT0S`/
      // `effectiveDepartureEpoch` (fixed there): the reference's
      // t_s=0 no longer sits at `depJd` -- it's `depJd + t0S / 86_400`
      // (t0S is typically NEGATIVE: the parking orbit + escape leg precede
      // the nominal departure epoch). Body tracks are sampled from t_s=0 on
      // the REBASED timeline, so they must anchor on this corrected epoch
      // -- anchoring on raw `depJd` (or, the residual bug fixed:
      // on `arc[0].t_s` while the reference actually starts at the earlier
      // parking-orbit point) puts Earth days/hours away from where the
      // spacecraft actually departs.
      const effectiveDepJd = depJd + t0S / 86_400

      // Duration first (timestamp-only, needs no tracks) -- the body-track
      // fetches below need it, and the re-anchored reference
      // needs those very tracks, so the old reference-then-fetch order had
      // to flip.
      const durationSeed = missionDurationS({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
        achievedTofDays: selectedTrajectory.achievedTofDays,
      })

      // D1: rebase every planned burn onto the SAME timeline `reference`
      // itself is already rebased onto (t=0 at reference[0] -- the parking
      // orbit's own first point once D3 applies). This is the fix for the
      // confirmed bug where the capture burn fired `|arc[0].t_s|` early,
      // in deep space, because it was sent on the wrong timeline.
      const plannedBurns = rebasePlannedBurns(rawPlannedBurns, t0S)

      // B1: sample density scaled to mission duration (>= 1/day) instead of
      // a fixed 8 -- the backend interpolates body tracks LINEARLY, so a
      // sparse track put a fast-moving body (e.g. Mercury, 88-day period)
      // tens of millions of km from its real position for most of a
      // multi-month mission (wrong gravity, wrong SOI-capture trigger,
      // wrong TargetPointing direction, wrong rendered planet position).
      const sampleCount = sampleCountForDuration(durationSeed)

      // A1: the departure body is now a real soi_capture:true body_track --
      // the s/c STARTS inside its SOI (the parking orbit, D3), so it must
      // be a central-body candidate for the truth propagator, not merely a
      // perturber/pointing source. Before this fix, body_tracks carried
      // ONLY the target -- the truth flew the first hours/days of the
      // mission under Sun-only gravity (~4 orders of magnitude too weak
      // near Earth) while the reference it had to track was propagated
      // under Earth-dominated dynamics, diverging by thousands of km
      // within hours and driving the TCM executive to chase a trajectory
      // it could never physically follow.
      const expectsCapture = config.mission.objective === "Orbit" || config.mission.objective === "Landing"
      const departureBodyName = config.trajectory.departure_body
      const targetTrackRaw = targetName
        ? await fetchBodyTrack(targetName, effectiveDepJd, durationSeed, sampleCount, expectsCapture)
        : null
      const departureTrackRaw = await fetchBodyTrack(departureBodyName, effectiveDepJd, durationSeed, sampleCount, true)
      // Same hold as the eager display fetch (holdBodyTrack's header), and
      // ONLY for a served orbit piece detected as frozen-origin. REAL BUG,
      // found from the captured request body of the Mars run:
      // this site held Earth unconditionally, so with the backend's new
      // time-resolved parking orbit the sim's Earth was parked at the
      // injection position, 326,000 km from r0 -- the truth felt no Earth
      // gravity, flew off at parking-orbit speed from tick 0, and the
      // launcher ΔV then sent it to 7.5 AU. The eager display path already
      // had the isFrozenOriginOrbit gate; this one had been missed.
      const injectionS =
        selectedTrajectory.preDepartureOrbitArc?.length &&
        selectedTrajectory.arc[0] &&
        isFrozenOriginOrbit(selectedTrajectory.preDepartureOrbitArc)
          ? selectedTrajectory.arc[0].t_s - t0S
          : null
      const captureS =
        selectedTrajectory.postCaptureOrbitArc?.length &&
        selectedTrajectory.achievedTofDays != null &&
        isFrozenOriginOrbit(selectedTrajectory.postCaptureOrbitArc)
          ? selectedTrajectory.achievedTofDays * 86_400 - t0S
          : null
      const departureTrack = departureTrackRaw ? holdBodyTrack(departureTrackRaw, { holdBeforeS: injectionS }) : null
      const targetTrack = targetTrackRaw ? holdBodyTrack(targetTrackRaw, { holdAfterS: captureS }) : null
      setViewportTracks({ departure: departureTrack, target: targetTrack })

      // A2: carry Phase 01's full perturber list too, so Phase 03's force
      // model matches (or exceeds) what Phase 01 actually used to compute
      // the trajectory being replayed (the design notes standing requirement
      // #3) -- not just the departure/target bodies.
      const perturberNames = Array.from(
        new Set(
          (config.optimization?.force_model.bodies ?? [])
            .map((b) => b.name)
            // "Sun" is the heliocentric origin -- never a body_track (the
            // server 422s it by design). Found via the
            // instrumented repro: ~130 rejected /api/bodies/Sun/state
            // requests per run, one per track sample.
            .filter((name): name is string => !!name && name !== "Sun" && name !== departureBodyName && name !== targetName),
        ),
      )
      const perturberTracks = await Promise.all(
        perturberNames.map((name) => fetchBodyTrack(name, effectiveDepJd, durationSeed, sampleCount, false)),
      )
      // fetchBodyTrack swallows every failed /api/bodies/{name}/state call
      // and returns null once fewer than 2 samples survive. Found 
      // from a captured request body: the backend restarted mid-assembly,
      // every fetch failed, and the run was sent with an EMPTY body_tracks
      // -- rejected by check_config with an opaque "Body('Mars') has no
      // matching cruise_seed.body_tracks entry" (or a proxy 502). A missing
      // track is never acceptable here: without the departure/target track
      // the truth has no SOI gravity, and a dropped perturber silently
      // breaks the force-model parity requirement (#3). Refuse with the
      // real reason instead, same idiom as the seed invariant below.
      const missingTracks = [
        departureTrack ? null : departureBodyName,
        targetName && !targetTrack ? targetName : null,
        ...perturberNames.filter((_, i) => perturberTracks[i] == null),
      ].filter((n): n is string => n != null)
      if (missingTracks.length > 0) {
        throw new Error(
          `Refusing to run: could not fetch the ephemeris track for ${missingTracks.join(", ")} ` +
            `(/api/bodies/{name}/state failed for every sample) — is the backend up? ` +
            `A run without these body tracks would fly with the wrong gravity and force model.`,
        )
      }
      // Backend B2: a body track with an EMPTY `track` and an
      // `epoch_jd` is resolved server-side from ANISE at 4 samples/day --
      // denser than this client's 1/day fetch and owned by the side that
      // has the kernels (the backend's message asked for exactly
      // this). Used for the SIM's tracks whenever no hold is needed (i.e.
      // the adopted arcs are time-resolved); the client-fetched tracks
      // above stay for rendering and for the seed invariant below. A held
      // (frozen-origin, stale-adoption) track must stay client-supplied,
      // since the hold IS the data.
      const serverResolved = (t: NonNullable<typeof departureTrack>, held: boolean) =>
        held ? t : { name: t.name, soi_capture: t.soi_capture, epoch_jd: effectiveDepJd, track: [] }
      const bodyTracks = [
        departureTrack ? serverResolved(departureTrack, injectionS != null) : null,
        targetTrack ? serverResolved(targetTrack, captureS != null) : null,
        ...perturberTracks.map((t) => (t ? serverResolved(t, false) : null)),
      ].filter((t): t is NonNullable<typeof t> => t != null)

      // D3: the real transfer arc (clamped to the achieved encounter), PLUS
      // the real parking orbit before departure, PLUS the real post-capture
      // orbit -- all exactly as served (the frozen-origin geometry is
      // reconciled by HOLDING the body tracks above, not by modifying the
      // served trajectory data; see cruiseSeed.ts's FROZEN-ORIGIN NOTE).
      const reference = buildFullCruiseReference({
        arc: selectedTrajectory.arc,
        preDepartureOrbitArc: selectedTrajectory.preDepartureOrbitArc,
        postCaptureOrbitArc: selectedTrajectory.postCaptureOrbitArc,
        achievedTofDays: selectedTrajectory.achievedTofDays,
        burnEpochsS: rawPlannedBurns.map((b) => b.epoch_s),
      })

      // SEED INVARIANT (after the Mars run flew off at tick 0):
      // a body registered as an SOI-capture central body must actually BE
      // where the reference says the spacecraft orbits it. Whatever the
      // cause (a stale frozen-origin arc, a wrong epoch anchor, a wrong
      // hold), this is the one geometric symptom every such bug shares --
      // so check it once, here, and refuse to run rather than fly a
      // physically meaningless mission. Departure: at t=0 the parking orbit
      // radius is a few thousand km; target: at the capture epoch the
      // reference must be inside the target's SOI (Mars ~577,000 km; the
      // 2e6 km bound is generous for every catalog body).
      const inv: string[] = []
      if (departureTrack && selectedTrajectory.preDepartureOrbitArc?.length) {
        const e0 = trackPositionAt(departureTrack, 0)
        const r0 = reference[0].r_m
        const d = Math.hypot(r0[0] - e0[0], r0[1] - e0[1], r0[2] - e0[2])
        if (d > 1e8) inv.push(`${departureBodyName} is ${(d / 1e3).toFixed(0)} km from the spacecraft at t=0 (a parking orbit is a few thousand km)`)
      }
      const captureEpochS = plannedBurns.find((b) => b.capture_body)?.epoch_s
      if (targetTrack && targetName && captureEpochS != null) {
        const tp = trackPositionAt(targetTrack, captureEpochS)
        let ref = reference[0]
        for (const p of reference) if (Math.abs(p.t_s - captureEpochS) < Math.abs(ref.t_s - captureEpochS)) ref = p
        const d = Math.hypot(ref.r_m[0] - tp[0], ref.r_m[1] - tp[1], ref.r_m[2] - tp[2])
        if (d > 2e9) inv.push(`${targetName} is ${(d / 1e6).toFixed(0)} Mm from the reference at the capture epoch (must be inside its SOI)`)
      }
      if (inv.length > 0) {
        throw new Error(
          `Refusing to run: the cruise seed is geometrically inconsistent — ${inv.join("; ")}. ` +
            `This means the body tracks and the adopted trajectory disagree (stale adoption? re-adopt from a fresh Phase 01 run) — a run would be physically meaningless.`,
        )
      }

      const cruiseSeed = buildCruiseSeed({
        reference,
        durationS: durationSeed,
        tickS: DEFAULT_TICK_S,
        modes: gncModes.modes,
        modeSchedule: gncModes.schedule,
        safeMode: gncModes.safeMode,
        tcmThresholdM: gncModes.tcmThresholdM,
        bodyTracks,
        plannedBurns,
      })

      await start({
        ...config,
        cruise_seed: cruiseSeed,
        // 0, not 1: per useCruiseStream's own branching contract, cruise_seed
        // + monte_carlo_runs > 0 is the (unbuilt, "03 layer 2") cruise MC
        // path, which streams CruiseMcRunMsg (a per-run summary with no
        // r_m/q/etc.) instead of CruiseStepMsg per tick -- a real bug found
        // sending 1 here crashed CruiseReplayView reading
        // tick.r_m on an object that doesn't have that field at all.
        simulation: { ...config.simulation, monte_carlo_runs: 0 },
      })
      setPlayheadS(0)
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Failed to build cruise seed")
    }
  }, [selectedTrajectory, config, start, gncModes])

  return (
    // UX review: the timeline is the page's MASTER time control,
    // so it spans the full page width at the bottom (video-editor/flight-
    // data-review convention) with both columns above slaved to it --
    // instead of living inside the right column only.
    <div className="flex h-screen w-full flex-col">
      <div className="flex min-h-0 flex-1">
      <div className="w-[58vw] min-w-[720px] overflow-y-auto border-r border-border bg-background p-6">
        {/* Real bug found: "can't go back to the gnc
            design page once I'm on the mission validation page" -- this
            page had NO navigation controls at all, unlike every other
            phase's paper (VehiclePaper's "← 01 Trajectory" rail, "back to
            the sky" link). A genuine dead end. */}
        <div className="mb-3 flex items-center gap-4 border-b border-border pb-2 text-[10px] font-bold tracking-wider text-muted-foreground uppercase">
          <button type="button" onClick={() => setActiveTool("study")} className="hover:text-orange-500">
            ← 02 Vehicle &amp; GNC design
          </button>
          <button type="button" onClick={backToLanding} className="ml-auto hover:text-orange-500">
            back to the sky
          </button>
        </div>
        <div className="mb-4">
          <h1 className="text-sm font-bold uppercase tracking-wider">
            03 <span className="text-orange-500">Mission validation — closed-loop replay</span>
          </h1>
          <p className="mt-2 max-w-prose text-sm italic text-muted-foreground">
            Flies the built vehicle and GNC design against the real Layer-1 reference trajectory, tick by tick.
            Feasibility-grade (a few minutes per run), not flight-software-exact.
          </p>
        </div>

        {/* Configure/results lifecycle (UX review): once a run
            exists, configuration is context, not the task -- the editor
            collapses behind this header so results lead the column. */}
        <div className="mb-4">
          <button
            type="button"
            className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-orange-500"
            onClick={() => setSetupOpen((v) => !v)}
          >
            {setupOpen ? "▾" : "▸"} GNC setup{!setupOpen ? " — collapsed after run, click to edit" : ""}
          </button>
          {setupOpen && (
            <GncModesEditor
              hardware={config.spacecraft.hardware}
              targetBodyName={config.target_body.name || null}
              legDurationS={derivedDefaults?.legDurationS ?? null}
              modes={gncModes.modes}
              schedule={gncModes.schedule}
              safeMode={gncModes.safeMode}
              tcmThresholdM={gncModes.tcmThresholdM}
              propulsion={config.spacecraft.propulsion}
              onModesChange={gncModes.setModes}
              onScheduleChange={gncModes.setSchedule}
              onSafeModeChange={gncModes.setSafeMode}
              onTcmThresholdChange={gncModes.setTcmThresholdM}
              onPropulsionChange={setPropulsion}
              onResetToAuto={() => derivedDefaults && gncModes.resetToAuto(derivedDefaults)}
            />
          )}
        </div>

        {adoptionGaps.length > 0 && (
          <div className="mb-4 rounded border border-amber-600 bg-amber-950/40 px-3 py-2.5 text-xs text-amber-200">
            <p className="font-bold text-amber-400">Adopted trajectory is missing data this page needs:</p>
            <ul className="mt-1 list-disc pl-4">
              {adoptionGaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
            <p className="mt-1.5">
              It was adopted with an older version of the app (or from an outdated preset snapshot). Go back to
              Phase 01, run the optimization again, and click <b>Adopt</b> on the fresh result — until then this
              replay silently falls back to the old, degraded behavior.
            </p>
          </div>
        )}

        {propellantFeasibility && !propellantFeasibility.feasible && (
          <div className="mb-4 rounded border border-red-700 bg-red-950/40 px-3 py-2.5 text-[11px] text-red-200">
            <p className="font-bold text-red-300">
              Infeasible design: the tank holds {propellantFeasibility.availableMps.toFixed(0)} m/s, the mission needs{" "}
              {propellantFeasibility.requiredMps.toFixed(0)} m/s onboard ({propellantFeasibility.ratio.toFixed(1)}× short).
            </p>
            <p className="mt-1 opacity-90">
              Onboard ΔV = {propellantFeasibility.departureByLauncher ? "launcher covers departure · " : `departure ${propellantFeasibility.onboardDepartureMps.toFixed(0)} m/s + `}
              {propellantFeasibility.dsmMps > 0 ? `DSMs ${propellantFeasibility.dsmMps.toFixed(0)} m/s + ` : ""}
              arrival/capture {propellantFeasibility.arrivalMps.toFixed(0)} m/s; available = Isp·g₀·ln(m_wet/m_dry). A chemical
              spacecraft cannot fly this trajectory — it needs an MGA (flyby-chain) design or low thrust in Phase 01. The
              run below will fly until the tank is empty and is labelled accordingly.
            </p>
          </div>
        )}
        {infeasibleRun && (
          <div className="mb-4 rounded border border-amber-700 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-200">
            <b>Infeasible-design run</b> — {infeasibleRun}. Not a control failure: the GNC held attitude and tracked
            the reference until the propellant ran out.
          </div>
        )}
        <BurnAuthorityCard
          check={vehicle?.main_engine_torque_check}
          mirror={burnAuthority}
          comPending={vehiclePending}
          hardware={config.spacecraft.hardware}
          tickS={DEFAULT_TICK_S}
        />

        {result && ((result.warnings?.length ?? 0) > 0 || result.reference_interpolation_floor_m != null) && (
          <div className="mb-4 rounded border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200">
            {result.reference_interpolation_floor_m != null && (
              <p>
                Reference interpolation floor: {(result.reference_interpolation_floor_m / 1e3).toFixed(1)} km — dispersion below
                this is interpolation noise, not physics (backend C2).
              </p>
            )}
            {result.warnings?.map((w) => (
              <p key={w}>⚠ {w}</p>
            ))}
          </div>
        )}

        <div className="mb-6 flex items-center gap-3">
          <button
            className="rounded bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50"
            onClick={runReplay}
            disabled={connectionState === "starting" || connectionState === "streaming"}
          >
            {connectionState === "streaming" ? "Streaming…" : "Run mission validation"}
          </button>
          {(connectionState === "starting" || connectionState === "streaming") && (
            <button className="text-xs text-muted-foreground underline" onClick={cancel}>
              Stop
            </button>
          )}
          {connectionState === "streaming" && <span className="text-xs text-muted-foreground">{liveSteps.length} ticks received</span>}
        </div>

        {(buildError || error) && <p className="mb-4 text-xs text-red-500">{buildError ?? error}</p>}

        {steps.length > 0 && (
          <CruiseFigures
            steps={steps}
            schedule={gncModes.schedule}
            playheadS={playheadS}
            hardware={config.spacecraft.hardware}
            focusWindow={figureFocusSettled}
            torqueCheck={vehicle?.main_engine_torque_check ?? null}
            tickS={DEFAULT_TICK_S}
          />
        )}
        {steps.length > 0 && (
          <BurnReport
            plannedBurns={plannedBurnsView}
            steps={steps}
            reports={result?.planned_burn_reports ?? []}
            onSeek={seekAndPause}
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 bg-[#04060c] p-4">
        {/* Play/Pause moved into CruiseTimeline's transport row (
            UX review): one place to read and control mission time, instead
            of a play button in this corner and the scrubber two panels
            down. The live stat readout below replaces it here. */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-white">Trajectory · replay</span>
          {currentTick && (
            <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-white/70">
              <span className="text-white/45">{currentTick.active_mode ?? "fixed hold"}</span>
              <span title="pointing error">err {currentTick.pointing_error_deg.toFixed(2)}°</span>
              <span title="trajectory-following error vs the Phase 01 reference">
                dr {currentTick.dr_m >= 1e6 ? `${(currentTick.dr_m / 1e6).toFixed(1)} Mm` : `${(currentTick.dr_m / 1e3).toFixed(0)} km`}
              </span>
              <span title="wheel speed saturation fraction">wheels {(currentTick.wheel_sat_frac * 100).toFixed(0)}%</span>
              <span title="cumulative propellant: RCS + main engine">
                prop {(currentTick.rcs_propellant_kg_cum + currentTick.tcm_propellant_kg_cum).toFixed(1)} kg
              </span>
              {bodyDistances?.departure != null && (
                <span title={`distance to ${config.trajectory.departure_body}`}>
                  {config.trajectory.departure_body} {fmtBodyDistance(bodyDistances.departure)}
                </span>
              )}
              {bodyDistances?.target != null && config.target_body.name && (
                <span title={`distance to ${config.target_body.name}`}>
                  {config.target_body.name} {fmtBodyDistance(bodyDistances.target)}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="relative flex-1 overflow-hidden rounded border border-white/10">
          {pipSwapped ? (
            // No onClick here: the enlarged attitude view is
            // now rotatable (interactive OrbitControls), so a drag-release
            // inside it must NOT read as "swap back" -- the swap gesture
            // lives exclusively on the corner thumbnail, which shows the
            // trajectory while swapped and toggles on click as before.
            <div className="absolute inset-0">
              <AttitudePip
                tick={displayTick}
                sampleSpacingS={sampleSpacingS}
                busDimsM={config.spacecraft.bus_dims_m}
                hardware={config.spacecraft.hardware}
                cameraDirRef={cameraDirRef}
                interactive
                steps={steps}
                targetTrack={viewportTracks.target}
                targetName={config.target_body.name || null}
                departureTrack={viewportTracks.departure}
                departureName={config.trajectory.departure_body}
              />
            </div>
          ) : (
            <CruiseReplayView
              steps={steps}
              playheadS={playheadS}
              tick={displayTick}
              busDimsM={config.spacecraft.bus_dims_m}
              hardware={config.spacecraft.hardware}
              departureBodyName={config.trajectory.departure_body}
              targetBodyName={config.target_body.name}
              departureTrack={viewportTracks.departure}
              targetTrack={viewportTracks.target}
              referenceArc={visualReferenceArc}
              referencePreCount={referencePreCount}
              referencePostCount={referencePostCount}
              burnMarkers={burnMarkers}
              cameraDirRef={cameraDirRef}
            />
          )}
          {/* Real request,: "make it slightly larger" -- was
              160x210px. */}
          {!DEBUG_FLAGS.noPip && (
          <div
            className="absolute bottom-3 right-3 h-[210px] w-[270px] cursor-pointer overflow-hidden rounded border border-white/25 shadow-2xl"
            onClick={() => setPipSwapped((v) => !v)}
          >
            {pipSwapped ? (
              <CruiseReplayView
                steps={steps}
                playheadS={playheadS}
                busDimsM={config.spacecraft.bus_dims_m}
                hardware={config.spacecraft.hardware}
                departureBodyName={config.trajectory.departure_body}
                targetBodyName={config.target_body.name}
                departureTrack={viewportTracks.departure}
                targetTrack={viewportTracks.target}
                referenceArc={visualReferenceArc}
                referencePreCount={referencePreCount}
                referencePostCount={referencePostCount}
                burnMarkers={burnMarkers}
                cameraDirRef={cameraDirRef}
                compact
              />
            ) : (
              <AttitudePip
                tick={displayTick}
                sampleSpacingS={sampleSpacingS}
                busDimsM={config.spacecraft.bus_dims_m}
                hardware={config.spacecraft.hardware}
                cameraDirRef={cameraDirRef}
                steps={steps}
                targetTrack={viewportTracks.target}
                targetName={config.target_body.name || null}
                departureTrack={viewportTracks.departure}
                departureName={config.trajectory.departure_body}
              />
            )}
          </div>
          )}
        </div>
      </div>
      </div>

      {steps.length > 0 && (
        <div className="border-t border-white/10 bg-[#04060c] px-4 pb-2 pt-2">
          <CruiseTimeline
            steps={steps}
            schedule={gncModes.schedule}
            transitions={result?.mode_transitions ?? []}
            durationS={durationS}
            playheadS={playheadS}
            onSeek={seekAndPause}
            focusWindow={figureFocus}
            onFocusWindowChange={handleFigureFocus}
            playing={playing}
            onPlayPause={handlePlayPause}
            wallclockS={wallclockS}
            onWallclockChange={setWallclockS}
            depJd={effectiveDepJd}
          />
          {/* Real confusion found (
              correctly but dr_m [Fig. 4] still looks large/noisy, why?") --
              confirmed against cruise.rs: "settled" means ATTITUDE only
              (pointing error dropped below the 0.5deg threshold), completely
              independent of trajectory convergence. */}
          <p className="mt-1 text-[10px] italic text-white/40">
            "Settled" (in a transition's hover detail) means attitude only — a burn targets the leg's own endpoint,
            not the instantaneous reference point, so trajectory-following error (Fig. 4) can stay large for a
            while after a settle and only converges as the leg approaches its end.
          </p>
        </div>
      )}
    </div>
  )
}
