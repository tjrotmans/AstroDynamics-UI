// The full-bleed living solar system behind the landing page, matching the
// design mockup 1:1 (.scratch/wt-hybrid-observatory/design/mockup.html):
// simple shaded-sphere-look dots on orbit rings, click-a-planet route
// chaining, per-leg transfer arcs with resonant-return loops, and a small
// gold spacecraft flying the route.
//
// SANCTIONED EXCEPTION -- fixed circular orbits, not real ephemeris:
// the first cut of this page fetched each planet's real state from
// /api/bodies/{name}/state (same pattern the MGA live-replay feature uses).
// The user explicitly asked to drop that for the landing page specifically
// ("just do it the same as in the mockup... that's not really necessary
// for this landing page"): a decorative front door doesn't need
// real-time positions, and real fetches bought nothing but self-pacing
// complexity and a camera-axis interaction that made the whole scene read
// as unstable. Positions here are simple circular orbits from each
// planet's real semi-major axis (public astronomical constants) via
// Kepler's third law (period ∝ a^1.5) -- same formula, same compressed
// sqrt(au) display scale, same per-planet colors as the mockup. This is
// display-only decoration, never a number read by the user as a real
// result or sent to the backend -- same scoping as lib/lambert.ts's and
// lib/orbitExtrapolation.ts's own sanctioned exceptions. Real per-mission
// ephemeris still drives every other view in the app (Optimize/Overview/
// Top-down) unchanged; this is deliberately the one purely decorative
// exception, confined to this file.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import { Html, Line, OrbitControls, Stars } from "@react-three/drei"
import * as THREE from "three"

const SUN_POS = new THREE.Vector3(0, 0, 0)
const GOLD = "#ffc861"

// Compressed display scale (NOT sceneShared.tsx's physical SCENE_SCALE --
// this is its own small decorative unit system, matching the mockup's
// `AU = au => au**0.5 * 115`, chosen so all 8 real orbits fit on screen).
const AU_SCENE = (au: number) => Math.sqrt(au) * 115
const DEMO_EARTH_PERIOD_S = 75 // seconds per lap, decorative pacing only

interface PlanetDef {
  name: string
  au: number
  color: string
  dotPx: number // sphere diameter, CSS px
  th0: number // initial phase angle, radians
  periodS: number
  periodYr: number
  // mockup drawPlanet visual extras (see drawPlanetSprite below)
  bands?: string[]
  ring?: boolean
  earth?: boolean
  mars?: boolean
}

function definePlanet(
  au: number,
  name: string,
  color: string,
  dotPx: number,
  th0: number,
  extra?: Partial<PlanetDef>,
): PlanetDef {
  return { name, au, color, dotPx, th0, periodS: DEMO_EARTH_PERIOD_S * au ** 1.5, periodYr: au ** 1.5, ...extra }
}

// Real semi-major axes (au) and the mockup's exact colors/band palettes/
// feature flags/initial phase spread.
const PLANETS: PlanetDef[] = [
  definePlanet(0.39, "Mercury", "#a89f93", 7, 0.9),
  definePlanet(0.72, "Venus", "#e3cca6", 11, 2.6),
  definePlanet(1.0, "Earth", "#5f9fd4", 12, 0.4, { earth: true }),
  definePlanet(1.52, "Mars", "#d98a66", 9, 4.4, { mars: true }),
  definePlanet(5.2, "Jupiter", "#d9a86c", 24, 3.6, { bands: ["#c2854f", "#e8caa0", "#b57847", "#e3bd8d"] }),
  definePlanet(9.54, "Saturn", "#dcc491", 20, 5.5, { bands: ["#c9ad76", "#e8d7ab"], ring: true }),
  definePlanet(19.19, "Uranus", "#a8dde0", 14, 1.7, { bands: ["#98ccd0", "#bce6e8"] }),
  definePlanet(30.07, "Neptune", "#7292e8", 13, 5.9, { bands: ["#6484d8", "#84a4f0"] }),
]

