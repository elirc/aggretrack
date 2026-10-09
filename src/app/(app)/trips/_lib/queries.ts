import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { purchaseLines } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import { execRows } from "@/lib/services/landedCost";

/**
 * Small org-scoped read helpers for the trips pages (P3-D). The trips service
 * returns link counts but not weights; these add the linked kg so the UI can
 * show cost per kg. Read-only — no new service file.
 */

/** tripId → linked kg (purchase net kg for inbound, dispatched kg for outbound). */
export async function linkedKgByTrip(ctx: OrgContext): Promise<Map<string, string>> {
  const res = await db.execute(sql`
    SELECT t.id,
      coalesce((SELECT sum(pl.net_kg) FROM trip_purchases tp
                JOIN purchase_lines pl ON pl.purchase_id = tp.purchase_id
                WHERE tp.trip_id = t.id AND tp.organisation_id = ${ctx.orgId}), 0)
      + coalesce((SELECT sum(d.dispatched_kg) FROM trip_dispatches td
                JOIN dispatches d ON d.id = td.dispatch_id
                WHERE td.trip_id = t.id AND td.organisation_id = ${ctx.orgId}), 0) AS kg
    FROM trips t
    WHERE t.organisation_id = ${ctx.orgId}
  `);
  const out = new Map<string, string>();
  for (const r of execRows<{ id: string; kg: string | number }>(res)) {
    out.set(String(r.id), gramsToKg(kgToGrams(String(r.kg ?? "0"))));
  }
  return out;
}

/** purchaseId → net kg, for the given purchases (org-scoped). */
export async function purchaseNetKg(ctx: OrgContext, purchaseIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (purchaseIds.length === 0) return out;
  const rows = await db
    .select({ purchaseId: purchaseLines.purchaseId, kg: sql<string>`coalesce(sum(${purchaseLines.netKg}), 0)` })
    .from(purchaseLines)
    .where(and(eq(purchaseLines.organisationId, ctx.orgId), inArray(purchaseLines.purchaseId, purchaseIds)))
    .groupBy(purchaseLines.purchaseId);
  for (const r of rows) out.set(r.purchaseId, gramsToKg(kgToGrams(String(r.kg))));
  return out;
}

export function sumKg(kgs: string[]): string {
  return gramsToKg(kgs.reduce((s, k) => s + kgToGrams(k), 0));
}
