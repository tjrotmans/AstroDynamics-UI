// Approximate real ephemeris for the major planets, from public J2000 mean
// orbital elements + linear per-century rates -- NOT a real ANISE/DE440S
// ephemeris fetch.
//
// SANCTIONED EXCEPTION to "no physics constants in the frontend"),
// same category as lib/lambert.ts and LandingScene.tsx's circular-orbit
// table: user-approved ("for every planet look up their Kepler
// elements, and from this draw their ephemeris... will not be perfect but at
// least better than the circular assumption"). Hard scope limit, same as the
// other two exceptions: nothing computed here may ever feed a number the
// user reads as a mission result or a value sent to the backend -- decorative
// orbit rings and background-planet positions ONLY. The real per-mission
// arc/burns/target position always come from the backend's actual propagated
// result; this module never touches that data.
//
// Source: JPL Solar System Dynamics, "Keplerian Elements for Approximate
// Positions of the Major Planets" (E.M. Standish, 1992), valid 1800 AD -
// 2050 AD -- the standard, widely-published low-precision planetary
// ephemeris. Elements are mean-of-date w.r.t. the mean ecliptic and equinox
// of J2000, so the result is a smooth, real-shaped ellipse (position
// accurate to within a fraction of a degree over the valid range) -- not
// exact like a real ANISE query, but not a circle either.
//
// If this ever needs more than decorative rings/background dots (heavier
// per-frame cost, precision that matters, more callers), the right move is
// a real backend endpoint (e.g. proper elements added to /api/bodies) --
// same escape hatch the other two exceptions document.

export interface KeplerElements {
  /** Semi-major axis at J2000 [AU] and its rate [AU/century]. */
  a0: number
  aDot: number
  /** Eccentricity at J2000 and its rate [1/century]. */
  e0: number
  eDot: number
  /** Inclination at J2000 [deg] and its rate [deg/century]. */
  i0: number
  iDot: number
  /** Mean longitude at J2000 [deg] and its rate [deg/century]. */
  l0: number
  lDot: number
  /** Longitude of perihelion (ϖ = Ω + ω) at J2000 [deg] and its rate. */
  peri0: number
  periDot: number
  /** Longitude of ascending node (Ω) at J2000 [deg] and its rate. */
  node0: number
  nodeDot: number
}

// Standish 1992 table, EM Bary used for Earth (barycentric, close enough for
// a decorative ring/dot -- the real per-mission Earth position always comes
// from the backend's own ANISE query, never this table).
export const PLANET_ELEMENTS: Record<string, KeplerElements> = {
  Mercury: { a0: 0.38709927, aDot: 0.00000037, e0: 0.20563593, eDot: 0.00001906, i0: 7.00497902, iDot: -0.00594749, l0: 252.2503235, lDot: 149472.67411175, peri0: 77.45779628, periDot: 0.16047689, node0: 48.33076593, nodeDot: -0.12534081 },
  Venus: { a0: 0.72333566, aDot: 0.0000039, e0: 0.00677672, eDot: -0.00004107, i0: 3.39467605, iDot: -0.0007889, l0: 181.9790995, lDot: 58517.81538729, peri0: 131.60246718, periDot: 0.00268329, node0: 76.67984255, nodeDot: -0.27769418 },
  Earth: { a0: 1.00000261, aDot: 0.00000562, e0: 0.01671123, eDot: -0.00004392, i0: -0.00001531, iDot: -0.01294668, l0: 100.46457166, lDot: 35999.37244981, peri0: 102.93768193, periDot: 0.32327364, node0: 0, nodeDot: 0 },
  Mars: { a0: 1.52371034, aDot: 0.00001847, e0: 0.0933941, eDot: 0.00007882, i0: 1.84969142, iDot: -0.00813131, l0: -4.55343205, lDot: 19140.30268499, peri0: -23.94362959, periDot: 0.44441088, node0: 49.55953891, nodeDot: -0.29257343 },
  Jupiter: { a0: 5.202887, aDot: -0.00011607, e0: 0.04838624, eDot: -0.00013253, i0: 1.30439695, iDot: -0.00183714, l0: 34.39644051, lDot: 3034.74612775, peri0: 14.72847983, periDot: 0.21252668, node0: 100.47390909, nodeDot: 0.20469106 },
  Saturn: { a0: 9.53667594, aDot: -0.0012506, e0: 0.05386179, eDot: -0.00050991, i0: 2.48599187, iDot: 0.00193609, l0: 49.95424423, lDot: 1222.49362201, peri0: 92.59887831, periDot: -0.41897216, node0: 113.66242448, nodeDot: -0.28867794 },
  Uranus: { a0: 19.18916464, aDot: -0.00196176, e0: 0.04725744, eDot: -0.00004397, i0: 0.77263783, iDot: -0.00242939, l0: 313.23810451, lDot: 428.48202785, peri0: 170.9542763, periDot: 0.40805281, node0: 74.01692503, nodeDot: 0.04240589 },
  Neptune: { a0: 30.06992276, aDot: 0.00026291, e0: 0.00859048, eDot: 0.00005105, i0: 1.77004347, iDot: 0.00035372, l0: -55.12002969, lDot: 218.45945325, peri0: 44.96476227, periDot: -0.32241464, node0: 131.78422574, nodeDot: -0.00508664 },
}

