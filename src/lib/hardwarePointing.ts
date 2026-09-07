import type { HardwareItem } from "@/api/client"

// A placed hardware item's real pointing vector, when it has one -- shared
// between CruiseReplayPage's mode preview and GncModesEditor.tsx so both
// read the exact same ground truth instead of two independent guesses at
// "which field on this union member is the pointing vector."
export function hardwarePointingVector(item: HardwareItem): number[] | null {
  if ("boresight" in item && Array.isArray(item.boresight)) return item.boresight
  if ("normal" in item && Array.isArray(item.normal)) return item.normal
  if ("direction" in item && Array.isArray(item.direction)) return item.direction
  return null
}

export function fmtVec(v: number[] | null): string {
  if (!v) return "—"
  return `[${v.map((x) => x.toFixed(2)).join(", ")}]`
}

export function hardwareLabel(item: HardwareItem, index: number): string {
  return `[${index}] ${item.type}`
}
