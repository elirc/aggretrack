import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  commodities,
  customers,
  dispatches,
  grades,
  invoices,
  lotAllocations,
  lots,
  salesLines,
  salesOrders,
  warehouses,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, roundHalfUpKobo, type Grams, type Kobo } from "@/lib/domain/units";
import type { DocumentGenerateJob } from "@/lib/jobs";
import { QUEUES } from "@/lib/jobs";
import { nextDocNumber } from "@/lib/services/numbering";

/**
 * Sales orders (P2-C) + small helpers shared by the selling services.
 *
 * Lock order used by every selling mutation (prevents deadlocks):
 *   sales_orders row → lots (ORDER BY id) → lot_allocations / dispatches rows.
 */

// ── shared selling helpers ──────────────────────────────────────────────────

export type SalesOrder = typeof salesOrders.$inferSelect;
export type SalesLine = typeof salesLines.$inferSelect;
export type SalesOrderStatus = SalesOrder["status"];

/** Injectable side effects (tests pass a recorder; default enqueues on pg-boss). */
export type SellingDeps = {
  enqueue?: (queue: string, data: object) => Promise<unknown>;
};

/** Postgres SQLSTATE from a pg error, possibly wrapped by DrizzleQueryError. */
export function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Run in a transaction (savepoint when already inside one). */
export async function runTx<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (db as Tx).transaction(fn);
}

export function notFound(what: string): never {
  throw new DomainError("NOT_FOUND", `${what} not found`);
}

/** Today's calendar date in Africa/Lagos, yyyy-mm-dd. */
export function lagosToday(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** A `date` column value (yyyy-mm-dd) as a UTC-midnight Date. */
export function dateOnlyToDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

/**
 * Enqueue a PDF job AFTER the business tx committed. Best-effort: a queue
 * outage must never undo or fail a committed dispatch/invoice (the document
 * can be regenerated).
 */
export async function enqueueDocument(
  deps: SellingDeps | undefined,
  ctx: OrgContext,
  kind: DocumentGenerateJob["kind"],
  refId: string,
): Promise<void> {
  const payload: DocumentGenerateJob = { kind, refId, orgId: ctx.orgId };
  try {
    if (deps?.enqueue) {
      await deps.enqueue(QUEUES.DOCUMENT_GENERATE, payload);
      return;
    }
    // Relative import: worker/boss lives outside src (no @ alias there).
    const boss = await import("../../../worker/boss");
    await boss.enqueue(QUEUES.DOCUMENT_GENERATE, payload);
  } catch (err) {
    console.error(`[selling] failed to enqueue ${kind} document for ${refId}`, err);
  }
}

/** SELECT ... FOR UPDATE on one org-scoped sales order. */
export async function lockSalesOrder(tx: Tx, ctx: OrgContext, orderId: string): Promise<SalesOrder> {
  const [row] = await tx
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.id, orderId), eq(salesOrders.organisationId, ctx.orgId)))
    .for("update");
  if (!row) notFound("Sales order");
  return row;
}

export function lineAmountKobo(grams: Grams, pricePerKgKobo: Kobo): Kobo {
  return roundHalfUpKobo((grams * pricePerKgKobo) / 1000);
}

type LineCoverage = { lineId: string; lineG: Grams; reservedG: Grams; dispatchedG: Grams };

async function lineCoverage(tx: DbOrTx, ctx: OrgContext, orderId: string): Promise<LineCoverage[]> {
  const lines = await tx
    .select({ id: salesLines.id, kg: salesLines.kg })
    .from(salesLines)
    .where(and(eq(salesLines.organisationId, ctx.orgId), eq(salesLines.salesOrderId, orderId)));
  if (lines.length === 0) return [];
  const sums = await tx
    .select({
      lineId: lotAllocations.salesLineId,
      status: lotAllocations.status,
      kg: sql<string>`coalesce(sum(${lotAllocations.kg}), 0)`,
    })
    .from(lotAllocations)
    .where(
      and(
        eq(lotAllocations.organisationId, ctx.orgId),
        inArray(
          lotAllocations.salesLineId,
          lines.map((l) => l.id),
        ),
      ),
    )
    .groupBy(lotAllocations.salesLineId, lotAllocations.status);
  return lines.map((l) => {
    let reservedG = 0;
    let dispatchedG = 0;
    for (const s of sums) {
      if (s.lineId !== l.id) continue;
      if (s.status === "reserved") reservedG += kgToGrams(s.kg);
      if (s.status === "dispatched") dispatchedG += kgToGrams(s.kg);
    }
    return { lineId: l.id, lineG: kgToGrams(l.kg), reservedG, dispatchedG };
  });
}

