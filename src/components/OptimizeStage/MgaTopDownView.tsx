// Flat 2D top-down playback of a finished Optimize result -- the "topdown
// simple" view the user asked for alongside the cinematic OptimizeTrajectoryView
// (reference: a matplotlib-style mission-animation screenshot they supplied,
//). Renders via the shared SolarSystemMap2D (see that file's
// header comment for why it's kept generic across three planned consumers).
// Most useful for MGA (multiple bodies/legs read clearly from directly
// above) but works for single-leg GA/PSO results too -- just departure +
// target with no intermediate flybys.
import { useCallback, useEffect, useRef, useState } from "react"
import { Pause, Play, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { SolarSystemMap2D, type MapBody, type OrbitRing } from "@/components/PorkchopExplorer/SolarSystemMap2D"
import { useBodyState } from "@/hooks/useApi"
import { getBodyState, type OptimizeApiResult } from "@/api/client"
import { AU_M, julianDateToUtcString } from "@/components/scene/sceneShared"

const TARGET_PLAYBACK_SECONDS = 18

const DEPARTURE_COLOR = "#f59e0b"
const TARGET_COLOR = "#f472b6"
const FLYBY_COLOR = "#c084fc"

function sampleArcXY(arc: OptimizeApiResult["arc"], tS: number): [number, number] {
  if (arc.length === 0) return [0, 0]
  if (tS <= arc[0].t_s) return [arc[0].x_m / AU_M, arc[0].y_m / AU_M]
  const last = arc[arc.length - 1]
  if (tS >= last.t_s) return [last.x_m / AU_M, last.y_m / AU_M]
  let lo = 0
  let hi = arc.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (arc[mid].t_s <= tS) lo = mid
    else hi = mid
  }
  const a = arc[lo]
  const b = arc[hi]
  const f = b.t_s === a.t_s ? 0 : (tS - a.t_s) / (b.t_s - a.t_s)
  return [(a.x_m + (b.x_m - a.x_m) * f) / AU_M, (a.y_m + (b.y_m - a.y_m) * f) / AU_M]
}

