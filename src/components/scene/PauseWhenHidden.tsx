import { useEffect } from "react"
import { useThree } from "@react-three/fiber"

import { useUiStore, type Tool } from "@/stores/uiStore"

// Pauses a react-three-fiber render loop while the tree that owns it is
// CSS-hidden (App.tsx keeps StudyView / the GNC shell / CruiseReplayPage
// mounted but `display:none` when another tool is active, so their
// WebSocket jobs survive navigation). A hidden <canvas> still runs its
// requestAnimationFrame loop and issues every WebGL draw call -- the
// compositor just never shows the result.
//
// Measured (CPU sampling profile of the Phase 03 page during
// timeline gestures, `.scratch/repro_freeze_2026-08-31.cjs`): the main
// thread was idle 0.4 s out of 75.8 s, with 57 s in native render work
// and three.js shader-program setup near the top of the JS list -- while
// FOUR WebGL scenes were rendering at 60 fps (Phase 01's cinematic view
// and Phase 02's vehicle viewport invisibly, plus Phase 03's two). On a
// GPU-constrained or software-rendered machine that is exactly a tab that
// stops responding with no error. Mount this once inside each <Canvas>
// with the tool that owns it; it costs nothing while visible.
export function PauseWhenHidden({ tool }: { tool: Tool }) {
  const setFrameloop = useThree((s) => s.setFrameloop)
  const activeTool = useUiStore((s) => s.activeTool)
  const atLanding = useUiStore((s) => s.atLanding)
  const visible = !atLanding && activeTool === tool
  useEffect(() => {
    setFrameloop(visible ? "always" : "never")
  }, [visible, setFrameloop])
  return null
}
