import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  purchases,
  supplierAdvanceOffsets,
  supplierAdvances,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import {
  allocatePaymentFifo,
  validateManualPaymentAllocation,
  type OpenItem,
  type PaymentAllocationResult,
} from "@/lib/domain/payments";
import { formatNaira, type Kobo } from "@/lib/domain/units";
import { QUEUES } from "@/lib/jobs";
import { nextDocNumber } from "@/lib/services/numbering";
import type { OffsetAdvanceInput, SupplierPaymentInput, SupplierPaymentListInput } from "@/lib/validation/buying";

import { dateOnly, listAdvanceBalances, listOpenPurchases } from "./payables";
import { orgName } from "./receiving";
import { assertWritable, getSupplierRow, inTx, notFound, supplierBalances, type PendingJob } from "./suppliers";

/**
 * Supplier payments + advance offsets (P2-A, DOMAIN-ENGINE §9).
 *
 * Open items = RECEIVED purchases of the supplier with outstanding > 0, where
 *   outstanding = total − prior payment allocations − advance offsets.
 * Both mutations lock the supplier's received purchase rows FOR UPDATE ordered
 * by id (deadlock-free), and only then read outstanding — so two concurrent
 * payments can never over-allocate one purchase.
 * Payments are recorded, not processed; any amount not allocated stays on the
 * payment as unallocated credit.
 */

export type SupplierPayment = typeof supplierPayments.$inferSelect;

export type RecordPaymentResult = {
  payment: SupplierPayment;
  allocations: Array<{ purchaseId: string; amountKobo: Kobo }>;
  unallocatedKobo: Kobo;
  jobs: PendingJob[];
};

/** Lock the supplier's received purchases (ordered by id) and return fresh open items. */
async function lockOpenItems(tx: Tx, ctx: OrgContext, supplierId: string): Promise<OpenItem[]> {
  await tx
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.organisationId, ctx.orgId),
        eq(purchases.supplierId, supplierId),
        eq(purchases.status, "received"),
      ),
    )
    .orderBy(asc(purchases.id))
    .for("update");
  const open = await listOpenPurchases(tx, ctx, { supplierId });
  return open.map((p) => ({ id: p.id, date: dateOnly(p.purchaseDate), outstandingKobo: p.outstandingKobo }));
}

export async function recordSupplierPayment(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: SupplierPaymentInput,
): Promise<RecordPaymentResult> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    const supplier = await getSupplierRow(tx, ctx, input.supplierId);
    const open = await lockOpenItems(tx, ctx, input.supplierId);

    let result: PaymentAllocationResult;
    if (input.mode === "manual") {
      result = validateManualPaymentAllocation(
        input.amountKobo,
        input.allocations.map((a) => ({ id: a.purchaseId, amountKobo: a.amountKobo })),
        open,
      );
    } else {
      result = allocatePaymentFifo(input.amountKobo, open);
    }

    const paymentNumber = await nextDocNumber(tx, ctx.orgId, "spm");
    const [payment] = await tx
      .insert(supplierPayments)
      .values({
        organisationId: ctx.orgId,
        supplierId: input.supplierId,
        paymentNumber,
        amountKobo: input.amountKobo,
        method: input.method,
        paymentDate: input.paymentDate,
        reference: input.reference,
        note: input.note,
        createdBy: ctx.userId,
      })
      .returning();
    const allocations = result.allocations.map((a) => ({ purchaseId: a.id, amountKobo: a.amountKobo }));
    if (allocations.length > 0) {
      await tx.insert(supplierPaymentAllocations).values(
        allocations.map((a) => ({
          organisationId: ctx.orgId,
          paymentId: payment.id,
          purchaseId: a.purchaseId,
          amountKobo: a.amountKobo,
        })),
      );
    }
    await writeAudit(tx, ctx, {
      action: "create",
      tableName: "supplier_payments",
      recordId: payment.id,
      after: { ...payment, mode: input.mode, allocations, unallocatedKobo: result.unallocatedKobo },
    });

    const jobs: PendingJob[] = [];
    if (input.sendSms && supplier.phone) {
      const bal = (await supplierBalances(tx, ctx, [supplier.id])).get(supplier.id);
      const owed = bal ? Math.max(bal.owedToSupplierKobo, 0) : 0;
      const body =
        `${await orgName(tx, ctx)}: ${supplier.name}, we have paid you ${formatNaira(input.amountKobo)} ` +
        `by ${input.method} on ${input.paymentDate}. Ref ${paymentNumber}. Still owed to you: ${formatNaira(owed)}.`;
      jobs.push({ name: QUEUES.SMS_SEND, data: { orgId: ctx.orgId, to: supplier.phone, body } });
    }

    return { payment, allocations, unallocatedKobo: result.unallocatedKobo, jobs };
  });
}

export type OffsetResult = {
  advanceId: string;
  offsets: Array<{ purchaseId: string; amountKobo: Kobo }>;
  totalOffsetKobo: Kobo;
  advanceOutstandingKobo: Kobo;
};

