import { Line } from "@react-three/drei"

import type { Vec3 } from "@/lib/vehicleGeometry"

// Same X/Y/Z red/green/blue convention as VehicleViewport.tsx's own
// (private) AxesTriad and the fixed-corner GizmoHelper added to that
// viewport -- kept as one shared, exported component (rather than a third
// copy) specifically so every small standalone diagram (WheelClusterDiagram,
// ThrusterDiagram) reads the SAME body-frame axes as the real viewport,
// letting a user correlate "this spin axis in the small diagram" with "this
// direction on the real spacecraft" without having to remember a different
// color/direction convention per view.
const AXES: { dir: Vec3; color: string }[] = [
  { dir: [1, 0, 0], color: "#ff6b6b" },
  { dir: [0, 1, 0], color: "#5fd97a" },
  { dir: [0, 0, 1], color: "#5fa8ff" },
]

export function BodyAxesTriad({ size }: { size: number }) {
  return (
    <group>
      {AXES.map((a, i) => (
        <Line
          key={i}
          points={[
            [0, 0, 0],
            [a.dir[0] * size, a.dir[1] * size, a.dir[2] * size],
          ]}
          color={a.color}
          lineWidth={1.5}
        />
      ))}
    </group>
  )
}
