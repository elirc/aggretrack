import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import { lots, stockCountLines, stockCounts } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import { nextDocNumber } from "@/lib/services/numbering";
import {
  approvalThresholdGrams,
  createAdjustmentInTx,
  type Adjustment,
} from "@/lib/services/adjustments";
import {
  assertBinInWarehouse,
  assertWarehouseAccess,
  inTx,
  onHandAt,
  ownWarehouse,
  warehouseFilter,
} from "@/lib/services/stockQueries";
import type { CountIdInput, CreateCountInput, ListCountsInput } from "@/lib/validation/warehouse";

/**
 * Stock counts (DOMAIN-ENGINE §7).
 *
 * createCount snapshots system_kg = on hand of the lot in the count's
 * warehouse at entry and stores diff_kg = counted − system. postCount turns
 * every non-zero diff into a count_difference adjustment (source_count_id set);
 * each adjustment follows the org approval threshold (auto-post vs pending).
 */

export type StockCount = typeof stockCounts.$inferSelect;
export type StockCountLine = typeof stockCountLines.$inferSelect;
export type StockCountWithLines = StockCount & { lines: StockCountLine[] };

async function linesOf(db: DbOrTx, ctx: OrgContext, countId: string): Promise<StockCountLine[]> {
  return db
    .select()
    .from(stockCountLines)
    .where(and(eq(stockCountLines.organisationId, ctx.orgId), eq(stockCountLines.countId, countId)))
    .orderBy(asc(stockCountLines.createdAt), asc(stockCountLines.id));
}

export async function createCount(
  db: DbOrTx,
  ctx: OrgContext,
  input: CreateCountInput,
): Promise<StockCountWithLines> {
  assertWarehouseAccess(ctx, input.warehouseId);
  return inTx(db, async (tx) => {
    await ownWarehouse(tx, ctx, input.warehouseId);
    const lotIds = input.lines.map((l) => l.lotId);
    if (new Set(lotIds).size !== lotIds.length) {
      throw new DomainError("DUPLICATE_LINE", "Each lot can be counted once per count");
    }
    const found = await tx
      .select({ id: lots.id })
      .from(lots)
      .where(and(eq(lots.organisationId, ctx.orgId), inArray(lots.id, lotIds)));
    if (found.length !== lotIds.length) throw new DomainError("NOT_FOUND", "Lot not found");

    const values = [];
    for (const l of input.lines) {
      if (l.binId) await assertBinInWarehouse(tx, ctx, l.binId, input.warehouseId);
      const system = await onHandAt(tx, ctx, l.lotId, input.warehouseId);
      const countedG = kgToGrams(l.countedKg);
      values.push({
        organisationId: ctx.orgId,
        lotId: l.lotId,
        binId: l.binId,
        countedBags: l.countedBags,
        countedKg: gramsToKg(countedG),
        systemKg: gramsToKg(system.grams),
        diffKg: gramsToKg(countedG - system.grams),
      });
    }

    const countNumber = await nextDocNumber(tx, ctx.orgId, "cnt");
    const [c] = await tx
      .insert(stockCounts)
      .values({
        organisationId: ctx.orgId,
        countNumber,
        warehouseId: input.warehouseId,
        status: "draft",
        countedAt: input.countedAt ?? new Date(),
        createdBy: ctx.userId,
      })
      .returning();
    const lines = await tx
      .insert(stockCountLines)
      .values(values.map((v) => ({ ...v, countId: c.id })))
      .returning();
    const out = { ...c, lines };
    await writeAudit(tx, ctx, { action: "create", tableName: "stock_counts", recordId: c.id, after: out });
    return out;
  });
}

async function lockDraftCount(tx: Tx, ctx: OrgContext, id: string): Promise<StockCount> {
  const [c] = await tx
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.organisationId, ctx.orgId), eq(stockCounts.id, id)))
    .for("update");
  if (!c) throw new DomainError("NOT_FOUND", "Count not found");
  assertWarehouseAccess(ctx, c.warehouseId);
  if (c.status !== "draft") throw new DomainError("INVALID_STATE", `Count is ${c.status}`);
  return c;
}

export async function postCount(
  db: DbOrTx,
  ctx: OrgContext,
  input: CountIdInput,
): Promise<{ count: StockCount; adjustments: Adjustment[] }> {
  return inTx(db, async (tx) => {
    const c = await lockDraftCount(tx, ctx, input.countId);
    const lines = await linesOf(tx, ctx, c.id);
    const threshold = await approvalThresholdGrams(tx, ctx.orgId);

    const created: Adjustment[] = [];
    for (const line of lines) {
      const diffG = kgToGrams(line.diffKg);
      if (diffG === 0) continue;
      created.push(
        await createAdjustmentInTx(
          tx,
          ctx,
          {
            lotId: line.lotId,
            warehouseId: c.warehouseId,
            binId: line.binId,
            reason: "count_difference",
            grams: diffG,
            bags: 0,
            sourceCountId: c.id,
          },
          threshold,
        ),
      );
    }

    const now = new Date();
    const [posted] = await tx
      .update(stockCounts)
      .set({ status: "posted", postedAt: now, updatedAt: now })
      .where(eq(stockCounts.id, c.id))
      .returning();
    await writeAudit(tx, ctx, {
      action: "post",
      tableName: "stock_counts",
      recordId: c.id,
      before: { status: c.status },
      after: { status: posted.status, postedAt: posted.postedAt, adjustmentIds: created.map((a) => a.id) },
    });
    return { count: posted, adjustments: created };
  });
}

export async function cancelCount(db: DbOrTx, ctx: OrgContext, input: CountIdInput): Promise<StockCount> {
  return inTx(db, async (tx) => {
    const c = await lockDraftCount(tx, ctx, input.countId);
    const [cancelled] = await tx
      .update(stockCounts)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(stockCounts.id, c.id))
      .returning();
    await writeAudit(tx, ctx, {
      action: "cancel",
      tableName: "stock_counts",
      recordId: c.id,
      before: { status: c.status },
      after: { status: cancelled.status },
    });
    return cancelled;
  });
}

export async function getCount(db: DbOrTx, ctx: OrgContext, id: string): Promise<StockCountWithLines> {
  const [c] = await db
    .select()
    .from(stockCounts)
    .where(and(eq(stockCounts.organisationId, ctx.orgId), eq(stockCounts.id, id)))
    .limit(1);
  if (!c || (ctx.restrictions.warehouseIds !== null && !ctx.restrictions.warehouseIds.includes(c.warehouseId))) {
    throw new DomainError("NOT_FOUND", "Count not found");
  }
  return { ...c, lines: await linesOf(db, ctx, c.id) };
}

export async function listCounts(
  db: DbOrTx,
  ctx: OrgContext,
  q: Partial<ListCountsInput> = {},
): Promise<{ rows: StockCount[]; total: number; page: number; pageSize: number }> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 50;
  const where: SQL[] = [eq(stockCounts.organisationId, ctx.orgId)];
  const wf = warehouseFilter(ctx, stockCounts.warehouseId);
  if (wf) where.push(wf);
  if (q.status) where.push(eq(stockCounts.status, q.status));
  if (q.warehouseId) where.push(eq(stockCounts.warehouseId, q.warehouseId));
  const cond = and(...where);
  const [{ n }] = await db.select({ n: count() }).from(stockCounts).where(cond);
  const rows = await db
    .select()
    .from(stockCounts)
    .where(cond)
    .orderBy(desc(stockCounts.countedAt), desc(stockCounts.countNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows, total: Number(n), page, pageSize };
}
