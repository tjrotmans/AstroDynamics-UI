import { useState } from "react"

import type { VehicleProperties } from "@/api/client"
import { InlineEditField } from "@/components/Study/InlineEditField"
import { PaperDisclosure, PaperSelect } from "@/components/Study/paperForm"
import { SRP_MODELS } from "@/lib/srpModels"
import { StageCard } from "@/components/Study/StageCard"
import { SlewTestPanel } from "@/components/Vehicle/SlewTestPanel"
import { SlewTestMonteCarlo } from "@/components/Vehicle/SlewTestMonteCarlo"
import { WheelClusterDiagram } from "@/components/Vehicle/WheelClusterDiagram"
import { useHardwareCatalog } from "@/hooks/useApi"
import { useMissionStore } from "@/stores/missionStore"
import { useUiStore } from "@/stores/uiStore"
import { useVehicleUiStore, type PanelPlacement, type ThrusterPlacement } from "@/stores/vehicleUiStore"
import { useVehicleBoresightUiStore, type BoresightPlacement } from "@/stores/vehicleBoresightUiStore"
import {
  CANT_RANGE_DEG,
  CLOCK_RANGE_DEG,
  PITCH_RANGE_DEG,
  ROLL_RANGE_DEG,
  YAW_RANGE_DEG,
  TILT_RANGE_DEG,
  SPIN_RANGE_DEG,
  clampBoresightAnglesDeg,
  clampRotationDeg,
  clampThrusterAnglesDeg,
  clampToFace,
  compileBoresightItem,
  compileSolarPanel,
  compileThruster,
  decomposeBoresightItem,
  decomposeSolarPanel,
  decomposeThruster,
  FACES,
  FACE_NAMES,
  overhangMarginM,
  THRUSTER_OVERHANG_MARGIN_M,
  torqueAuthority,
  type Vec3,
} from "@/lib/vehicleGeometry"

const BORESIGHT_OVERHANG_MARGIN_M = 0.1
const BORESIGHT_LABEL: Record<string, string> = {
  StarTracker: "Star tracker",
  OpNavCamera: "OpNav camera",
  Lidar: "Lidar",
  CommAntenna: "Comm antenna",
}

const AXIS_LABELS = ["X", "Y", "Z"]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className="py-1 pr-2 text-[#55524b]">{label}</td>
      <td className="py-1 text-right">{children}</td>
    </tr>
  )
}

// the backend schema work (the design notes "Spacecraft Configuration Builder"
// section) found this exact gap: the srp_model selector already existed in
// PhysicsFields.tsx (Memo 01's Optimizer section), but nowhere near where a
// user actually PLACES SolarPanel/CustomPlate geometry -- so a user could
// carefully place panels under Cannonball and see no effect anywhere, with
// no explanation. This surfaces the same selector here, plus a warning when
// placed geometry exists but Cannonball is active (Cannonball is
// attitude-independent by definition -- placement/orientation genuinely
// cannot matter to it, see GNC_MANUAL.md §4.1). Reuses SRP_MODELS from
// PhysicsFields.tsx rather than duplicating the option list/hints.
function SrpModelBanner() {
  const srpModel = useMissionStore((s) => s.config.spacecraft.srp_model)
  const setSrpModel = useMissionStore((s) => s.setSrpModel)
  const hardware = useMissionStore((s) => s.config.spacecraft.hardware)

  const placedGeometryCount = hardware.filter(
    (h) => h.type === "CustomPlate" || (h.type === "SolarPanel" && h.position_m != null && h.normal != null),
  ).length

  const isCannonball = srpModel === "Cannonball"

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border border-[#d8d4c8] bg-[#f4f2ea] px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <label htmlFor="vehicle-srp-model" className="text-[10px] font-bold tracking-[0.1em] text-[#8b877d] uppercase">
          SRP model
        </label>
        <PaperSelect
          id="vehicle-srp-model"
          value={srpModel}
          options={SRP_MODELS.map((s) => ({ value: s.value, label: s.value }))}
          onChange={(value) => setSrpModel(value)}
        />
      </div>
      <span className="text-[11px] text-[#8b877d]">{SRP_MODELS.find((s) => s.value === srpModel)?.hint}</span>
      {isCannonball && placedGeometryCount > 0 && (
        <span className="text-[11px] font-semibold text-[#b5651d]">
          {placedGeometryCount} placed panel{placedGeometryCount === 1 ? "" : "s"}/plate
          {placedGeometryCount === 1 ? "" : "s"} below {placedGeometryCount === 1 ? "has" : "have"} no torque or
          force effect under Cannonball — switch to FlatPlate to make placement/orientation matter.
        </span>
      )}
    </div>
  )
}

