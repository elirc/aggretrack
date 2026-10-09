import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import { expenseCategories, expenses, lots, purchaseLines, tripPurchases, trips } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { shareByWeight } from "@/lib/domain/costSharing";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams, type Grams, type Kobo } from "@/lib/domain/units";

/**
 * Landed cost (DOMAIN-ENGINE §8) — BINDING.
 *
 * Per lot:
 *   landed_rate = purchase_price_per_kg_kobo + (tripShareKobo + directLotExpensesKobo) / original_kg
 *
 * - tripShareKobo: for every INBOUND trip linked (trip_purchases) to the lot's
 *   purchase, the pool `trip.cost_kobo + Σ affects-landed-cost expenses attached
 *   to that trip` is shared across ALL lots of ALL purchases on that trip by
 *   original_kg with domain shareByWeight (largest remainder → integer kobo,
 *   Σ shares === pool exactly). A lot on several trips sums its shares.
 * - directLotExpensesKobo: Σ affects-landed-cost expenses attached to the lot.
 *
 * Rounding (exact, documented): shares are integer kobo. The per-kg division
 * happens ONCE per lot at the end, in BigInt:
 *   extra4 = round_half_up(extraKobo × 1000 g/kg × 10^4 / original_grams)
 *   rate   = purchase_price + extra4 / 10^4        (numeric(14,4), 4 dp half-up)
 * A lot with original_kg = 0 keeps rate = purchase price (nothing to divide over).
 *
 * Late-cost rule: costs may arrive after sales. Recompute updates
 * lots.landed_cost_per_kg_kobo IN PLACE regardless of sales/dispatches; margin
 * reads the CURRENT value, so historical margins shift (intended). Invoices
 * never change.
 *
 * Callers (trip / expense mutations, and receiving once lots exist) MUST call
 * this inside the same transaction as the change.
 */

// ── small shared helpers for P2-D services ───────────────────────────────────

/** Rows from a drizzle node-postgres `execute` result. */
export function execRows<T>(result: unknown): T[] {
  const r = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(r) ? r : [];
}

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Run a mutation in a transaction (savepoint when already inside one); map FK/unique errors. */
export async function mutate<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await (db as Tx).transaction(fn);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const code = pgCode(err);
    if (code === "23505") throw new DomainError("DUPLICATE", "Already exists");
    if (code === "23503") throw new DomainError("IN_USE", "This record is referenced and cannot be changed");
    if (code === "23514") throw new DomainError("INVALID_INPUT", "Check constraint violated");
    throw err;
  }
}

// ── rate maths ───────────────────────────────────────────────────────────────

/** Exact numeric(14,4) string for price + extraKobo / (grams/1000), half-up at the 4th dp. */
export function landedRateString(purchasePricePerKgKobo: Kobo, extraKobo: Kobo, originalGrams: Grams): string {
  const price4 = BigInt(purchasePricePerKgKobo) * BigInt(10_000);
  let extra4 = BigInt(0);
  if (originalGrams > 0 && extraKobo !== 0) {
    const num = BigInt(extraKobo) * BigInt(10_000_000); // kobo × 1000 g/kg × 10^4
    const den = BigInt(originalGrams);
    extra4 = (num * BigInt(2) + den) / (den * BigInt(2)); // half-up (num ≥ 0)
  }
  const total = price4 + extra4;
  const whole = total / BigInt(10_000);
  const frac = (total % BigInt(10_000)).toString().padStart(4, "0");
  return `${whole.toString()}.${frac}`;
}

/** Normalise a numeric(14,4) DB string to exactly 4 dp for equality checks. */
function norm4(s: string): string {
  const [w, f = ""] = s.split(".");
  return `${w}.${(f + "0000").slice(0, 4)}`;
}

// ── affected-lot discovery ──────────────────────────────────────────────────

/** All lot ids of all purchases linked to the given trips (any direction filter applied by caller). */
export async function lotIdsForTrips(tx: DbOrTx, ctx: OrgContext, tripIds: string[]): Promise<string[]> {
  if (tripIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ id: lots.id })
    .from(tripPurchases)
    .innerJoin(purchaseLines, eq(purchaseLines.purchaseId, tripPurchases.purchaseId))
    .innerJoin(lots, eq(lots.purchaseLineId, purchaseLines.id))
    .where(and(eq(tripPurchases.organisationId, ctx.orgId), inArray(tripPurchases.tripId, tripIds)));
  return rows.map((r) => r.id);
}

