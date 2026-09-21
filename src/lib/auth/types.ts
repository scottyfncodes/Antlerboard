export type ManagerRole = "manager" | "commissioner";

/** The minimal, client-safe view of the signed-in manager - never includes a PIN or hash. */
export interface CurrentManagerSummary {
  id: string;
  name: string;
  role: ManagerRole;
}