// "02 Vehicle & GNC design" -- the phase 02 paper, per the 
// design). A SECOND VIEW of
// the same 58vw paper column StudyPaper renders for phase 01, swapped in
// by StudyView based on uiStore.studyPhase -- not a separate route, not
// stacked below the trajectory section. Table 2's mass/CoM/inertia are now
// REAL, not a bus-box-only approximation: the backend shipped
// `POST /api/design/vehicle` (full non-diagonal inertia tensor,
// real per-component parallel-axis contributions, itemized hardware mass),
// which this debounces on every spacecraft-config edit. Still not wired:
// the CoM/CoP viewport overlay and per-plate SRP force arrows -- the
// endpoint supports both (via a `sun_hat_body` the request can pass), just
// not built into the 3D view yet. No Fig. 4 torque budget yet either --
// `/api/design/gnc`'s own SRP torque computation was checked directly
// against the backend source and confirmed to still ignore placed-hardware
// geometry entirely (only the bus's largest face + a flat SolarPanel.area_m2
// sum, not any real per-plate position/normal), so a chart built on it would
// show numbers that don't move when you place a panel -- filed as backend
// the backend design rather than building a misleading control.
//
// Table 3 placements now use HardwareItem::SolarPanel's own purpose-built
// fields (position_m/normal/width_m/height_m/articulation, shipped
// backend-side) instead of the generic CustomPlate -- real,
// independently-editable width/height and a real articulation mechanism-
// class (derived from Pitch/Roll usage, see vehicleGeometry.ts's
// articulationFor), not a derived-from-area guess. Position and rotation
// are fully decoupled -- Table 3's
// Offset u/v columns only ever move the panel, and Pitch/Roll/Yaw (renamed
// from Tilt/Twist/Spin, same request) only ever rotate it about that fixed
// anchor; dragging the anchor never changes which way the panel faces.
export function VehiclePaper({
  onFullscreen,
  selectedIndex,
  onSelect,
  vehicle,
  vehiclePending,
  vehicleError,
}: {
  onFullscreen: () => void
  selectedIndex: number | null
  onSelect: (hardwareIndex: number | null) => void
  // Lifted to StudyView (useVehicleProperties) so VehicleViewport's 3D CoM
  // marker and this paper's Table 2 read the exact same debounced
  // /api/design/vehicle response, instead of each firing its own request.
  vehicle: VehicleProperties | undefined
  vehiclePending: boolean
  vehicleError: boolean
}) {
  const backToLanding = useUiStore((s) => s.backToLanding)
  const setStudyPhase = useUiStore((s) => s.setStudyPhase)
  const setActiveTool = useUiStore((s) => s.setActiveTool)

  const config = useMissionStore((s) => s.config)
  // Lifted out of SlewTestPanel so SlewTestMonteCarlo shares
  // the exact same actuator-mode selection -- see SlewTestPanel's own
  // comment on this prop for why.
  const [slewControlMode, setSlewControlMode] = useState<"WheelsPrimary" | "ThrustersPrimary" | "ThrustersOnly">("ThrustersOnly")
  const setBusDim = useMissionStore((s) => s.setBusDim)
  const setMass = useMissionStore((s) => s.setMass)
  const setPropellantMass = useMissionStore((s) => s.setPropellantMass)
  const hardware = config.spacecraft.hardware
  const updateHardwareAt = useMissionStore((s) => s.updateHardwareAt)
  const removeHardwareAt = useMissionStore((s) => s.removeHardwareAt)
  const toggleHardware = useMissionStore((s) => s.toggleHardware)
  const setHardwareModel = useMissionStore((s) => s.setHardwareModel)
  const { data: hardwareCatalog } = useHardwareCatalog()
  const wheelCatalog = (hardwareCatalog?.reaction_wheels ?? []) as ({ name: string } & Record<string, unknown>)[]
  const thrusterCatalog = (hardwareCatalog?.thrusters ?? []) as ({ name: string } & Record<string, unknown>)[]
  const wheelItem = hardware.find((h) => h.type === "ReactionWheelCluster")
  const wheelIndex = hardware.findIndex((h) => h.type === "ReactionWheelCluster")

  const placements = useVehicleUiStore((s) => s.placements)
  const setPlacement = useVehicleUiStore((s) => s.setPlacement)
  const thrusterPlacements = useVehicleUiStore((s) => s.thrusterPlacements)
  const setThrusterPlacement = useVehicleUiStore((s) => s.setThrusterPlacement)
  const reindexAfterRemoval = useVehicleUiStore((s) => s.reindexAfterRemoval)

  const boresightPlacements = useVehicleBoresightUiStore((s) => s.placements)
  const setBoresightPlacement = useVehicleBoresightUiStore((s) => s.setPlacement)
  const reindexBoresightAfterRemoval = useVehicleBoresightUiStore((s) => s.reindexAfterRemoval)

  const busDimsMRaw = config.spacecraft.bus_dims_m
  const busDimsM = (busDimsMRaw.length === 3 ? busDimsMRaw : [1, 1, 1]) as Vec3
  const dryMassKg = config.spacecraft.dry_mass_kg
  const massKg = config.spacecraft.mass_kg
  const propellantKg = config.spacecraft.propellant_mass_kg


  // Same "placements is authoritative, decomposeSolarPanel is only a
  // bootstrap fallback" rule as VehicleViewport.tsx -- see
  // vehicleUiStore.ts's header comment for why. Table 4 must read the SAME
  // way the viewport does, or the two would disagree about a rotated
  // panel's face/u/v.
  function placementFor(index: number, normal: Vec3, positionM: Vec3, heightM: number): PanelPlacement {
    if (placements[index]) return placements[index]
    const { faceIndex, u, v } = decomposeSolarPanel(normal, positionM, heightM)
    return { faceIndex, u, v, rotXDeg: 0, rotYDeg: 0, rotZDeg: 0 }
  }

  // Recompile and commit both the real backend-bound fields AND the
  // authoritative placement record in one place, so every Table 4 edit
  // (offset, width/height, any of the 3 rotation angles) goes through the
  // identical path the viewport's drag/rotation handlers use.
  function commit(index: number, placement: PanelPlacement, widthM: number, heightM: number) {
    const face = FACES[placement.faceIndex]
    // Re-clamp here too (same rule as VehicleViewport's commitPlacement) --
    // widened by overhangMarginM so the anchor can be dragged partway past
    // an edge, same as the viewport's own drag handler.
    const { u, v } = clampToFace(face, placement.u, placement.v, busDimsM, overhangMarginM(widthM, heightM))
    const clamped = { ...placement, u, v, ...clampRotationDeg(placement.rotXDeg, placement.rotYDeg, placement.rotZDeg) }
    const { normal, positionM, articulation } = compileSolarPanel(
      face,
      u,
      v,
      busDimsM,
      heightM,
      clamped.rotXDeg,
      clamped.rotYDeg,
      clamped.rotZDeg,
    )
    updateHardwareAt(index, {
      normal,
      position_m: positionM,
      width_m: widthM,
      height_m: heightM,
      area_m2: widthM * heightM,
      articulation,
    })
    setPlacement(index, clamped)
  }

  function handleRemove(index: number) {
    removeHardwareAt(index)
    // Removal shifts every later hardware index -- every placement store is
    // keyed off that shared index regardless of which store "owns" the
    // removed item, so all must reindex on every removal.
    reindexAfterRemoval(index)
    reindexBoresightAfterRemoval(index)
    if (selectedIndex === index) onSelect(null)
  }

  // Same "placements is authoritative" rule as placementFor above, for a
  // thruster's (face, u, v, Cant, Clock) mount identity -- see
  // vehicleUiStore.ts's ThrusterPlacement doc comment.
  function thrusterPlacementFor(index: number, positionM: Vec3, direction: Vec3): ThrusterPlacement {
    if (thrusterPlacements[index]) return thrusterPlacements[index]
    const { faceIndex, u, v, cantDeg, clockDeg } = decomposeThruster(positionM, direction)
    return { faceIndex, u, v, cantDeg, clockDeg }
  }

  // Mirrors `commit` above (same recompile-and-write-both-places shape) but
  // for a thruster's own compileThruster/clampThrusterAnglesDeg -- no
  // width/height, only two rotation angles instead of three.
  function commitThruster(index: number, placement: ThrusterPlacement) {
    const face = FACES[placement.faceIndex]
    const { u, v } = clampToFace(face, placement.u, placement.v, busDimsM, THRUSTER_OVERHANG_MARGIN_M)
    const { cantDeg, clockDeg } = clampThrusterAnglesDeg(placement.cantDeg, placement.clockDeg)
    const clamped = { ...placement, u, v, cantDeg, clockDeg }
    const { positionM, direction } = compileThruster(face, u, v, busDimsM, cantDeg, clockDeg)
    updateHardwareAt(index, { position_m: positionM, direction })
    setThrusterPlacement(index, clamped)
  }

  // Boresight-cone family (star tracker/OpNav camera/lidar/comm antenna) --
  // same "placements is authoritative" rule as the panel logic above, kept
  // as separate functions (not merged) since the compiled fields differ.
  function boresightPlacementFor(index: number, positionM: Vec3): BoresightPlacement {
    if (boresightPlacements[index]) return boresightPlacements[index]
    const { faceIndex, u, v } = decomposeBoresightItem(positionM, busDimsM)
    return { faceIndex, u, v, tiltDeg: 0, spinDeg: 0 }
  }

  function commitBoresight(index: number, placement: BoresightPlacement, coneHalfAngleDeg: number | null) {
    const face = FACES[placement.faceIndex]
    const { u, v } = clampToFace(face, placement.u, placement.v, busDimsM, BORESIGHT_OVERHANG_MARGIN_M)
    const clamped = { ...placement, u, v, ...clampBoresightAnglesDeg(placement.tiltDeg, placement.spinDeg) }
    const { boresight, positionM } = compileBoresightItem(face, u, v, busDimsM, clamped.tiltDeg, clamped.spinDeg)
    const item = hardware[index]
    if (item?.type === "CommAntenna") {
      updateHardwareAt(index, { boresight, position_m: positionM, beamwidth_deg: coneHalfAngleDeg ?? 8 })
    } else {
      updateHardwareAt(index, { boresight, position_m: positionM, fov_deg: coneHalfAngleDeg })
    }
    setBoresightPlacement(index, clamped)
  }

  const plateRows = hardware
    .map((item, index) => ({ item, index }))
    .filter(
      (r) =>
        r.item.type === "SolarPanel" &&
        r.item.position_m != null &&
        r.item.normal != null &&
        r.item.width_m != null &&
        r.item.height_m != null,
    )

  const thrusterRows = hardware
    .map((item, index) => ({ item, index }))
    .filter((r) => r.item.type === "RcsThruster" && r.item.position_m != null && r.item.direction != null)

  // Boresight-cone family rows for the sub-table below Table 3b -- same
  // "needs both position_m and boresight to count as placed" rule as
  // VehicleViewport.tsx's isPlacedBoresight.
  const boresightRows = hardware
    .map((item, index) => ({ item, index }))
    .filter(
      (r) =>
        (r.item.type === "StarTracker" ||
          r.item.type === "OpNavCamera" ||
          r.item.type === "Lidar" ||
          r.item.type === "CommAntenna") &&
        r.item.position_m != null &&
        r.item.boresight != null,
    )

  return (
    <div className="h-full overflow-y-auto bg-[#fbfaf6] text-[#171512]">
      <div className="px-7 pt-4.5">
        <div className="flex items-baseline justify-between">
          <h1 className="text-[17px] font-extrabold tracking-[0.05em] uppercase">
            AstroDynamics <span className="text-[#f24d00]">Mission Planner</span>
          </h1>
          <div className="font-mono text-[10px] tracking-[0.1em] text-[#55524b]">TM-2026-08 · REV A</div>
        </div>
        <div className="mt-0.5 flex justify-between pb-2 text-[11.5px] text-[#55524b]">
          <span>{config.mission.name || "Vehicle & GNC design"}</span>
          <button type="button" onClick={backToLanding} className="font-bold text-[#f24d00]">
            ← back to the sky
          </button>
        </div>
        <div className="h-[5px] border-t-[3px] border-b border-t-[#171512] border-b-[#171512]" />
      </div>

      {/* The phase rail itself: unlike StudyPaper's plain status line (a real
 UX fix from when the rail duplicated PhaseDock's own
          navigation), THIS rail's "01" is now a genuine second click target
 on purpose -- direct design decision supersedes that
          old note. It's the ONE place phase 01/02 are toggled from inside
          the paper; PhaseDock still separately exists for landing-page
          entry. */}
      <div className="flex items-center gap-4 border-b border-[#dedbd2] px-7 py-2.5">
        <button
          type="button"
          onClick={() => setStudyPhase("01")}
          className="text-[10px] font-bold tracking-[0.1em] text-[#8b877d] uppercase hover:text-[#f24d00]"
        >
          ← 01 Trajectory
        </button>
        <span className="text-[10px] font-bold tracking-[0.1em] text-[#8b877d] uppercase">
          Phase 02 of 03 · vehicle in progress
        </span>
      </div>

      <div className="px-7 pt-5 pb-20">
        <div className="flex items-baseline gap-3.5 bg-[#2e9e53] px-3.5 py-2 text-white">
          <span className="text-[21px] font-extrabold">02</span>
          <span className="text-[13px] font-bold tracking-[0.14em] uppercase">Vehicle & GNC design</span>
        </div>

        <p className="mt-3 max-w-[62ch] font-serif text-[13px] leading-relaxed text-[#55524b] italic">
          The trajectory of Memo 01 fixes the ΔV budget and the disturbance environment; this section fixes the
          vehicle that must fly it. Place hardware on the bus in the viewport at right — each placement becomes a
          numbered row in Table 4 below.
        </p>

        <SrpModelBanner />

        {/* direct user feedback: the page read as "chaotic" --
            every table stacked directly on the next with no visual
            boundary. Wrapped into StageCard sections (same bordered/
            headered pattern StudyPaper.tsx already uses for its Survey/
            MGA/Optimizer stages), one per real phase of the workflow: mass
            properties, actuator sizing (specs only), component placement
            (geometry), attitude testing. */}
        <StageCard label="Mass properties">
        <table className="w-full border-collapse text-[12px]">
          <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
            Table 2 — bus &amp; mass properties
          </caption>
          <tbody>
            <Row label="Bus dimensions (x × y × z)">
              {[0, 1, 2].map((i) => (
                <span key={i}>
                  <InlineEditField
                    displayValue={busDimsM[i].toFixed(2)}
                    rawValue={String(busDimsM[i])}
                    variant={{ kind: "number", min: 0.1, max: 8, step: 0.05 }}
                    onCommit={(v) => setBusDim(i, Math.max(0.1, Math.min(8, parseFloat(v) || busDimsM[i])))}
                  />
                  {i < 2 ? " × " : " m"}
                </span>
              ))}
            </Row>
            <Row label="Total mass">
              <InlineEditField
                displayValue={massKg.toFixed(0)}
                rawValue={String(massKg)}
                variant={{ kind: "number", min: 1, step: 5 }}
                onCommit={(v) => setMass(Math.max(1, parseFloat(v) || massKg))}
              />{" "}
              kg
            </Row>
            <Row label="Propellant">
              <InlineEditField
                displayValue={propellantKg.toFixed(1)}
                rawValue={String(propellantKg)}
                variant={{ kind: "number", min: 0, step: 1 }}
                onCommit={(v) => setPropellantMass(Math.max(0, parseFloat(v) || 0))}
              />{" "}
              kg
            </Row>
            <Row label="Dry mass (derived)">
              <span className="font-mono text-[11.5px] text-[#55524b]">
                {dryMassKg.toFixed(1)} kg
                <span className="ml-1.5 rounded border border-[#dedbd2] px-1 py-px text-[8.5px] tracking-[0.1em] text-[#8b877d] uppercase">
                  derived
                </span>
              </span>
            </Row>
            <Row label="Centre of mass (derived)">
              <span className="font-mono text-[11.5px] text-[#55524b]">
                {vehicle
                  ? `[${vehicle.com_m.map((c) => c.toFixed(3)).join(", ")}] m`
                  : vehiclePending
                    ? "computing…"
                    : "—"}
                <span className="ml-1.5 rounded border border-[#dedbd2] px-1 py-px text-[8.5px] tracking-[0.1em] text-[#8b877d] uppercase">
                  derived
                </span>
              </span>
            </Row>
            <Row label="Inertia diag (derived)">
              <span className="font-mono text-[11.5px] text-[#55524b]">
                {vehicle
                  ? AXIS_LABELS.map((label, i) => `I${label.toLowerCase()}${label.toLowerCase()} ${vehicle.inertia_kgm2[i][i].toFixed(0)}`).join(
                      " · ",
                    )
                  : vehiclePending
                    ? "computing…"
                    : "—"}{" "}
                {vehicle && "kg·m²"}
                <span className="ml-1.5 rounded border border-[#dedbd2] px-1 py-px text-[8.5px] tracking-[0.1em] text-[#8b877d] uppercase">
                  derived
                </span>
              </span>
            </Row>
          </tbody>
        </table>
        {vehicle && (
          <PaperDisclosure title="How the inertia is computed">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-[#dedbd2] text-[9px] font-bold tracking-[0.08em] text-[#8b877d] uppercase">
                  <th className="py-1 pr-2 text-left font-medium">Component</th>
                  <th className="py-1 pr-2 text-right font-medium">Mass [kg]</th>
                  <th className="py-1 pr-2 text-right font-medium">Ixx</th>
                  <th className="py-1 pr-2 text-right font-medium">Iyy</th>
                  <th className="py-1 text-right font-medium">Izz</th>
                </tr>
              </thead>
              <tbody>
                {vehicle.contributions.map((c, i) => (
                  <tr key={i} className="border-b border-[#dedbd2]/60">
                    <td className="py-1 pr-2 text-[#55524b]">{c.label}</td>
                    <td className="py-1 pr-2 text-right font-mono">{c.mass_kg.toFixed(2)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{c.inertia_about_com_kgm2[0][0].toFixed(1)}</td>
                    <td className="py-1 pr-2 text-right font-mono">{c.inertia_about_com_kgm2[1][1].toFixed(1)}</td>
                    <td className="py-1 text-right font-mono">{c.inertia_about_com_kgm2[2][2].toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
              Bus/structure is the mass budget's remainder after every itemized hardware mass — a real parallel-axis
              contribution per component, about the true centre of mass, real off-diagonal terms included (not shown
              in this table's diagonal-only view). {vehicle.warnings.length > 0 && `⚠ ${vehicle.warnings.join(" ")}`}
            </p>
          </PaperDisclosure>
        )}
        <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
          Real mass properties from <code>/api/design/vehicle</code> — updates ~500ms after any spacecraft edit.{" "}
          {vehicleError && "Request failed — check the backend connection."}
        </p>
        </StageCard>

        <StageCard label="Actuator sizing">
        {/* Table 3 — hardware specifications (wheels + RCS thruster
            definitions, split across two small tables below, same
            Table_X/Table_Xb numbering convention Table 4/4b/4c already
 use for placements). Real gap found and fixed 
            (direct user ask: "we need to be able to add different types/
            size of thrusters or wheels... to investigate what the best
            setup/hardware is for our mission"). Reaction wheels aren't
            individually placed (a deliberate phase-1 scope decision --
            cluster GEOMETRY, not position, is what matters for wheels --
 see the design notes), but
            SIZING is a separate, real, buildable-now axis: which catalog
            grade, and how many. Reuses the exact same toggleHardware/
            setHardwareModel mechanism HardwareChecklist.tsx already used
            in the old GNC-tree sidebar -- but that mechanism had a real
            bug (fixed the same day, see missionStore.ts's own comment on
            setHardwareModel): selecting a model only ever wrote the
            `.model` LABEL, never the real max_speed_rads/max_torque_nm/
            inertia_kgm2/mass_kg the simulation actually integrates
            against. Fixed at the source, so this section and the old
            sidebar both get the real fix.

 Round 2 (direct user design feedback): model
            picking for RCS thrusters originally lived INSIDE the
            placement table (Table 4b's old Model column) while wheel
            sizing lived in its own separate section -- an inconsistent
            split the user disliked on sight. Moved thruster
            model/thrust/mass into this same specifications area (Table
            3b below), leaving Table 4b pure geometry (face/offset/cant/
            clock only) -- specs and placement are now cleanly separated
            for both actuator kinds, not just wheels. */}
        <div className="flex items-start gap-4">
        <table className="w-full border-collapse text-[12px]">
          <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
            Table 3 — reaction wheel sizing
          </caption>
          <tbody>
            <Row label="Fitted">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={wheelItem != null}
                  onChange={() => toggleHardware("ReactionWheelCluster")}
                />
                <span className="text-[11.5px] text-[#171512]">Reaction wheel cluster</span>
              </label>
            </Row>
            {wheelItem && wheelItem.type === "ReactionWheelCluster" && (
              <>
                <Row label="Model">
                  <select
                    value={wheelItem.model ?? ""}
                    onChange={(e) => {
                      const spec = wheelCatalog.find((s) => s.name === e.target.value)
                      setHardwareModel(
                        "ReactionWheelCluster",
                        e.target.value,
                        spec
                          ? {
                              max_speed_rads: spec.max_speed_rads,
                              max_torque_nm: spec.max_torque_nm,
                              inertia_kgm2: spec.inertia_kgm2,
                              mass_kg: spec.mass_kg,
                            }
                          : undefined,
                      )
                    }}
                    className="rounded border border-[#dedbd2] bg-white px-1.5 py-0.5 text-[11.5px] text-[#171512]"
                  >
                    <option value="" disabled>
                      Select a model…
                    </option>
                    {wheelCatalog.map((spec) => (
                      <option key={spec.name} value={spec.name}>
                        {spec.name}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Count">
                  <InlineEditField
                    displayValue={String(wheelItem.count)}
                    rawValue={String(wheelItem.count)}
                    variant={{ kind: "number", min: 1, max: 8, step: 1 }}
                    onCommit={(v) => updateHardwareAt(wheelIndex, { count: Math.max(1, Math.round(parseFloat(v)) || wheelItem.count) })}
                  />
                </Row>
                <Row label="Max torque per wheel [N·m]">
                  <InlineEditField
                    displayValue={(wheelItem.max_torque_nm ?? 0).toFixed(4)}
                    rawValue={String(wheelItem.max_torque_nm ?? 0)}
                    variant={{ kind: "number", min: 0, step: 0.001 }}
                    onCommit={(v) => updateHardwareAt(wheelIndex, { max_torque_nm: parseFloat(v) || 0 })}
                  />
                </Row>
                <Row label="Max speed [rad/s]">
                  <InlineEditField
                    displayValue={(wheelItem.max_speed_rads ?? 0).toFixed(1)}
                    rawValue={String(wheelItem.max_speed_rads ?? 0)}
                    variant={{ kind: "number", min: 0, step: 10 }}
                    onCommit={(v) => updateHardwareAt(wheelIndex, { max_speed_rads: parseFloat(v) || 0 })}
                  />
                </Row>
                <Row label="Spin-axis inertia [kg·m²]">
                  <InlineEditField
                    displayValue={(wheelItem.inertia_kgm2 ?? 0).toFixed(5)}
                    rawValue={String(wheelItem.inertia_kgm2 ?? 0)}
                    variant={{ kind: "number", min: 0, step: 0.0001 }}
                    onCommit={(v) => updateHardwareAt(wheelIndex, { inertia_kgm2: parseFloat(v) || 0 })}
                  />
                </Row>
                <Row label="Mass per wheel [kg]">
                  <InlineEditField
                    displayValue={(wheelItem.mass_kg ?? 0).toFixed(2)}
                    rawValue={String(wheelItem.mass_kg ?? 0)}
                    variant={{ kind: "number", min: 0.001, step: 0.1 }}
                    onCommit={(v) => {
                      // Same bug/fix as the RCS thruster bulk mass control
                      // just above: InlineEditField commits on every blur,
                      // even an accidental click-in-click-out with nothing
                      // typed. Backend rejects mass_kg == 0 outright
                      // ("must be > 0 when set"), so never write it.
                      const massKg = parseFloat(v)
                      if (!(massKg > 0)) return
                      updateHardwareAt(wheelIndex, { mass_kg: massKg })
                    }}
                  />
                </Row>
              </>
            )}
          </tbody>
        </table>
        {wheelItem && wheelItem.type === "ReactionWheelCluster" && (
          <WheelClusterDiagram
            massKgPerWheel={wheelItem.mass_kg ?? null}
            catalogMassRangeKg={
              wheelCatalog.length > 0
                ? [
                    Math.min(...wheelCatalog.map((s) => s.mass_kg as number)),
                    Math.max(...wheelCatalog.map((s) => s.mass_kg as number)),
                  ]
                : [0, 1]
            }
          />
        )}
        </div>
        <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
          Pick a catalog model to fill in real specs, then fine-tune any field by hand to investigate a size the
          catalog doesn't have — both paths write the same real fields the simulation (slew test, Monte Carlo)
          actually integrates against. Momentum capacity isn't a separate input — the sim derives it as spin-axis
          inertia × max speed.{" "}
          {wheelItem && (
            <>
              The diagram is the REAL 4-wheel pyramid arrangement <code>wheel_cluster_from_hardware()</code>{" "}
              actually simulates (verified against the real spin-axis geometry, not invented) — always 4 wheels
              regardless of the Count above, which only affects total mass, not cluster shape. Disk size is a
              relative visual (scaled against the catalog's own mass range), not a real dimension — no diameter
              field exists in the catalog. Cluster geometry itself (3-orthogonal vs. 4-pyramid, cant angle) is
              still fixed, not yet configurable.
            </>
          )}
        </p>

        {thrusterRows.length > 0 && (
          <table className="mt-4 w-full border-collapse text-[12px]">
            <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
              Table 3b — RCS thruster type
            </caption>
            {/* Round 3 (direct user design feedback): one row
                per PLACED thruster was more than the user wanted -- "just
                let the user choose one type/size/T/Isp and this is applied
                to all of them." This is now one control that bulk-writes
                thrust_n (and, if picked from catalog, mass_kg) to every
                currently-placed thruster at once. A user who really wants a
                mix still can -- Table 4b below still carries its own
                per-row Thrust override, so placing an extra thruster and
                editing just that one row's value is how "a different type"
                actually happens; this control is the fast common path, not
                the only path. */}
            <tbody>
              <Row label="Type">
                <select
                  value=""
                  onChange={(e) => {
                    const spec = thrusterCatalog.find((s) => s.name === e.target.value)
                    if (!spec) return
                    // ThrusterSpec has no mass_kg field (unlike
                    // ReactionWheelSpec) -- only thrust_n is real to bulk-
                    // fill here; mass stays whatever it already was.
                    for (const { index } of thrusterRows) updateHardwareAt(index, { thrust_n: spec.thrust_n as number })
                  }}
                  className="rounded border border-[#dedbd2] bg-white px-1.5 py-0.5 text-[11.5px] text-[#171512]"
                >
                  <option value="">from catalog…</option>
                  {thrusterCatalog.map((spec) => (
                    <option key={spec.name} value={spec.name}>
                      {spec.name} — {spec.thrust_n as number} N, Isp {spec.isp_s as number} s
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Thrust [N] (all placed thrusters)">
                <InlineEditField
                  displayValue={(thrusterRows[0]?.item as { thrust_n?: number }).thrust_n?.toFixed(2) ?? "0.00"}
                  rawValue={String((thrusterRows[0]?.item as { thrust_n?: number }).thrust_n ?? 0)}
                  variant={{ kind: "number", min: 0.01, step: 0.5 }}
                  onCommit={(val) => {
                    const thrustN = Math.max(0.01, parseFloat(val) || 1)
                    for (const { index } of thrusterRows) updateHardwareAt(index, { thrust_n: thrustN })
                  }}
                />
              </Row>
              <Row label="Mass per thruster [kg] (all placed thrusters)">
                <InlineEditField
                  displayValue={(thrusterRows[0]?.item as { mass_kg?: number | null }).mass_kg?.toFixed(3) ?? "— (backend default)"}
                  rawValue={String((thrusterRows[0]?.item as { mass_kg?: number | null }).mass_kg ?? "")}
                  variant={{ kind: "number", min: 0.001, step: 0.01 }}
                  onCommit={(val) => {
                    // InlineEditField's number input commits on every blur,
                    // even an accidental click-in-click-out with nothing
                    // typed -- a real bug found (:
                    // "RcsThruster: mass_kg must be > 0 when set" spamming
                    // the validation panel). mass_kg is meant to be
                    // OMITTABLE ("backend default" above) when unset; only
                    // ever write a real positive value here, never an
                    // explicit 0 that then fails backend validation forever.
                    const massKg = parseFloat(val)
                    if (!(massKg > 0)) return
                    for (const { index } of thrusterRows) updateHardwareAt(index, { mass_kg: massKg })
                  }}
                />
              </Row>
            </tbody>
          </table>
        )}
        {thrusterRows.length > 0 && (
          <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
            Real per-thruster parameters the simulation actually consumes: <b>thrust</b> (magnitude), <b>position +
            direction</b> (Table 4b below — the torque/force geometry), and <b>mass</b>. <b>Isp is not one of them
            yet</b> — <code>HardwareItem::RcsThruster</code> has no Isp field at all today, so propellant accounting
            always uses the backend's fixed internal default (Monoprop's Isp) regardless of which catalog thruster is
            picked here; the catalog's own Isp is shown above for comparison only. Filed as a real backend gap
            (catalog breadth + per-thruster Isp), not yet fixed. Want one thruster to differ from the rest? Edit its
            own Thrust value directly in Table 4b's placement row instead of using this bulk control.
          </p>
        )}
        </StageCard>

        <StageCard label="Component placements">
        <table className="w-full border-collapse text-[12px]">
          <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
            Table 4 — component placements (body frame)
          </caption>
          {plateRows.length > 0 && (
            <thead>
              <tr className="border-b border-[#171512] text-[9.5px] font-bold tracking-[0.08em] text-[#8b877d] uppercase">
                <th className="py-1 pr-2 text-left font-medium">#</th>
                <th className="py-1 pr-2 text-left font-medium">Component</th>
                <th className="py-1 pr-2 text-left font-medium">Face</th>
                <th className="py-1 pr-2 text-right font-medium">Offset u [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Offset v [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Width [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Height [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Pitch [°]</th>
                <th className="py-1 pr-2 text-right font-medium">Roll [°]</th>
                <th className="py-1 pr-2 text-right font-medium">Yaw [°]</th>
                <th className="py-1"></th>
              </tr>
            </thead>
          )}
          <tbody>
            {plateRows.map(({ item, index }, n) => {
              if (item.type !== "SolarPanel" || item.position_m == null || item.normal == null) return null
              const normal = item.normal as Vec3
              const positionM = item.position_m as Vec3
              const widthM = item.width_m ?? 1
              const heightM = item.height_m ?? 1
              const placement = placementFor(index, normal, positionM, heightM)
              const { faceIndex, u, v, rotXDeg, rotYDeg, rotZDeg } = placement
              const selected = selectedIndex === index
              const rowClass = "border-b border-[#dedbd2] " + (selected ? "bg-[#f24d00]/10" : "")
              const selectCellClass = "cursor-pointer py-1.5 pr-2 hover:text-[#f24d00]"
              const toggleSelect = () => onSelect(selected ? null : index)
              return (
                <tr key={index} className={rowClass}>
                  <td className={selectCellClass + " font-mono text-[11px] text-[#8b877d]"} onClick={toggleSelect}>
                    {n + 1}
                  </td>
                  <td className={selectCellClass} onClick={toggleSelect}>
                    Solar panel
                  </td>
                  <td className={selectCellClass + " font-mono text-[11px]"} onClick={toggleSelect}>
                    {FACE_NAMES[faceIndex]}
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <InlineEditField
                      displayValue={u.toFixed(2)}
                      rawValue={String(u)}
                      variant={{ kind: "number", step: 0.05 }}
                      onCommit={(val) => commit(index, { ...placement, u: parseFloat(val) || 0 }, widthM, heightM)}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <InlineEditField
                      displayValue={v.toFixed(2)}
                      rawValue={String(v)}
                      variant={{ kind: "number", step: 0.05 }}
                      onCommit={(val) => commit(index, { ...placement, v: parseFloat(val) || 0 }, widthM, heightM)}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <InlineEditField
                      displayValue={widthM.toFixed(2)}
                      rawValue={String(widthM)}
                      variant={{ kind: "number", min: 0.05, step: 0.1 }}
                      onCommit={(val) => commit(index, placement, Math.max(0.05, parseFloat(val) || widthM), heightM)}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <InlineEditField
                      displayValue={heightM.toFixed(2)}
                      rawValue={String(heightM)}
                      variant={{ kind: "number", min: 0.05, step: 0.1 }}
                      onCommit={(val) => commit(index, placement, widthM, Math.max(0.05, parseFloat(val) || heightM))}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <InlineEditField
                      displayValue={rotXDeg.toFixed(0)}
                      rawValue={String(rotXDeg)}
                      variant={{ kind: "number", min: PITCH_RANGE_DEG[0], max: PITCH_RANGE_DEG[1], step: 5 }}
                      onCommit={(val) => commit(index, { ...placement, rotXDeg: parseFloat(val) || 0 }, widthM, heightM)}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <InlineEditField
                      displayValue={rotYDeg.toFixed(0)}
                      rawValue={String(rotYDeg)}
                      variant={{ kind: "number", min: ROLL_RANGE_DEG[0], max: ROLL_RANGE_DEG[1], step: 5 }}
                      onCommit={(val) => commit(index, { ...placement, rotYDeg: parseFloat(val) || 0 }, widthM, heightM)}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <InlineEditField
                      displayValue={rotZDeg.toFixed(0)}
                      rawValue={String(rotZDeg)}
                      variant={{ kind: "number", min: YAW_RANGE_DEG[0], max: YAW_RANGE_DEG[1], step: 5 }}
                      onCommit={(val) => commit(index, { ...placement, rotZDeg: parseFloat(val) || 0 }, widthM, heightM)}
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => handleRemove(index)}
                      className="px-1.5 text-[#8b877d] hover:text-[#f24d00]"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {plateRows.length === 0 && thrusterRows.length === 0 && boresightRows.length === 0 && (
          <p className="mt-2 font-serif text-[13px] text-[#8b877d] italic">
            No hardware placed yet — pick a component from the palette in the viewport and click a bus face to mount
            it.
          </p>
        )}
        {plateRows.some(({ index }) => {
          const p = placements[index]
          return p && (p.rotXDeg !== 0 || p.rotYDeg !== 0 || p.rotZDeg !== 0)
        }) && (
          <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
            Pitch/Roll/Yaw produce a real tilted <code>normal</code> vector sent to the backend — not decorative, and
            fully independent of position: dragging or editing Offset u/v never changes them. Pitch is the main
            hinge-open motion; Roll and Yaw are the other two rotation axes about the same fixed mounting edge — Yaw
            is the only way to face a different edge of the bus surface.
          </p>
        )}

        {/* RCS thrusters get their OWN small table, not merged into Table 4
            above -- a thruster's columns (Cant, Clock) don't share Table 4's
            Width/Height/Pitch/Roll/Yaw shape at all (a thruster is a point +
            a free direction, not a flat plate on a face). Round 2 (direct
 user design feedback): Model/Thrust/Mass moved OUT of
            this table into Table 3b above -- this table is now pure
            geometry (face/offset/cant/clock), matching how wheels' own specs
            already lived separately from anything placement-like. Still
            inside the same 02 paper section, not a new page. */}
        {thrusterRows.length > 0 && (
          <table className="mt-4 w-full border-collapse text-[12px]">
            <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
              Table 4b — RCS thruster placements (body frame)
            </caption>
            <thead>
              <tr className="border-b border-[#171512] text-[9.5px] font-bold tracking-[0.08em] text-[#8b877d] uppercase">
                <th className="py-1 pr-2 text-left font-medium">#</th>
                <th className="py-1 pr-2 text-left font-medium">Component</th>
                <th className="py-1 pr-2 text-left font-medium">Face</th>
                <th className="py-1 pr-2 text-right font-medium">Offset u [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Offset v [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Cant [°]</th>
                <th className="py-1 pr-2 text-right font-medium">Clock [°]</th>
                <th className="py-1 pr-2 text-right font-medium">Thrust [N]</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {thrusterRows.map(({ item, index }, n) => {
                if (item.type !== "RcsThruster" || item.position_m == null || item.direction == null) return null
                const positionM = item.position_m as Vec3
                const direction = item.direction as Vec3
                const thrustN = item.thrust_n
                const placement = thrusterPlacementFor(index, positionM, direction)
                const { faceIndex, u, v, cantDeg, clockDeg } = placement
                const selected = selectedIndex === index
                const rowClass = "border-b border-[#dedbd2] " + (selected ? "bg-[#f24d00]/10" : "")
                const selectCellClass = "cursor-pointer py-1.5 pr-2 hover:text-[#f24d00]"
                const toggleSelect = () => onSelect(selected ? null : index)
                return (
                  <tr key={index} className={rowClass}>
                    <td className={selectCellClass + " font-mono text-[11px] text-[#8b877d]"} onClick={toggleSelect}>
                      {n + 1}
                    </td>
                    <td className={selectCellClass} onClick={toggleSelect}>
                      RCS thruster
                    </td>
                    <td className={selectCellClass + " font-mono text-[11px]"} onClick={toggleSelect}>
                      {FACE_NAMES[faceIndex]}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={u.toFixed(2)}
                        rawValue={String(u)}
                        variant={{ kind: "number", step: 0.05 }}
                        onCommit={(val) => commitThruster(index, { ...placement, u: parseFloat(val) || 0 })}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={v.toFixed(2)}
                        rawValue={String(v)}
                        variant={{ kind: "number", step: 0.05 }}
                        onCommit={(val) => commitThruster(index, { ...placement, v: parseFloat(val) || 0 })}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={cantDeg.toFixed(0)}
                        rawValue={String(cantDeg)}
                        variant={{ kind: "number", min: CANT_RANGE_DEG[0], max: CANT_RANGE_DEG[1], step: 5 }}
                        onCommit={(val) => commitThruster(index, { ...placement, cantDeg: parseFloat(val) || 0 })}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={clockDeg.toFixed(0)}
                        rawValue={String(clockDeg)}
                        variant={{ kind: "number", min: CLOCK_RANGE_DEG[0], max: CLOCK_RANGE_DEG[1], step: 5 }}
                        onCommit={(val) => commitThruster(index, { ...placement, clockDeg: parseFloat(val) || 0 })}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={thrustN.toFixed(2)}
                        rawValue={String(thrustN)}
                        variant={{ kind: "number", min: 0.01, step: 0.5 }}
                        onCommit={(val) => updateHardwareAt(index, { thrust_n: Math.max(0.01, parseFloat(val) || thrustN) })}
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleRemove(index)}
                        className="px-1.5 text-[#8b877d] hover:text-[#f24d00]"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {thrusterRows.length > 0 && (
          <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
            This Thrust column overrides just that one thruster — use it when you want a mix of thruster types rather
            than Table 3b's uniform bulk value.{" "}
            <code>direction</code> is the FORCE applied to the spacecraft, not the exhaust direction — the viewport
            draws the small metallic nozzle and the translucent plume cone pointing the opposite way (Newton's third
            law). Cant tips the thrust direction away from the mount face's own outward normal (0 = straight out);
            Clock spins that tip around the face normal and has no visible effect at Cant = 0.
          </p>
        )}

        {thrusterRows.length > 0 &&
          (() => {
            if (!vehicle) {
              return (
                <p className="mt-1.5 text-[10.5px] text-[#8b877d]">
                  Torque authority check — waiting on <code>/api/design/vehicle</code>&apos;s real centre of mass…
                </p>
              )
            }
            const comM = vehicle.com_m as Vec3
            const result = torqueAuthority(
              thrusterRows.flatMap(({ item }) => {
                if (item.type !== "RcsThruster" || item.position_m == null || item.direction == null) return []
                return [{ positionM: item.position_m as Vec3, direction: item.direction as Vec3, thrustN: item.thrust_n }]
              }),
              comM,
            )
            const statusLabel =
              result.rank === 3
                ? "Full 3-axis torque authority"
                : result.rank === 0
                  ? "No torque authority — thrusters fire straight through the centre of mass"
                  : `Only ${result.rank}-axis torque authority — one or more body rotations are unreachable`
            return (
              <div
                className={
                  "mt-3 rounded border px-3 py-2 text-[11px] " +
                  (result.fullyControllable
                    ? "border-[#2e9e53]/40 bg-[#2e9e53]/10 text-[#1f6b39]"
                    : "border-[#c23b2a]/40 bg-[#c23b2a]/10 text-[#8a2a1e]")
                }
              >
                <div className="flex items-center gap-1.5 font-bold">
                  <span>●</span>
                  <span>{statusLabel}</span>
                </div>
                <div className="mt-1 font-mono text-[10.5px] opacity-80">
                  Singular values [N·m]: {result.singularValuesNm.map((v) => v.toFixed(3)).join(", ")}
                  {result.conditionNumber != null && ` · condition number ${result.conditionNumber.toFixed(1)}`}
                </div>
                <p className="mt-1 text-[10px] text-[#55524b]">
                  A static geometric check only — rank of the aggregated r×F matrix about the real centre of mass,
                  assuming every placed thruster can fire simultaneously at its full rated thrust. Not a real
                  closed-loop controllability result: the live 6DOF simulation does not yet consume these
                  individually-placed thrusters at all.
                </p>
              </div>
            )
          })()}

        {/* Boresight-cone family gets its own small table too, same reasoning
            as thrusters above -- sensors/antennas have Tilt/Spin/FOV columns
            that don't share Table 4's flat-plate shape. */}
        {boresightRows.length > 0 && (
          <table className="mt-4 w-full border-collapse text-[12px]">
            <caption className="pb-1.5 text-left text-[10px] font-bold tracking-[0.12em] text-[#8b877d] uppercase">
              Table 4c — sensor &amp; antenna placements (body frame)
            </caption>
            <thead>
              <tr className="border-b border-[#171512] text-[9.5px] font-bold tracking-[0.08em] text-[#8b877d] uppercase">
                <th className="py-1 pr-2 text-left font-medium">#</th>
                <th className="py-1 pr-2 text-left font-medium">Component</th>
                <th className="py-1 pr-2 text-left font-medium">Face</th>
                <th className="py-1 pr-2 text-right font-medium">Offset u [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Offset v [m]</th>
                <th className="py-1 pr-2 text-right font-medium">Tilt [°]</th>
                <th className="py-1 pr-2 text-right font-medium">Spin [°]</th>
                <th className="py-1 pr-2 text-right font-medium">FOV/beamwidth [°]</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {boresightRows.map(({ item, index }, n) => {
                if (
                  (item.type !== "StarTracker" && item.type !== "OpNavCamera" && item.type !== "Lidar" && item.type !== "CommAntenna") ||
                  item.position_m == null ||
                  item.boresight == null
                )
                  return null
                const positionM = item.position_m as Vec3
                const placement = boresightPlacementFor(index, positionM)
                const { faceIndex, u, v, tiltDeg, spinDeg } = placement
                const coneAngle = (item.type === "CommAntenna" ? item.beamwidth_deg : item.fov_deg) ?? null
                const selected = selectedIndex === index
                const rowClass = "border-b border-[#dedbd2] " + (selected ? "bg-[#f24d00]/10" : "")
                const selectCellClass = "cursor-pointer py-1.5 pr-2 hover:text-[#f24d00]"
                const toggleSelect = () => onSelect(selected ? null : index)
                return (
                  <tr key={index} className={rowClass}>
                    <td className={selectCellClass + " font-mono text-[11px] text-[#8b877d]"} onClick={toggleSelect}>
                      {n + 1}
                    </td>
                    <td className={selectCellClass} onClick={toggleSelect}>
                      {BORESIGHT_LABEL[item.type] ?? item.type}
                    </td>
                    <td className={selectCellClass + " font-mono text-[11px]"} onClick={toggleSelect}>
                      {FACE_NAMES[faceIndex]}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={u.toFixed(2)}
                        rawValue={String(u)}
                        variant={{ kind: "number", step: 0.05 }}
                        onCommit={(val) => commitBoresight(index, { ...placement, u: parseFloat(val) || 0 }, coneAngle)}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={v.toFixed(2)}
                        rawValue={String(v)}
                        variant={{ kind: "number", step: 0.05 }}
                        onCommit={(val) => commitBoresight(index, { ...placement, v: parseFloat(val) || 0 }, coneAngle)}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={tiltDeg.toFixed(0)}
                        rawValue={String(tiltDeg)}
                        variant={{ kind: "number", min: TILT_RANGE_DEG[0], max: TILT_RANGE_DEG[1], step: 5 }}
                        onCommit={(val) => commitBoresight(index, { ...placement, tiltDeg: parseFloat(val) || 0 }, coneAngle)}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={spinDeg.toFixed(0)}
                        rawValue={String(spinDeg)}
                        variant={{ kind: "number", min: SPIN_RANGE_DEG[0], max: SPIN_RANGE_DEG[1], step: 5 }}
                        onCommit={(val) => commitBoresight(index, { ...placement, spinDeg: parseFloat(val) || 0 }, coneAngle)}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <InlineEditField
                        displayValue={(coneAngle ?? 0).toFixed(0)}
                        rawValue={String(coneAngle ?? 0)}
                        variant={{ kind: "number", min: 1, max: 45, step: 1 }}
                        onCommit={(val) => commitBoresight(index, placement, parseFloat(val) || 1)}
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleRemove(index)}
                        className="px-1.5 text-[#8b877d] hover:text-[#f24d00]"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {boresightRows.length === 0 && (thrusterRows.length > 0 || plateRows.length > 0) && (
          <p className="mt-2 font-serif text-[13px] text-[#8b877d] italic">
            No sensors or antennas placed yet — pick Star tracker / OpNav camera / Lidar / HGA antenna from the
            palette and click a bus face to mount one.
          </p>
        )}
        </StageCard>

        <StageCard label="Attitude &amp; slew testing">
        <SlewTestPanel controlMode={slewControlMode} setControlMode={setSlewControlMode} />
        <SlewTestMonteCarlo config={config} controlMode={slewControlMode} />
        </StageCard>

        <div className="mt-8 flex items-center gap-3 border-t border-[#dedbd2] pt-5">
          <div>
            <div className="text-[11.5px] font-bold text-[#171512]">03 · Mission validation</div>
            <p className="mt-0.5 max-w-[52ch] text-[10.5px] text-[#8b877d]">
              Fly this built vehicle and its GNC design against the real trajectory from Memo 01, tick by tick — real
              attitude, mode transitions, and pointing/momentum/propellant telemetry.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setActiveTool("cruise")}
            className="ml-auto shrink-0 bg-[#2e9e53] px-3.5 py-1.5 text-[10px] font-bold tracking-[0.1em] text-white uppercase hover:bg-[#257c42]"
          >
            Continue to mission validation →
          </button>
        </div>

        <button
          type="button"
          onClick={onFullscreen}
          className="mt-6 border-[1.5px] border-[#dedbd2] px-3.5 py-1.5 text-[10px] font-bold tracking-[0.1em] text-[#55524b] uppercase hover:border-[#f24d00] hover:text-[#f24d00]"
        >
          ⛶ Fullscreen viewport
        </button>
      </div>
    </div>
  )
}