/** All lot ids that share an inbound trip with any lot of the given purchases (incl. their own lots). */
export async function lotIdsForPurchases(tx: DbOrTx, ctx: OrgContext, purchaseIds: string[]): Promise<string[]> {
  if (purchaseIds.length === 0) return [];
  const own = await tx
    .select({ id: lots.id })
    .from(lots)
    .innerJoin(purchaseLines, eq(lots.purchaseLineId, purchaseLines.id))
    .where(and(eq(lots.organisationId, ctx.orgId), inArray(purchaseLines.purchaseId, purchaseIds)));
  const tripRows = await tx
    .selectDistinct({ tripId: tripPurchases.tripId })
    .from(tripPurchases)
    .where(and(eq(tripPurchases.organisationId, ctx.orgId), inArray(tripPurchases.purchaseId, purchaseIds)));
  const viaTrips = await lotIdsForTrips(
    tx,
    ctx,
    tripRows.map((r) => r.tripId),
  );
  return [...new Set([...own.map((r) => r.id), ...viaTrips])];
}

/**
 * Convenience for the receiving flow: after a purchase's lots are created,
 * recompute every lot sharing an inbound trip with it (the new lots change
 * everyone's weight share).
 */
export async function recomputeLandedCostForPurchase(tx: Tx, ctx: OrgContext, purchaseId: string) {
  return recomputeLandedCost(tx, ctx, await lotIdsForPurchases(tx, ctx, [purchaseId]));
}

// ── the recompute ────────────────────────────────────────────────────────────

export type LandedCostChange = { lotId: string; before: string; after: string };

export type LandedCostBreakdown = {
  lotId: string;
  originalGrams: Grams;
  purchasePricePerKgKobo: Kobo;
  tripShareKobo: Kobo;
  directExpensesKobo: Kobo;
  landedCostPerKgKobo: string;
};

/**
 * Pure-read computation of the landed breakdown for the given lots (no writes).
 * Exposed so lot pages can show "price + trip share + expenses".
 */