const CRAFT_SPEED = 9 // scene units/s, tuned for AU_SCENE's compressed range
const TRAIL_LENGTH = 26
const LEG_SAMPLES = 26
const LOOP_SAMPLES = 56
const MAX_ROUTE_POINTS = 12 * LOOP_SAMPLES

export interface PopoverOption {
  key: string
  label: string
  disabled?: boolean
  hint?: string
}

export interface LandingSceneProps {
  route: string[]
  // The route as actually drawn -- normally identical to `route`, except a
  // Sample-return terminal appends the departure body a second time so the
  // spacecraft flies the real return leg too (route itself stays the
  // logical 2-or-more-body chain; this stays a display-only concern).
  displayRoute: string[]
  // Body to ring with a small parking-orbit loop, set only when the route's
  // terminal arrival mode is "orbit".
  orbitBody: string | null
  popoverBody: string | null
  popoverOptions: PopoverOption[]
  popoverShowGo: boolean
  onPlanetClick: (name: string) => void
  onPopoverOption: (key: string) => void
  onPopoverGo: () => void
  onDismiss: () => void
}

type PositionsRef = MutableRefObject<Map<string, THREE.Vector3>>

// Direct port of the mockup's canvas `drawPlanet` routine: a sun-lit sphere
// (offset radial highlight + limb darkening), latitude bands for the gas/ice
// giants, Saturn's ring (far half behind the disc, near half in front),
// Earth's continents + polar cap, Mars' dark region + ice cap. Drawn once
// per planet onto a small offscreen-style <canvas> sprite; the light
// direction is fixed screen-space upper-left (the mockup aimed it at the
// Sun's screen position per frame, but a DOM sprite doesn't rotate with the
// 3D camera, so a fixed direction is the honest equivalent).
function drawPlanetSprite(canvas: HTMLCanvasElement, def: PlanetDef, sizeCss: number) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = sizeCss * dpr
  canvas.height = sizeCss * dpr
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const c = sizeCss / 2
  const r = def.dotPx / 2
  const lx = -0.55
  const ly = -0.5
  const ringRx = r * 2.05
  const ringRy = r * 2.05 * 0.45

  if (def.ring) {
    ctx.strokeStyle = "rgba(214,196,150,0.45)"
    ctx.lineWidth = r * 0.42
    ctx.beginPath()
    ctx.ellipse(c, c, ringRx, ringRy, 0, Math.PI, Math.PI * 2)
    ctx.stroke()
  }

  const g = ctx.createRadialGradient(c + lx * r * 0.5, c + ly * r * 0.5, r * 0.12, c, c, r * 1.04)
  g.addColorStop(0, shade(def.color, 0.32))
  g.addColorStop(0.55, def.color)
  g.addColorStop(1, shade(def.color, -0.78))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(c, c, r, 0, 7)
  ctx.fill()

  ctx.save()
  ctx.beginPath()
  ctx.arc(c, c, r, 0, 7)
  ctx.clip()
  if (def.bands) {
    const n = def.bands.length
    const bh = (2.3 * r) / (n * 2)
    for (let i = 0; i < n * 2; i++) {
      ctx.globalAlpha = 0.3
      ctx.fillStyle = def.bands[i % n]
      ctx.fillRect(c - r, c - r * 1.15 + i * bh, r * 2, bh * 0.82)
    }
    ctx.globalAlpha = 1
  }
  if (def.earth) {
    ctx.fillStyle = "rgba(112,158,92,0.85)"
    ctx.beginPath()
    ctx.ellipse(c - r * 0.3, c - r * 0.18, r * 0.42, r * 0.3, -0.5, 0, 7)
    ctx.fill()
    ctx.beginPath()
    ctx.ellipse(c + r * 0.34, c + r * 0.3, r * 0.3, r * 0.22, 0.4, 0, 7)
    ctx.fill()
    ctx.fillStyle = "rgba(240,246,252,0.85)"
    ctx.beginPath()
    ctx.ellipse(c, c - r * 0.8, r * 0.55, r * 0.22, 0, 0, 7)
    ctx.fill()
  }
  if (def.mars) {
    ctx.fillStyle = "rgba(120,70,50,0.5)"
    ctx.beginPath()
    ctx.ellipse(c + r * 0.15, c + r * 0.1, r * 0.5, r * 0.3, 0.3, 0, 7)
    ctx.fill()
    ctx.fillStyle = "rgba(240,240,235,0.9)"
    ctx.beginPath()
    ctx.ellipse(c, c - r * 0.82, r * 0.34, r * 0.16, 0, 0, 7)
    ctx.fill()
  }
  // re-assert lighting over the surface detail (mockup's overlay pass)
  const o = ctx.createRadialGradient(c + lx * r * 0.55, c + ly * r * 0.55, r * 0.2, c, c, r * 1.02)
  o.addColorStop(0, "rgba(255,255,255,0.12)")
  o.addColorStop(0.6, "rgba(0,0,0,0)")
  o.addColorStop(1, "rgba(4,6,12,0.8)")
  ctx.fillStyle = o
  ctx.fillRect(c - r, c - r, r * 2, r * 2)
  ctx.restore()

  if (def.ring) {
    ctx.strokeStyle = "rgba(224,207,163,0.6)"
    ctx.lineWidth = r * 0.42
    ctx.beginPath()
    ctx.ellipse(c, c, ringRx, ringRy, 0, 0, Math.PI)
    ctx.stroke()
  }
}

