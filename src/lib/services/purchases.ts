import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  bagTypes,
  buyingPoints,
  commodities,
  grades,
  lots,
  purchaseLineDeductions,
  purchaseLines,
  purchases,
  suppliers,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, type Grams, type Kobo } from "@/lib/domain/units";
import {
  computeLineAmountKobo,
  computeNetGrams,
  computeSackDeductionGrams,
  type DeductionInput,
} from "@/lib/domain/weights";
import { nextDocNumber } from "@/lib/services/numbering";
import type {
  PurchaseCancelInput,
  PurchaseCreateInput,
  PurchaseLineInput,
  PurchaseListInput,
  PurchaseRejectInput,
  PurchaseUpdateInput,
} from "@/lib/validation/buying";

import { lookupGuide } from "./priceGuides";
import {
  assertBuyingPointAllowed,
  assertCan,
  assertWritable,
  getSupplierRow,
  inTx,
  notFound,
} from "./suppliers";

/**
 * Purchases (P2-A).
 *
 * - Line net = gross − Σ deductions (domain computeNetGrams). When a bag type
 *   is given and the line carries no explicit sack_weight deduction, bags ×
 *   bag_type.sack_weight_kg is deducted automatically and stored as a
 *   sack_weight deduction row (so supplier quality history includes it).
 * - Line amount = computeLineAmountKobo(net, price); purchase total = Σ lines.
 * - over_guide per line via lookupGuide; any over-guide line → status
 *   pending_approval + requires_approval (needs `purchase.approve`), else
 *   approved. `saveAsDraft` keeps it draft.
 * - Offline idempotency (DECISIONS #11): the client-generated purchase id is
 *   the PK. A create with an id that already exists in the org returns the
 *   stored purchase unchanged, flagged `duplicate: true`.
 * - Buying-point restriction (ctx.restrictions.buyingPointIds) enforced on
 *   create, update, approve/reject/cancel, list and detail.
 */

export type Purchase = typeof purchases.$inferSelect;
export type PurchaseStatus = Purchase["status"];

export type PurchaseLineDetail = Omit<typeof purchaseLines.$inferSelect, "pricePerKgKobo" | "amountKobo"> & {
  pricePerKgKobo: Kobo | null;
  amountKobo: Kobo | null;
  commodityName: string;
  gradeName: string;
  bagTypeName: string | null;
  deductions: Array<typeof purchaseLineDeductions.$inferSelect>;
  lot: { id: string; lotNumber: string } | null;
};

export type PurchaseDetail = Omit<Purchase, "totalAmountKobo"> & {
  totalAmountKobo: Kobo | null;
  supplierName: string;
  supplierPhone: string | null;
  buyingPointName: string | null;
  netKg: string;
  lines: PurchaseLineDetail[];
};

export type CreatePurchaseResult = { purchase: PurchaseDetail; duplicate: boolean };

// ── line computation ─────────────────────────────────────────────────────────

type ComputedLine = {
  id: string;
  commodityId: string;
  gradeId: string;
  bagTypeId: string | null;
  bags: number;
  grossG: Grams;
  netG: Grams;
  moisturePercent: string | null;
  pricePerKgKobo: Kobo;
  amountKobo: Kobo;
  overGuide: boolean;
  guideMaxKobo: Kobo | null;
  deductions: Array<DeductionInput & { note: string | null }>;
};

