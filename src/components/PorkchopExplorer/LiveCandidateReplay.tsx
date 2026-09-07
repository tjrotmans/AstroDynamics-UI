// Live search-animation during a running MGA job - both Manual sequence and
// Auto (Tisserand sequence_search) mode.
//
// Reworked after user feedback on the first cut ("doesn't make
// sense at all"): the frame now shows the WHOLE solar system context - every
// catalog planet out to just beyond the mission's outermost body, each with
// a dashed orbit ring - and cycles to a DIFFERENT search candidate every
// ~1.5s. The first cut redrew only the best-so-far chromosome, which is
// monotone within a search branch, so frames barely changed; this one cycles
// through the full history of distinct best chromosomes received so far
// (looping, picking up new ones as they stream), which is what actually
// shows "how the optimizer searches". Candidate paths are per-leg ballistic
// Lambert arcs (lib/lambert.ts) between real body positions at the
// candidate's reconstructed encounter epochs - good or bad trajectories
// alike, that's the point.
//
// Auto-mode unblocked the backend now interleaves an
// MgaSequenceContextMsg into the step stream before each candidate flyby
// sequence's own steps (Phase 9k "step-stream context" ask) - the frontend
// tags every appended step with the sequence active at arrival time
// (optimizeStore.ts's TaggedStep.seqIdx) and this component reads
// useOptimizeStore's `activeSequence` to know which real body sequence to
// decode. The effect restarts whenever the active sequence changes (a
// beam-search move to a new candidate invalidates any accumulated
// candidates from the old one).
//
// Fetch discipline, rewritten after a real backend crash: the
// first cut called /api/bodies/{name}/state once per body EVERY redraw
// (~every 1.5s). That endpoint reloads full ANISE kernels per call with no
// server-side caching, and under sustained polling plus several MGA jobs
// left running concurrently (test scripts that never called Stop between
// runs), the server hit an allocation failure and crashed (`memory
// allocation ... failed`, from the server's own log). Fixed by fetching
// each body's real (position, velocity) ONCE for the whole run (at the
// departure epoch) and extrapolating every other epoch analytically via
// lib/orbitExtrapolation.ts's circular-orbit approximation - same fidelity
// choice the backend's own plot_mga_animation.py already makes for its
// planet background. Real network calls: one per unique body name, total,
// not one per body per frame. See the design notes Frontend Backlog for the
// backend-side concurrency/caching bug this doesn't fully paper over.
import { useEffect, useRef, useState } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getBodyState } from "@/api/client"
import { epochStringToJd, jdToEpochString } from "@/lib/utils"
import { lambertArcPoints, type Vec3 } from "@/lib/lambert"
import { propagateCircular } from "@/lib/orbitExtrapolation"
import { useBodies } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"
import { useOptimizeStore } from "@/stores/optimizeStore"
import { SolarSystemMap2D, type MapBody, type OrbitRing } from "./SolarSystemMap2D"

const AU_M = 1.495978707e11
const MIN_FRAME_GAP_MS = 1500
const LOOP_SAMPLES = 48

// A resonant-return leg (the same body twice in a row, e.g. VEEGA's
// Earth->Earth leg) sends lambertArcPoints a near-zero transfer angle --
// numerically degenerate (A -> 0 in the universal-variables formulation),
// so it legitimately returns null and the caller fell back to a straight
// line through the body. Real bug, found: draw a loop instead,
// same bulge-around-the-radius shape LandingScene.tsx's RouteLayer already
// uses for the identical same-body case, adapted from 3D scene units to
// this component's flat AU space.
function loopArcPoints(posAu: [number, number]): [number, number][] {
  const r0 = Math.hypot(posAu[0], posAu[1])
  const ang0 = Math.atan2(posAu[1], posAu[0])
  const pts: [number, number][] = []
  for (let q = 0; q <= LOOP_SAMPLES; q++) {
    const s = q / LOOP_SAMPLES
    const th = ang0 + s * Math.PI * 2
    const rf = r0 * (1 + 0.32 * Math.sin(Math.PI * s))
    pts.push([rf * Math.cos(th), rf * Math.sin(th)])
  }
  return pts
}

