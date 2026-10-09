import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  dispatches,
  drivers,
  expenses,
  purchases,
  salesOrders,
  suppliers,
  tripDispatches,
  tripPurchases,
  trips,
  vehicles,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { nextDocNumber } from "@/lib/services/numbering";
import type {
  TripInput,
  TripLinkDispatchesInput,
  TripLinkPurchasesInput,
  TripListInput,
  TripUnlinkDispatchInput,
  TripUnlinkPurchaseInput,
  TripUpdateInput,
} from "@/lib/validation/logistics";

import { lotIdsForTrips, mutate, recomputeLandedCost } from "./landedCost";

/**
 * Trips (P2-D). Inbound trips link purchases (trip_purchases) and their cost
 * plus affects-landed-cost trip expenses is shared into lot landed cost by
 * weight; outbound trips link dispatches (trip_dispatches) and are cost
 * records only. Every change to an inbound trip's cost or purchase links
 * recomputes the affected lots' landed cost IN THE SAME TX.
 */

export type Trip = typeof trips.$inferSelect;

export type TripListRow = Trip & {
  vehiclePlate: string | null;
  driverName: string | null;
  linkedCount: number;
  expensesKobo: number;
};

export type TripDetail = Trip & {
  vehiclePlate: string | null;
  driverName: string | null;
  purchases: {
    purchaseId: string;
    purchaseNumber: string | null;
    purchaseDate: string;
    supplierName: string;
    status: string;
    totalAmountKobo: number;
  }[];
  dispatches: {
    dispatchId: string;
    waybillNumber: string | null;
    orderNumber: string;
    dispatchedKg: string;
    dispatchedAt: Date;
  }[];
  expenses: { id: string; expenseNumber: string; amountKobo: number; expenseDate: string; categoryId: string }[];
};

function notFound(what: string): never {
  throw new DomainError("NOT_FOUND", `${what} not found`);
}

async function assertRef(
  tx: DbOrTx,
  ctx: OrgContext,
  table: typeof vehicles | typeof drivers,
  id: string | null,
  what: string,
) {
  if (!id) return;
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.organisationId, ctx.orgId), eq(table.id, id)))
    .limit(1);
  if (!row) notFound(what);
}

