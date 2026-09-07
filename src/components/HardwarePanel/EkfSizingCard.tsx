import type { GncDesign } from "@/api/client"

/**
 * EKF state dimension, with a one-line plain-language gloss -- this app's
 * users aren't necessarily GNC experts, so a bare number like "10" needs a
 * hint at what's actually being estimated. Mirrors the two cases the backend
 * (`gnc_design.rs::ekf_state_dim`) actually produces: 10 when a cannonball
 * SRP model + OpNav camera are both configured (position, velocity, SRP
 * reflectivity, and 3-axis stochastic drag/SRP acceleration are all
 * estimated), 6 otherwise (position and velocity only).
 */
export function EkfSizingCard({ design }: { design: GncDesign }) {
  const isAugmented = design.ekf_state_dim === 10
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm">
        State dimension: <span className="font-medium">{design.ekf_state_dim}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {isAugmented
          ? "Estimates position, velocity, plus solar-pressure reflectivity and a slowly-varying " +
            "unmodeled acceleration -- needed because a cannonball SRP model and OpNav camera are both configured."
          : "Estimates position and velocity only -- no SRP/acceleration augmentation, since either the " +
            "cannonball SRP model or an OpNav camera isn't configured for this mission."}
      </p>
    </div>
  )
}