/**
 * Recover an advance against the supplier's open received purchases, oldest
 * purchase first; capped by the advance's outstanding (and the optional
 * amount) on one side and each purchase's outstanding on the other.
 */
export async function offsetAdvance(dbOrTx: DbOrTx, ctx: OrgContext, input: OffsetAdvanceInput): Promise<OffsetResult> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    const [adv] = await tx
      .select()
      .from(supplierAdvances)
      .where(and(eq(supplierAdvances.organisationId, ctx.orgId), eq(supplierAdvances.id, input.advanceId)))
      .for("update");
    if (!adv) notFound("Advance");
    const open = await lockOpenItems(tx, ctx, adv.supplierId);
    const [balance] = await listAdvanceBalances(tx, ctx, { advanceIds: [adv.id] });
    const advOutstanding = balance?.outstandingKobo ?? 0;
    if (advOutstanding <= 0) {
      throw new DomainError("ADVANCE_FULLY_RECOVERED", "This advance has nothing left to recover");
    }
    const cap = Math.min(advOutstanding, input.amountKobo ?? advOutstanding);
    const { allocations } = allocatePaymentFifo(cap, open);
    if (allocations.length === 0) {
      throw new DomainError("NOTHING_TO_OFFSET", "The supplier has no unpaid received purchases to offset against");
    }
    const offsets = allocations.map((a) => ({ purchaseId: a.id, amountKobo: a.amountKobo }));
    const rows = await tx
      .insert(supplierAdvanceOffsets)
      .values(
        offsets.map((o) => ({
          organisationId: ctx.orgId,
          advanceId: adv.id,
          purchaseId: o.purchaseId,
          amountKobo: o.amountKobo,
          createdBy: ctx.userId,
        })),
      )
      .returning();
    const totalOffsetKobo = offsets.reduce((s, o) => s + o.amountKobo, 0);
    for (const row of rows) {
      await writeAudit(tx, ctx, { action: "create", tableName: "supplier_advance_offsets", recordId: row.id, after: row });
    }
    return {
      advanceId: adv.id,
      offsets,
      totalOffsetKobo,
      advanceOutstandingKobo: advOutstanding - totalOffsetKobo,
    };
  });
}

export type SupplierPaymentListRow = SupplierPayment & {
  supplierName: string;
  allocatedKobo: Kobo;
  unallocatedKobo: Kobo;
};

export async function listSupplierPayments(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: Partial<SupplierPaymentListInput> = {},
): Promise<{ rows: SupplierPaymentListRow[]; total: number; page: number; pageSize: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  const where: SQL[] = [eq(supplierPayments.organisationId, ctx.orgId)];
  if (input.supplierId) where.push(eq(supplierPayments.supplierId, input.supplierId));
  if (input.from) where.push(gte(supplierPayments.paymentDate, input.from));
  if (input.to) where.push(lte(supplierPayments.paymentDate, input.to));
  const [{ n }] = await dbOrTx
    .select({ n: sql<string>`count(*)` })
    .from(supplierPayments)
    .where(and(...where));
  const rows = await dbOrTx
    .select({
      payment: supplierPayments,
      supplierName: suppliers.name,
      allocated: sql<string>`coalesce((select sum(a.amount_kobo) from supplier_payment_allocations a where a.payment_id = "supplier_payments"."id"), 0)`,
    })
    .from(supplierPayments)
    .innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
    .where(and(...where))
    .orderBy(desc(supplierPayments.paymentDate), desc(supplierPayments.paymentNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    rows: rows.map((r) => ({
      ...r.payment,
      supplierName: r.supplierName,
      allocatedKobo: Number(r.allocated),
      unallocatedKobo: r.payment.amountKobo - Number(r.allocated),
    })),
    total: Number(n),
    page,
    pageSize,
  };
}

export async function getSupplierPayment(dbOrTx: DbOrTx, ctx: OrgContext, id: string) {
  const [payment] = await dbOrTx
    .select()
    .from(supplierPayments)
    .where(and(eq(supplierPayments.organisationId, ctx.orgId), eq(supplierPayments.id, id)))
    .limit(1);
  if (!payment) notFound("Payment");
  const allocations = await dbOrTx
    .select({
      id: supplierPaymentAllocations.id,
      purchaseId: supplierPaymentAllocations.purchaseId,
      advanceId: supplierPaymentAllocations.advanceId,
      amountKobo: supplierPaymentAllocations.amountKobo,
      purchaseNumber: purchases.purchaseNumber,
      purchaseDate: purchases.purchaseDate,
    })
    .from(supplierPaymentAllocations)
    .leftJoin(purchases, eq(purchases.id, supplierPaymentAllocations.purchaseId))
    .where(and(eq(supplierPaymentAllocations.organisationId, ctx.orgId), eq(supplierPaymentAllocations.paymentId, id)))
    .orderBy(asc(purchases.purchaseDate));
  const allocatedKobo = allocations.reduce((s, a) => s + a.amountKobo, 0);
  return { payment, allocations, allocatedKobo, unallocatedKobo: payment.amountKobo - allocatedKobo };
}
