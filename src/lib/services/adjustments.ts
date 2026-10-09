import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import { adjustments, lots, notifications, organisationSettings } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { can } from "@/lib/authz/permissions";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, type Grams } from "@/lib/domain/units";
import { nextDocNumber } from "@/lib/services/numbering";
import { postMovements } from "@/lib/services/stockCore";
import {
  assertBinInWarehouse,
  assertWarehouseAccess,
  inTx,
  ownWarehouse,
  warehouseFilter,
} from "@/lib/services/stockQueries";
import type {
  AdjustmentIdInput,
  CreateAdjustmentInput,
  ListAdjustmentsInput,
  RejectAdjustmentInput,
} from "@/lib/validation/warehouse";

/**
 * Stock adjustments (DOMAIN-ENGINE §7).
 *
 * ADJ number at creation. |kg| <= organisation_settings.adjustment_approval_threshold_kg
 * → auto-approved and posted in the same tx (status posted, approved_by null =
 * automatic). Above → pending_approval + an approval_request notification;
 * a holder of adjustment.approve posts it later. The movement row is written
 * ONLY on post, via stockCore.postMovements, which locks the lot and refuses
 * to take on-hand (or available, after reservations) below zero.
 */

export type Adjustment = typeof adjustments.$inferSelect;
export type AdjustmentReason = Adjustment["reason"];

export async function approvalThresholdGrams(db: DbOrTx, orgId: string): Promise<Grams> {
  const [row] = await db
    .select({ t: organisationSettings.adjustmentApprovalThresholdKg })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, orgId))
    .limit(1);
  return kgToGrams(row?.t ?? "50");
}

async function postAdjustmentMovement(tx: Tx, ctx: OrgContext, adj: Adjustment): Promise<void> {
  await postMovements(tx, ctx, [
    {
      lotId: adj.lotId,
      warehouseId: adj.warehouseId,
      binId: adj.binId,
      type: "adjustment",
      grams: kgToGrams(adj.kg),
      bags: adj.bags,
      refType: "adj",
      refId: adj.id,
    },
  ]);
}

export type NewAdjustment = {
  lotId: string;
  warehouseId: string;
  binId?: string | null;
  reason: AdjustmentReason;
  grams: Grams;
  bags?: number;
  note?: string | null;
  sourceCountId?: string | null;
};

/**
 * Create one adjustment inside an existing tx and apply the threshold rule.
 * Shared by createAdjustment (manual) and postCount (count_difference).
 */
