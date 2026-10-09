import { and, asc, eq } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { bins, lots, organization, purchaseLines, purchases, suppliers, warehouses } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { formatNaira, gramsToKg, kgToGrams, type Grams, type Kobo } from "@/lib/domain/units";
import { QUEUES } from "@/lib/jobs";
import { recomputeLandedCostForPurchase } from "@/lib/services/landedCost";
import { nextDocNumber } from "@/lib/services/numbering";
import { postMovements, type MovementInput } from "@/lib/services/stockCore";
import type { ReceivePurchaseInput } from "@/lib/validation/buying";

import { lockPurchase } from "./purchases";
import { assertBuyingPointAllowed, assertWarehouseAllowed, assertWritable, inTx, notFound, type PendingJob } from "./suppliers";

/**
 * Receiving (P2-A): approved purchase → warehouse.
 *
 * In ONE transaction: lock the purchase; per line create a lot (LOT number,
 * purchase price = line price, landed cost initialised = price, received now,
 * original kg/bags = line net/bags) and post a `receive` movement (+net grams,
 * ref grn → purchase id) through stockCore.postMovements; assign the GRN
 * number onto the purchase; audit. Returns the jobs to enqueue after commit
 * (GRN PDF, optional SMS receipt) — see PendingJob.
 *
 * A zero-net line still gets its lot (1 line = 1 lot) but no movement
 * (receive movements must be > 0).
 */

export type Lot = typeof lots.$inferSelect;

export type ReceiveResult = {
  purchaseId: string;
  grnNumber: string;
  warehouseId: string;
  receivedAt: Date;
  lots: Lot[];
  totalNetKg: string;
  jobs: PendingJob[];
};

export async function receivePurchase(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: ReceivePurchaseInput,
): Promise<ReceiveResult> {
  assertWritable(ctx);
  assertWarehouseAllowed(ctx, input.warehouseId);

  return inTx(dbOrTx, async (tx) => {
    const purchase = await lockPurchase(tx, ctx, input.purchaseId);
    if (ctx.role === "procurement") assertBuyingPointAllowed(ctx, purchase.buyingPointId);
    if (purchase.status === "received") {
      throw new DomainError("ALREADY_RECEIVED", `Purchase already received (${purchase.grnNumber ?? ""})`);
    }
    if (purchase.status !== "approved") {
      throw new DomainError("NOT_APPROVED", `Only approved purchases can be received (is ${purchase.status})`);
    }

    const [wh] = await tx
      .select({ id: warehouses.id, active: warehouses.active, name: warehouses.name })
      .from(warehouses)
      .where(and(eq(warehouses.organisationId, ctx.orgId), eq(warehouses.id, input.warehouseId)))
      .limit(1);
    if (!wh) notFound("Warehouse");
    if (!wh.active) throw new DomainError("WAREHOUSE_INACTIVE", "Warehouse is inactive");
    if (input.binId) {
      const [bin] = await tx
        .select({ id: bins.id, warehouseId: bins.warehouseId })
        .from(bins)
        .where(and(eq(bins.organisationId, ctx.orgId), eq(bins.id, input.binId)))
        .limit(1);
      if (!bin) notFound("Bin");
      if (bin.warehouseId !== input.warehouseId) {
        throw new DomainError("BIN_WAREHOUSE_MISMATCH", "Bin is not in the selected warehouse");
      }
    }

    const lines = await tx
      .select()
      .from(purchaseLines)
      .where(and(eq(purchaseLines.organisationId, ctx.orgId), eq(purchaseLines.purchaseId, purchase.id)))
      .orderBy(asc(purchaseLines.createdAt), asc(purchaseLines.id));
    if (lines.length === 0) throw new DomainError("NO_LINES", "Purchase has no lines");

    const receivedAt = new Date();
    const createdLots: Lot[] = [];
    const moves: MovementInput[] = [];
    let totalG: Grams = 0;
    let totalBags = 0;
    for (const line of lines) {
      const netG = kgToGrams(line.netKg);
      const lotNumber = await nextDocNumber(tx, ctx.orgId, "lot");
      const [lot] = await tx
        .insert(lots)
        .values({
          organisationId: ctx.orgId,
          lotNumber,
          commodityId: line.commodityId,
          gradeId: line.gradeId,
          supplierId: purchase.supplierId,
          purchaseLineId: line.id,
          receivedAt,
          originalKg: gramsToKg(netG),
          originalBags: line.bags,
          purchasePricePerKgKobo: line.pricePerKgKobo,
          landedCostPerKgKobo: String(line.pricePerKgKobo),
        })
        .returning();
      createdLots.push(lot);
      totalG += netG;
      totalBags += line.bags;
      if (netG > 0) {
        moves.push({
          lotId: lot.id,
          warehouseId: input.warehouseId,
          binId: input.binId,
          type: "receive",
          grams: netG,
          bags: line.bags,
          refType: "grn",
          refId: purchase.id,
          occurredAt: receivedAt,
        });
      }
    }
    await postMovements(tx, ctx, moves);

    const grnNumber = await nextDocNumber(tx, ctx.orgId, "grn");
    const [after] = await tx
      .update(purchases)
      .set({
        status: "received",
        receivedWarehouseId: input.warehouseId,
        receivedAt,
        grnNumber,
        updatedAt: receivedAt,
      })
      .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.id, purchase.id)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "post",
      tableName: "purchases",
      recordId: purchase.id,
      before: purchase,
      after: { ...after, lots: createdLots.map((l) => ({ id: l.id, lotNumber: l.lotNumber, originalKg: l.originalKg })) },
    });
    for (const lot of createdLots) {
      await writeAudit(tx, ctx, { action: "create", tableName: "lots", recordId: lot.id, after: lot });
    }

    // A purchase may already be linked to an inbound trip before it is
    // received; the new lots must pick up their trip-cost share now.
    await recomputeLandedCostForPurchase(tx, ctx, purchase.id);

    const jobs: PendingJob[] = [
      { name: QUEUES.DOCUMENT_GENERATE, data: { kind: "grn", refId: purchase.id, orgId: ctx.orgId } },
    ];
    if (input.sendSms) {
      const sms = await receiptSms(tx, ctx, {
        supplierId: purchase.supplierId,
        grnNumber,
        totalG,
        totalBags,
        amountKobo: purchase.totalAmountKobo,
      });
      if (sms) jobs.push(sms);
    }

    return {
      purchaseId: purchase.id,
      grnNumber,
      warehouseId: input.warehouseId,
      receivedAt,
      lots: createdLots,
      totalNetKg: gramsToKg(totalG),
      jobs,
    };
  });
}

