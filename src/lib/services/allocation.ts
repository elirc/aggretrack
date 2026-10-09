import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import { lotAllocations, lots, salesLines, stockMovements, warehouses } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import {
  allocateFifo,
  validateManualAllocation,
  type AllocationLine,
  type LotAvailability,
} from "@/lib/domain/allocation";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, type Grams } from "@/lib/domain/units";
import { lockSalesOrder, notFound, refreshOrderStatus, runTx } from "@/lib/services/salesOrders";

/**
 * Lot allocation — the oversell guard (DOMAIN-ENGINE §4, BINDING).
 *
 * Protocol:
 *  1. Resolve candidate lot ids (commodity + grade, org-scoped, stock in an allowed warehouse).
 *  2. SELECT id FROM lots WHERE id IN (...) ORDER BY id FOR UPDATE (ordered → no deadlock).
 *  3. AFTER locking, aggregate fresh on_hand (Σ movements) and reserved (Σ allocations
 *     status='reserved') per lot+warehouse.
 *  4. allocateFifo / validateManualAllocation on those fresh numbers — throws abort the tx.
 *  5. Insert lot_allocations (status reserved), update order status, audit.
 *
 * Reservations are NOT movements; stockCore.postMovements already subtracts
 * status='reserved' rows from availability for every non-dispatch outflow.
 */

export type LotAllocation = typeof lotAllocations.$inferSelect;

export type ReserveForSalesLineInput = {
  salesLineId: string;
  mode: "fifo" | "manual";
  /** Manual picks in grams (domain AllocationLine). Required for mode 'manual'. */
  picks?: AllocationLine[];
  /** Restrict candidates to one warehouse. */
  warehouseId?: string;
};

type Pair = { lotId: string; warehouseId: string };

function allowedWarehouses(ctx: OrgContext, warehouseId?: string): string[] | null {
  const restricted = ctx.restrictions.warehouseIds;
  if (warehouseId) {
    if (restricted && !restricted.includes(warehouseId)) {
      throw new DomainError("FORBIDDEN_WAREHOUSE", "You do not have access to that warehouse");
    }
    return [warehouseId];
  }
  return restricted;
}

/** Lot+warehouse pairs of a commodity/grade that currently hold stock (pre-lock hint; re-checked after lock). */
async function candidatePairs(
  tx: DbOrTx,
  ctx: OrgContext,
  commodityId: string,
  gradeId: string,
  allowed: string[] | null,
): Promise<Pair[]> {
  const where: SQL[] = [
    eq(lots.organisationId, ctx.orgId),
    eq(lots.commodityId, commodityId),
    eq(lots.gradeId, gradeId),
    eq(stockMovements.organisationId, ctx.orgId),
  ];
  if (allowed) {
    if (allowed.length === 0) return [];
    where.push(inArray(stockMovements.warehouseId, allowed));
  }
  return tx
    .select({ lotId: lots.id, warehouseId: stockMovements.warehouseId })
    .from(lots)
    .innerJoin(stockMovements, eq(stockMovements.lotId, lots.id))
    .where(and(...where))
    .groupBy(lots.id, stockMovements.warehouseId)
    .having(sql`sum(${stockMovements.kg}) > 0`);
}

