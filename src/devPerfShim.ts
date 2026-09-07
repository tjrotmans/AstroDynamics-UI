// DEV-ONLY. Must be the FIRST import in main.tsx (module evaluation order),
// before react-dom is loaded.
//
// React 19.2's development build feeds the Chrome DevTools "Components ⚛"
// performance track by deep-diffing every re-rendered component's changed
// props (react-dom-client.development.js: addObjectDiffToProperties, up to
// three levels, enumerating every array element) inside flushPassiveEffects
// -- whenever `console.timeStamp` and `performance.measure` exist, i.e.
// always in Chrome, whether or not DevTools is open. Measured 
// (instrumented Playwright run on the real GPU, `.scratch/
// repro_freeze_2026-08-31.cjs`): a single ~6 s synchronous pass at the end
// of every mission run and 240-400 ms passes on every stream flush, purely
// from diffing the 20k-element `steps` prop -- the reported "page freezes
// with no error". Production builds have none of this. Removing
// `console.timeStamp` before React loads makes React's `supportsUserTiming`
// false and disables the whole track (no other React behavior depends on
// it). Nothing else in this app uses console.timeStamp.
if (import.meta.env.DEV && typeof console !== "undefined" && typeof console.timeStamp === "function") {
  Object.defineProperty(console, "timeStamp", { value: undefined, configurable: true, writable: true })
}