async function lockTrip(tx: Tx, ctx: OrgContext, id: string): Promise<Trip> {
  const [row] = await tx
    .select()
    .from(trips)
    .where(and(eq(trips.organisationId, ctx.orgId), eq(trips.id, id)))
    .for("update");
  if (!row) notFound("Trip");
  return row;
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function listTrips(db: DbOrTx, ctx: OrgContext, input: Partial<TripListInput> = {}): Promise<TripListRow[]> {
  const where: SQL[] = [eq(trips.organisationId, ctx.orgId)];
  if (input.from) where.push(gte(trips.tripDate, input.from));
  if (input.to) where.push(lte(trips.tripDate, input.to));
  if (input.direction) where.push(eq(trips.direction, input.direction));
  if (input.vehicleId) where.push(eq(trips.vehicleId, input.vehicleId));

  const rows = await db
    .select({
      trip: trips,
      vehiclePlate: vehicles.plateNumber,
      driverName: drivers.name,
      linkedCount: sql<string>`(
        (SELECT count(*) FROM trip_purchases tp WHERE tp.trip_id = ${trips.id})
        + (SELECT count(*) FROM trip_dispatches td WHERE td.trip_id = ${trips.id}))`,
      expensesKobo: sql<string>`(SELECT coalesce(sum(e.amount_kobo), 0) FROM expenses e WHERE e.trip_id = ${trips.id})`,
    })
    .from(trips)
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .where(and(...where))
    .orderBy(desc(trips.tripDate), desc(trips.tripNumber));

  return rows.map((r) => ({
    ...r.trip,
    vehiclePlate: r.vehiclePlate,
    driverName: r.driverName,
    linkedCount: Number(r.linkedCount),
    expensesKobo: Number(r.expensesKobo),
  }));
}

export async function getTrip(db: DbOrTx, ctx: OrgContext, id: string): Promise<TripDetail> {
  const [row] = await db
    .select({ trip: trips, vehiclePlate: vehicles.plateNumber, driverName: drivers.name })
    .from(trips)
    .leftJoin(vehicles, eq(vehicles.id, trips.vehicleId))
    .leftJoin(drivers, eq(drivers.id, trips.driverId))
    .where(and(eq(trips.organisationId, ctx.orgId), eq(trips.id, id)))
    .limit(1);
  if (!row) notFound("Trip");

  const linkedPurchases = await db
    .select({
      purchaseId: purchases.id,
      purchaseNumber: purchases.purchaseNumber,
      purchaseDate: purchases.purchaseDate,
      supplierName: suppliers.name,
      status: purchases.status,
      totalAmountKobo: purchases.totalAmountKobo,
    })
    .from(tripPurchases)
    .innerJoin(purchases, eq(purchases.id, tripPurchases.purchaseId))
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(and(eq(tripPurchases.organisationId, ctx.orgId), eq(tripPurchases.tripId, id)))
    .orderBy(asc(purchases.purchaseDate));

  const linkedDispatches = await db
    .select({
      dispatchId: dispatches.id,
      waybillNumber: dispatches.waybillNumber,
      orderNumber: salesOrders.orderNumber,
      dispatchedKg: dispatches.dispatchedKg,
      dispatchedAt: dispatches.dispatchedAt,
    })
    .from(tripDispatches)
    .innerJoin(dispatches, eq(dispatches.id, tripDispatches.dispatchId))
    .innerJoin(salesOrders, eq(salesOrders.id, dispatches.salesOrderId))
    .where(and(eq(tripDispatches.organisationId, ctx.orgId), eq(tripDispatches.tripId, id)))
    .orderBy(asc(dispatches.dispatchedAt));

  const tripExpenses = await db
    .select({
      id: expenses.id,
      expenseNumber: expenses.expenseNumber,
      amountKobo: expenses.amountKobo,
      expenseDate: expenses.expenseDate,
      categoryId: expenses.categoryId,
    })
    .from(expenses)
    .where(and(eq(expenses.organisationId, ctx.orgId), eq(expenses.tripId, id)))
    .orderBy(asc(expenses.expenseDate));

  return {
    ...row.trip,
    vehiclePlate: row.vehiclePlate,
    driverName: row.driverName,
    purchases: linkedPurchases,
    dispatches: linkedDispatches,
    expenses: tripExpenses,
  };
}

// ── mutations ────────────────────────────────────────────────────────────────

export async function createTrip(db: DbOrTx, ctx: OrgContext, input: TripInput): Promise<Trip> {
  return mutate(db, async (tx) => {
    await assertRef(tx, ctx, vehicles, input.vehicleId, "Vehicle");
    await assertRef(tx, ctx, drivers, input.driverId, "Driver");
    const tripNumber = await nextDocNumber(tx, ctx.orgId, "trp");
    const [row] = await tx
      .insert(trips)
      .values({
        organisationId: ctx.orgId,
        tripNumber,
        direction: input.direction,
        vehicleId: input.vehicleId,
        driverId: input.driverId,
        origin: input.origin,
        destination: input.destination,
        tripDate: input.tripDate,
        costKobo: input.costKobo,
        note: input.note,
        createdBy: ctx.userId,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "trips", recordId: row.id, after: row });
    // A new trip has no links yet → no landed-cost effect.
    return row;
  });
}

export async function updateTrip(db: DbOrTx, ctx: OrgContext, input: TripUpdateInput): Promise<Trip> {
  return mutate(db, async (tx) => {
    const before = await lockTrip(tx, ctx, input.id);
    await assertRef(tx, ctx, vehicles, input.vehicleId, "Vehicle");
    await assertRef(tx, ctx, drivers, input.driverId, "Driver");
    const [row] = await tx
      .update(trips)
      .set({
        vehicleId: input.vehicleId,
        driverId: input.driverId,
        origin: input.origin,
        destination: input.destination,
        tripDate: input.tripDate,
        costKobo: input.costKobo,
        note: input.note,
        updatedAt: new Date(),
      })
      .where(and(eq(trips.organisationId, ctx.orgId), eq(trips.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "trips", recordId: row.id, before, after: row });
    if (row.direction === "inbound" && before.costKobo !== row.costKobo) {
      await recomputeLandedCost(tx, ctx, await lotIdsForTrips(tx, ctx, [row.id]));
    }
    return row;
  });
}

/**
 * Delete a trip (links cascade). Refused with IN_USE while expenses are
 * attached — move or delete those first. Recomputes the lots it carried.
 */
export async function deleteTrip(db: DbOrTx, ctx: OrgContext, id: string): Promise<{ id: string }> {
  return mutate(db, async (tx) => {
    const before = await lockTrip(tx, ctx, id);
    const [exp] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(expenses)
      .where(and(eq(expenses.organisationId, ctx.orgId), eq(expenses.tripId, id)));
    if (Number(exp?.n ?? 0) > 0) {
      throw new DomainError("IN_USE", "Trip has expenses attached; remove them first");
    }
    const affected = before.direction === "inbound" ? await lotIdsForTrips(tx, ctx, [id]) : [];
    await tx.delete(trips).where(and(eq(trips.organisationId, ctx.orgId), eq(trips.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "trips", recordId: id, before, after: null });
    await recomputeLandedCost(tx, ctx, affected);
    return { id };
  });
}

/** Link purchases to an INBOUND trip; recomputes every lot on the trip. Already-linked ids are ignored. */
export async function linkPurchases(
  db: DbOrTx,
  ctx: OrgContext,
  input: TripLinkPurchasesInput,
): Promise<{ linked: number }> {
  return mutate(db, async (tx) => {
    const trip = await lockTrip(tx, ctx, input.tripId);
    if (trip.direction !== "inbound") {
      throw new DomainError("TRIP_DIRECTION", "Only inbound trips carry purchases");
    }
    const ids = [...new Set(input.purchaseIds)];
    const found = await tx
      .select({ id: purchases.id, status: purchases.status })
      .from(purchases)
      .where(and(eq(purchases.organisationId, ctx.orgId), inArray(purchases.id, ids)));
    if (found.length !== ids.length) notFound("Purchase");
    if (found.some((p) => p.status === "cancelled")) {
      throw new DomainError("INVALID_STATE", "Cancelled purchases cannot be linked");
    }
    const inserted = await tx
      .insert(tripPurchases)
      .values(ids.map((purchaseId) => ({ organisationId: ctx.orgId, tripId: trip.id, purchaseId })))
      .onConflictDoNothing({ target: [tripPurchases.tripId, tripPurchases.purchaseId] })
      .returning({ purchaseId: tripPurchases.purchaseId });
    if (inserted.length > 0) {
      await writeAudit(tx, ctx, {
        action: "update",
        tableName: "trips",
        recordId: trip.id,
        after: { linkedPurchaseIds: inserted.map((r) => r.purchaseId) },
      });
      await recomputeLandedCost(tx, ctx, await lotIdsForTrips(tx, ctx, [trip.id]));
    }
    return { linked: inserted.length };
  });
}

export async function unlinkPurchase(
  db: DbOrTx,
  ctx: OrgContext,
  input: TripUnlinkPurchaseInput,
): Promise<{ unlinked: boolean }> {
  return mutate(db, async (tx) => {
    const trip = await lockTrip(tx, ctx, input.tripId);
    // Lots before the unlink (includes the leaving purchase's lots, which lose the share).
    const affected = await lotIdsForTrips(tx, ctx, [trip.id]);
    const removed = await tx
      .delete(tripPurchases)
      .where(
        and(
          eq(tripPurchases.organisationId, ctx.orgId),
          eq(tripPurchases.tripId, trip.id),
          eq(tripPurchases.purchaseId, input.purchaseId),
        ),
      )
      .returning({ id: tripPurchases.id });
    if (removed.length === 0) notFound("Trip purchase link");
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "trips",
      recordId: trip.id,
      before: { linkedPurchaseId: input.purchaseId },
      after: { unlinkedPurchaseId: input.purchaseId },
    });
    if (trip.direction === "inbound") await recomputeLandedCost(tx, ctx, affected);
    return { unlinked: true };
  });
}

/** Link dispatches to an OUTBOUND trip (cost record only — no landed-cost effect). */
export async function linkDispatches(
  db: DbOrTx,
  ctx: OrgContext,
  input: TripLinkDispatchesInput,
): Promise<{ linked: number }> {
  return mutate(db, async (tx) => {
    const trip = await lockTrip(tx, ctx, input.tripId);
    if (trip.direction !== "outbound") {
      throw new DomainError("TRIP_DIRECTION", "Only outbound trips carry dispatches");
    }
    const ids = [...new Set(input.dispatchIds)];
    const found = await tx
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(and(eq(dispatches.organisationId, ctx.orgId), inArray(dispatches.id, ids)));
    if (found.length !== ids.length) notFound("Dispatch");
    const inserted = await tx
      .insert(tripDispatches)
      .values(ids.map((dispatchId) => ({ organisationId: ctx.orgId, tripId: trip.id, dispatchId })))
      .onConflictDoNothing({ target: [tripDispatches.tripId, tripDispatches.dispatchId] })
      .returning({ dispatchId: tripDispatches.dispatchId });
    if (inserted.length > 0) {
      await writeAudit(tx, ctx, {
        action: "update",
        tableName: "trips",
        recordId: trip.id,
        after: { linkedDispatchIds: inserted.map((r) => r.dispatchId) },
      });
    }
    return { linked: inserted.length };
  });
}

export async function unlinkDispatch(
  db: DbOrTx,
  ctx: OrgContext,
  input: TripUnlinkDispatchInput,
): Promise<{ unlinked: boolean }> {
  return mutate(db, async (tx) => {
    const trip = await lockTrip(tx, ctx, input.tripId);
    const removed = await tx
      .delete(tripDispatches)
      .where(
        and(
          eq(tripDispatches.organisationId, ctx.orgId),
          eq(tripDispatches.tripId, trip.id),
          eq(tripDispatches.dispatchId, input.dispatchId),
        ),
      )
      .returning({ id: tripDispatches.id });
    if (removed.length === 0) notFound("Trip dispatch link");
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "trips",
      recordId: trip.id,
      before: { linkedDispatchId: input.dispatchId },
      after: { unlinkedDispatchId: input.dispatchId },
    });
    return { unlinked: true };
  });
}
