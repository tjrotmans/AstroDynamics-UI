// The app's front door, rebuilt to match the design mockup 1:1
// (.scratch/wt-hybrid-observatory/design/mockup.html, rev 4): a full-bleed
// living solar system with almost no UI on top of it -- a serif wordmark,
// three preset historical-tour chips, a route bar that appears once a route
// is being sketched, and the phase dock. All the mockup's interaction lives
// here for real: click a planet to start/extend a route (LandingScene reports
// clicks up; the popover itself renders inside the 3D scene, anchored to the
// clicked body, so it tracks the body as it moves), or jump straight to a
// preset tour. "Design trajectory" wires the sketched route into the real mission
// store (departure/target body, and -- for routes with intermediate bodies --
// manual MGA flyby_bodies) before entering the existing workspace shell.
import { useState } from "react"

import { LandingScene, type PopoverOption } from "./LandingScene"
import { PhaseDock } from "./PhaseDock"
import { PRESET_SNAPSHOTS } from "@/data/presetSnapshots"
import { useDesignStore } from "@/stores/designStore"
import { useMgaScanStore } from "@/stores/mgaScanStore"
import { useMissionStore } from "@/stores/missionStore"
import { useOptimizeStore } from "@/stores/optimizeStore"
import { useUiStore, type Tool } from "@/stores/uiStore"

// The route's terminal arrival mode -- unset (null) means the route is still
// open and clicking another planet extends it with a flyby leg. Choosing any
// of these three ends the route right there (confirmed: no
// leg can follow a parked orbit/rendezvous/sample-return); the terminal
// choice can be removed to reopen the route from that same point, but no
// further body is implied by removing it.
type ArrivalMode = "rendezvous" | "sampleReturn" | "orbit"

const ARRIVAL_LABEL: Record<ArrivalMode, string> = {
  rendezvous: "Rendezvous",
  sampleReturn: "Sample return",
  orbit: "Orbit",
}

interface Preset {
  id: string
  name: string
  meta: string
  route: string[]
  /** Unset (Flyby) for the three MGA tour presets. The Mercury preset needs
   * "orbit" so `openStudy` maps it onto the real `Orbit` objective its
   * pre-baked snapshot was actually optimized for (see presetSnapshots'
   * own header) -- otherwise the chip would silently claim Flyby while the
   * seeded result is a real orbit-insertion GA run. */
  terminal?: ArrivalMode
}

const PRESETS: Preset[] = [
  { id: "cassini", name: "Cassini–Huygens", meta: "1997 · E→V→V→E→J→S", route: ["Earth", "Venus", "Venus", "Earth", "Jupiter", "Saturn"] },
  { id: "galileo", name: "Galileo", meta: "1989 · VEEGA · E→V→E→E→J", route: ["Earth", "Venus", "Earth", "Earth", "Jupiter"] },
  { id: "voyager2", name: "Voyager 2", meta: "1977 · grand tour · E→J→S→U→N", route: ["Earth", "Jupiter", "Saturn", "Uranus", "Neptune"] },
  // Direct (non-MGA) example, added per --
  // deliberately NOT named after a real Mercury mission (MESSENGER/
  // BepiColombo both flew real multi-flyby routes very different from this
  // simplified direct GA transfer) since the other three chips' names are
  // 1:1 accurate to their real historical flyby sequence.
  { id: "mercury", name: "Mercury Orbiter", meta: "direct · GA · E→Mercury (Orbit)", route: ["Earth", "Mercury"], terminal: "orbit" },
  // Feasible direct example -- see presetSnapshots/index.ts's
  // `mars` entry for why it exists next to the (infeasible) Mercury one.
  { id: "mars", name: "Mars Orbiter", meta: "direct · GA · E→Mars (Orbit) · feasible", route: ["Earth", "Mars"], terminal: "orbit" },
]

const DEFAULT_LEG_TOF: [number, number] = [30, 800]

// Same empty-state shape as Study/mgaHelpers.ts's DEFAULT_MGA_BASE, kept as
// its own local constant rather than imported -- this file's route builder
// is a genuinely independent entry point from Study's own MGA editing (see
// this file's own header comment), not meant to couple to its internals.
const EMPTY_MGA_PARAMS = { flyby_bodies: [], leg_tof_days: [DEFAULT_LEG_TOF], sequence_search: null }

