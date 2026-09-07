import type { MissionConfig } from "@/api/client"

// Shared between PhysicsFields.tsx (Memo 01's Optimizer section) and
// VehiclePaper.tsx (Memo 02's SrpModelBanner, next to where placed
// panel/plate hardware actually lives) -- kept in a non-component module so
// both can import it without tripping react-refresh's
// only-export-components rule.
export type SrpModel = MissionConfig["spacecraft"]["srp_model"]

export const SRP_MODELS: { value: SrpModel; hint: string }[] = [
  { value: "Cannonball", hint: "Single effective area + scalar reflectivity -- fast, used inside the EKF filter." },
  { value: "FlatPlate", hint: "Bus faces + solar panels as discrete flat plates -- attitude-dependent SRP." },
  { value: "NPlate", hint: "User-defined plate list -- most general SRP model." },
]
