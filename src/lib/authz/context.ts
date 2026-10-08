import type { Role } from "./permissions";

export type { Role };

/**
 * Request-scoped organisation context (DECISIONS #8).
 * orgId is ALWAYS resolved server-side from the session — never from client
 * input. Services scope every query by ctx.orgId.
 */
export interface OrgContext {
  orgId: string;
  userId: string;
  role: Role;
  restrictions: {
    /** null = unrestricted (no access rows for the member) */
    warehouseIds: string[] | null;
    /** null = unrestricted */
    buyingPointIds: string[] | null;
    /** warehouse role + org-wide hide_prices_from_warehouse switch */
    hidePrices: boolean;
  };
  /** true after trial expiry / failed payment — mutations rejected by guard */
  readOnly: boolean;
}