async function computeLines(
  tx: DbOrTx,
  ctx: OrgContext,
  purchaseDate: string,
  buyingPointId: string | null,
  lines: PurchaseLineInput[],
): Promise<ComputedLine[]> {
  const commodityIds = [...new Set(lines.map((l) => l.commodityId))];
  const gradeIds = [...new Set(lines.map((l) => l.gradeId))];
  const bagTypeIds = [...new Set(lines.map((l) => l.bagTypeId).filter((x): x is string => !!x))];

  const cRows = await tx
    .select({ id: commodities.id, active: commodities.active })
    .from(commodities)
    .where(and(eq(commodities.organisationId, ctx.orgId), inArray(commodities.id, commodityIds)));
  const gRows = await tx
    .select({ id: grades.id, commodityId: grades.commodityId })
    .from(grades)
    .where(and(eq(grades.organisationId, ctx.orgId), inArray(grades.id, gradeIds)));
  const bRows =
    bagTypeIds.length === 0
      ? []
      : await tx
          .select({ id: bagTypes.id, sackWeightKg: bagTypes.sackWeightKg })
          .from(bagTypes)
          .where(and(eq(bagTypes.organisationId, ctx.orgId), inArray(bagTypes.id, bagTypeIds)));
  const cMap = new Map(cRows.map((r) => [r.id, r]));
  const gMap = new Map(gRows.map((r) => [r.id, r]));
  const bMap = new Map(bRows.map((r) => [r.id, r]));

  const out: ComputedLine[] = [];
  for (const l of lines) {
    if (!cMap.has(l.commodityId)) notFound("Commodity");
    const g = gMap.get(l.gradeId);
    if (!g) notFound("Grade");
    if (g.commodityId !== l.commodityId) {
      throw new DomainError("GRADE_COMMODITY_MISMATCH", "Grade does not belong to the commodity");
    }
    const deductions: ComputedLine["deductions"] = l.deductions.map((d) => ({
      reason: d.reason,
      grams: kgToGrams(d.kg),
      note: d.note,
    }));
    if (l.bagTypeId) {
      const bt = bMap.get(l.bagTypeId);
      if (!bt) notFound("Bag type");
      const hasExplicitSack = l.deductions.some((d) => d.reason === "sack_weight");
      if (!hasExplicitSack && l.bags > 0) {
        const sackG = computeSackDeductionGrams(l.bags, bt.sackWeightKg);
        if (sackG > 0) deductions.push({ reason: "sack_weight", grams: sackG, note: "auto: bags × sack weight" });
      }
    }
    const grossG = kgToGrams(l.grossKg);
    const netG = computeNetGrams(grossG, deductions);
    const amountKobo = computeLineAmountKobo(netG, l.pricePerKgKobo);
    const guide = await lookupGuide(tx, ctx, {
      commodityId: l.commodityId,
      gradeId: l.gradeId,
      buyingPointId,
      date: purchaseDate,
    });
    const overGuide = guide !== null && l.pricePerKgKobo > guide.maxPricePerKgKobo;
    out.push({
      id: l.id ?? randomUUID(),
      commodityId: l.commodityId,
      gradeId: l.gradeId,
      bagTypeId: l.bagTypeId,
      bags: l.bags,
      grossG,
      netG,
      moisturePercent: l.moisturePercent,
      pricePerKgKobo: l.pricePerKgKobo,
      amountKobo,
      overGuide,
      guideMaxKobo: guide?.maxPricePerKgKobo ?? null,
      deductions,
    });
  }
  return out;
}

/**
 * Pure preview for the quick-entry form (live net kg + amount + over-guide
 * badge) — same math the save path uses. No writes.
 */
export async function previewPurchaseLines(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: { purchaseDate: string; buyingPointId: string | null; lines: PurchaseLineInput[] },
): Promise<
  Array<{ netKg: string; amountKobo: Kobo; overGuide: boolean; guideMaxKobo: Kobo | null; deductedKg: string }>
> {
  const lines = await computeLines(dbOrTx, ctx, input.purchaseDate, input.buyingPointId, input.lines);
  return lines.map((l) => ({
    netKg: gramsToKg(l.netG),
    amountKobo: l.amountKobo,
    overGuide: l.overGuide,
    guideMaxKobo: l.guideMaxKobo,
    deductedKg: gramsToKg(l.grossG - l.netG),
  }));
}

