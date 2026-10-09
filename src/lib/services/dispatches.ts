import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  customers,
  dispatches,
  dispatchLines,
  drivers,
  lotAllocations,
  lots,
  salesLines,
  salesOrders,
  vehicles,
  warehouses,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import { lockLots } from "@/lib/services/allocation";
import { nextDocNumber } from "@/lib/services/numbering";
import {
  enqueueDocument,
  lockSalesOrder,
  notFound,
  pgCode,
  refreshOrderStatus,
  runTx,
  type SellingDeps,
} from "@/lib/services/salesOrders";
import { postMovements } from "@/lib/services/stockCore";

/**
 * Dispatch & delivery (DOMAIN-ENGINE §5).
 *
 * createDispatch converts reservations into `dispatch` stock movements in ONE
 * tx: lock order → lock lots (ordered) → lock + verify allocations reserved →
 * dispatch row (+ WB number) → dispatch_lines → postMovements(dispatch, −kg)
 * → flip allocations to dispatched. The waybill PDF is enqueued after commit.
 *
 * Offline idempotency: `clientId` becomes the dispatch PK; an existing id in
 * this org returns { duplicate: true } without writing anything.
 */

export type Dispatch = typeof dispatches.$inferSelect;
export type DispatchLine = typeof dispatchLines.$inferSelect;

export type CreateDispatchInput = {
  salesOrderId: string;
  allocationIds: string[];
  vehicleId?: string | null;
  driverId?: string | null;
  clientId?: string;
  dispatchedAt?: Date;
};

export type CreateDispatchResult = { dispatch: Dispatch; lines: DispatchLine[]; duplicate: boolean };

async function findExisting(db: DbOrTx, ctx: OrgContext, id: string): Promise<CreateDispatchResult | null> {
  const [row] = await db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) return null;
  if (row.organisationId !== ctx.orgId) {
    // A client UUID colliding across tenants: never reveal or touch the other org's row.
    throw new DomainError("CONFLICT", "Dispatch id already in use");
  }
  const lines = await db
    .select()
    .from(dispatchLines)
    .where(and(eq(dispatchLines.organisationId, ctx.orgId), eq(dispatchLines.dispatchId, id)));
  return { dispatch: row, lines, duplicate: true };
}

async function assertMaster(
  tx: Tx,
  ctx: OrgContext,
  vehicleId: string | null | undefined,
  driverId: string | null | undefined,
): Promise<void> {
  if (vehicleId) {
    const [v] = await tx
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(and(eq(vehicles.id, vehicleId), eq(vehicles.organisationId, ctx.orgId)));
    if (!v) notFound("Vehicle");
  }
  if (driverId) {
    const [d] = await tx
      .select({ id: drivers.id })
      .from(drivers)
      .where(and(eq(drivers.id, driverId), eq(drivers.organisationId, ctx.orgId)));
    if (!d) notFound("Driver");
  }
}

