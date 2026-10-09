import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import { expenseCategories, expenses, lots, trips, warehouses } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { nextDocNumber } from "@/lib/services/numbering";
import type { ExpenseInput, ExpenseListInput, ExpenseUpdateInput } from "@/lib/validation/logistics";

import { lotIdsForTrips, mutate, recomputeLandedCost } from "./landedCost";

/**
 * Expenses (P2-D). Recorded by category, attached to at most one of a lot, a
 * trip or a warehouse (schema CHECK + zod). When the category has
 * affects_landed_cost AND the attachment is a lot or an INBOUND trip, the
 * affected lots' landed cost is recomputed in the same tx. Other expenses are
 * margin-only (lot) or overhead (warehouse / unattached / outbound trip).
 */

export type Expense = typeof expenses.$inferSelect;
export type ExpenseListRow = Expense & {
  categoryName: string;
  affectsLandedCost: boolean;
  lotNumber: string | null;
  tripNumber: string | null;
  warehouseName: string | null;
};

type Attachment = { categoryId: string; lotId: string | null; tripId: string | null; warehouseId: string | null };

function notFound(what: string): never {
  throw new DomainError("NOT_FOUND", `${what} not found`);
}

async function categoryAffects(tx: DbOrTx, ctx: OrgContext, categoryId: string): Promise<boolean> {
  const [cat] = await tx
    .select({ affects: expenseCategories.affectsLandedCost })
    .from(expenseCategories)
    .where(and(eq(expenseCategories.organisationId, ctx.orgId), eq(expenseCategories.id, categoryId)))
    .limit(1);
  if (!cat) notFound("Expense category");
  return cat.affects;
}

async function assertAttachment(tx: DbOrTx, ctx: OrgContext, a: Attachment): Promise<void> {
  const n = [a.lotId, a.tripId, a.warehouseId].filter((x) => x !== null).length;
  if (n > 1) throw new DomainError("INVALID_INPUT", "Attach to at most one of lot, trip or warehouse");
  if (a.lotId) {
    const [r] = await tx
      .select({ id: lots.id })
      .from(lots)
      .where(and(eq(lots.organisationId, ctx.orgId), eq(lots.id, a.lotId)))
      .limit(1);
    if (!r) notFound("Lot");
  }
  if (a.tripId) {
    const [r] = await tx
      .select({ id: trips.id })
      .from(trips)
      .where(and(eq(trips.organisationId, ctx.orgId), eq(trips.id, a.tripId)))
      .limit(1);
    if (!r) notFound("Trip");
  }
  if (a.warehouseId) {
    const [r] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.organisationId, ctx.orgId), eq(warehouses.id, a.warehouseId)))
      .limit(1);
    if (!r) notFound("Warehouse");
  }
}

/** Lots whose landed cost depends on an expense with this attachment (empty when it cannot affect any). */
async function affectedLots(tx: Tx, ctx: OrgContext, a: Attachment): Promise<string[]> {
  if (!a.lotId && !a.tripId) return [];
  if (!(await categoryAffects(tx, ctx, a.categoryId))) return [];
  if (a.lotId) return [a.lotId];
  const [trip] = await tx
    .select({ direction: trips.direction })
    .from(trips)
    .where(and(eq(trips.organisationId, ctx.orgId), eq(trips.id, a.tripId!)))
    .limit(1);
  if (!trip || trip.direction !== "inbound") return [];
  return lotIdsForTrips(tx, ctx, [a.tripId!]);
}