export async function createAdjustmentInTx(
  tx: Tx,
  ctx: OrgContext,
  input: NewAdjustment,
  thresholdG?: Grams,
): Promise<Adjustment> {
  if (!Number.isSafeInteger(input.grams) || input.grams === 0) {
    throw new DomainError("INVALID_INPUT", "Adjustment weight must be a non-zero whole number of grams");
  }
  const bags = input.bags ?? 0;
  if (bags !== 0 && Math.sign(bags) !== Math.sign(input.grams)) {
    throw new DomainError("INVALID_INPUT", "Bags must move in the same direction as the weight");
  }
  const [lot] = await tx
    .select({ id: lots.id })
    .from(lots)
    .where(and(eq(lots.organisationId, ctx.orgId), eq(lots.id, input.lotId)))
    .limit(1);
  if (!lot) throw new DomainError("NOT_FOUND", "Lot not found");
  await ownWarehouse(tx, ctx, input.warehouseId);
  if (input.binId) await assertBinInWarehouse(tx, ctx, input.binId, input.warehouseId);

  const threshold = thresholdG ?? (await approvalThresholdGrams(tx, ctx.orgId));
  const auto = Math.abs(input.grams) <= threshold;
  const adjustmentNumber = await nextDocNumber(tx, ctx.orgId, "adj");
  const now = new Date();

  const [created] = await tx
    .insert(adjustments)
    .values({
      organisationId: ctx.orgId,
      adjustmentNumber,
      lotId: input.lotId,
      warehouseId: input.warehouseId,
      binId: input.binId ?? null,
      reason: input.reason,
      kg: gramsToKg(input.grams),
      bags,
      status: "pending_approval",
      sourceCountId: input.sourceCountId ?? null,
      note: input.note ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  await writeAudit(tx, ctx, { action: "create", tableName: "adjustments", recordId: created.id, after: created });

  if (!auto) {
    await tx.insert(notifications).values({
      organisationId: ctx.orgId,
      userId: null,
      type: "approval_request",
      title: `Adjustment ${adjustmentNumber} needs approval`,
      body: `${input.reason.replace("_", " ")}: ${gramsToKg(input.grams)} kg`,
      link: `/adjustments/${created.id}`,
    });
    return created;
  }

  await postAdjustmentMovement(tx, ctx, created);
  const [posted] = await tx
    .update(adjustments)
    .set({ status: "posted", approvedAt: now, updatedAt: now })
    .where(eq(adjustments.id, created.id))
    .returning();
  await writeAudit(tx, ctx, {
    action: "post",
    tableName: "adjustments",
    recordId: created.id,
    before: { status: created.status },
    after: { status: posted.status, auto: true },
  });
  return posted;
}

export async function createAdjustment(
  db: DbOrTx,
  ctx: OrgContext,
  input: CreateAdjustmentInput,
): Promise<Adjustment> {
  assertWarehouseAccess(ctx, input.warehouseId);
  return inTx(db, (tx) =>
    createAdjustmentInTx(tx, ctx, {
      lotId: input.lotId,
      warehouseId: input.warehouseId,
      binId: input.binId,
      reason: input.reason,
      grams: kgToGrams(input.kg),
      bags: input.bags,
      note: input.note,
    }),
  );
}

async function lockAdjustment(tx: Tx, ctx: OrgContext, id: string): Promise<Adjustment> {
  const [row] = await tx
    .select()
    .from(adjustments)
    .where(and(eq(adjustments.organisationId, ctx.orgId), eq(adjustments.id, id)))
    .for("update");
  if (!row) throw new DomainError("NOT_FOUND", "Adjustment not found");
  assertWarehouseAccess(ctx, row.warehouseId);
  if (row.status !== "pending_approval") {
    throw new DomainError("INVALID_STATE", `Adjustment is ${row.status}`);
  }
  return row;
}

export async function approveAdjustment(
  db: DbOrTx,
  ctx: OrgContext,
  input: AdjustmentIdInput,
): Promise<Adjustment> {
  if (!can(ctx.role, "adjustment.approve")) throw new DomainError("FORBIDDEN", "Not allowed to approve");
  return inTx(db, async (tx) => {
    const adj = await lockAdjustment(tx, ctx, input.adjustmentId);
    await postAdjustmentMovement(tx, ctx, adj);
    const now = new Date();
    const [posted] = await tx
      .update(adjustments)
      .set({ status: "posted", approvedBy: ctx.userId, approvedAt: now, updatedAt: now })
      .where(eq(adjustments.id, adj.id))
      .returning();
    await writeAudit(tx, ctx, {
      action: "approve",
      tableName: "adjustments",
      recordId: adj.id,
      before: { status: adj.status },
      after: { status: posted.status, approvedBy: posted.approvedBy, approvedAt: posted.approvedAt },
    });
    return posted;
  });
}

export async function rejectAdjustment(
  db: DbOrTx,
  ctx: OrgContext,
  input: RejectAdjustmentInput,
): Promise<Adjustment> {
  if (!can(ctx.role, "adjustment.approve")) throw new DomainError("FORBIDDEN", "Not allowed to reject");
  return inTx(db, async (tx) => {
    const adj = await lockAdjustment(tx, ctx, input.adjustmentId);
    const [rejected] = await tx
      .update(adjustments)
      .set({ status: "rejected", rejectedReason: input.reason, updatedAt: new Date() })
      .where(eq(adjustments.id, adj.id))
      .returning();
    await writeAudit(tx, ctx, {
      action: "reject",
      tableName: "adjustments",
      recordId: adj.id,
      before: { status: adj.status },
      after: { status: rejected.status, rejectedReason: rejected.rejectedReason },
    });
    return rejected;
  });
}

export async function getAdjustment(db: DbOrTx, ctx: OrgContext, id: string): Promise<Adjustment> {
  const [row] = await db
    .select()
    .from(adjustments)
    .where(and(eq(adjustments.organisationId, ctx.orgId), eq(adjustments.id, id)))
    .limit(1);
  if (!row || (ctx.restrictions.warehouseIds !== null && !ctx.restrictions.warehouseIds.includes(row.warehouseId))) {
    throw new DomainError("NOT_FOUND", "Adjustment not found");
  }
  return row;
}

export async function listAdjustments(
  db: DbOrTx,
  ctx: OrgContext,
  q: Partial<ListAdjustmentsInput> = {},
): Promise<{ rows: Adjustment[]; total: number; page: number; pageSize: number }> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 50;
  const where: SQL[] = [eq(adjustments.organisationId, ctx.orgId)];
  const wf = warehouseFilter(ctx, adjustments.warehouseId);
  if (wf) where.push(wf);
  if (q.status) where.push(eq(adjustments.status, q.status));
  if (q.warehouseId) where.push(eq(adjustments.warehouseId, q.warehouseId));
  if (q.lotId) where.push(eq(adjustments.lotId, q.lotId));
  const cond = and(...where);
  const [{ n }] = await db.select({ n: count() }).from(adjustments).where(cond);
  const rows = await db
    .select()
    .from(adjustments)
    .where(cond)
    .orderBy(desc(adjustments.createdAt), desc(adjustments.adjustmentNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows, total: Number(n), page, pageSize };
}

/** Pending adjustments awaiting approval, oldest first. */
export async function approvalQueue(db: DbOrTx, ctx: OrgContext): Promise<Adjustment[]> {
  const where: SQL[] = [eq(adjustments.organisationId, ctx.orgId), eq(adjustments.status, "pending_approval")];
  const wf = warehouseFilter(ctx, adjustments.warehouseId);
  if (wf) where.push(wf);
  return db
    .select()
    .from(adjustments)
    .where(and(...where))
    .orderBy(asc(adjustments.createdAt), asc(adjustments.id));
}