async function createInTx(tx: Tx, ctx: OrgContext, input: CreateDispatchInput): Promise<CreateDispatchResult> {
  const allocationIds = [...new Set(input.allocationIds)];
  if (allocationIds.length === 0) throw new DomainError("VALIDATION", "Select at least one allocation");

  const order = await lockSalesOrder(tx, ctx, input.salesOrderId);
  // Idempotency check AFTER the order lock: a concurrent replay of the same
  // offline dispatch waits here and then sees the committed row.
  if (input.clientId) {
    const existing = await findExisting(tx, ctx, input.clientId);
    if (existing) return existing;
  }
  if (order.status !== "confirmed" && order.status !== "allocated") {
    throw new DomainError("ORDER_NOT_DISPATCHABLE", `Cannot dispatch an order in status ${order.status}`);
  }
  await assertMaster(tx, ctx, input.vehicleId, input.driverId);

  // Lot ids first (unlocked read), then lock lots in id order, THEN lock + verify allocations.
  const preview = await tx
    .select({ id: lotAllocations.id, lotId: lotAllocations.lotId })
    .from(lotAllocations)
    .where(and(eq(lotAllocations.organisationId, ctx.orgId), inArray(lotAllocations.id, allocationIds)));
  if (preview.length !== allocationIds.length) notFound("Allocation");
  await lockLots(
    tx,
    ctx,
    preview.map((p) => p.lotId),
  );

  const allocs = await tx
    .select({
      id: lotAllocations.id,
      lotId: lotAllocations.lotId,
      warehouseId: lotAllocations.warehouseId,
      kg: lotAllocations.kg,
      status: lotAllocations.status,
      salesOrderId: salesLines.salesOrderId,
    })
    .from(lotAllocations)
    .innerJoin(salesLines, eq(salesLines.id, lotAllocations.salesLineId))
    .where(and(eq(lotAllocations.organisationId, ctx.orgId), inArray(lotAllocations.id, allocationIds)))
    .orderBy(asc(lotAllocations.id))
    .for("update", { of: lotAllocations });
  if (allocs.length !== allocationIds.length) notFound("Allocation");
  const restricted = ctx.restrictions.warehouseIds;
  for (const a of allocs) {
    if (a.salesOrderId !== order.id) {
      throw new DomainError("ALLOCATION_NOT_IN_ORDER", "Allocation belongs to another sales order");
    }
    if (a.status !== "reserved") {
      throw new DomainError("ALLOCATION_NOT_RESERVED", `Allocation is ${a.status}`);
    }
    if (restricted && !restricted.includes(a.warehouseId)) {
      throw new DomainError("FORBIDDEN_WAREHOUSE", "You do not have access to that warehouse");
    }
  }

  const totalG = allocs.reduce((s, a) => s + kgToGrams(a.kg), 0);
  const waybillNumber = await nextDocNumber(tx, ctx.orgId, "wb");
  const dispatchedAt = input.dispatchedAt ?? new Date();
  const [dispatch] = await tx
    .insert(dispatches)
    .values({
      ...(input.clientId ? { id: input.clientId } : {}),
      organisationId: ctx.orgId,
      waybillNumber,
      salesOrderId: order.id,
      vehicleId: input.vehicleId ?? null,
      driverId: input.driverId ?? null,
      status: "in_transit",
      dispatchedKg: gramsToKg(totalG),
      dispatchedAt,
      createdBy: ctx.userId,
    })
    .returning();
  const lines = await tx
    .insert(dispatchLines)
    .values(
      allocs.map((a) => ({
        dispatchId: dispatch.id,
        organisationId: ctx.orgId,
        lotAllocationId: a.id,
        kg: gramsToKg(kgToGrams(a.kg)),
      })),
    )
    .returning();

  // Stock leaves now: one dispatch movement per allocation (−kg). stockCore enforces on_hand ≥ 0.
  await postMovements(
    tx,
    ctx,
    allocs.map((a) => ({
      lotId: a.lotId,
      warehouseId: a.warehouseId,
      type: "dispatch" as const,
      grams: -kgToGrams(a.kg),
      bags: 0,
      refType: "wb" as const,
      refId: dispatch.id,
      occurredAt: dispatchedAt,
    })),
  );

  // Same tx as the movement → the reservation never double-counts.
  await tx
    .update(lotAllocations)
    .set({ status: "dispatched", updatedAt: new Date() })
    .where(and(eq(lotAllocations.organisationId, ctx.orgId), inArray(lotAllocations.id, allocationIds)));

  await writeAudit(tx, ctx, {
    action: "create",
    tableName: "dispatches",
    recordId: dispatch.id,
    after: { ...dispatch, lines, allocationIds },
  });
  await refreshOrderStatus(tx, ctx, order);
  return { dispatch, lines, duplicate: false };
}

export async function createDispatch(
  db: DbOrTx,
  ctx: OrgContext,
  input: CreateDispatchInput,
  deps?: SellingDeps,
): Promise<CreateDispatchResult> {
  let result: CreateDispatchResult;
  try {
    result = await runTx(db, (tx) => createInTx(tx, ctx, input));
  } catch (err) {
    // Two concurrent submits of the same offline dispatch: the loser hits the PK.
    if (input.clientId && pgCode(err) === "23505") {
      const existing = await findExisting(db, ctx, input.clientId);
      if (existing) return existing;
    }
    throw err;
  }
  if (!result.duplicate) await enqueueDocument(deps, ctx, "waybill", result.dispatch.id);
  return result;
}

/** Record weight on arrival. transit_loss = dispatched − delivered (≥ 0). Reporting only. */
export async function recordDelivery(
  db: DbOrTx,
  ctx: OrgContext,
  input: { dispatchId: string; deliveredKg: string; deliveredAt?: Date },
): Promise<Dispatch> {
  return runTx(db, async (tx) => {
    const [peek] = await tx
      .select({ salesOrderId: dispatches.salesOrderId })
      .from(dispatches)
      .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.organisationId, ctx.orgId)));
    if (!peek) notFound("Dispatch");
    const order = await lockSalesOrder(tx, ctx, peek.salesOrderId);
    const [before] = await tx
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.organisationId, ctx.orgId)))
      .for("update");
    if (!before) notFound("Dispatch");
    if (before.status !== "in_transit") {
      throw new DomainError("DISPATCH_ALREADY_DELIVERED", "Delivery has already been recorded");
    }
    const dispatchedG = kgToGrams(before.dispatchedKg);
    const deliveredG = kgToGrams(input.deliveredKg);
    if (deliveredG < 0) throw new DomainError("VALIDATION", "Delivered weight cannot be negative");
    if (deliveredG > dispatchedG) {
      throw new DomainError("DELIVERED_EXCEEDS_DISPATCHED", "Delivered weight cannot exceed dispatched weight");
    }
    const [after] = await tx
      .update(dispatches)
      .set({
        status: "delivered",
        deliveredKg: gramsToKg(deliveredG),
        transitLossKg: gramsToKg(dispatchedG - deliveredG),
        deliveredAt: input.deliveredAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(dispatches.id, before.id), eq(dispatches.organisationId, ctx.orgId)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "dispatches",
      recordId: after.id,
      before: { status: before.status, deliveredKg: before.deliveredKg, transitLossKg: before.transitLossKg },
      after: { status: after.status, deliveredKg: after.deliveredKg, transitLossKg: after.transitLossKg },
    });

    // Order completes when everything is dispatched and every dispatch has arrived.
    if (order.status === "dispatched") {
      const [open] = await tx
        .select({ n: count() })
        .from(dispatches)
        .where(
          and(
            eq(dispatches.organisationId, ctx.orgId),
            eq(dispatches.salesOrderId, order.id),
            eq(dispatches.status, "in_transit"),
          ),
        );
      if ((open?.n ?? 0) === 0) {
        await tx
          .update(salesOrders)
          .set({ status: "completed", updatedAt: new Date() })
          .where(and(eq(salesOrders.id, order.id), eq(salesOrders.organisationId, ctx.orgId)));
        await writeAudit(tx, ctx, {
          action: "update",
          tableName: "sales_orders",
          recordId: order.id,
          before: { status: order.status },
          after: { status: "completed" },
        });
      }
    }
    return after;
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