/**
 * Re-derive confirmed / allocated / dispatched from the allocation layer.
 * Caller holds the order lock. draft / completed / cancelled are left alone.
 *  - every line fully dispatched                → dispatched
 *  - every line fully covered (reserved+disp.)  → allocated
 *  - otherwise                                  → confirmed
 */
export async function refreshOrderStatus(tx: Tx, ctx: OrgContext, order: SalesOrder): Promise<SalesOrderStatus> {
  if (order.status !== "confirmed" && order.status !== "allocated" && order.status !== "dispatched") {
    return order.status;
  }
  const cov = await lineCoverage(tx, ctx, order.id);
  let next: SalesOrderStatus = "confirmed";
  if (cov.length > 0 && cov.every((c) => c.dispatchedG >= c.lineG)) next = "dispatched";
  else if (cov.length > 0 && cov.every((c) => c.reservedG + c.dispatchedG >= c.lineG)) next = "allocated";
  if (next !== order.status) {
    await tx
      .update(salesOrders)
      .set({ status: next, updatedAt: new Date() })
      .where(and(eq(salesOrders.id, order.id), eq(salesOrders.organisationId, ctx.orgId)));
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "sales_orders",
      recordId: order.id,
      before: { status: order.status },
      after: { status: next },
    });
  }
  return next;
}

// ── input types ─────────────────────────────────────────────────────────────

export type SalesLineCreate = {
  commodityId: string;
  gradeId: string;
  /** kg decimal string */
  kg: string;
  pricePerKgKobo: Kobo;
};

export type SalesOrderCreate = {
  customerId: string;
  orderDate: string;
  lines: SalesLineCreate[];
};

async function assertCustomer(tx: DbOrTx, ctx: OrgContext, customerId: string): Promise<void> {
  const [c] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organisationId, ctx.orgId)));
  if (!c) notFound("Customer");
}