// The planet marker. Layout is deliberately shift-proof (real bug:
// the dot visibly moved on hover and whenever a preset put it on
// the route): the Html-centered anchor is a FIXED-size box that never
// changes -- the sprite scales via CSS transform only (no layout change),
// and the name label is absolutely positioned off the box's right edge so
// appearing/disappearing can't re-center anything.
function SkyPlanet({
  def,
  routeCount,
  onClick,
  hoveredRef,
}: {
  def: PlanetDef
  routeCount: number
  onClick: (name: string) => void
  hoveredRef: MutableRefObject<boolean>
}) {
  const [hovered, setHovered] = useState(false)
  // Callback ref, not useRef+useEffect: drei's <Html> attaches its portaled
  // children to the DOM slightly later than a plain child's commit (a real
  // timing race, caught by inspecting the live canvas -- canvasRef.current
  // was still null when a useEffect ran, so the draw call silently no-opped
  // and every sprite stayed at the browser's default blank 300x150 canvas).
  // A callback ref fires exactly when the node actually attaches/detaches,
  // regardless of Html's internal effect ordering.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null)
  const showLabel = hovered || routeCount > 0
  // Box side: sphere + Saturn-ring overhang + a little click padding.
  const boxPx = Math.ceil(def.dotPx * (def.ring ? 2.3 : 1.6)) + 8

  useEffect(() => {
    if (canvasEl) drawPlanetSprite(canvasEl, def, boxPx)
  }, [canvasEl, def, boxPx])

  return (
    <Html center zIndexRange={[40, 0]}>
      <div
        onMouseEnter={() => {
          hoveredRef.current = true
          setHovered(true)
        }}
        onMouseLeave={() => {
          hoveredRef.current = false
          setHovered(false)
        }}
        onClick={(e) => {
          e.stopPropagation()
          onClick(def.name)
        }}
        style={{
          position: "relative",
          width: boxPx,
          height: boxPx,
          cursor: "pointer",
          pointerEvents: "auto",
        }}
      >
        <canvas
          ref={setCanvasEl}
          style={{
            width: boxPx,
            height: boxPx,
            display: "block",
            transform: hovered ? "scale(1.18)" : "scale(1)",
            transition: "transform 0.15s ease, filter 0.15s ease",
            filter: hovered
              ? `drop-shadow(0 0 6px ${def.color}) drop-shadow(0 0 2px ${GOLD})`
              : `drop-shadow(0 0 3px ${def.color}66)`,
          }}
        />
        {/* Always mounted, never conditionally added/removed -- toggling
            visibility this way (instead of {showLabel && <span>...}) was a
            real fix, not a precaution: drei's <Html center> recomputes its
            centering transform when the wrapped content's DOM shape
            changes, and a label mounting/unmounting (even position:
            absolute, which doesn't affect layout size) was enough to
            trigger a visible ~2-6px re-center pop, exactly the "shifts a
 bit on hover / on selecting a preset" ed. */}
        <span
          style={{
            position: "absolute",
            left: "100%",
            top: "50%",
            transform: "translateY(-50%)",
            marginLeft: 2,
            fontFamily: "'Red Hat Mono', Consolas, monospace",
            fontSize: 11,
            letterSpacing: "0.05em",
            color: hovered ? "#e9edf5" : "#8b93a6",
            textShadow: "0 1px 3px #000",
            whiteSpace: "nowrap",
            userSelect: "none",
            pointerEvents: "none",
            opacity: showLabel ? 1 : 0,
          }}
        >
          {def.name.toUpperCase()}
          {routeCount > 1 ? ` ×${routeCount}` : ""}
        </span>
      </div>
    </Html>
  )
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16)
  let r = (n >> 16) & 255
  let g = (n >> 8) & 255
  let b = n & 255
  const t = f < 0 ? 0 : 255
  const a = Math.abs(f)
  r = Math.round(r + (t - r) * a)
  g = Math.round(g + (t - g) * a)
  b = Math.round(b + (t - b) * a)
  return `rgb(${r},${g},${b})`
}