export async function orgName(dbOrTx: DbOrTx, ctx: OrgContext): Promise<string> {
  const [org] = await dbOrTx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, ctx.orgId))
    .limit(1);
  return org?.name ?? "AggreTrack";
}

/** SMS receipt job for the supplier's phone, or null when the supplier has none. */
async function receiptSms(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  p: { supplierId: string; grnNumber: string; totalG: Grams; totalBags: number; amountKobo: Kobo },
): Promise<PendingJob | null> {
  const [s] = await dbOrTx
    .select({ phone: suppliers.phone, name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.organisationId, ctx.orgId), eq(suppliers.id, p.supplierId)))
    .limit(1);
  if (!s?.phone) return null;
  const bags = p.totalBags > 0 ? ` (${p.totalBags} bags)` : "";
  const body =
    `${await orgName(dbOrTx, ctx)}: ${s.name}, we received ${gramsToKg(p.totalG)} kg${bags} from you. ` +
    `Amount ${formatNaira(p.amountKobo)}. Ref ${p.grnNumber}. Thank you.`;
  return { name: QUEUES.SMS_SEND, data: { orgId: ctx.orgId, to: s.phone, body } };
}


/** Approved purchases waiting to be received (warehouse receive queue). */
export async function listAwaitingReceipt(dbOrTx: DbOrTx, ctx: OrgContext) {
  return dbOrTx
    .select({
      id: purchases.id,
      purchaseNumber: purchases.purchaseNumber,
      purchaseDate: purchases.purchaseDate,
      supplierName: suppliers.name,
      buyingPointId: purchases.buyingPointId,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.status, "approved")))
    .orderBy(asc(purchases.purchaseDate), asc(purchases.createdAt));
}
