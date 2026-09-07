import { InlineEditField } from "./InlineEditField"
import { PaperSelect } from "./paperForm"
import { useBodies, useHardwareCatalog, useObjectives } from "@/hooks/useApi"
import { epochToDatetimeLocal } from "@/lib/utils"
import { useMissionStore } from "@/stores/missionStore"
import { useOptimizeStore } from "@/stores/optimizeStore"
import type { MissionConfig } from "@/api/client"

type SpacecraftWithLaunchVehicle = MissionConfig["spacecraft"] & { launch_vehicle?: string | null }

// Launch-site presets for [trajectory.departure].launch_site (backend Phase
// 14a). Display data, not physics constants: only the
// latitude enters the backend's launch geometry (i ≥ |site latitude| for a
// dogleg-free ascent); longitude is display / future daily-window use.
const LAUNCH_SITES: { name: string; lat_deg: number; lon_deg: number }[] = [
  { name: "Cape Canaveral", lat_deg: 28.5, lon_deg: -80.6 },
  { name: "Kourou", lat_deg: 5.2, lon_deg: -52.8 },
  { name: "Baikonur", lat_deg: 45.6, lon_deg: 63.3 },
  { name: "Vandenberg", lat_deg: 34.7, lon_deg: -120.6 },
]


function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <td className="py-1 pr-2 text-[#55524b]">{label}</td>
      <td className="py-1 text-right">{children}</td>
    </tr>
  )
}