async function lockExpense(tx: Tx, ctx: OrgContext, id: string): Promise<Expense> {
  const [row] = await tx
    .select()
    .from(expenses)
    .where(and(eq(expenses.organisationId, ctx.orgId), eq(expenses.id, id)))
    .for("update");
  if (!row) notFound("Expense");
  return row;
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function listExpenses(
  db: DbOrTx,
  ctx: OrgContext,
  input: Partial<ExpenseListInput> = {},
): Promise<ExpenseListRow[]> {
  const where: SQL[] = [eq(expenses.organisationId, ctx.orgId)];
  if (input.from) where.push(gte(expenses.expenseDate, input.from));
  if (input.to) where.push(lte(expenses.expenseDate, input.to));
  if (input.categoryId) where.push(eq(expenses.categoryId, input.categoryId));
  if (input.lotId) where.push(eq(expenses.lotId, input.lotId));
  if (input.tripId) where.push(eq(expenses.tripId, input.tripId));
  if (input.warehouseId) where.push(eq(expenses.warehouseId, input.warehouseId));

  const rows = await db
    .select({
      e: expenses,
      categoryName: expenseCategories.name,
      affectsLandedCost: expenseCategories.affectsLandedCost,
      lotNumber: lots.lotNumber,
      tripNumber: trips.tripNumber,
      warehouseName: warehouses.name,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .leftJoin(lots, eq(lots.id, expenses.lotId))
    .leftJoin(trips, eq(trips.id, expenses.tripId))
    .leftJoin(warehouses, eq(warehouses.id, expenses.warehouseId))
    .where(and(...where))
    .orderBy(desc(expenses.expenseDate), desc(expenses.expenseNumber));

  return rows.map((r) => ({
    ...r.e,
    categoryName: r.categoryName,
    affectsLandedCost: r.affectsLandedCost,
    lotNumber: r.lotNumber,
    tripNumber: r.tripNumber,
    warehouseName: r.warehouseName,
  }));
}

export async function getExpense(db: DbOrTx, ctx: OrgContext, id: string): Promise<Expense> {
  const [row] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.organisationId, ctx.orgId), eq(expenses.id, id)))
    .limit(1);
  if (!row) notFound("Expense");
  return row;
}

// ── mutations ────────────────────────────────────────────────────────────────

export async function createExpense(db: DbOrTx, ctx: OrgContext, input: ExpenseInput): Promise<Expense> {
  return mutate(db, async (tx) => {
    await categoryAffects(tx, ctx, input.categoryId); // existence + org scope
    await assertAttachment(tx, ctx, input);
    const expenseNumber = await nextDocNumber(tx, ctx.orgId, "exp");
    const [row] = await tx
      .insert(expenses)
      .values({
        organisationId: ctx.orgId,
        expenseNumber,
        categoryId: input.categoryId,
        amountKobo: input.amountKobo,
        expenseDate: input.expenseDate,
        lotId: input.lotId,
        tripId: input.tripId,
        warehouseId: input.warehouseId,
        note: input.note,
        createdBy: ctx.userId,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "expenses", recordId: row.id, after: row });
    await recomputeLandedCost(tx, ctx, await affectedLots(tx, ctx, row));
    return row;
  });
}

export async function updateExpense(db: DbOrTx, ctx: OrgContext, input: ExpenseUpdateInput): Promise<Expense> {
  return mutate(db, async (tx) => {
    const before = await lockExpense(tx, ctx, input.id);
    await categoryAffects(tx, ctx, input.categoryId);
    await assertAttachment(tx, ctx, input);
    // Lots affected by the OLD attachment/category lose this expense; NEW ones gain it.
    const oldLots = await affectedLots(tx, ctx, before);
    const [row] = await tx
      .update(expenses)
      .set({
        categoryId: input.categoryId,
        amountKobo: input.amountKobo,
        expenseDate: input.expenseDate,
        lotId: input.lotId,
        tripId: input.tripId,
        warehouseId: input.warehouseId,
        note: input.note,
        updatedAt: new Date(),
      })
      .where(and(eq(expenses.organisationId, ctx.orgId), eq(expenses.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "expenses", recordId: row.id, before, after: row });
    const newLots = await affectedLots(tx, ctx, row);
    await recomputeLandedCost(tx, ctx, [...oldLots, ...newLots]);
    return row;
  });
}

export async function deleteExpense(db: DbOrTx, ctx: OrgContext, id: string): Promise<{ id: string }> {
  return mutate(db, async (tx) => {
    const before = await lockExpense(tx, ctx, id);
    const affected = await affectedLots(tx, ctx, before);
    await tx.delete(expenses).where(and(eq(expenses.organisationId, ctx.orgId), eq(expenses.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "expenses", recordId: id, before, after: null });
    await recomputeLandedCost(tx, ctx, affected);
    return { id };
  });
}