export type DispatchListRow = {
  id: string;
  waybillNumber: string | null;
  salesOrderId: string;
  orderNumber: string;
  customerName: string;
  status: Dispatch["status"];
  dispatchedKg: string;
  deliveredKg: string | null;
  transitLossKg: string | null;
  dispatchedAt: Date;
};

export async function listDispatches(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { status?: Dispatch["status"]; salesOrderId?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: DispatchListRow[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;
  const where: SQL[] = [eq(dispatches.organisationId, ctx.orgId)];
  if (opts.status) where.push(eq(dispatches.status, opts.status));
  if (opts.salesOrderId) where.push(eq(dispatches.salesOrderId, opts.salesOrderId));
  const rows = await db
    .select({
      id: dispatches.id,
      waybillNumber: dispatches.waybillNumber,
      salesOrderId: dispatches.salesOrderId,
      orderNumber: salesOrders.orderNumber,
      customerName: customers.name,
      status: dispatches.status,
      dispatchedKg: dispatches.dispatchedKg,
      deliveredKg: dispatches.deliveredKg,
      transitLossKg: dispatches.transitLossKg,
      dispatchedAt: dispatches.dispatchedAt,
    })
    .from(dispatches)
    .innerJoin(salesOrders, eq(salesOrders.id, dispatches.salesOrderId))
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .where(and(...where))
    .orderBy(desc(dispatches.dispatchedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [c] = await db.select({ n: count() }).from(dispatches).where(and(...where));
  return { rows, total: c?.n ?? 0 };
}

export type DispatchDetail = Dispatch & {
  orderNumber: string;
  customerId: string;
  customerName: string;
  vehiclePlate: string | null;
  driverName: string | null;
  lines: {
    id: string;
    lotAllocationId: string;
    lotId: string;
    lotNumber: string;
    warehouseId: string;
    warehouseName: string;
    kg: string;
    salesLineId: string;
    pricePerKgKobo: number;
  }[];
};

export async function getDispatch(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<DispatchDetail> {
  const [row] = await db
    .select({
      dispatch: dispatches,
      orderNumber: salesOrders.orderNumber,
      customerId: customers.id,
      customerName: customers.name,
      vehiclePlate: vehicles.plateNumber,
      driverName: drivers.name,
    })
    .from(dispatches)
    .innerJoin(salesOrders, eq(salesOrders.id, dispatches.salesOrderId))
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .leftJoin(vehicles, eq(vehicles.id, dispatches.vehicleId))
    .leftJoin(drivers, eq(drivers.id, dispatches.driverId))
    .where(and(eq(dispatches.id, input.id), eq(dispatches.organisationId, ctx.orgId)));
  if (!row) notFound("Dispatch");
  const lines = await db
    .select({
      id: dispatchLines.id,
      lotAllocationId: dispatchLines.lotAllocationId,
      lotId: lotAllocations.lotId,
      lotNumber: lots.lotNumber,
      warehouseId: lotAllocations.warehouseId,
      warehouseName: warehouses.name,
      kg: dispatchLines.kg,
      salesLineId: salesLines.id,
      pricePerKgKobo: salesLines.pricePerKgKobo,
    })
    .from(dispatchLines)
    .innerJoin(lotAllocations, eq(lotAllocations.id, dispatchLines.lotAllocationId))
    .innerJoin(lots, eq(lots.id, lotAllocations.lotId))
    .innerJoin(warehouses, eq(warehouses.id, lotAllocations.warehouseId))
    .innerJoin(salesLines, eq(salesLines.id, lotAllocations.salesLineId))
    .where(and(eq(dispatchLines.organisationId, ctx.orgId), eq(dispatchLines.dispatchId, input.id)))
    .orderBy(asc(lots.receivedAt), asc(dispatchLines.id));
  const visible = ctx.restrictions.hidePrices ? lines.map((l) => ({ ...l, pricePerKgKobo: 0 })) : lines;
  return {
    ...row.dispatch,
    orderNumber: row.orderNumber,
    customerId: row.customerId,
    customerName: row.customerName,
    vehiclePlate: row.vehiclePlate,
    driverName: row.driverName,
    lines: visible,
  };
}