const PLANET_COLORS: Record<string, string> = {
  Mercury: "#9ca3af",
  Venus: "#eab308",
  Earth: "#3b82f6",
  Mars: "#ef4444",
  Jupiter: "#f97316",
  Saturn: "#fbbf24",
  Uranus: "#67e8f9",
  Neptune: "#6366f1",
}

// mga.rs chromosome layout: p[0] = departure offset [days], p[4+2k] =
// leg k's TOF [days]; len = 5n+2 for n legs.
function decodeEncounterEpochs(params: number[], depJdBase: number, legCount: number): number[] {
  const epochs = [depJdBase + params[0]]
  for (let k = 0; k < legCount; k++) {
    epochs.push(epochs[k] + params[4 + 2 * k])
  }
  return epochs
}

interface Frame {
  planets: MapBody[]
  rings: OrbitRing[]
  path: [number, number][]
  fitnessMs: number
  candidateNumber: number
  candidateCount: number
}

export function LiveCandidateReplay() {
  const optimization = useMissionStore((state) => state.config.optimization)
  const connectionState = useOptimizeStore((state) => state.connectionState)
  const steps = useOptimizeStore((state) => state.steps)
  const activeSequence = useOptimizeStore((state) => state.activeSequence)
  const { data: bodiesData } = useBodies()

  const stepsRef = useRef(steps)
  useEffect(() => {
    stepsRef.current = steps
  }, [steps])

  const [frame, setFrame] = useState<Frame | null>(null)

  const isMga = optimization?.method === "MGA"
  const isAutoMga = isMga && !!optimization.mga?.sequence_search
  const isStreaming = connectionState === "streaming"

  // Manual mode: the configured flyby_bodies list is the (only, fixed)
  // sequence, known before the job even starts. Auto mode: the sequence
  // currently being searched, from the backend's own announcement --
  // unknown until the first MgaSequenceContextMsg arrives.
  const manualBodySequence = optimization
    ? [optimization.departure_body, ...(optimization.mga?.flyby_bodies ?? []), optimization.target_body]
    : []
  const autoBodySequence =
    isAutoMga && activeSequence && optimization
      ? [optimization.departure_body, ...activeSequence.flyby_bodies, optimization.target_body]
      : null
  const bodySequence = isAutoMga ? autoBodySequence : manualBodySequence
  // Only steps tagged with the currently active sequence count -- mixing
  // candidates across sequences would decode garbage (different sequences
  // can share the same leg count, so length alone can't disambiguate). The
  // backend sends exactly one MgaSequenceContextMsg even for the fixed
  // (Manual) sequence path (seq_count: 1 -- see its openapi doc), so every
  // step is tagged with a real seq_idx in both modes; always match against
  // whatever activeSequence actually holds rather than assuming null for
  // Manual (assuming null was a real bug: it filtered out every step and
  // stuck the panel on "waiting for the first candidate" forever).
  const targetSeqIdx = activeSequence?.seq_idx ?? null

  const depJdBase = optimization?.departure_epoch ? epochStringToJd(optimization.departure_epoch) : null
  const active = isMga && isStreaming && bodySequence != null && depJdBase != null

  const catalog = bodiesData?.bodies

  useEffect(() => {
    if (!active || !bodySequence || depJdBase == null || !catalog) return
    // Re-bind to a definite number: TS doesn't retain the depJdBase == null
    // narrowing across the nested function declarations below.
    const depJd: number = depJdBase
    let cancelled = false

    // One real fetch per body name, ever, for this run -- (r0, v0) at the
    // departure epoch. Every other epoch is derived from this via
    // propagateCircular, never a second network call for the same body.
    const stateCache = new Map<string, { r0: Vec3; v0: Vec3 } | null>()
    const fetchState0 = async (name: string): Promise<{ r0: Vec3; v0: Vec3 } | null> => {
      const hit = stateCache.get(name)
      if (hit !== undefined) return hit
      try {
        const s = await getBodyState(name, jdToEpochString(depJd))
        const state = { r0: [s.x_m, s.y_m, s.z_m] as Vec3, v0: [s.vx_mps, s.vy_mps, s.vz_mps] as Vec3 }
        stateCache.set(name, state)
        return state
      } catch {
        stateCache.set(name, null)
        return null
      }
    }
    // jd is days from depJdBase (as decoded from a candidate's chromosome);
    // extrapolate analytically from the one real fetch, no network call.
    const posAtJd = async (name: string, jd: number): Promise<Vec3 | null> => {
      const state = await fetchState0(name)
      if (!state) return null
      return propagateCircular(state.r0, state.v0, (jd - depJd) * 86_400)
    }
    const toAu = (p: Vec3): [number, number] => [p[0] / AU_M, p[1] / AU_M]

    // Distinct-candidate history for the active sequence, in arrival order.
    const seen = new Set<string>()
    const candidates: { params: number[]; fitnessMs: number }[] = []
    const expectedLen = 5 * (bodySequence.length - 1) + 2
    const collectCandidates = () => {
      for (const s of stepsRef.current) {
        if (s.seqIdx !== targetSeqIdx) continue
        if (!s.best_params || s.best_params.length !== expectedLen) continue
        const key = s.best_params.map((v) => v.toPrecision(6)).join(",")
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({ params: s.best_params, fitnessMs: s.best_fitness })
      }
    }

    // Solar-system background: planets out to just beyond the mission's
    // outermost body (drawing Neptune for a Venus mission would shrink the
    // interesting part to a dot). Positions at the departure epoch, once.
    const sequenceSet = new Set(bodySequence)
    const planetNames = catalog.filter((b) => b.kind === "Planet").map((b) => b.name)

    let cycleIdx = -1
    let timer: ReturnType<typeof setTimeout>

    async function runRound() {
      collectCandidates()
      if (candidates.length > 0) {
        cycleIdx = (cycleIdx + 1) % candidates.length
        const cand = candidates[cycleIdx]
        const epochs = decodeEncounterEpochs(cand.params, depJd, bodySequence!.length - 1)

        const [encounterPositions, planetPositionsInitial] = await Promise.all([
          Promise.all(bodySequence!.map((name, i) => posAtJd(name, epochs[i]))),
          Promise.all(planetNames.map((name) => posAtJd(name, depJd))),
        ])

        if (!cancelled) {
          // One dot per background planet. Bodies actually in the flyby
          // sequence use THEIR OWN encounter epoch's position (already
          // computed above for the path) -- a body sitting at the mission's
          // departure-epoch position while the path arcs meet it somewhere
          // else entirely didn't make sense (real bug, found).
          // Bodies not in the sequence are purely decorative background/
          // scale context, so they stay at the departure-epoch position
          // (there's no single relevant "event" epoch for them). Round 5
          // simplified this down to one marker per planet
          // (no filled+hollow start/end pair) -- that decision stands, only
          // WHICH epoch each marker uses changed.
          const planets: MapBody[] = []
          const rings: OrbitRing[] = []
          let maxSequenceR = 1
          planetPositionsInitial.forEach((pos, i) => {
            const name = planetNames[i]
            const seqIdx = bodySequence!.indexOf(name)
            const eventPos = seqIdx >= 0 ? (encounterPositions[seqIdx] ?? pos) : pos
            if (!eventPos) return
            const posAu = toAu(eventPos)
            const color = PLANET_COLORS[name] ?? "#8899bb"
            const r = Math.hypot(posAu[0], posAu[1])
            if (sequenceSet.has(name)) maxSequenceR = Math.max(maxSequenceR, r)
            planets.push({ name, positionAu: posAu, color })
            rings.push({ name, radiusAu: r, color })
          })
          const rLimit = maxSequenceR * 1.35
          const shownPlanets = planets.filter((p) => Math.hypot(p.positionAu[0], p.positionAu[1]) <= rLimit)
          const shownRings = rings.filter((r) => r.radiusAu <= rLimit)

          // Per-leg prograde Lambert arcs (display-only solver, lib/lambert.ts
          // -- see its header for the sanctioned trajectory-math exception).
          // A resonant-return leg (same body twice, e.g. VEEGA's Earth->Earth
          // leg) draws a loop instead of calling the Lambert solver at all --
          // a near-zero transfer angle is numerically degenerate there and
          // legitimately returns null every time, which used to fall back to
          // a straight line through the body (real bug, found; a
          // genuine solver failure on a non-resonant leg still falls back to
          // a straight segment, now rare). Note the real MGA-1DSM leg has a
          // mid-course DSM; a single ballistic Lambert arc per leg is a
          // better-looking schematic, not the optimizer's actual model.
          const path: [number, number][] = []
          for (let leg = 0; leg < bodySequence!.length - 1; leg++) {
            const rA = encounterPositions[leg]
            const rB = encounterPositions[leg + 1]
            if (!rA || !rB) continue
            let legPoints: [number, number][]
            if (bodySequence![leg] === bodySequence![leg + 1]) {
              legPoints = loopArcPoints(toAu(rA))
            } else {
              const tofS = (epochs[leg + 1] - epochs[leg]) * 86_400
              const arc = lambertArcPoints(rA, rB, tofS)
              legPoints = arc ? arc.map(toAu) : [toAu(rA), toAu(rB)]
            }
            // Skip the duplicated shared endpoint between consecutive legs.
            path.push(...(path.length > 0 ? legPoints.slice(1) : legPoints))
          }

          setFrame({
            planets: shownPlanets,
            rings: shownRings,
            path,
            fitnessMs: cand.fitnessMs,
            candidateNumber: cycleIdx + 1,
            candidateCount: candidates.length,
          })
        }
      }
      if (!cancelled) timer = setTimeout(runRound, MIN_FRAME_GAP_MS)
    }

    timer = setTimeout(runRound, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Deliberately keyed on targetSeqIdx (not the bodySequence array
    // reference, which changes every render): a new active sequence means
    // any accumulated candidates belong to a different, no-longer-relevant
    // search, so the effect must restart (fresh `candidates`/`seen`) rather
    // than keep cycling stale frames from the previous sequence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, depJdBase, catalog, targetSeqIdx])

  if (!isMga || !isStreaming) return null

  if (isAutoMga && !activeSequence) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Live search animation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Waiting for the optimizer to announce its first candidate sequence…</p>
        </CardContent>
      </Card>
    )
  }

  if (!active) return null

  const rangeAu = frame && frame.rings.length > 0 ? Math.max(...frame.rings.map((r) => r.radiusAu)) * 1.1 : 2

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-2">
        <CardTitle>Live search animation</CardTitle>
        <div className="flex items-baseline gap-3 text-xs text-muted-foreground tabular-nums">
          {isAutoMga && activeSequence && (
            <span>
              sequence {activeSequence.seq_idx + 1}/{activeSequence.seq_count}
              {activeSequence.is_direct_baseline ? " (direct)" : ` (${bodySequence!.slice(1, -1).join("→") || "direct"})`}
            </span>
          )}
          {frame && (
            <span>
              candidate {frame.candidateNumber}/{frame.candidateCount} · ΔV {(frame.fitnessMs / 1000).toFixed(2)} km/s
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!frame ? (
          <p className="text-sm text-muted-foreground">Waiting for the first candidate…</p>
        ) : (
          <>
            <SolarSystemMap2D
              bodies={frame.planets}
              orbitRings={frame.rings}
              path={frame.path}
              rangeAu={rangeAu}
              heightPx={420}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Cycles through the search's distinct candidates (~one every {MIN_FRAME_GAP_MS / 1000}s, looping as new
              ones stream in). Yellow path = per-leg ballistic Lambert arcs through each body's real position at
              that candidate's encounter dates (display approximation - the optimizer's real legs include a
              mid-course DSM). Filled dot = a planet's position at this candidate's departure date, hollow dot =
              its position at arrival. Visible corners at a flyby are a display artifact, not a real dynamics
              effect: each leg is solved independently with no velocity-continuity constraint across the flyby,
              unlike a real gravity-assist, which smoothly bends the velocity vector.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