const AU_M = 1.495978707e11
const DEG = Math.PI / 180

function normalizeDeg(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

// Kepler's equation E - e sin(E) = M, Newton's method (converges in a
// handful of iterations for the eccentricities involved here, all < 0.21).
function solveEccentricAnomaly(mRad: number, e: number): number {
  let E = mRad
  for (let i = 0; i < 20; i++) {
    const dE = (E - e * Math.sin(E) - mRad) / (1 - e * Math.cos(E))
    E -= dE
    if (Math.abs(dE) < 1e-10) break
  }
  return E
}

/** Heliocentric ecliptic J2000 position [m] at a given Julian date. */
export function keplerPositionM(elements: KeplerElements, jd: number): [number, number, number] {
  const t = (jd - 2451545.0) / 36525
  const a = elements.a0 + elements.aDot * t
  const e = elements.e0 + elements.eDot * t
  const iDeg = elements.i0 + elements.iDot * t
  const lDeg = elements.l0 + elements.lDot * t
  const periDeg = elements.peri0 + elements.periDot * t
  const nodeDeg = elements.node0 + elements.nodeDot * t

  const omega = (periDeg - nodeDeg) * DEG // argument of perihelion
  const node = nodeDeg * DEG
  const inc = iDeg * DEG
  const mDeg = normalizeDeg(lDeg - periDeg)
  const E = solveEccentricAnomaly(mDeg * DEG, e)

  const xOrb = a * (Math.cos(E) - e)
  const yOrb = a * Math.sqrt(1 - e * e) * Math.sin(E)

  const cosO = Math.cos(omega)
  const sinO = Math.sin(omega)
  const cosN = Math.cos(node)
  const sinN = Math.sin(node)
  const cosI = Math.cos(inc)
  const sinI = Math.sin(inc)

  const xAu = (cosO * cosN - sinO * sinN * cosI) * xOrb + (-sinO * cosN - cosO * sinN * cosI) * yOrb
  const yAu = (cosO * sinN + sinO * cosN * cosI) * xOrb + (-sinO * sinN + cosO * cosN * cosI) * yOrb
  const zAu = sinO * sinI * xOrb + cosO * sinI * yOrb

  return [xAu * AU_M, yAu * AU_M, zAu * AU_M]
}

// Ring/ellipse shape at a given epoch (element precession is slow enough
// that one epoch's shape is a good decorative approximation for the ring
// itself -- only the body's own moving dot needs per-frame position).
export function keplerOrbitRingPointsM(elements: KeplerElements, jd: number, samples = 128): [number, number, number][] {
  const t = (jd - 2451545.0) / 36525
  const a = elements.a0 + elements.aDot * t
  const e = elements.e0 + elements.eDot * t
  const iDeg = elements.i0 + elements.iDot * t
  const periDeg = elements.peri0 + elements.periDot * t
  const nodeDeg = elements.node0 + elements.nodeDot * t

  const omega = (periDeg - nodeDeg) * DEG
  const node = nodeDeg * DEG
  const inc = iDeg * DEG
  const cosO = Math.cos(omega)
  const sinO = Math.sin(omega)
  const cosN = Math.cos(node)
  const sinN = Math.sin(node)
  const cosI = Math.cos(inc)
  const sinI = Math.sin(inc)

  const points: [number, number, number][] = []
  for (let k = 0; k <= samples; k++) {
    const E = (k / samples) * 2 * Math.PI
    const xOrb = a * (Math.cos(E) - e)
    const yOrb = a * Math.sqrt(1 - e * e) * Math.sin(E)
    const xAu = (cosO * cosN - sinO * sinN * cosI) * xOrb + (-sinO * cosN - cosO * sinN * cosI) * yOrb
    const yAu = (cosO * sinN + sinO * cosN * cosI) * xOrb + (-sinO * sinN + cosO * cosN * cosI) * yOrb
    const zAu = sinO * sinI * xOrb + cosO * sinI * yOrb
    points.push([xAu * AU_M, yAu * AU_M, zAu * AU_M])
  }
  return points
}