export async function computeLandedBreakdown(
  tx: DbOrTx,
  ctx: OrgContext,
  lotIds: string[],
): Promise<Map<string, LandedCostBreakdown>> {
  const out = new Map<string, LandedCostBreakdown>();
  const ids = [...new Set(lotIds)];
  if (ids.length === 0) return out;

  // 1. Target lots + their purchase.
  const targets = await tx
    .select({
      id: lots.id,
      originalKg: lots.originalKg,
      price: lots.purchasePricePerKgKobo,
      purchaseId: purchaseLines.purchaseId,
    })
    .from(lots)
    .innerJoin(purchaseLines, eq(lots.purchaseLineId, purchaseLines.id))
    .where(and(eq(lots.organisationId, ctx.orgId), inArray(lots.id, ids)));

  const purchaseIds = [...new Set(targets.map((t) => t.purchaseId))];

  // 2. Inbound trips linked to those purchases.
  const tripLinks =
    purchaseIds.length === 0
      ? []
      : await tx
          .select({ tripId: trips.id, purchaseId: tripPurchases.purchaseId, costKobo: trips.costKobo })
          .from(tripPurchases)
          .innerJoin(trips, eq(trips.id, tripPurchases.tripId))
          .where(
            and(
              eq(tripPurchases.organisationId, ctx.orgId),
              eq(trips.direction, "inbound"),
              inArray(tripPurchases.purchaseId, purchaseIds),
            ),
          );
  const tripIds = [...new Set(tripLinks.map((l) => l.tripId))];

  // 3. Pool per trip = cost + Σ affecting expenses attached to the trip.
  const pool = new Map<string, Kobo>();
  for (const l of tripLinks) pool.set(l.tripId, l.costKobo);
  if (tripIds.length > 0) {
    const tripExp = await tx
      .select({ tripId: expenses.tripId, total: sql<string>`coalesce(sum(${expenses.amountKobo}), 0)` })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(
        and(
          eq(expenses.organisationId, ctx.orgId),
          inArray(expenses.tripId, tripIds),
          eq(expenseCategories.affectsLandedCost, true),
        ),
      )
      .groupBy(expenses.tripId);
    for (const r of tripExp) {
      if (r.tripId) pool.set(r.tripId, (pool.get(r.tripId) ?? 0) + Number(r.total));
    }
  }

  // 4. Every lot on every one of those trips (the sharing population), and the shares.
  const tripShare = new Map<string, Kobo>();
  if (tripIds.length > 0) {
    const members = await tx
      .select({ tripId: tripPurchases.tripId, lotId: lots.id, originalKg: lots.originalKg })
      .from(tripPurchases)
      .innerJoin(purchaseLines, eq(purchaseLines.purchaseId, tripPurchases.purchaseId))
      .innerJoin(lots, eq(lots.purchaseLineId, purchaseLines.id))
      .where(and(eq(tripPurchases.organisationId, ctx.orgId), inArray(tripPurchases.tripId, tripIds)));
    const byTrip = new Map<string, { id: string; grams: Grams }[]>();
    for (const m of members) {
      const list = byTrip.get(m.tripId) ?? [];
      list.push({ id: m.lotId, grams: kgToGrams(m.originalKg) });
      byTrip.set(m.tripId, list);
    }
    for (const [tripId, items] of byTrip) {
      const shares = shareByWeight(pool.get(tripId) ?? 0, items);
      for (const [lotId, kobo] of shares) tripShare.set(lotId, (tripShare.get(lotId) ?? 0) + kobo);
    }
  }

  // 5. Direct affecting expenses on the lots.
  const direct = new Map<string, Kobo>();
  const directRows = await tx
    .select({ lotId: expenses.lotId, total: sql<string>`coalesce(sum(${expenses.amountKobo}), 0)` })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .where(
      and(
        eq(expenses.organisationId, ctx.orgId),
        inArray(expenses.lotId, ids),
        eq(expenseCategories.affectsLandedCost, true),
      ),
    )
    .groupBy(expenses.lotId);
  for (const r of directRows) if (r.lotId) direct.set(r.lotId, Number(r.total));

  // 6. Rates.
  for (const t of targets) {
    const grams = kgToGrams(t.originalKg);
    const share = tripShare.get(t.id) ?? 0;
    const dir = direct.get(t.id) ?? 0;
    out.set(t.id, {
      lotId: t.id,
      originalGrams: grams,
      purchasePricePerKgKobo: t.price,
      tripShareKobo: share,
      directExpensesKobo: dir,
      landedCostPerKgKobo: landedRateString(t.price, share + dir, grams),
    });
  }
  return out;
}

/**
 * Recompute and persist landed cost for the given lots, in the caller's tx.
 * Locks the lots (ordered by id, same order as stockCore → no deadlock) before
 * reading. Writes an audit row per lot whose rate actually changed.
 */
export async function recomputeLandedCost(
  tx: Tx,
  ctx: OrgContext,
  lotIds: string[],
): Promise<LandedCostChange[]> {
  const ids = [...new Set(lotIds)].sort();
  if (ids.length === 0) return [];

  const locked = execRows<{ id: string; landed: string }>(
    await tx.execute(sql`
      SELECT id, landed_cost_per_kg_kobo AS landed FROM lots
      WHERE organisation_id = ${ctx.orgId}
        AND id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      ORDER BY id
      FOR UPDATE
    `),
  );
  const before = new Map(locked.map((r) => [r.id, norm4(String(r.landed))]));

  const breakdown = await computeLandedBreakdown(tx, ctx, ids);
  const changes: LandedCostChange[] = [];
  for (const id of ids) {
    const b = breakdown.get(id);
    const prev = before.get(id);
    if (!b || prev === undefined) continue;
    if (prev === b.landedCostPerKgKobo) continue;
    await tx
      .update(lots)
      .set({ landedCostPerKgKobo: b.landedCostPerKgKobo, updatedAt: new Date() })
      .where(and(eq(lots.organisationId, ctx.orgId), eq(lots.id, id)));
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "lots",
      recordId: id,
      before: { landedCostPerKgKobo: prev },
      after: {
        landedCostPerKgKobo: b.landedCostPerKgKobo,
        tripShareKobo: b.tripShareKobo,
        directExpensesKobo: b.directExpensesKobo,
      },
    });
    changes.push({ lotId: id, before: prev, after: b.landedCostPerKgKobo });
  }
  return changes;
}