export function MgaTopDownView({
  result,
  departureBodyName,
  targetBodyName,
}: {
  result: OptimizeApiResult
  departureBodyName: string
  targetBodyName: string
}) {
  const [playing, setPlaying] = useState(false)
  const [elapsedS, setElapsedS] = useState(0)
  const elapsedSRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)

  const totalDurationS = result.arc.length === 0 ? 0 : result.arc[result.arc.length - 1].t_s
  const bodySequence = result.mga_body_sequence ?? [departureBodyName, targetBodyName]

  const effectiveDepartureEpoch = julianDateToUtcString(result.dep_jd)
  const effectiveArrivalEpoch = julianDateToUtcString(result.dep_jd + totalDurationS / 86_400)
  const { data: departureBodyState } = useBodyState(departureBodyName, effectiveDepartureEpoch)
  const { data: departureBodyFinalState } = useBodyState(departureBodyName, effectiveArrivalEpoch)
  const departureXY: [number, number] = departureBodyState
    ? [departureBodyState.x_m / AU_M, departureBodyState.y_m / AU_M]
    : // Parenthesization matters: `a?.x / AU_M ?? 0` divides FIRST, so an
      // absent arc[0] produced NaN (never nullish -- the ?? 0 fallback was
      // unreachable, a real TS2869 build error). Fall back before dividing.
      [(result.arc[0]?.x_m ?? 0) / AU_M, (result.arc[0]?.y_m ?? 0) / AU_M]
  const departureFinalXY: [number, number] | null = departureBodyFinalState
    ? [departureBodyFinalState.x_m / AU_M, departureBodyFinalState.y_m / AU_M]
    : null
  const targetXY: [number, number] = [result.target_r_arr_m[0] / AU_M, result.target_r_arr_m[1] / AU_M]

  const legBoundaryTimes: number[] = []
  for (let i = 1; i < result.arc.length; i++) {
    const prevLeg = result.arc[i - 1].leg_idx ?? 0
    const curLeg = result.arc[i].leg_idx ?? 0
    if (curLeg !== prevLeg) legBoundaryTimes.push(result.arc[i].t_s)
  }
  const flybyXYs = legBoundaryTimes.map((t) => sampleArcXY(result.arc, t))
  const flybyBodyNames = flybyXYs.map((_, i) => bodySequence[i + 1] ?? `Flyby ${i + 1}`)

  // Initial (departure-epoch) position of every body actually involved in
  // the mission -- target and each flyby body -- so the map shows how far
  // each one moved in its own orbit over the transfer, not just its single
  // encounter point. One real state fetch per body, once (not per frame),
  // same "acceptable" category as the single departure-body fetch above --
  // not the repeated-per-frame polling the kernel-caching backend note is
  // actually about.
  const [initialPositionsAu, setInitialPositionsAu] = useState<Record<string, [number, number]>>({})
  useEffect(() => {
    let cancelled = false
    const names = Array.from(new Set([targetBodyName, ...flybyBodyNames]))
    Promise.all(
      names.map(async (name) => {
        try {
          const s = await getBodyState(name, effectiveDepartureEpoch)
          return [name, [s.x_m / AU_M, s.y_m / AU_M] as [number, number]] as const
        } catch {
          return [name, null] as const
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      const map: Record<string, [number, number]> = {}
      for (const [name, xy] of entries) if (xy) map[name] = xy
      setInitialPositionsAu(map)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetBodyName, effectiveDepartureEpoch, JSON.stringify(flybyBodyNames)])

  const bodies: MapBody[] = [
    { name: bodySequence[0] ?? departureBodyName, positionAu: departureXY, color: DEPARTURE_COLOR },
    ...(departureFinalXY ? [{ name: bodySequence[0] ?? departureBodyName, positionAu: departureFinalXY, color: DEPARTURE_COLOR, style: "open" as const }] : []),
    ...flybyXYs.flatMap((xy, i): MapBody[] => {
      const name = flybyBodyNames[i]
      const initial = initialPositionsAu[name]
      return [
        ...(initial ? [{ name, positionAu: initial, color: FLYBY_COLOR, style: "open" as const }] : []),
        { name, positionAu: xy, color: FLYBY_COLOR },
      ]
    }),
    ...(initialPositionsAu[targetBodyName]
      ? [{ name: bodySequence[bodySequence.length - 1] ?? targetBodyName, positionAu: initialPositionsAu[targetBodyName], color: TARGET_COLOR, style: "open" as const }]
      : []),
    { name: bodySequence[bodySequence.length - 1] ?? targetBodyName, positionAu: targetXY, color: TARGET_COLOR },
  ]
  const orbitRings: OrbitRing[] = bodies.map((b) => ({
    name: b.name,
    radiusAu: Math.hypot(b.positionAu[0], b.positionAu[1]),
    color: b.color,
  }))

  const rangeAu = Math.max(
    ...bodies.map((b) => Math.max(Math.abs(b.positionAu[0]), Math.abs(b.positionAu[1]))),
    ...result.arc.map((p) => Math.max(Math.abs(p.x_m / AU_M), Math.abs(p.y_m / AU_M))),
    0.5,
  ) * 1.15

  const path = result.arc
    .filter((p) => p.t_s <= elapsedS)
    .map((p): [number, number] => [p.x_m / AU_M, p.y_m / AU_M])
  const currentPositionAu = sampleArcXY(result.arc, elapsedS)

  const tick = useCallback((ts: number) => {
    if (lastTsRef.current == null) lastTsRef.current = ts
    const deltaS = (ts - lastTsRef.current) / 1000
    lastTsRef.current = ts
    const multiplier = totalDurationS / TARGET_PLAYBACK_SECONDS
    elapsedSRef.current = Math.min(elapsedSRef.current + deltaS * multiplier, totalDurationS)
    setElapsedS(elapsedSRef.current)
    if (elapsedSRef.current >= totalDurationS) { setPlaying(false); return }
    rafRef.current = requestAnimationFrame(tick)
  }, [totalDurationS])

  useEffect(() => {
    if (!playing) { lastTsRef.current = null; return }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [playing, tick])

  const handleRestart = useCallback(() => {
    elapsedSRef.current = 0
    setElapsedS(0)
    setPlaying(true)
  }, [])

  if (result.arc.length === 0) {
    return (
      <Card><CardHeader><CardTitle>Top-down</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No arc in this result to visualize.</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Top-down</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => (playing ? setPlaying(false) : (elapsedS >= totalDurationS ? handleRestart() : setPlaying(true)))}>
            {playing ? <><Pause data-icon="inline-start" /> Pause</> : <><Play data-icon="inline-start" /> {elapsedS > 0 ? "Resume" : "Play"}</>}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleRestart}><RotateCcw data-icon="inline-start" /> Restart</Button>
        </div>
      </CardHeader>
      <CardContent>
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", top: 8, left: 8, zIndex: 1, color: "#e5e5e5", fontSize: 12, fontWeight: 600, textShadow: "0 1px 3px #000" }}>
            Time: {(elapsedS / 86_400).toFixed(1)} days
          </div>
          <SolarSystemMap2D bodies={bodies} orbitRings={orbitRings} path={path} currentPositionAu={currentPositionAu} rangeAu={rangeAu} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Flat top-down view (raw heliocentric x/y, no camera controls) -- orbit rings are circular approximations at
          each body's real distance from the Sun at its encounter, not true orbital elements. Filled markers are each
          body's position at departure; hollow markers are its position at its own encounter (flyby/target) or at
          mission end (departure body), showing how far each one moved during the transfer.
        </p>
      </CardContent>
    </Card>
  )
}
