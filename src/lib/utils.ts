import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Julian date -> the backend's epoch wire format ("YYYY-MM-DDTHH:MM:SS UTC").
// Calendar conversion only (JD 2440587.5 = 1970-01-01T00:00 UTC), not physics
// -- used to turn a result's dep_jd into a seed for another tool's epoch
// field. Ignores the ~69s UTC/TT offset; irrelevant at day-scale windows.
export function jdToEpochString(jd: number): string {
  const iso = new Date((jd - 2440587.5) * 86_400_000).toISOString()
  return `${iso.slice(0, 19)} UTC`
}

// Inverse of jdToEpochString -- the backend's wire format back to a Julian
// date, for reconstructing encounter epochs from a candidate's departure
// offset + per-leg TOF client-side (no backend round-trip needed).
export function epochStringToJd(epoch: string): number {
  const iso = epoch.replace(" UTC", "Z")
  return Date.parse(iso) / 86_400_000 + 2440587.5
}

// The backend's epoch wire format ("YYYY-MM-DDTHH:MM:SS UTC") <-> a native
// <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM[:SS]"). Shared by
// EpochField and the Study paper's inline date editor so both stay in sync
// with exactly one conversion, not two copies that could drift.
export function epochToDatetimeLocal(epoch: string | null | undefined): string {
  if (!epoch) return ""
  const m = epoch.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/)
  return m ? m[1] : ""
}

export function datetimeLocalToEpoch(inputValue: string): string | null {
  if (!inputValue) return null
  const withSeconds = inputValue.length === 16 ? `${inputValue}:00` : inputValue
  return `${withSeconds} UTC`
}
