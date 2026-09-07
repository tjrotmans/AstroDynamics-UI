// 2K equirectangular texture maps from Solar System Scope
// (https://www.solarsystemscope.com/textures/), CC BY 4.0 -- see
// public/textures/planets/CREDITS.md. Covers every body this app's
// catalog has a real texture for; bodies not listed here (small
// bodies/asteroids -- Bennu, Apophis, Ryugu, Eros, Didymos, Phobos, Deimos)
// have no real texture available and fall back to a plain shaded sphere.
const PLANET_TEXTURE_FILES: Record<string, string> = {
  Sun: "2k_sun.jpg",
  Mercury: "2k_mercury.jpg",
  Venus: "2k_venus_surface.jpg",
  Earth: "2k_earth_daymap.jpg",
  Mars: "2k_mars.jpg",
  Jupiter: "2k_jupiter.jpg",
  Saturn: "2k_saturn.jpg",
  Uranus: "2k_uranus.jpg",
  Neptune: "2k_neptune.jpg",
  Moon: "2k_moon.jpg",
}

export function planetTexturePathFor(bodyName: string | undefined): string | undefined {
  if (!bodyName) return undefined
  const file = PLANET_TEXTURE_FILES[bodyName]
  return file ? `/textures/planets/${file}` : undefined
}