async function insertLines(tx: Tx, ctx: OrgContext, purchaseId: string, lines: ComputedLine[]): Promise<void> {
  // Lines carry no line number: stamp created_at 1 ms apart so entry order is
  // preserved (detail/receiving order by created_at, id).
  const base = Date.now();
  await tx.insert(purchaseLines).values(
    lines.map((l, i) => ({
      createdAt: new Date(base + i),
      id: l.id,
      purchaseId,
      organisationId: ctx.orgId,
      commodityId: l.commodityId,
      gradeId: l.gradeId,
      bagTypeId: l.bagTypeId,
      bags: l.bags,
      grossKg: gramsToKg(l.grossG),
      netKg: gramsToKg(l.netG),
      moisturePercent: l.moisturePercent,
      pricePerKgKobo: l.pricePerKgKobo,
      amountKobo: l.amountKobo,
      overGuide: l.overGuide,
    })),
  );
  const deductionRows = lines.flatMap((l) =>
    l.deductions
      .filter((d) => d.grams > 0)
      .map((d) => ({
        purchaseLineId: l.id,
        organisationId: ctx.orgId,
        reason: d.reason,
        kg: gramsToKg(d.grams),
        note: d.note,
      })),
  );
  if (deductionRows.length > 0) await tx.insert(purchaseLineDeductions).values(deductionRows);
}

function statusFor(lines: ComputedLine[], saveAsDraft: boolean): { status: PurchaseStatus; requiresApproval: boolean } {
  const requiresApproval = lines.some((l) => l.overGuide);
  if (saveAsDraft) return { status: "draft", requiresApproval };
  return { status: requiresApproval ? "pending_approval" : "approved", requiresApproval };
}

async function assertHeaderRefs(
  tx: DbOrTx,
  ctx: OrgContext,
  input: { supplierId: string; buyingPointId: string | null },
): Promise<void> {
  await getSupplierRow(tx, ctx, input.supplierId);
  if (input.buyingPointId) {
    const [bp] = await tx
      .select({ id: buyingPoints.id })
      .from(buyingPoints)
      .where(and(eq(buyingPoints.organisationId, ctx.orgId), eq(buyingPoints.id, input.buyingPointId)))
      .limit(1);
    if (!bp) notFound("Buying point");
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

async function findPurchase(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<Purchase | null> {
  const [row] = await dbOrTx
    .select()
    .from(purchases)
    .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, id)))
    .limit(1);
  return row ?? null;
}

/** Lock a purchase row for a state change (org-scoped; restricted users only see their points). */
export async function lockPurchase(tx: Tx, ctx: OrgContext, id: string): Promise<Purchase> {
  const [row] = await tx
    .select()
    .from(purchases)
    .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, id)))
    .for("update");
  if (!row) notFound("Purchase");
  return row;
}

function visibleToCaller(ctx: OrgContext, p: { buyingPointId: string | null }): boolean {
  const allowed = ctx.restrictions.buyingPointIds;
  return allowed === null || (p.buyingPointId !== null && allowed.includes(p.buyingPointId));
}