async function prepareLines(tx: DbOrTx, ctx: OrgContext, lines: SalesLineCreate[]) {
  if (lines.length === 0) throw new DomainError("VALIDATION", "A sales order needs at least one line");
  const gradeIds = [...new Set(lines.map((l) => l.gradeId))];
  const gradeRows = await tx
    .select({ id: grades.id, commodityId: grades.commodityId })
    .from(grades)
    .where(and(eq(grades.organisationId, ctx.orgId), inArray(grades.id, gradeIds)));
  const gradeMap = new Map(gradeRows.map((g) => [g.id, g.commodityId]));
  const commodityIds = [...new Set(lines.map((l) => l.commodityId))];
  const commodityRows = await tx
    .select({ id: commodities.id })
    .from(commodities)
    .where(and(eq(commodities.organisationId, ctx.orgId), inArray(commodities.id, commodityIds)));
  const commoditySet = new Set(commodityRows.map((c) => c.id));

  return lines.map((l) => {
    if (!commoditySet.has(l.commodityId)) notFound("Commodity");
    const gc = gradeMap.get(l.gradeId);
    if (!gc) notFound("Grade");
    if (gc !== l.commodityId) {
      throw new DomainError("VALIDATION", "Grade does not belong to the commodity");
    }
    const grams = kgToGrams(l.kg);
    if (grams <= 0) throw new DomainError("VALIDATION", "Line weight must be greater than 0");
    if (!Number.isSafeInteger(l.pricePerKgKobo) || l.pricePerKgKobo < 0) {
      throw new DomainError("VALIDATION", "Price must be non-negative integer kobo");
    }
    return {
      organisationId: ctx.orgId,
      commodityId: l.commodityId,
      gradeId: l.gradeId,
      kg: gramsToKg(grams),
      pricePerKgKobo: l.pricePerKgKobo,
      amountKobo: lineAmountKobo(grams, l.pricePerKgKobo),
    };
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

export async function createSalesOrder(
  db: DbOrTx,
  ctx: OrgContext,
  input: SalesOrderCreate,
): Promise<SalesOrder & { lines: SalesLine[] }> {
  return runTx(db, async (tx) => {
    await assertCustomer(tx, ctx, input.customerId);
    const lineRows = await prepareLines(tx, ctx, input.lines);
    const total = lineRows.reduce((s, l) => s + l.amountKobo, 0);
    const orderNumber = await nextDocNumber(tx, ctx.orgId, "so");
    const [order] = await tx
      .insert(salesOrders)
      .values({
        organisationId: ctx.orgId,
        orderNumber,
        customerId: input.customerId,
        orderDate: input.orderDate,
        status: "draft",
        totalAmountKobo: total,
        createdBy: ctx.userId,
      })
      .returning();
    const lines = await tx
      .insert(salesLines)
      .values(lineRows.map((l) => ({ ...l, salesOrderId: order.id })))
      .returning();
    await writeAudit(tx, ctx, {
      action: "create",
      tableName: "sales_orders",
      recordId: order.id,
      after: { ...order, lines },
    });
    return { ...order, lines };
  });
}

export async function updateSalesOrder(
  db: DbOrTx,
  ctx: OrgContext,
  input: SalesOrderCreate & { id: string },
): Promise<SalesOrder & { lines: SalesLine[] }> {
  return runTx(db, async (tx) => {
    const before = await lockSalesOrder(tx, ctx, input.id);
    if (before.status !== "draft") {
      throw new DomainError("ORDER_NOT_DRAFT", "Only draft orders can be edited");
    }
    await assertCustomer(tx, ctx, input.customerId);
    const lineRows = await prepareLines(tx, ctx, input.lines);
    const beforeLines = await tx
      .select()
      .from(salesLines)
      .where(and(eq(salesLines.organisationId, ctx.orgId), eq(salesLines.salesOrderId, before.id)));
    // Draft orders never carry allocations (allocation requires confirmed), so lines can be replaced.
    await tx
      .delete(salesLines)
      .where(and(eq(salesLines.organisationId, ctx.orgId), eq(salesLines.salesOrderId, before.id)));
    const lines = await tx
      .insert(salesLines)
      .values(lineRows.map((l) => ({ ...l, salesOrderId: before.id })))
      .returning();
    const total = lineRows.reduce((s, l) => s + l.amountKobo, 0);
    const [order] = await tx
      .update(salesOrders)
      .set({
        customerId: input.customerId,
        orderDate: input.orderDate,
        totalAmountKobo: total,
        updatedAt: new Date(),
      })
      .where(and(eq(salesOrders.id, before.id), eq(salesOrders.organisationId, ctx.orgId)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "sales_orders",
      recordId: order.id,
      before: { ...before, lines: beforeLines },
      after: { ...order, lines },
    });
    return { ...order, lines };
  });
}

export async function confirmSalesOrder(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<SalesOrder> {
  return runTx(db, async (tx) => {
    const before = await lockSalesOrder(tx, ctx, input.id);
    if (before.status !== "draft") {
      throw new DomainError("ORDER_NOT_DRAFT", "Only draft orders can be confirmed");
    }
    const [order] = await tx
      .update(salesOrders)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(and(eq(salesOrders.id, before.id), eq(salesOrders.organisationId, ctx.orgId)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "approve",
      tableName: "sales_orders",
      recordId: order.id,
      before: { status: before.status },
      after: { status: order.status },
    });
    return order;
  });
}

/** Cancel a not-yet-dispatched order; releases any reservations (reserved → cancelled). */
export async function cancelSalesOrder(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<SalesOrder> {
  return runTx(db, async (tx) => {
    const before = await lockSalesOrder(tx, ctx, input.id);
    if (before.status === "cancelled") throw new DomainError("ORDER_ALREADY_CANCELLED");
    if (before.status === "dispatched" || before.status === "completed") {
      throw new DomainError("ORDER_NOT_CANCELLABLE", "A dispatched order cannot be cancelled");
    }
    const lineIds = (
      await tx
        .select({ id: salesLines.id })
        .from(salesLines)
        .where(and(eq(salesLines.organisationId, ctx.orgId), eq(salesLines.salesOrderId, before.id)))
    ).map((l) => l.id);
    if (lineIds.length > 0) {
      const [dispatched] = await tx
        .select({ n: count() })
        .from(lotAllocations)
        .where(
          and(
            eq(lotAllocations.organisationId, ctx.orgId),
            inArray(lotAllocations.salesLineId, lineIds),
            eq(lotAllocations.status, "dispatched"),
          ),
        );
      if ((dispatched?.n ?? 0) > 0) {
        throw new DomainError("ORDER_NOT_CANCELLABLE", "Part of this order has been dispatched");
      }
    }
    let released: { id: string }[] = [];
    if (lineIds.length > 0) {
      released = await tx
        .update(lotAllocations)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(lotAllocations.organisationId, ctx.orgId),
            inArray(lotAllocations.salesLineId, lineIds),
            eq(lotAllocations.status, "reserved"),
          ),
        )
        .returning({ id: lotAllocations.id });
    }
    const [order] = await tx
      .update(salesOrders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(salesOrders.id, before.id), eq(salesOrders.organisationId, ctx.orgId)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "cancel",
      tableName: "sales_orders",
      recordId: order.id,
      before: { status: before.status },
      after: { status: order.status, releasedAllocationIds: released.map((r) => r.id) },
    });
    return order;
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

export type SalesOrderListRow = {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  orderDate: string;
  status: SalesOrderStatus;
  totalAmountKobo: Kobo;
  createdAt: Date;
};

export async function listSalesOrders(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { status?: SalesOrderStatus; customerId?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: SalesOrderListRow[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;
  const where: SQL[] = [eq(salesOrders.organisationId, ctx.orgId)];
  if (opts.status) where.push(eq(salesOrders.status, opts.status));
  if (opts.customerId) where.push(eq(salesOrders.customerId, opts.customerId));
  const rows = await db
    .select({
      id: salesOrders.id,
      orderNumber: salesOrders.orderNumber,
      customerId: salesOrders.customerId,
      customerName: customers.name,
      orderDate: salesOrders.orderDate,
      status: salesOrders.status,
      totalAmountKobo: salesOrders.totalAmountKobo,
      createdAt: salesOrders.createdAt,
    })
    .from(salesOrders)
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .where(and(...where))
    .orderBy(desc(salesOrders.orderDate), desc(salesOrders.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [c] = await db.select({ n: count() }).from(salesOrders).where(and(...where));
  return { rows, total: c?.n ?? 0 };
}

export type AllocationView = {
  id: string;
  lotId: string;
  lotNumber: string;
  warehouseId: string;
  warehouseName: string;
  kg: string;
  status: "reserved" | "dispatched" | "cancelled";
  receivedAt: Date;
};

export type SalesLineView = SalesLine & {
  commodityName: string;
  gradeName: string;
  reservedKg: string;
  dispatchedKg: string;
  remainingKg: string;
  fullyAllocated: boolean;
  allocations: AllocationView[];
};

export type SalesOrderDetail = SalesOrder & {
  customerName: string;
  lines: SalesLineView[];
  dispatches: { id: string; waybillNumber: string | null; status: string; dispatchedKg: string; deliveredKg: string | null; dispatchedAt: Date }[];
  invoices: { id: string; invoiceNumber: string; status: string; totalKobo: Kobo; invoiceDate: string }[];
};

export async function getSalesOrder(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<SalesOrderDetail> {
  const [order] = await db
    .select({ order: salesOrders, customerName: customers.name })
    .from(salesOrders)
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .where(and(eq(salesOrders.id, input.id), eq(salesOrders.organisationId, ctx.orgId)));
  if (!order) notFound("Sales order");

  const lineRows = await db
    .select({ line: salesLines, commodityName: commodities.name, gradeName: grades.name })
    .from(salesLines)
    .innerJoin(commodities, eq(commodities.id, salesLines.commodityId))
    .innerJoin(grades, eq(grades.id, salesLines.gradeId))
    .where(and(eq(salesLines.organisationId, ctx.orgId), eq(salesLines.salesOrderId, input.id)))
    .orderBy(asc(salesLines.createdAt), asc(salesLines.id));

  const lineIds = lineRows.map((l) => l.line.id);
  const allocRows = lineIds.length
    ? await db
        .select({
          id: lotAllocations.id,
          salesLineId: lotAllocations.salesLineId,
          lotId: lotAllocations.lotId,
          lotNumber: lots.lotNumber,
          warehouseId: lotAllocations.warehouseId,
          warehouseName: warehouses.name,
          kg: lotAllocations.kg,
          status: lotAllocations.status,
          receivedAt: lots.receivedAt,
        })
        .from(lotAllocations)
        .innerJoin(lots, eq(lots.id, lotAllocations.lotId))
        .innerJoin(warehouses, eq(warehouses.id, lotAllocations.warehouseId))
        .where(and(eq(lotAllocations.organisationId, ctx.orgId), inArray(lotAllocations.salesLineId, lineIds)))
        .orderBy(asc(lots.receivedAt), asc(lotAllocations.lotId))
    : [];

  const lines: SalesLineView[] = lineRows.map(({ line, commodityName, gradeName }) => {
    const allocations = allocRows.filter((a) => a.salesLineId === line.id);
    const reservedG = allocations.filter((a) => a.status === "reserved").reduce((s, a) => s + kgToGrams(a.kg), 0);
    const dispatchedG = allocations.filter((a) => a.status === "dispatched").reduce((s, a) => s + kgToGrams(a.kg), 0);
    const lineG = kgToGrams(line.kg);
    const remainingG = Math.max(0, lineG - reservedG - dispatchedG);
    return {
      ...line,
      commodityName,
      gradeName,
      reservedKg: gramsToKg(reservedG),
      dispatchedKg: gramsToKg(dispatchedG),
      remainingKg: gramsToKg(remainingG),
      fullyAllocated: remainingG === 0,
      allocations: allocations.map((a) => ({
        id: a.id,
        lotId: a.lotId,
        lotNumber: a.lotNumber,
        warehouseId: a.warehouseId,
        warehouseName: a.warehouseName,
        kg: a.kg,
        status: a.status,
        receivedAt: a.receivedAt,
      })),
    };
  });

  const dispatchRows = await db
    .select({
      id: dispatches.id,
      waybillNumber: dispatches.waybillNumber,
      status: dispatches.status,
      dispatchedKg: dispatches.dispatchedKg,
      deliveredKg: dispatches.deliveredKg,
      dispatchedAt: dispatches.dispatchedAt,
    })
    .from(dispatches)
    .where(and(eq(dispatches.organisationId, ctx.orgId), eq(dispatches.salesOrderId, input.id)))
    .orderBy(asc(dispatches.dispatchedAt));
  const invoiceRows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      totalKobo: invoices.totalKobo,
      invoiceDate: invoices.invoiceDate,
    })
    .from(invoices)
    .where(and(eq(invoices.organisationId, ctx.orgId), eq(invoices.salesOrderId, input.id)))
    .orderBy(asc(invoices.invoiceDate));

  return { ...order.order, customerName: order.customerName, lines, dispatches: dispatchRows, invoices: invoiceRows };
}