/** Step 2: lock the lot rows, ordered by id. */
export async function lockLots(tx: Tx, ctx: OrgContext, lotIds: string[]): Promise<void> {
  const ids = [...new Set(lotIds)].sort();
  if (ids.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM lots
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND organisation_id = ${ctx.orgId}
    ORDER BY id
    FOR UPDATE
  `);
}

/** Step 3: fresh availability per lot+warehouse. Call only while holding the lot locks. */
export async function freshAvailability(
  tx: DbOrTx,
  ctx: OrgContext,
  lotIds: string[],
  allowed: string[] | null,
): Promise<LotAvailability[]> {
  if (lotIds.length === 0) return [];
  const onHand = await tx
    .select({
      lotId: stockMovements.lotId,
      warehouseId: stockMovements.warehouseId,
      kg: sql<string>`coalesce(sum(${stockMovements.kg}), 0)`,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.organisationId, ctx.orgId), inArray(stockMovements.lotId, lotIds)))
    .groupBy(stockMovements.lotId, stockMovements.warehouseId);
  const reserved = await tx
    .select({
      lotId: lotAllocations.lotId,
      warehouseId: lotAllocations.warehouseId,
      kg: sql<string>`coalesce(sum(${lotAllocations.kg}), 0)`,
    })
    .from(lotAllocations)
    .where(
      and(
        eq(lotAllocations.organisationId, ctx.orgId),
        inArray(lotAllocations.lotId, lotIds),
        eq(lotAllocations.status, "reserved"),
      ),
    )
    .groupBy(lotAllocations.lotId, lotAllocations.warehouseId);
  const received = await tx
    .select({ id: lots.id, receivedAt: lots.receivedAt })
    .from(lots)
    .where(and(eq(lots.organisationId, ctx.orgId), inArray(lots.id, lotIds)));
  const receivedMap = new Map(received.map((r) => [r.id, r.receivedAt]));
  const reservedMap = new Map(reserved.map((r) => [`${r.lotId}|${r.warehouseId}`, kgToGrams(r.kg)]));

  const out: LotAvailability[] = [];
  for (const r of onHand) {
    if (allowed && !allowed.includes(r.warehouseId)) continue;
    const receivedAt = receivedMap.get(r.lotId);
    if (!receivedAt) continue;
    const availableG = kgToGrams(r.kg) - (reservedMap.get(`${r.lotId}|${r.warehouseId}`) ?? 0);
    out.push({ lotId: r.lotId, warehouseId: r.warehouseId, receivedAt, availableG });
  }
  return out;
}

async function activeAllocatedGrams(tx: DbOrTx, ctx: OrgContext, salesLineId: string): Promise<Grams> {
  const [row] = await tx
    .select({ kg: sql<string>`coalesce(sum(${lotAllocations.kg}), 0)` })
    .from(lotAllocations)
    .where(
      and(
        eq(lotAllocations.organisationId, ctx.orgId),
        eq(lotAllocations.salesLineId, salesLineId),
        inArray(lotAllocations.status, ["reserved", "dispatched"]),
      ),
    );
  return kgToGrams(row?.kg ?? "0");
}

async function reserveInTx(tx: Tx, ctx: OrgContext, input: ReserveForSalesLineInput): Promise<LotAllocation[]> {
  const [line] = await tx
    .select()
    .from(salesLines)
    .where(and(eq(salesLines.id, input.salesLineId), eq(salesLines.organisationId, ctx.orgId)));
  if (!line) notFound("Sales line");

  // Parent lock first: serialises allocations on the same order (no double-cover of a line).
  const order = await lockSalesOrder(tx, ctx, line.salesOrderId);
  if (order.status !== "confirmed" && order.status !== "allocated") {
    throw new DomainError("ORDER_NOT_ALLOCATABLE", `Cannot allocate an order in status ${order.status}`);
  }

  const requestedG = kgToGrams(line.kg) - (await activeAllocatedGrams(tx, ctx, line.id));
  if (requestedG <= 0) {
    throw new DomainError("LINE_FULLY_ALLOCATED", "This line is already fully allocated");
  }

  const allowed = allowedWarehouses(ctx, input.warehouseId);

  // 1. candidates
  const pairs = await candidatePairs(tx, ctx, line.commodityId, line.gradeId, allowed);
  const lotIds = [...new Set(pairs.map((p) => p.lotId))];

  // 2. lock (ordered by id)
  await lockLots(tx, ctx, lotIds);

  // 3. fresh numbers after the lock
  const fresh = await freshAvailability(tx, ctx, lotIds, allowed);

  // 4. domain decision on fresh numbers
  let chosen: AllocationLine[];
  if (input.mode === "manual") {
    if (!input.picks || input.picks.length === 0) {
      throw new DomainError("ALLOCATION_INVALID", "Manual allocation needs at least one pick");
    }
    chosen = validateManualAllocation(requestedG, input.picks, fresh);
  } else {
    chosen = allocateFifo(requestedG, fresh);
  }

  // 5. reservations + order status + audit
  const rows = await tx
    .insert(lotAllocations)
    .values(
      chosen.map((c) => ({
        organisationId: ctx.orgId,
        salesLineId: line.id,
        lotId: c.lotId,
        warehouseId: c.warehouseId,
        kg: gramsToKg(c.grams),
        status: "reserved" as const,
        createdBy: ctx.userId,
      })),
    )
    .returning();
  for (const r of rows) {
    await writeAudit(tx, ctx, {
      action: "create",
      tableName: "lot_allocations",
      recordId: r.id,
      after: { ...r, mode: input.mode },
    });
  }
  await refreshOrderStatus(tx, ctx, order);
  return rows;
}

/** Reserve stock for one sales line (FIFO or manual picks). DOMAIN-ENGINE §4. */
export async function reserveForSalesLine(
  db: DbOrTx,
  ctx: OrgContext,
  input: ReserveForSalesLineInput,
): Promise<LotAllocation[]> {
  return runTx(db, (tx) => reserveInTx(tx, ctx, input));
}

/** FIFO-allocate every not-yet-covered line of an order in one transaction. */
export async function autoAllocateOrder(
  db: DbOrTx,
  ctx: OrgContext,
  input: { salesOrderId: string; warehouseId?: string },
): Promise<LotAllocation[]> {
  return runTx(db, async (tx) => {
    const order = await lockSalesOrder(tx, ctx, input.salesOrderId);
    if (order.status !== "confirmed" && order.status !== "allocated") {
      throw new DomainError("ORDER_NOT_ALLOCATABLE", `Cannot allocate an order in status ${order.status}`);
    }
    const lines = await tx
      .select({ id: salesLines.id, kg: salesLines.kg })
      .from(salesLines)
      .where(and(eq(salesLines.organisationId, ctx.orgId), eq(salesLines.salesOrderId, order.id)))
      .orderBy(asc(salesLines.createdAt), asc(salesLines.id));
    const out: LotAllocation[] = [];
    for (const l of lines) {
      if (kgToGrams(l.kg) - (await activeAllocatedGrams(tx, ctx, l.id)) <= 0) continue;
      out.push(...(await reserveInTx(tx, ctx, { salesLineId: l.id, mode: "fifo", warehouseId: input.warehouseId })));
    }
    return out;
  });
}

/**
 * Release reservations (reserved → cancelled). By allocation id or by whole
 * sales line. Dispatched/cancelled rows are never touched.
 */
export async function releaseAllocation(
  db: DbOrTx,
  ctx: OrgContext,
  input: { allocationId?: string; salesLineId?: string },
): Promise<LotAllocation[]> {
  if (Boolean(input.allocationId) === Boolean(input.salesLineId)) {
    throw new DomainError("VALIDATION", "Give exactly one of allocationId or salesLineId");
  }
  return runTx(db, async (tx) => {
    let salesLineId = input.salesLineId;
    if (input.allocationId) {
      const [a] = await tx
        .select({ salesLineId: lotAllocations.salesLineId })
        .from(lotAllocations)
        .where(and(eq(lotAllocations.id, input.allocationId), eq(lotAllocations.organisationId, ctx.orgId)));
      if (!a) notFound("Allocation");
      salesLineId = a.salesLineId;
    }
    const [line] = await tx
      .select({ id: salesLines.id, salesOrderId: salesLines.salesOrderId })
      .from(salesLines)
      .where(and(eq(salesLines.id, salesLineId!), eq(salesLines.organisationId, ctx.orgId)));
    if (!line) notFound("Sales line");
    const order = await lockSalesOrder(tx, ctx, line.salesOrderId);

    const where: SQL[] = [eq(lotAllocations.organisationId, ctx.orgId), eq(lotAllocations.salesLineId, line.id)];
    if (input.allocationId) {
      where.push(eq(lotAllocations.id, input.allocationId));
      const [current] = await tx
        .select({ status: lotAllocations.status })
        .from(lotAllocations)
        .where(and(...where))
        .for("update");
      if (!current) notFound("Allocation");
      if (current.status !== "reserved") {
        throw new DomainError("ALLOCATION_NOT_RESERVED", `Allocation is ${current.status}`);
      }
    }
    const released = await tx
      .update(lotAllocations)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(...where, eq(lotAllocations.status, "reserved")))
      .returning();
    for (const r of released) {
      await writeAudit(tx, ctx, {
        action: "cancel",
        tableName: "lot_allocations",
        recordId: r.id,
        before: { status: "reserved" },
        after: { status: "cancelled" },
      });
    }
    await refreshOrderStatus(tx, ctx, order);
    return released;
  });
}

export type AvailableLotRow = {
  lotId: string;
  lotNumber: string;
  warehouseId: string;
  warehouseName: string;
  receivedAt: Date;
  availableKg: string;
};

/** Manual-picker data: lots of a commodity/grade with available kg per warehouse (no locks; advisory). */
export async function listAvailableLots(
  db: DbOrTx,
  ctx: OrgContext,
  input: { commodityId: string; gradeId: string; warehouseId?: string },
): Promise<AvailableLotRow[]> {
  const allowed = allowedWarehouses(ctx, input.warehouseId);
  const pairs = await candidatePairs(db, ctx, input.commodityId, input.gradeId, allowed);
  const lotIds = [...new Set(pairs.map((p) => p.lotId))];
  if (lotIds.length === 0) return [];
  const avail = (await freshAvailability(db, ctx, lotIds, allowed)).filter((a) => a.availableG > 0);
  const meta = await db
    .select({ id: lots.id, lotNumber: lots.lotNumber })
    .from(lots)
    .where(and(eq(lots.organisationId, ctx.orgId), inArray(lots.id, lotIds)));
  const whIds = [...new Set(avail.map((a) => a.warehouseId))];
  const whRows = whIds.length
    ? await db
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .where(and(eq(warehouses.organisationId, ctx.orgId), inArray(warehouses.id, whIds)))
    : [];
  const lotNo = new Map(meta.map((m) => [m.id, m.lotNumber]));
  const whName = new Map(whRows.map((w) => [w.id, w.name]));
  return avail
    .sort(
      (a, b) =>
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0),
    )
    .map((a) => ({
      lotId: a.lotId,
      lotNumber: lotNo.get(a.lotId) ?? "",
      warehouseId: a.warehouseId,
      warehouseName: whName.get(a.warehouseId) ?? "",
      receivedAt: a.receivedAt,
      availableKg: gramsToKg(a.availableG),
    }));
}