export async function getPurchaseDetail(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<PurchaseDetail> {
  const [head] = await dbOrTx
    .select({
      purchase: purchases,
      supplierName: suppliers.name,
      supplierPhone: suppliers.phone,
      buyingPointName: buyingPoints.name,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(buyingPoints, eq(buyingPoints.id, purchases.buyingPointId))
    .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, id)))
    .limit(1);
  if (!head || !visibleToCaller(ctx, head.purchase)) notFound("Purchase");

  const lineRows = await dbOrTx
    .select({
      line: purchaseLines,
      commodityName: commodities.name,
      gradeName: grades.name,
      bagTypeName: bagTypes.name,
      lotId: lots.id,
      lotNumber: lots.lotNumber,
    })
    .from(purchaseLines)
    .innerJoin(commodities, eq(commodities.id, purchaseLines.commodityId))
    .innerJoin(grades, eq(grades.id, purchaseLines.gradeId))
    .leftJoin(bagTypes, eq(bagTypes.id, purchaseLines.bagTypeId))
    .leftJoin(lots, eq(lots.purchaseLineId, purchaseLines.id))
    .where(and(eq(purchaseLines.organisationId, ctx.orgId), eq(purchaseLines.purchaseId, id)))
    .orderBy(asc(purchaseLines.createdAt), asc(purchaseLines.id));
  const lineIds = lineRows.map((r) => r.line.id);
  const dRows =
    lineIds.length === 0
      ? []
      : await dbOrTx
          .select()
          .from(purchaseLineDeductions)
          .where(
            and(
              eq(purchaseLineDeductions.organisationId, ctx.orgId),
              inArray(purchaseLineDeductions.purchaseLineId, lineIds),
            ),
          )
          .orderBy(asc(purchaseLineDeductions.reason));

  const hide = ctx.restrictions.hidePrices;
  let netG = 0;
  const lines: PurchaseLineDetail[] = lineRows.map((r) => {
    netG += kgToGrams(r.line.netKg);
    return {
      ...r.line,
      pricePerKgKobo: hide ? null : r.line.pricePerKgKobo,
      amountKobo: hide ? null : r.line.amountKobo,
      commodityName: r.commodityName,
      gradeName: r.gradeName,
      bagTypeName: r.bagTypeName,
      deductions: dRows.filter((d) => d.purchaseLineId === r.line.id),
      lot: r.lotId && r.lotNumber ? { id: r.lotId, lotNumber: r.lotNumber } : null,
    };
  });
  return {
    ...head.purchase,
    totalAmountKobo: hide ? null : head.purchase.totalAmountKobo,
    supplierName: head.supplierName,
    supplierPhone: head.supplierPhone,
    buyingPointName: head.buyingPointName,
    netKg: gramsToKg(netG),
    lines,
  };
}

export type PurchaseListRow = {
  id: string;
  purchaseNumber: string | null;
  purchaseDate: string;
  status: PurchaseStatus;
  requiresApproval: boolean;
  supplierId: string;
  supplierName: string;
  buyingPointId: string | null;
  buyingPointName: string | null;
  totalAmountKobo: Kobo | null;
  netKg: string;
  grnNumber: string | null;
  createdOffline: boolean;
  createdAt: Date;
};