// A real-time read of the mission being defined, from the margin column
// of the mockup's 01 Trajectory band. Every row is wired to the exact same
// missionStore setter the full-size MissionEditor component for that
// field already calls. Route here is just departure -> target (direct
// transfer). Below it: an "Analysis" block -- Direct and MGA are each
// independently toggleable (direct user feedback), controlling
// whether their stage cards show up on the main content column. The MGA
// flyby-sequence picker itself lives in the MGA sub-window now, not here
// -- it moved through three locations this same session (Mission
// Definition, then this margin column, now the MGA sub-window) as the
// user refined exactly where it read best; see MgaSequenceEditor.tsx.
export function MissionMarginTable({
  directEnabled,
  onToggleDirect,
  mgaEnabled,
  onToggleMga,
}: {
  directEnabled: boolean
  onToggleDirect: (enabled: boolean) => void
  mgaEnabled: boolean
  onToggleMga: (enabled: boolean) => void
}) {
  const departureBody = useMissionStore((s) => s.config.trajectory.departure_body)
  const setTrajectoryDepartureBody = useMissionStore((s) => s.setTrajectoryDepartureBody)
  const targetBody = useMissionStore((s) => s.config.target_body.name)
  const selectCatalogBody = useMissionStore((s) => s.selectCatalogBody)
  const objective = useMissionStore((s) => s.config.mission.objective)
  const setObjective = useMissionStore((s) => s.setObjective)
  const departureEpoch = useMissionStore((s) => s.config.trajectory.departure_epoch)
  const setTrajectoryDepartureEpoch = useMissionStore((s) => s.setTrajectoryDepartureEpoch)
  const dryMassKg = useMissionStore((s) => s.config.spacecraft.dry_mass_kg)
  const propellantMassKg = useMissionStore((s) => s.config.spacecraft.propellant_mass_kg)
  const setPropellantMass = useMissionStore((s) => s.setPropellantMass)
  const launchVehicle = useMissionStore(
    (s) => (s.config.spacecraft as SpacecraftWithLaunchVehicle).launch_vehicle ?? null,
  )
  const setLaunchVehicle = useMissionStore((s) => s.setLaunchVehicle)
  const departureMode = useMissionStore((s) => s.config.trajectory.departure?.mode ?? "ParkingOrbit")
  const launchSite = useMissionStore((s) => s.config.trajectory.departure?.launch_site ?? null)
  const departureInclination = useMissionStore((s) => s.config.trajectory.departure?.inclination_deg ?? null)
  const setDepartureMode = useMissionStore((s) => s.setDepartureMode)
  const setLaunchSite = useMissionStore((s) => s.setLaunchSite)
  const setDepartureInclination = useMissionStore((s) => s.setDepartureInclination)
  // Read-only: the closed-form launch geometry of the LAST optimizer result
  // (Launch mode only, null otherwise) -- a result quantity, shown here next
  // to the inputs that produced it.
  const launchGeometry = useOptimizeStore((s) => s.result?.launch_geometry ?? null)

  const { data: bodiesData } = useBodies()
  const { data: objectivesData } = useObjectives()
  const { data: hardware } = useHardwareCatalog()

  const showLauncher = departureBody === "Earth"

  const bodyOptions = (bodiesData?.bodies ?? []).map((b) => ({ value: b.name, label: b.name }))

  return (
    <aside className="text-[11.5px]">
      <div className="mb-2 text-[9.5px] font-bold tracking-[0.16em] text-[#8b877d] uppercase">
        Mission definition
      </div>

      <div className="mb-3 flex flex-col gap-1.5">
        <div className="text-[10px] text-[#55524b]">Route</div>
        <div className="flex items-center gap-1.5">
          <PaperSelect value={departureBody ?? ""} options={bodyOptions} onChange={setTrajectoryDepartureBody} />
          <span className="text-[#f24d00]">→</span>
          <PaperSelect value={targetBody} options={bodyOptions} onChange={selectCatalogBody} />
        </div>
      </div>

      <table className="w-full border-collapse">
        <tbody>
          <Row label="Objective">
            <InlineEditField
              displayValue={objective}
              rawValue={objective}
              variant={{
                kind: "select",
                options: (objectivesData?.objectives ?? []).map((o) => ({ value: o.id, label: o.id })),
              }}
              onCommit={(v) => setObjective(v as typeof objective)}
            />
          </Row>
          <Row label="Departure">
            <InlineEditField
              displayValue={departureEpoch ? departureEpoch.replace(" UTC", "") : "-"}
              rawValue={epochToDatetimeLocal(departureEpoch)}
              variant={{ kind: "date" }}
              onCommit={(v) => setTrajectoryDepartureEpoch(v ? `${v.length === 16 ? `${v}:00` : v} UTC` : null)}
            />
          </Row>
          {/* Capture radius moved OUT of Mission Definition (
: "Maybe this capture radius should be
              removed from the Mission Definition, especially since its also
              not applicable to flyby's... So it only appears in the
              Optimizer part as Capture perigee when Orbit is selected, and
              otherwise as flyby distance") -- see OptimizerSection's
              contextual field. Also matches MinDeltaV's same-day
              radius-free redefinition: the radius is a target-distance
              search parameter now, not a mission property. */}
          <Row label="Dry / prop mass">
            <span className="font-semibold text-[#171512]">
              {dryMassKg.toFixed(0)} /{" "}
              <InlineEditField
                displayValue={`${propellantMassKg.toFixed(0)} kg`}
                rawValue={propellantMassKg.toFixed(0)}
                variant={{ kind: "number", min: 0, max: 1000, step: 1 }}
                onCommit={(v) => setPropellantMass(Number(v))}
              />
            </span>
          </Row>
          {showLauncher && (
            <Row label="Launcher">
              <InlineEditField
                displayValue={launchVehicle ?? "None"}
                rawValue={launchVehicle ?? "__none__"}
                variant={{
                  kind: "select",
                  options: [
                    { value: "__none__", label: "None (onboard propellant)" },
                    ...(hardware?.launch_vehicles ?? []).map((v) => ({ value: v.name, label: v.name })),
                  ],
                }}
                onCommit={(v) => setLaunchVehicle(v === "__none__" ? null : v)}
              />
            </Row>
          )}
          {/* Departure mode (backend Phase 14a) mirrors the
              arrival mode: ParkingOrbit = the spacecraft is already in orbit
              and fires its own departure burn; Launch = from a launch site,
              the launcher's upper stage injects and the optimizer's departure
              genes become the asymptote (v∞/RLA/DLA) with the parking orbit
              derived closed-form. Only offered once a launcher is selected --
              check_config rejects Launch without one. */}
          {showLauncher && launchVehicle && (
            <Row label="Departure">
              <InlineEditField
                displayValue={departureMode === "Launch" ? "Launch from site" : "Parking orbit"}
                rawValue={departureMode}
                variant={{
                  kind: "select",
                  options: [
                    { value: "ParkingOrbit", label: "Parking orbit (spacecraft burns)" },
                    { value: "Launch", label: "Launch from site (upper stage injects)" },
                  ],
                }}
                onCommit={(v) => {
                  setDepartureMode(v as "ParkingOrbit" | "Launch")
                  // A site is REQUIRED in Launch mode -- seed the default so
                  // the config is runnable the moment the mode is picked.
                  if (v === "Launch" && !launchSite) setLaunchSite(LAUNCH_SITES[0])
                }}
              />
            </Row>
          )}
          {showLauncher && launchVehicle && departureMode === "Launch" && (
            <>
              <Row label="Launch site">
                <InlineEditField
                  displayValue={launchSite ? `${launchSite.name ?? "site"} (${launchSite.lat_deg.toFixed(1)}°)` : "-"}
                  rawValue={launchSite?.name ?? LAUNCH_SITES[0].name}
                  variant={{ kind: "select", options: LAUNCH_SITES.map((s) => ({ value: s.name, label: `${s.name} (${s.lat_deg.toFixed(1)}°)` })) }}
                  onCommit={(v) => setLaunchSite(LAUNCH_SITES.find((s) => s.name === v) ?? LAUNCH_SITES[0])}
                />
              </Row>
              <Row label="Plane inclination">
                <InlineEditField
                  displayValue={departureInclination != null ? `${departureInclination.toFixed(1)}°` : "min feasible"}
                  rawValue={departureInclination != null ? departureInclination.toFixed(1) : ""}
                  variant={{ kind: "number", min: 0, max: 180, step: 0.1 }}
                  onCommit={(v) => setDepartureInclination(v.trim() === "" ? null : Number(v))}
                />
              </Row>
              {launchGeometry && (
                <Row label="Launch geometry">
                  <span
                    className="font-semibold text-[#171512]"
                    title="From the last optimizer result: right ascension / declination of the launch asymptote, parking-plane inclination, launch azimuth from north, in-plane coast to injection"
                  >
                    RLA {launchGeometry.rla_deg.toFixed(1)}° · DLA {launchGeometry.dla_deg.toFixed(1)}° · i{" "}
                    {launchGeometry.inclination_deg.toFixed(1)}° · az {launchGeometry.launch_azimuth_deg.toFixed(1)}° · coast{" "}
                    {launchGeometry.coast_angle_deg.toFixed(0)}°
                    {!launchGeometry.feasible_no_dogleg && <span className="text-[#c23b2a]"> · dogleg needed</span>}
                  </span>
                </Row>
              )}
            </>
          )}
        </tbody>
      </table>

      <div className="mt-4 flex flex-col gap-2 border-t border-[#dedbd2] pt-3">
        <div className="text-[9.5px] font-bold tracking-[0.16em] text-[#8b877d] uppercase">Analysis</div>
        <label className="flex items-start gap-1.5">
          <input
            type="checkbox"
            checked={directEnabled}
            onChange={(e) => onToggleDirect(e.target.checked)}
            className="mt-0.5 size-[12px] accent-[#f24d00]"
          />
          <span>
            <span className="block text-[11px] font-semibold text-[#171512]">Direct transfer</span>
            <span className="block text-[10px] leading-relaxed text-[#8b877d]">
              Closed-form Lambert porkchop, a fast baseline with no gravity assists.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-1.5">
          <input
            type="checkbox"
            checked={mgaEnabled}
            onChange={(e) => onToggleMga(e.target.checked)}
            className="mt-0.5 size-[12px] accent-[#f24d00]"
          />
          <span>
            <span className="block text-[11px] font-semibold text-[#171512]">Gravity-assist (MGA)</span>
            <span className="block text-[10px] leading-relaxed text-[#8b877d]">
              Analyze whether a gravity-assisted route can be interesting.
            </span>
          </span>
        </label>
      </div>
    </aside>
  )
}
