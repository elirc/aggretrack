import { and, eq, sql } from "drizzle-orm";

import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, type Grams } from "@/lib/domain/units";
import type { DocType } from "@/lib/domain/numbering";
import type { OrgContext } from "@/lib/authz/context";
import type { DbOrTx, Tx } from "@/db/client";
import { lotAllocations, stockMovements } from "@/db/schema";

/**
 * Stock spine (ARCHITECTURE §Stock spine, DOMAIN-ENGINE §2/§4).
 *
 * This module is the ONLY code allowed to insert stock_movements rows.
 * The table is append-only: no update, no delete, ever. Corrections are new
 * movements. Stock on hand is always SUM(movements.kg) per lot+warehouse.
 */

export type MovementType =
  | "receive"
  | "transfer_out"
  | "transfer_in"
  | "adjustment"
  | "dispatch"
  | "return";

export type MovementInput = {
  lotId: string;
  warehouseId: string;
  binId?: string | null;
  type: MovementType;
  /** Signed: receive/transfer_in/return > 0; transfer_out/dispatch < 0; adjustment either (non-zero). */
  grams: Grams;
  /** Signed likewise; 0 when bags are not tracked for the movement. */
  bags: number;
  refType: DocType;
  refId: string;
  occurredAt?: Date;
};

const POSITIVE_TYPES: ReadonlySet<MovementType> = new Set(["receive", "transfer_in", "return"]);
const NEGATIVE_TYPES: ReadonlySet<MovementType> = new Set(["transfer_out", "dispatch"]);

function validateMove(m: MovementInput): void {
  if (!Number.isSafeInteger(m.grams)) {
    throw new DomainError("INVALID_MOVEMENT", `grams must be an integer (lot ${m.lotId})`);
  }
  if (!Number.isSafeInteger(m.bags)) {
    throw new DomainError("INVALID_MOVEMENT", `bags must be an integer (lot ${m.lotId})`);
  }
  if (POSITIVE_TYPES.has(m.type) && m.grams <= 0) {
    throw new DomainError("INVALID_MOVEMENT", `${m.type} movement must have grams > 0`);
  }
  if (NEGATIVE_TYPES.has(m.type) && m.grams >= 0) {
    throw new DomainError("INVALID_MOVEMENT", `${m.type} movement must have grams < 0`);
  }
  if (m.type === "adjustment" && m.grams === 0) {
    throw new DomainError("INVALID_MOVEMENT", "adjustment movement must have grams !== 0");
  }
  if (m.bags !== 0 && Math.sign(m.bags) !== Math.sign(m.grams)) {
    throw new DomainError("INVALID_MOVEMENT", "bags sign must match grams sign");
  }
  if (!m.refType || !m.refId) {
    throw new DomainError("INVALID_MOVEMENT", "movement requires refType and refId");
  }
}

type PairState = {
  lotId: string;
  warehouseId: string;
  netChangeGrams: Grams;
  /** true when a negative move in the batch is NOT a dispatch (dispatch releases its reservation in the same tx). */
  needsReservedCheck: boolean;
};

async function sumKgGrams(
  tx: Tx,
  ctx: OrgContext,
  lotId: string,
  warehouseId: string,
): Promise<Grams> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${stockMovements.kg}), 0)` })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.organisationId, ctx.orgId),
        eq(stockMovements.lotId, lotId),
        eq(stockMovements.warehouseId, warehouseId),
      ),
    );
  return kgToGrams(rows[0]?.total ?? "0");
}

async function sumReservedGrams(
  tx: Tx,
  ctx: OrgContext,
  lotId: string,
  warehouseId: string,
): Promise<Grams> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${lotAllocations.kg}), 0)` })
    .from(lotAllocations)
    .where(
      and(
        eq(lotAllocations.organisationId, ctx.orgId),
        eq(lotAllocations.lotId, lotId),
        eq(lotAllocations.warehouseId, warehouseId),
        eq(lotAllocations.status, "reserved"),
      ),
    );
  return kgToGrams(rows[0]?.total ?? "0");
}

/**
 * Append a batch of stock movements atomically, with the oversell guard.
 *
 * Protocol (THE concurrency recipe):
 *  1. Lock every affected lot: SELECT ... ORDER BY id FOR UPDATE (ordered ids → no deadlock).
 *  2. AFTER locking, read fresh on-hand / reserved sums per (lot, warehouse).
 *  3. Enforce: on_hand + netChange >= 0 for every pair; and for pairs whose
 *     negative moves include non-dispatch types, on_hand + netChange - reserved >= 0
 *     (dispatch movements flip their own reservations in the same tx, so they are
 *     exempt from the reservation floor — the caller's flip keeps the books level).
 *  4. Insert the movement rows.
 */