export async function listPurchases(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: Partial<PurchaseListInput> = {},
): Promise<{ rows: PurchaseListRow[]; total: number; page: number; pageSize: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  const where: SQL[] = [eq(purchases.organisationId, ctx.orgId)];
  if (input.status) where.push(eq(purchases.status, input.status));
  if (input.supplierId) where.push(eq(purchases.supplierId, input.supplierId));
  if (input.buyingPointId) where.push(eq(purchases.buyingPointId, input.buyingPointId));
  if (input.from) where.push(gte(purchases.purchaseDate, input.from));
  if (input.to) where.push(lte(purchases.purchaseDate, input.to));
  const allowed = ctx.restrictions.buyingPointIds;
  if (allowed !== null) {
    if (allowed.length === 0) where.push(sql`false`);
    else where.push(inArray(purchases.buyingPointId, allowed));
  }

  const [{ n }] = await dbOrTx
    .select({ n: sql<string>`count(*)` })
    .from(purchases)
    .where(and(...where));
  const rows = await dbOrTx
    .select({
      id: purchases.id,
      purchaseNumber: purchases.purchaseNumber,
      purchaseDate: purchases.purchaseDate,
      status: purchases.status,
      requiresApproval: purchases.requiresApproval,
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      buyingPointId: purchases.buyingPointId,
      buyingPointName: buyingPoints.name,
      totalAmountKobo: purchases.totalAmountKobo,
      grnNumber: purchases.grnNumber,
      createdOffline: purchases.createdOffline,
      createdAt: purchases.createdAt,
      netKg: sql<string>`coalesce((select sum(pl.net_kg) from purchase_lines pl where pl.purchase_id = "purchases"."id"), 0)`,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(buyingPoints, eq(buyingPoints.id, purchases.buyingPointId))
    .where(and(...where))
    .orderBy(desc(purchases.purchaseDate), desc(purchases.createdAt), desc(purchases.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const hide = ctx.restrictions.hidePrices;
  return {
    rows: rows.map((r) => ({
      ...r,
      totalAmountKobo: hide ? null : r.totalAmountKobo,
      netKg: gramsToKg(kgToGrams(r.netKg)),
    })),
    total: Number(n),
    page,
    pageSize,
  };
}

// ── mutations ────────────────────────────────────────────────────────────────

/** Snapshot for audit before/after values (header + lines + deductions). */
async function auditSnapshot(tx: Tx, ctx: OrgContext, id: string) {
  const p = await findPurchase(tx, ctx, id);
  const ls = await tx
    .select()
    .from(purchaseLines)
    .where(and(eq(purchaseLines.organisationId, ctx.orgId), eq(purchaseLines.purchaseId, id)))
    .orderBy(asc(purchaseLines.id));
  const ds =
    ls.length === 0
      ? []
      : await tx
          .select()
          .from(purchaseLineDeductions)
          .where(
            and(
              eq(purchaseLineDeductions.organisationId, ctx.orgId),
              inArray(
                purchaseLineDeductions.purchaseLineId,
                ls.map((l) => l.id),
              ),
            ),
          );
  return { ...p, lines: ls.map((l) => ({ ...l, deductions: ds.filter((d) => d.purchaseLineId === l.id) })) };
}

export async function createPurchase(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: PurchaseCreateInput,
): Promise<CreatePurchaseResult> {
  assertWritable(ctx);
  if (input.id) {
    const existing = await findPurchase(dbOrTx, ctx, input.id);
    if (existing) return { purchase: await getPurchaseDetail(dbOrTx, ctx, existing.id), duplicate: true };
  }
  assertBuyingPointAllowed(ctx, input.buyingPointId);

  const purchaseId = input.id ?? randomUUID();
  try {
    await inTx(dbOrTx, async (tx) => {
      await assertHeaderRefs(tx, ctx, input);
      const lines = await computeLines(tx, ctx, input.purchaseDate, input.buyingPointId, input.lines);
      const { status, requiresApproval } = statusFor(lines, input.saveAsDraft);
      const purchaseNumber = await nextDocNumber(tx, ctx.orgId, "po");
      await tx.insert(purchases).values({
        id: purchaseId,
        organisationId: ctx.orgId,
        purchaseNumber,
        supplierId: input.supplierId,
        buyingPointId: input.buyingPointId,
        officerId: ctx.userId,
        purchaseDate: input.purchaseDate,
        status,
        totalAmountKobo: lines.reduce((s, l) => s + l.amountKobo, 0),
        requiresApproval,
        createdOffline: input.createdOffline,
        clientCreatedAt: input.clientCreatedAt ? new Date(input.clientCreatedAt) : null,
      });
      await insertLines(tx, ctx, purchaseId, lines);
      await writeAudit(tx, ctx, {
        action: "create",
        tableName: "purchases",
        recordId: purchaseId,
        after: await auditSnapshot(tx, ctx, purchaseId),
      });
    });
  } catch (err) {
    // Concurrent replay of the same offline purchase: the PK race loser
    // returns the winner's row unchanged.
    if (input.id && err instanceof DomainError && err.code === "DUPLICATE") {
      const existing = await findPurchase(dbOrTx, ctx, input.id);
      if (existing) {
        return { purchase: await getPurchaseDetail(dbOrTx, ctx, existing.id), duplicate: true };
      }
    }
    throw err;
  }
  return { purchase: await getPurchaseDetail(dbOrTx, ctx, purchaseId), duplicate: false };
}

const EDITABLE: ReadonlySet<PurchaseStatus> = new Set(["draft", "pending_approval"]);

export async function updatePurchase(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: PurchaseUpdateInput,
): Promise<PurchaseDetail> {
  assertWritable(ctx);
  await inTx(dbOrTx, async (tx) => {
    const current = await lockPurchase(tx, ctx, input.id);
    if (!visibleToCaller(ctx, current)) notFound("Purchase");
    if (!EDITABLE.has(current.status)) {
      throw new DomainError("NOT_EDITABLE", `A ${current.status} purchase cannot be edited`);
    }
    assertBuyingPointAllowed(ctx, input.buyingPointId);
    const before = await auditSnapshot(tx, ctx, input.id);
    await assertHeaderRefs(tx, ctx, input);
    const lines = await computeLines(tx, ctx, input.purchaseDate, input.buyingPointId, input.lines);
    const { status, requiresApproval } = statusFor(lines, input.saveAsDraft);

    // Lines are replaced wholesale (deductions cascade).
    await tx
      .delete(purchaseLines)
      .where(and(eq(purchaseLines.organisationId, ctx.orgId), eq(purchaseLines.purchaseId, input.id)));
    await insertLines(tx, ctx, input.id, lines);
    await tx
      .update(purchases)
      .set({
        supplierId: input.supplierId,
        buyingPointId: input.buyingPointId,
        purchaseDate: input.purchaseDate,
        status,
        requiresApproval,
        totalAmountKobo: lines.reduce((s, l) => s + l.amountKobo, 0),
        approvedBy: null,
        approvedAt: null,
        rejectedReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, input.id)));
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "purchases",
      recordId: input.id,
      before,
      after: await auditSnapshot(tx, ctx, input.id),
    });
  });
  return getPurchaseDetail(dbOrTx, ctx, input.id);
}

/** Manager approval of an over-guide purchase (permission purchase.approve). */
export async function approvePurchase(dbOrTx: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<Purchase> {
  assertWritable(ctx);
  assertCan(ctx, "purchase.approve");
  return inTx(dbOrTx, async (tx) => {
    const before = await lockPurchase(tx, ctx, input.id);
    if (!visibleToCaller(ctx, before)) notFound("Purchase");
    if (before.status !== "pending_approval") {
      throw new DomainError("INVALID_STATUS", `Only purchases pending approval can be approved (is ${before.status})`);
    }
    const [after] = await tx
      .update(purchases)
      .set({ status: "approved", approvedBy: ctx.userId, approvedAt: new Date(), rejectedReason: null, updatedAt: new Date() })
      .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "approve", tableName: "purchases", recordId: input.id, before, after });
    return after;
  });
}