function SunDot() {
  return (
    <Html position={SUN_POS} center style={{ pointerEvents: "none" }} zIndexRange={[40, 0]}>
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "radial-gradient(circle, #fff3d6 0%, #ffc861 55%, rgba(255,200,97,0) 100%)",
          boxShadow: "0 0 22px 8px rgba(255,200,97,0.5)",
        }}
      />
    </Html>
  )
}

// One planet's orbit ring (a perfect circle at the display radius -- since
// positions are computed from the same radius, dots always sit exactly on
// their ring, every frame, by construction) + its live-positioned dot.
function PlanetOrbit({
  def,
  routeCount,
  onClick,
  positionsRef,
}: {
  def: PlanetDef
  routeCount: number
  onClick: (name: string) => void
  positionsRef: PositionsRef
}) {
  const groupRef = useRef<THREE.Group>(null)
  const R = AU_SCENE(def.au)
  const hoveredRef = useRef(false)
  const frozenThRef = useRef<number | null>(null)
  const ringPts = useMemo(() => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2
      pts.push(new THREE.Vector3(R * Math.cos(a), R * Math.sin(a), 0))
    }
    return pts
  }, [R])

  // Reads r3f's own clock directly -- no React state/props needed just to
  // move a dot, which avoids the whole class of "unstable prop reference
  // causes a 60fps re-render cascade" bug hit earlier in this file's history
  // (see git log): nothing here re-renders on a clock tick, only the actual
  // THREE object positions change, imperatively, every frame.
  //
  // Freezes the orbital angle while hovered: a UX fix, not a bug fix -- a
  // rigorous elapsed-time-matched measurement proved there's no layout bug
  // (idle motion over the same real wall-clock time produces the identical
  // displacement), but "the thing you're pointing at keeps sliding out from
  // under the cursor" is a legitimate complaint on its own regardless of
  // root cause, especially for a fast-orbiting body like Mercury at this
  // compressed demo timescale.
  useFrame(({ clock }) => {
    let th: number
    if (hoveredRef.current) {
      if (frozenThRef.current == null) {
        frozenThRef.current = def.th0 + (2 * Math.PI * clock.elapsedTime) / def.periodS
      }
      th = frozenThRef.current
    } else {
      frozenThRef.current = null
      th = def.th0 + (2 * Math.PI * clock.elapsedTime) / def.periodS
    }
    const x = R * Math.cos(th)
    const y = R * Math.sin(th)
    groupRef.current?.position.set(x, y, 0)
    positionsRef.current.set(def.name, new THREE.Vector3(x, y, 0))
  })

  return (
    <>
      <Line points={ringPts} color="#5e6982" opacity={0.3} transparent lineWidth={1} />
      <group ref={groupRef}>
        <SkyPlanet def={def} routeCount={routeCount} onClick={onClick} hoveredRef={hoveredRef} />
      </group>
    </>
  )
}

