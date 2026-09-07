import { useEffect, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"
import * as THREE from "three"

import { CAMERA_FLY_DURATION_S, FOLLOW_CAMERA_OFFSET_DIR, smoothstep } from "./sceneShared"

// design review finding F -- CruiseReplayView's SceneCamera used
// to be a parallel reimplementation of Phase 01's free-camera mode
// (OptimizeTrajectoryView's CameraController "paused" branch: plain
// OrbitControls + click-to-focus fly-in + double-click-empty-space reset),
// converging on it one user complaint at a time with its own drifted
// min/maxDistance formulas and easing. This is that mode extracted into ONE
// real shared component, built from the SAME primitives (CAMERA_FLY_DURATION_S,
// FOLLOW_CAMERA_OFFSET_DIR, smoothstep) OptimizeTrajectoryView's own
// CameraController already imports from sceneShared -- so a future tuning
// change to either can't drift the two apart the way two independent
// reimplementations already had. Phase 01's CameraController keeps its own
// playback/chase-camera machinery untouched (this component only covers the
// free/idle mode, which is all Phase 03 ever needed); mounting THIS
// component there too, instead of its bespoke idle/fitAll/focus fly-in
// logic, is real future work (noted, not done here -- CameraController is a
// heavily user-tuned ~40-round-reviewed state machine, and swapping its
// idle-mode internals out from under its playback logic is a separate,
// higher-risk change than giving Phase 03 real parity).
export const FREE_CAMERA_MOUSE_BUTTONS = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
export const FREE_CAMERA_DAMPING = 0.08
export const FREE_CAMERA_ZOOM_SPEED = 1.4

export interface FreeCameraFocusRequest {
  pos: THREE.Vector3
  version: number
  radiusScene?: number
}

export function FreeCameraControls({
  closeDist,
  wideDist,
  focusPoint,
  focusRequest,
  resetTrigger,
  cameraDirRef,
}: {
  /** Close-up framing distance (a body/vehicle scale) -- drives minDistance, same formula as OptimizeTrajectoryView's closeDistDeparture-based minDistance. */
  closeDist: number
  /** "Fit all" framing distance (the whole mission span) -- drives maxDistance AND the double-click reset's resting distance. */
  wideDist: number
  /** Where the camera settles on mount / after a reset (usually the origin/Sun). */
  focusPoint: THREE.Vector3
  /** Click-to-focus request, e.g. from a PlanetBody's onFocus (already useClickNotDrag-protected internally). */
  focusRequest?: FreeCameraFocusRequest
  /** Bump to trigger a fly-in back to `focusPoint` at `wideDist` -- caller wires this to a double-click-empty-space handler. */
  resetTrigger?: number
  /** Written every frame with the camera's current look direction (unit vector) -- for a picture-in-picture view to mirror. */
  cameraDirRef?: React.RefObject<THREE.Vector3>
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null)

  // Zoom toward the pointer position, not the orbit target -- the exact
  // same activation Phase 01's CameraController (OptimizeTrajectoryView)
  // and OverviewTrajectoryView already do on their own controls. Confirmed
  // parity gap ("can't zoom to where my mouse
  // is" -- Phase 01 has this, this shared free camera didn't). Same `any`
  // cast as those two mounts: three-stdlib's OrbitControls type predates
  // the zoomToCursor property, but the runtime (three 0.185) supports it.
  useEffect(() => {
    if (controlsRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(controlsRef.current as any).zoomToCursor = true
    }
  })

  const prevFocusVersionRef = useRef<number | undefined>(undefined)
  const focusFlyElapsedRef = useRef(Infinity)
  const focusFlyStartPosRef = useRef(new THREE.Vector3())
  const focusFlyStartTargetRef = useRef(new THREE.Vector3())
  const prevResetTriggerRef = useRef<number | undefined>(resetTrigger)
  const resetFlyElapsedRef = useRef(Infinity)
  const resetFlyStartPosRef = useRef(new THREE.Vector3())
  const resetFlyStartTargetRef = useRef(new THREE.Vector3())

  useFrame((state, delta) => {
    // Click-to-focus fly-in -- exact same math as CameraController's own
    // focusRequest branch (OptimizeTrajectoryView.tsx).
    if (focusRequest && focusRequest.version !== prevFocusVersionRef.current) {
      prevFocusVersionRef.current = focusRequest.version
      focusFlyElapsedRef.current = 0
      focusFlyStartPosRef.current.copy(state.camera.position)
      focusFlyStartTargetRef.current.copy(controlsRef.current?.target ?? focusRequest.pos)
    }
    const focusFlying = focusFlyElapsedRef.current < CAMERA_FLY_DURATION_S
    if (focusFlying && focusRequest) {
      focusFlyElapsedRef.current += delta
      const t = smoothstep(0, CAMERA_FLY_DURATION_S, focusFlyElapsedRef.current)
      const focusDist = focusRequest.radiusScene != null ? Math.max(focusRequest.radiusScene * 6, 0.05) : closeDist
      const desiredPos = focusRequest.pos.clone().add(FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(focusDist))
      state.camera.position.lerpVectors(focusFlyStartPosRef.current, desiredPos, t)
      state.camera.up.set(0, 0, 1)
      const tgt = focusFlyStartTargetRef.current.clone().lerp(focusRequest.pos, t)
      state.camera.lookAt(tgt)
      if (controlsRef.current) {
        controlsRef.current.enabled = false
        controlsRef.current.target.copy(tgt)
      }
      if (cameraDirRef) writeCameraDir(state.camera, controlsRef.current, cameraDirRef)
      return
    }

    // Double-click-empty-space reset -- flies back to focusPoint at wideDist,
    // same fly-in duration/easing as the focus-click path.
    if (resetTrigger !== undefined && resetTrigger !== prevResetTriggerRef.current) {
      prevResetTriggerRef.current = resetTrigger
      resetFlyElapsedRef.current = 0
      resetFlyStartPosRef.current.copy(state.camera.position)
      resetFlyStartTargetRef.current.copy(controlsRef.current?.target ?? focusPoint)
    }
    const resetFlying = resetFlyElapsedRef.current < CAMERA_FLY_DURATION_S
    if (resetFlying) {
      resetFlyElapsedRef.current += delta
      const t = smoothstep(0, CAMERA_FLY_DURATION_S, resetFlyElapsedRef.current)
      const desiredPos = focusPoint.clone().add(FOLLOW_CAMERA_OFFSET_DIR.clone().multiplyScalar(wideDist))
      state.camera.position.lerpVectors(resetFlyStartPosRef.current, desiredPos, t)
      state.camera.up.set(0, 0, 1)
      const tgt = resetFlyStartTargetRef.current.clone().lerp(focusPoint, t)
      state.camera.lookAt(tgt)
      if (controlsRef.current) {
        controlsRef.current.enabled = false
        controlsRef.current.target.copy(tgt)
      }
      if (cameraDirRef) writeCameraDir(state.camera, controlsRef.current, cameraDirRef)
      return
    }

    if (controlsRef.current) controlsRef.current.enabled = true
    if (cameraDirRef) writeCameraDir(state.camera, controlsRef.current, cameraDirRef)
  })

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={FREE_CAMERA_DAMPING}
      makeDefault
      zoomSpeed={FREE_CAMERA_ZOOM_SPEED}
      minDistance={Math.max(closeDist * 0.15, 0.05)}
      maxDistance={wideDist * 15}
      mouseButtons={FREE_CAMERA_MOUSE_BUTTONS}
    />
  )
}

function writeCameraDir(
  camera: THREE.Camera,
  controls: OrbitControlsImpl | null,
  cameraDirRef: React.RefObject<THREE.Vector3>,
) {
  const target = controls?.target
  if (!target) return
  const offset = camera.position.clone().sub(target)
  if (offset.lengthSq() > 1e-12) cameraDirRef.current.copy(offset).normalize()
}
