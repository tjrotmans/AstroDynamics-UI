import type { StateStorage } from "zustand/middleware"

// Shared localStorage wrapper for every persisted store (direct
// user feedback: "the frontend sometimes fails/crashes, I then need to
// reload and lose everything I did"). A plain `localStorage` write can throw
// (quota exceeded -- a large MGA scan result or porkchop grid is the
// realistic way to hit this, not typical mission config) mid-update; letting
// that exception propagate out of a zustand persist call would be worse than
// just not persisting that one update, so every store shares this
// swallow-and-warn wrapper instead of throwing.
export const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value)
    } catch (err) {
      console.warn(`Persisting "${name}" failed (likely storage quota) -- this update won't survive a reload.`, err)
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // ignore
    }
  },
}