export async function postMovements(
  tx: Tx,
  ctx: OrgContext,
  moves: MovementInput[],
): Promise<void> {
  if (moves.length === 0) return;
  for (const m of moves) validateMove(m);

  const lotIds = [...new Set(moves.map((m) => m.lotId))].sort();
  const locked = await tx.execute(sql`
    SELECT id FROM lots
    WHERE id IN (${sql.join(lotIds.map((id) => sql`${id}`), sql`, `)})
      AND organisation_id = ${ctx.orgId}
    ORDER BY id
    FOR UPDATE
  `);
  const lockedRows =
    (locked as unknown as { rows?: Array<{ id: string }> }).rows ??
    (locked as unknown as Array<{ id: string }>);
  const lockedIds = new Set((Array.isArray(lockedRows) ? lockedRows : []).map((r) => r.id));
  for (const lotId of lotIds) {
    if (!lockedIds.has(lotId)) {
      throw new DomainError("NOT_FOUND", `lot ${lotId} not found in organisation`);
    }
  }

  const pairs = new Map<string, PairState>();
  for (const m of moves) {
    const key = `${m.lotId}|${m.warehouseId}`;
    const p = pairs.get(key) ?? {
      lotId: m.lotId,
      warehouseId: m.warehouseId,
      netChangeGrams: 0,
      needsReservedCheck: false,
    };
    p.netChangeGrams += m.grams;
    if (m.grams < 0 && m.type !== "dispatch") p.needsReservedCheck = true;
    pairs.set(key, p);
  }

  for (const p of pairs.values()) {
    if (p.netChangeGrams >= 0 && !p.needsReservedCheck) continue;
    const onHand = await sumKgGrams(tx, ctx, p.lotId, p.warehouseId);
    const afterOnHand = onHand + p.netChangeGrams;
    if (afterOnHand < 0) {
      throw new DomainError("INSUFFICIENT_STOCK", "insufficient stock", {
        lotId: p.lotId,
        warehouseId: p.warehouseId,
        shortfallGrams: -afterOnHand,
      });
    }
    if (p.needsReservedCheck) {
      const reserved = await sumReservedGrams(tx, ctx, p.lotId, p.warehouseId);
      const availableAfter = afterOnHand - reserved;
      if (availableAfter < 0) {
        throw new DomainError("INSUFFICIENT_STOCK", "stock is reserved", {
          lotId: p.lotId,
          warehouseId: p.warehouseId,
          shortfallGrams: -availableAfter,
        });
      }
    }
  }

  await tx.insert(stockMovements).values(
    moves.map((m) => ({
      organisationId: ctx.orgId,
      lotId: m.lotId,
      warehouseId: m.warehouseId,
      binId: m.binId ?? null,
      type: m.type,
      kg: gramsToKg(m.grams),
      bags: m.bags,
      refType: m.refType,
      refId: m.refId,
      createdBy: ctx.userId,
      occurredAt: m.occurredAt ?? new Date(),
    })),
  );
}

/** Total on-hand for a lot across all warehouses. */
export async function lotOnHand(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  lotId: string,
): Promise<{ grams: Grams; bags: number }> {
  const rows = await dbOrTx
    .select({
      kg: sql<string>`coalesce(sum(${stockMovements.kg}), 0)`,
      bags: sql<string>`coalesce(sum(${stockMovements.bags}), 0)`,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.organisationId, ctx.orgId), eq(stockMovements.lotId, lotId)));
  return {
    grams: kgToGrams(rows[0]?.kg ?? "0"),
    bags: Number(rows[0]?.bags ?? 0),
  };
}

/** available = on_hand − reserved for one lot+warehouse. Call inside a tx holding the lot lock when deciding writes. */
export async function availableGrams(
  tx: Tx,
  ctx: OrgContext,
  lotId: string,
  warehouseId: string,
): Promise<Grams> {
  const onHand = await sumKgGrams(tx, ctx, lotId, warehouseId);
  const reserved = await sumReservedGrams(tx, ctx, lotId, warehouseId);
  return onHand - reserved;
}