export function LandingView() {
  const [route, setRoute] = useState<string[]>([])
  const [terminalMode, setTerminalMode] = useState<ArrivalMode | null>(null)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [popoverBody, setPopoverBody] = useState<string | null>(null)
  const [shownPhase, setShownPhase] = useState<number | null>(null)

  const enterWorkspace = useUiStore((s) => s.enterWorkspace)
  const setTrajectoryDepartureBody = useMissionStore((s) => s.setTrajectoryDepartureBody)
  const loadConfig = useMissionStore((s) => s.loadConfig)
  const selectCatalogBody = useMissionStore((s) => s.selectCatalogBody)
  const setObjective = useMissionStore((s) => s.setObjective)
  const enableOptimization = useMissionStore((s) => s.enableOptimization)
  const setOptimizationMethod = useMissionStore((s) => s.setOptimizationMethod)
  const setMgaParams = useMissionStore((s) => s.setMgaParams)
  const selectedTrajectory = useDesignStore((s) => s.selectedTrajectory)
  const gncResult = useDesignStore((s) => s.gncResult)
  const setTrajectoryResult = useDesignStore((s) => s.setTrajectoryResult)
  const setMgaScanResult = useMgaScanStore((s) => s.setResult)
  const setMgaScanState = useMgaScanStore((s) => s.setState)
  const resetMgaScan = useMgaScanStore((s) => s.reset)
  const setOptimizeError = useOptimizeStore((s) => s.setError)
  const setOptimizeResult = useOptimizeStore((s) => s.setResult)
  const resetOptimize = useOptimizeStore((s) => s.reset)

  function applyRoute(r: string[], terminal: ArrivalMode | null = null) {
    setRoute(r)
    setTerminalMode(terminal)
    setActivePreset(null)
    setPopoverBody(null)
  }

  function handlePlanetClick(name: string) {
    setShownPhase(null)
    setPopoverBody(name)
  }

  // Wires a sketched route into the real mission store: departure = first
  // body, target = last body, and -- for routes with intermediate bodies --
  // manual MGA flyby_bodies (the only phase where a multi-leg route can
  // actually run; a plain 2-body route leaves the method untouched). The
  // terminal arrival mode (unset = Flyby) maps straight onto MissionObjective.
  //
  // Landing->Study roadmap item 1 (revised same day after
  //: "the idea is to have everything, including mga
  // scan and an optimization run too, not only the direct scan"): if this
  // route came straight from an untouched preset chip, seed the Study
  // page's Survey figure, MGA Scan figure, and Optimizer section with that
  // preset's real pre-baked results instead of leaving the paper empty --
  // a real analytical survey, a real MGA scan (real feasible branches for
  // Cassini/Galileo; a real empty result for Voyager 2's harder E-J-S-U-N
  // tour), and the real error from an actual full MGA optimizer attempt
  // (all three came back genuinely infeasible even at a moderately raised
  // budget -- an honest "mixed result," not a fabricated success, see
  // src/data/presetSnapshots/index.ts's header for the full story).
  // `presetId` is only ever non-null here when the user hasn't edited the
  // sketched route at all (LandingView's own `applyRoute` clears
  // `activePreset` on every manual edit) -- a hand-sketched or edited route
  // clears all three instead, same "wholesale replace" semantics
  // `missionStore.loadConfig` already uses. `StudyPaper`/`useMgaScan`/
  // `useOptimizeStream` call these exact same setters on a real run's
  // success/failure (and their `start()`s call `reset()` first), so
  // clicking any real run button naturally overwrites the pre-baked data --
  // no separate "is this fake" flag needed anywhere else.
  function openStudy(r: string[], terminal: ArrivalMode | null, presetId: string | null) {
    if (r.length < 2) return
    const departure = r[0]
    const target = r[r.length - 1]
    setTrajectoryDepartureBody(departure)
    selectCatalogBody(target)
    enableOptimization()
    setObjective(terminal === "rendezvous" ? "Rendezvous" : terminal === "sampleReturn" ? "SampleReturn" : terminal === "orbit" ? "Orbit" : "Flyby")
    if (r.length > 2) {
      const flybyBodies = r.slice(1, -1)
      setOptimizationMethod("MGA")
      setMgaParams({
        flyby_bodies: flybyBodies,
        leg_tof_days: Array.from({ length: r.length - 1 }, () => [...DEFAULT_LEG_TOF]),
        sequence_search: null,
      })
    } else {
      // Real bug, found (
      // optimization toggled on by default... I still see MGA toggled on
      // when selecting Mercury Orbiter"). This branch used to do nothing at
      // all for a direct (2-body) route -- only the r.length > 2 branch
      // above ever touched method/mga, so a direct preset silently
      // inherited whatever method/flyby_bodies were already sitting in the
      // store from a PRIOR mission (e.g. having loaded Cassini earlier in
      // the same session, or a stale localStorage-persisted config from an
      // earlier visit -- this app persists mission config across reloads).
      // `StudyPaper`'s own MGA-checkbox auto-latch
      // (`!mgaTouched && !mgaEnabled && flybyBodies.length > 0`) then fired
      // on that leftover data, showing the Gravity-assist checkbox ON for
      // a mission that was never supposed to have flybys at all. Fixed by
      // explicitly resetting both fields here, symmetric to the MGA branch
      // above, so a direct preset is self-consistent regardless of
      // whatever state came before it.
      setOptimizationMethod("GA")
      setMgaParams(EMPTY_MGA_PARAMS)
    }
    const snapshot = presetId ? PRESET_SNAPSHOTS[presetId] : null
    // Full-config restore (the example must carry "one
    // fixed example with settings"): a captured missionConfig replaces the
    // ENTIRE mission config wholesale -- dv bounds, windows, budgets,
    // capture radius, everything -- overriding both the piecemeal setters
    // above and any persisted state from earlier sessions. Guarded on a
    // real `mission` key so the pre-capture placeholder file is ignored.
    if (snapshot?.missionConfig && "mission" in snapshot.missionConfig) {
      loadConfig(snapshot.missionConfig as Parameters<typeof loadConfig>[0])
    }
    if (snapshot) {
      setTrajectoryResult(snapshot.survey)
      setMgaScanResult(snapshot.mgaScan)
      setMgaScanState("done")
      if (snapshot.optimizeResult) {
        setOptimizeResult(snapshot.optimizeResult)
        setOptimizeError(null)
      } else if (snapshot.optimizeError) {
        setOptimizeResult(null)
        setOptimizeError(snapshot.optimizeError)
      }
    } else {
      setTrajectoryResult(null)
      resetMgaScan()
      resetOptimize()
    }
    enterWorkspace("study")
  }

  // Popover option-menu handler. `flyby` extends the open route and keeps
  // sketching; rendezvous/sampleReturn/orbit append the body and lock the
  // route there; undoTerminal/clearRoute are the two ways back out of a
  // locked route (remove just the arrival choice, or start over).
  function handlePopoverOption(key: string) {
    if (!popoverBody) return
    if (key === "flyby") {
      applyRoute([...route, popoverBody])
    } else if (key === "rendezvous" || key === "sampleReturn" || key === "orbit") {
      applyRoute([...route, popoverBody], key)
    } else if (key === "undoTerminal") {
      setTerminalMode(null)
      setPopoverBody(null)
    } else if (key === "clearRoute") {
      applyRoute([])
    }
  }

  function handlePopoverGo() {
    if (!popoverBody) return
    const r = route.length === 0 ? ["Earth", popoverBody] : route[route.length - 1] !== popoverBody ? [...route, popoverBody] : route
    openStudy(r, null, null)
  }

  function handleTogglePhase(n: number) {
    setPopoverBody(null)
    setShownPhase((cur) => (cur === n ? null : n))
  }

  function handleDismiss() {
    setPopoverBody(null)
    setShownPhase(null)
  }

  function handleEnterPhase(tool: Tool) {
    setShownPhase(null)
    enterWorkspace(tool)
  }

  const isRouteLocked = terminalMode != null
  const isTerminalBody = isRouteLocked && route[route.length - 1] === popoverBody

  const popoverOptions: PopoverOption[] = isRouteLocked
    ? isTerminalBody
      ? [{ key: "undoTerminal", label: "Remove arrival choice, continue route" }]
      : [{ key: "clearRoute", label: `Clear route (ends at ${ARRIVAL_LABEL[terminalMode as ArrivalMode]})` }]
    : [
        {
          key: "flyby",
          label:
            route.length === 0
              ? "◦ Start route here"
              : route[route.length - 1] === popoverBody
                ? "+ Add resonant return"
                : "+ Add flyby leg",
        },
        ...(route.length === 0
          ? []
          : ([
              { key: "rendezvous", label: "Rendezvous", disabled: true, hint: "not supported by the backend yet, for any body" },
              { key: "sampleReturn", label: "Sample return" },
              { key: "orbit", label: "Orbit here" },
            ] as PopoverOption[])),
      ]
  const popoverShowGo = !isRouteLocked && !(route.length === 0 && popoverBody === "Earth")

  // Sample return flies the real leg back to the departure body too;
  // display-only, doesn't change the logical `route`/mission target.
  const displayRoute = terminalMode === "sampleReturn" && route.length > 0 ? [...route, route[0]] : route
  const orbitBody = terminalMode === "orbit" ? route[route.length - 1] : null

  return (
    <div className="relative h-screen w-screen overflow-hidden" onClick={handleDismiss}>
      <div onClick={(e) => e.stopPropagation()}>
        <LandingScene
          route={route}
          displayRoute={displayRoute}
          orbitBody={orbitBody}
          popoverBody={popoverBody}
          popoverOptions={popoverOptions}
          popoverShowGo={popoverShowGo}
          onPlanetClick={handlePlanetClick}
          onPopoverOption={handlePopoverOption}
          onPopoverGo={handlePopoverGo}
          onDismiss={handleDismiss}
        />
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-11 flex flex-col items-center text-center">
        <h1 className="font-serif text-[28px] italic text-foreground">
          Astro<span className="text-primary">Dynamics</span>
        </h1>
        <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          An instrument for mission design
        </p>
      </div>

      {shownPhase == null && (
        <div className="pointer-events-auto absolute inset-x-0 top-[136px] flex justify-center gap-2.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={(e) => {
                e.stopPropagation()
                applyRoute(p.route, p.terminal ?? null)
                setActivePreset(p.id)
              }}
              className={
                "rounded-[10px] border bg-card/60 px-4 py-2 text-left backdrop-blur-md " +
                (activePreset === p.id ? "border-primary/70" : "border-border hover:border-primary/45")
              }
            >
              <div className={"font-serif text-[13.5px] " + (activePreset === p.id ? "text-primary" : "text-foreground")}>
                {p.name}
              </div>
              <div className="mt-0.5 font-mono text-[9px] tracking-wide text-muted-foreground">{p.meta}</div>
            </button>
          ))}
        </div>
      )}

      <div className="pointer-events-auto absolute inset-x-0 bottom-8 flex flex-col items-center gap-3">
        {route.length > 0 && (
          <div
            className="flex items-center gap-3 rounded-full border border-border bg-card/60 py-1.5 pl-4 pr-1.5 font-mono text-[11.5px] backdrop-blur-md"
            onClick={(e) => e.stopPropagation()}
          >
            <span>
              {route.map((name, i) => (
                <span key={i}>
                  {i > 0 && <span className="text-primary"> → </span>}
                  {name}
                </span>
              ))}
              {terminalMode && (
                <span className="ml-1.5 text-primary">
                  ({ARRIVAL_LABEL[terminalMode]}
                  <button
                    onClick={() => setTerminalMode(null)}
                    title="Remove arrival choice, keep chaining from here"
                    className="ml-1 text-muted-foreground hover:text-foreground"
                  >
                    ✕
                  </button>
                  )
                </span>
              )}
            </span>
            {route.length >= 2 && (
              <button
                onClick={() => openStudy(route, terminalMode, activePreset)}
                className="rounded-full bg-primary px-3.5 py-1 font-sans text-[10px] font-semibold uppercase tracking-wider text-primary-foreground hover:brightness-110"
              >
                Design trajectory
              </button>
            )}
            <button
              onClick={() => applyRoute([])}
              className="flex size-[21px] items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        )}

        <div onClick={(e) => e.stopPropagation()}>
          <PhaseDock shownPhase={shownPhase} onTogglePhase={handleTogglePhase} onEnter={handleEnterPhase} />
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-8 right-[18px] rounded-[10px] border border-border bg-card/60 px-3.5 py-2 text-[10.5px] tracking-wide text-muted-foreground backdrop-blur-md">
        drag to orbit · click planets to chain a route · or try a preset tour
        {(selectedTrajectory || gncResult) && (
          <span className="ml-2 text-primary">
            {gncResult ? "· GNC design ready" : "· trajectory adopted"}
          </span>
        )}
      </div>
    </div>
  )
}