// Route arcs + resonant loops + the flying spacecraft. Per-leg (index +
// fraction) progress so the craft can't visibly slide backwards as the
// route re-shapes under the moving planets.
function RouteLayer({ route, positionsRef }: { route: string[]; positionsRef: PositionsRef }) {
  const lineObj = useMemo(() => {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_ROUTE_POINTS * 3), 3))
    return new THREE.Line(geom, new THREE.LineBasicMaterial({ color: "#e9edf5", transparent: true, opacity: 0.8 }))
  }, [])
  const trailObj = useMemo(() => {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_LENGTH * 3), 3))
    return new THREE.Line(geom, new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.6 }))
  }, [])
  const craftRef = useRef<THREE.Mesh>(null)
  const progress = useRef({ leg: 0, u: 0 })
  const trail = useRef<THREE.Vector3[]>([])

  useEffect(() => {
    progress.current = { leg: 0, u: 0 }
    trail.current = []
  }, [route])

  useFrame((_, delta) => {
    const positions = positionsRef.current
    const havePts = route.length >= 2 && route.every((name) => positions.has(name))
    lineObj.visible = havePts
    trailObj.visible = havePts
    if (craftRef.current) craftRef.current.visible = havePts
    if (!havePts) return

    const pts: THREE.Vector3[] = []
    const legStart: number[] = []
    for (let i = 0; i < route.length - 1; i++) {
      legStart.push(pts.length)
      const A = positions.get(route[i]) as THREE.Vector3
      const B = positions.get(route[i + 1]) as THREE.Vector3
      if (route[i] === route[i + 1]) {
        const r0 = Math.hypot(A.x, A.y)
        const ang0 = Math.atan2(A.y, A.x)
        for (let q = 0; q <= LOOP_SAMPLES; q++) {
          const s = q / LOOP_SAMPLES
          const th = ang0 + s * Math.PI * 2
          const rf = r0 * (1 + 0.32 * Math.sin(Math.PI * s))
          pts.push(new THREE.Vector3(rf * Math.cos(th), rf * Math.sin(th), 0))
        }
      } else {
        const mid = A.clone().add(B).multiplyScalar(0.5)
        const d = B.clone().sub(A)
        const len = d.length() || 1
        const n = new THREE.Vector3(-d.y, d.x, 0).normalize()
        if (mid.clone().addScaledVector(n, 10).length() < mid.clone().addScaledVector(n, -10).length()) n.negate()
        const ctrl = mid.clone().addScaledVector(n, len * 0.3)
        for (let q = 0; q <= LEG_SAMPLES; q++) {
          const t = q / LEG_SAMPLES
          const u = 1 - t
          pts.push(
            new THREE.Vector3(
              u * u * A.x + 2 * u * t * ctrl.x + t * t * B.x,
              u * u * A.y + 2 * u * t * ctrl.y + t * t * B.y,
              0,
            ),
          )
        }
      }
    }

    const attr = lineObj.geometry.getAttribute("position") as THREE.BufferAttribute
    const count = Math.min(pts.length, MAX_ROUTE_POINTS)
    for (let i = 0; i < count; i++) attr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z)
    attr.needsUpdate = true
    lineObj.geometry.setDrawRange(0, count)

    const legCount = route.length - 1
    if (progress.current.leg >= legCount) progress.current = { leg: 0, u: 0 }
    const start = legStart[progress.current.leg]
    const end = progress.current.leg + 1 < legCount ? legStart[progress.current.leg + 1] : pts.length
    let legLen = 0
    for (let i = start + 1; i < end; i++) legLen += pts[i].distanceTo(pts[i - 1])
    if (legLen > 1) {
      progress.current.u += (delta * CRAFT_SPEED) / legLen
      if (progress.current.u >= 1) {
        progress.current.u = 0
        progress.current.leg = (progress.current.leg + 1) % legCount
        trail.current = []
      }
      const dTarget = progress.current.u * legLen
      let acc = 0
      let pos = pts[start]
      let dir = new THREE.Vector3(1, 0, 0)
      for (let i = start + 1; i < end; i++) {
        const seg = pts[i].distanceTo(pts[i - 1])
        if (acc + seg >= dTarget) {
          const f = seg === 0 ? 0 : (dTarget - acc) / seg
          pos = pts[i - 1].clone().lerp(pts[i], f)
          dir = pts[i].clone().sub(pts[i - 1]).normalize()
          break
        }
        acc += seg
      }
      if (craftRef.current) {
        craftRef.current.position.copy(pos)
        craftRef.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      }
      trail.current.push(pos.clone())
      if (trail.current.length > TRAIL_LENGTH) trail.current.shift()
      const tAttr = trailObj.geometry.getAttribute("position") as THREE.BufferAttribute
      for (let i = 0; i < trail.current.length; i++) tAttr.setXYZ(i, trail.current[i].x, trail.current[i].y, trail.current[i].z)
      tAttr.needsUpdate = true
      trailObj.geometry.setDrawRange(0, trail.current.length)
    }
  })

  return (
    <>
      <primitive object={lineObj} />
      <primitive object={trailObj} />
      <mesh ref={craftRef} visible={false}>
        <coneGeometry args={[3.2, 10, 6]} />
        <meshBasicMaterial color={GOLD} toneMapped={false} />
      </mesh>
    </>
  )
}

