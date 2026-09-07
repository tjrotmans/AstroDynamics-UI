import type { components } from "@/api/types"
import type { HardwareItem } from "@/api/client"
import type { BurnAuthorityReport } from "@/lib/burnAuthority"

type MainEngineTorqueCheck = components["schemas"]["MainEngineTorqueCheck"]

// E5: a pre-run "can this vehicle hold attitude through a
// burn" verdict. The HEADLINE comes from the backend's own check
// (`/api/design/vehicle → main_engine_torque_check`, the same torque arm and
// thruster selection the live sim uses); the frontend's static mirror
// (lib/burnAuthority.ts) adds what the backend doesn't report yet --
// per-axis authority, cross-coupling, torque rank -- and stands in for the
// headline only against an older server that lacks the field.
export function BurnAuthorityCard({
  check,
  mirror,
  comPending,
  hardware,
  tickS,
}: {
  check: MainEngineTorqueCheck | null | undefined
  mirror: BurnAuthorityReport | null
  comPending: boolean
  // For the wheel-unload bound below.
  hardware: HardwareItem[]
  tickS: number
}) {
  // The runtime mechanism this static check does NOT cover (despite
  // the reassuring wording above): at burn
  // start the allocator (ThrustersPrimary) dumps ALL wheel momentum within
  // one tick and hands the reaction h_wheel / tick_s to the RCS. Bound it
  // from the config: per-wheel capacity I·ω_max, so a wheel entering the
  // burn near capacity alone demands I·ω_max / tick_s of RCS torque.
  const wheels = hardware.find((h) => h.type === "ReactionWheelCluster")
  const wheelCapNms =
    wheels?.type === "ReactionWheelCluster" && wheels.inertia_kgm2 != null && wheels.max_speed_rads != null
      ? wheels.inertia_kgm2 * wheels.max_speed_rads
      : null
  const unloadReactionNm = wheelCapNms != null && tickS > 0 ? wheelCapNms / tickS : null
  if (comPending && !check && !mirror) {
    return <p className="mb-4 text-[10px] italic text-muted-foreground">Computing burn-attitude authority (fetching vehicle properties)…</p>
  }
  const disturbance = check?.disturbance_torque_nm ?? mirror?.disturbanceMagNm ?? null
  const authority = check?.rcs_authority_nm ?? mirror?.counterAuthorityNm ?? null
  const ratio = check ? (check.ratio ?? (check.disturbance_torque_nm > 1e-9 ? Infinity : 0)) : mirror ? 1 / mirror.margin : null
  const offset = check?.thrust_offset_body_m ?? mirror?.thrustOffsetM ?? null
  if (disturbance == null || authority == null || ratio == null) {
    return (
      <div className="mb-4 rounded border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <b>Burn-attitude authority:</b> no main engine configured, or no individually placed RCS thrusters -- place
        thrusters in Phase 02 to get a real verdict.
      </div>
    )
  }
  const noDisturbance = disturbance < 1e-9
  const ok = noDisturbance || ratio <= 0.67
  const marginal = !ok && ratio <= 1
  const tone = ok
    ? "border-emerald-700 bg-emerald-950/30 text-emerald-200"
    : marginal
      ? "border-amber-600 bg-amber-950/40 text-amber-200"
      : "border-red-700 bg-red-950/40 text-red-200"
  const fmt = (v: number) => (Math.abs(v) < 1e-3 && v !== 0 ? v.toExponential(2) : v.toFixed(3))
  const marginTxt = Number.isFinite(ratio) && ratio > 0 ? `${(1 / ratio).toFixed(2)}× margin` : "zero authority along the needed axis"
  return (
    <div className={`mb-4 rounded border px-3 py-2.5 text-[11px] ${tone}`} style={{ fontVariantNumeric: "tabular-nums" }}>
      <p className="font-bold">
        Burn-attitude authority:{" "}
        {noDisturbance
          ? "engine passes through the CoM — no disturbance torque to hold"
          : ok
            ? `RCS can hold attitude through a burn (${marginTxt})`
            : marginal
              ? `marginal — RCS barely covers the engine disturbance (${marginTxt})`
              : `RCS CANNOT hold attitude through a burn (${marginTxt}) — the vehicle tumbles while thrusting, by physics`}
        {check ? "" : " · frontend estimate (server lacks main_engine_torque_check)"}
      </p>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 opacity-90 sm:grid-cols-3">
        {offset && <span title="engine mount (−X face centre) minus the derived CoM">thrust arm {offset.map((v) => v.toFixed(3)).join(", ")} m</span>}
        <span title="|arm × thrust| about the CoM">engine disturbance {fmt(disturbance)} N·m</span>
        <span title="RCS torque along the cancellation axis, every helpful thruster at 100% duty">RCS authority {fmt(authority)} N·m</span>
        {mirror && (
          <span>
            {mirror.placedThrusterCount} placed thrusters · torque rank {mirror.torqueRank}/3
            {mirror.deadAxes.length > 0 ? ` · no authority about ${mirror.deadAxes.join(" ")}` : ""}
          </span>
        )}
      </div>
      {unloadReactionNm != null && (
        <p className={`mt-1.5 ${unloadReactionNm > authority ? "font-semibold text-amber-300" : "opacity-80"}`}>
          Not covered by this static check: at burn start the allocator unloads all wheel momentum within one tick
          and the RCS must absorb the reaction h_wheel / {tickS} s. A wheel entering the burn at capacity ({wheelCapNms!.toFixed(1)}{" "}
          N·m·s) alone demands {unloadReactionNm.toFixed(2)} N·m — {unloadReactionNm > authority ? "MORE" : "less"} than the{" "}
          {fmt(authority)} N·m the RCS can deliver. See Fig. 6's purple trace for the real per-tick value.
        </p>
      )}
      {mirror && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10px] opacity-70 hover:opacity-100">per-axis authority (full duty) · cross-coupling</summary>
          <div className="mt-1 grid grid-cols-3 gap-x-4 gap-y-0.5 text-[10px] opacity-90 sm:grid-cols-6">
            {mirror.axes.map((a) => (
              <span
                key={a.axis}
                title="cross-coupling = off-axis / on-axis torque of the set the allocator fires for this axis (it fires every thruster with a positive projection); high = the RCS torques mostly sideways when asked for this axis"
              >
                {a.axis} {fmt(a.authorityNm)} N·m{Number.isFinite(a.crossCoupling) ? ` · ×${a.crossCoupling.toFixed(2)}` : " · ×∞"}
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
