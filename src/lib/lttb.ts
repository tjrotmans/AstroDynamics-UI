// Largest-Triangle-Three-Buckets downsampling (Steinarsson 2013) -- the
// standard way telemetry dashboards keep line charts faithful to peaks
// while never handing the renderer more points than the screen can show.
//
// Why this exists (freeze investigation, measured with an
// instrumented Playwright run against the live app): after ONE mission run
// the page's JS heap oscillated between ~160 MB and ~800 MB, with a 2.9 s
// main-thread stall right after the run finished and ~0.3-0.5 s stalls on
// every zoom. Six Plotly SVG figures × up to 15 traces × ~20k points each
// is ~1.5 M SVG-path points; Plotly's per-point calcdata objects make each
// relayout allocate hundreds of MB transiently, and a session with two or
// three runs walks the renderer toward its memory ceiling -- which in
// Chrome presents as exactly the reported symptom: a tab that stops
// responding with no error. A 1,600 px-wide figure cannot display more
// than ~1,600 distinct x positions, so every trace is downsampled to
// `threshold` points (default 1,200) before Plotly ever sees it; the
// zoomed-in views are already windowed upstream and pass through unchanged
// when they're small.
//
// `y` may contain nulls (a gap -- e.g. "while burning" traces). Gaps are
// preserved: each non-null run is downsampled on its own and runs are
// re-joined with a single null so Plotly still breaks the line there.

function lttbRun(x: number[], y: number[], threshold: number): { x: number[]; y: number[] } {
  const n = x.length
  if (threshold >= n || threshold < 3) return { x, y }
  const ox: number[] = [x[0]]
  const oy: number[] = [y[0]]
  const every = (n - 2) / (threshold - 2)
  let a = 0
  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = Math.floor((i + 1) * every) + 1
    const rangeEnd = Math.min(Math.floor((i + 2) * every) + 1, n)
    let avgX = 0
    let avgY = 0
    for (let j = rangeStart; j < rangeEnd; j++) {
      avgX += x[j]
      avgY += y[j]
    }
    const len = rangeEnd - rangeStart
    avgX /= len
    avgY /= len
    const bucketStart = Math.floor(i * every) + 1
    const bucketEnd = Math.min(Math.floor((i + 1) * every) + 1, n)
    const ax = x[a]
    const ay = y[a]
    let maxArea = -1
    let next = bucketStart
    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs((ax - avgX) * (y[j] - ay) - (ax - x[j]) * (avgY - ay))
      if (area > maxArea) {
        maxArea = area
        next = j
      }
    }
    ox.push(x[next])
    oy.push(y[next])
    a = next
  }
  ox.push(x[n - 1])
  oy.push(y[n - 1])
  return { x: ox, y: oy }
}

export function decimateTrace(
  x: number[],
  y: (number | null | undefined)[],
  threshold = 1200,
): { x: (number | null)[]; y: (number | null)[] } {
  if (x.length <= threshold) return { x, y: y.map((v) => (v == null ? null : v)) }
  // Split into non-null runs.
  const runs: { x: number[]; y: number[] }[] = []
  let rx: number[] = []
  let ry: number[] = []
  for (let i = 0; i < x.length; i++) {
    const v = y[i]
    if (v == null || Number.isNaN(v)) {
      if (rx.length) runs.push({ x: rx, y: ry })
      rx = []
      ry = []
    } else {
      rx.push(x[i])
      ry.push(v)
    }
  }
  if (rx.length) runs.push({ x: rx, y: ry })
  const total = runs.reduce((s, r) => s + r.x.length, 0)
  if (total === 0) return { x: [], y: [] }
  const outX: (number | null)[] = []
  const outY: (number | null)[] = []
  runs.forEach((r, k) => {
    const share = Math.max(3, Math.round((threshold * r.x.length) / total))
    const d = lttbRun(r.x, r.y, share)
    if (k > 0) {
      outX.push(null)
      outY.push(null)
    }
    outX.push(...d.x)
    outY.push(...d.y)
  })
  return { x: outX, y: outY }
}