function PlanetPopover({
  name,
  options,
  showGo,
  onOption,
  onGo,
  positionsRef,
}: {
  name: string
  options: PopoverOption[]
  showGo: boolean
  onOption: (key: string) => void
  onGo: () => void
  positionsRef: PositionsRef
}) {
  const groupRef = useRef<THREE.Group>(null)
  const def = PLANETS.find((p) => p.name === name)
  useFrame(() => {
    const pos = positionsRef.current.get(name)
    if (pos) groupRef.current?.position.copy(pos)
  })
  const btn: CSSProperties = {
    marginTop: 7,
    textAlign: "center",
    fontSize: 10.5,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    fontWeight: 600,
    padding: "7px 0",
    borderRadius: 9,
    userSelect: "none",
  }
  return (
    <group ref={groupRef}>
      <Html zIndexRange={[50, 41]} style={{ pointerEvents: "none" }}>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            pointerEvents: "auto",
            transform: "translate(18px, -30px)",
            width: 220,
            padding: "12px 16px 14px",
            background: "rgba(10, 14, 24, 0.72)",
            border: "1px solid rgba(233, 237, 245, 0.10)",
            borderRadius: 14,
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
            fontFamily: "'Libre Franklin', system-ui, sans-serif",
            color: "#e9edf5",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
          <div style={{ fontFamily: "'Red Hat Mono', Consolas, monospace", fontSize: 10.5, color: "#8b93a6", marginTop: 3, lineHeight: 1.6 }}>
            {def ? `${def.au.toFixed(2)} au · ${def.periodYr.toFixed(2)} yr` : "…"}
          </div>
          {options.map((opt) => (
            <div key={opt.key}>
              <div
                onClick={opt.disabled ? undefined : () => onOption(opt.key)}
                style={{
                  ...btn,
                  border: `1px solid ${GOLD}73`,
                  color: opt.disabled ? "#5c6376" : GOLD,
                  opacity: opt.disabled ? 0.55 : 1,
                  cursor: opt.disabled ? "not-allowed" : "pointer",
                }}
              >
                {opt.label}
              </div>
              {opt.disabled && opt.hint && (
                <div style={{ fontSize: 9, color: "#6b7288", marginTop: 2, lineHeight: 1.4 }}>{opt.hint}</div>
              )}
            </div>
          ))}
          {showGo && (
            <div onClick={onGo} style={{ ...btn, background: GOLD, color: "#201503", cursor: "pointer" }}>
              Design trajectory →
            </div>
          )}
        </div>
      </Html>
    </group>
  )
}