/**
 * Reject an over-guide purchase: back to draft with the reason, so the officer
 * can correct the price and resubmit (purchase_status has no 'rejected').
 */
export async function rejectPurchase(dbOrTx: DbOrTx, ctx: OrgContext, input: PurchaseRejectInput): Promise<Purchase> {
  assertWritable(ctx);
  assertCan(ctx, "purchase.approve");
  return inTx(dbOrTx, async (tx) => {
    const before = await lockPurchase(tx, ctx, input.id);
    if (!visibleToCaller(ctx, before)) notFound("Purchase");
    if (before.status !== "pending_approval") {
      throw new DomainError("INVALID_STATUS", `Only purchases pending approval can be rejected (is ${before.status})`);
    }
    const [after] = await tx
      .update(purchases)
      .set({ status: "draft", rejectedReason: input.reason, approvedBy: null, approvedAt: null, updatedAt: new Date() })
      .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "reject", tableName: "purchases", recordId: input.id, before, after });
    return after;
  });
}

/** Cancel any purchase that has not been received (received stock is corrected via adjustments). */
export async function cancelPurchase(dbOrTx: DbOrTx, ctx: OrgContext, input: PurchaseCancelInput): Promise<Purchase> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    const before = await lockPurchase(tx, ctx, input.id);
    if (!visibleToCaller(ctx, before)) notFound("Purchase");
    if (before.status === "received") {
      throw new DomainError("CANNOT_CANCEL_RECEIVED", "A received purchase cannot be cancelled");
    }
    if (before.status === "cancelled") {
      throw new DomainError("ALREADY_CANCELLED", "Purchase is already cancelled");
    }
    const [after] = await tx
      .update(purchases)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "cancel",
      tableName: "purchases",
      recordId: input.id,
      before,
      after: { ...after, cancelReason: input.reason ?? null },
    });
    return after;
  });
}
