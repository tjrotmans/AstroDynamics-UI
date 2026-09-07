// URL-driven debug switches for performance triage (freeze
// investigation). Read once at module load; harmless in normal use (no
// flags = no effect). Example: http://localhost:5173/?noLabels=1&noPip=1
const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams()

export const DEBUG_FLAGS = {
  /** Skip every drei <Html> label in the Phase 03 attitude/trajectory scenes. */
  noLabels: params.get("noLabels") === "1",
  /** Do not mount the Phase 03 corner picture-in-picture canvas at all. */
  noPip: params.get("noPip") === "1",
}