// Small parking-orbit ring around a body's current position, shown when the
// route's terminal arrival mode is "orbit" -- purely decorative (the real
// capture radius is a mission-config field, not derived from this pixel
// size), same spirit as the rest of this file's schematic sketch fidelity.
function TerminalOrbitRing({ name, positionsRef }: { name: string; positionsRef: PositionsRef }) {
  const groupRef = useRef<THREE.Group>(null)
  const def = PLANETS.find((p) => p.name === name)
  const ringPts = useMemo(() => {
    const r = (def?.dotPx ?? 12) * 0.9
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2
      pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a) * 0.55, 0))
    }
    return pts
  }, [def])
  useFrame(() => {
    const pos = positionsRef.current.get(name)
    if (pos) groupRef.current?.position.copy(pos)
  })
  return (
    <group ref={groupRef}>
      <Line points={ringPts} color={GOLD} opacity={0.75} transparent lineWidth={1.5} dashed dashSize={2} gapSize={1.4} />
    </group>
  )
}

function OrbitingBodies({
  route,
  displayRoute,
  orbitBody,
  popoverBody,
  popoverOptions,
  popoverShowGo,
  onPlanetClick,
  onPopoverOption,
  onPopoverGo,
}: Omit<LandingSceneProps, "onDismiss">) {
  const positionsRef = useRef(new Map<string, THREE.Vector3>())

  return (
    <>
      <SunDot />
      {PLANETS.map((def) => (
        <PlanetOrbit
          key={def.name}
          def={def}
          routeCount={route.filter((n) => n === def.name).length}
          onClick={onPlanetClick}
          positionsRef={positionsRef}
        />
      ))}
      <RouteLayer route={displayRoute} positionsRef={positionsRef} />
      {orbitBody && <TerminalOrbitRing name={orbitBody} positionsRef={positionsRef} />}
      {popoverBody && (
        <PlanetPopover
          name={popoverBody}
          options={popoverOptions}
          showGo={popoverShowGo}
          onOption={onPopoverOption}
          onGo={onPopoverGo}
          positionsRef={positionsRef}
        />
      )}
    </>
  )
}

export function LandingScene(props: LandingSceneProps) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#05070d" }}>
      <Canvas
        // up: [0,0,1] -- the orbital plane here is the XY plane (z=0), so the
        // camera's pole axis must be Z, not Three.js's default Y. Without
        // this, OrbitControls' autoRotate spins around the wrong axis
        // entirely and the whole system reads as tumbling instead of
        // precessing cleanly around the ecliptic normal (real bug, caught
        // by
        // rotating around its z axis").
        // Real bug, found (UX audit): at this camera's original
        // distance ([0,-900,420]), Neptune's ring (the outermost, always
        // visible regardless of route) clipped off the right edge of the
        // frame at common desktop widths -- the first-impression view of
        // the whole product. Pulled back along the same direction (same
        // viewing angle, just farther) so the full outer solar system
        // fits comfortably; still well inside OrbitControls' own
        // maxDistance below, so manual zoom range is unaffected.
        camera={{ fov: 50, near: 0.1, far: 20_000, position: [0, -1170, 546], up: [0, 0, 1] }}
        onPointerMissed={props.onDismiss}
      >
        <color attach="background" args={["#05070d"]} />
        <Stars radius={4000} depth={1500} count={5000} factor={4} fade speed={0} />
        <OrbitingBodies {...props} />
        <OrbitControls
          enableDamping
          dampingFactor={0.08}
          autoRotate
          autoRotateSpeed={0.35}
          minDistance={60}
          maxDistance={2400}
        />
      </Canvas>
    </div>
  )
}
