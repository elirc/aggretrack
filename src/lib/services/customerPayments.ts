import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { customerPaymentAllocations, customerPayments, customers, invoices } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import {
  allocatePaymentFifo,
  validateManualPaymentAllocation,
  type OpenItem,
  type PaymentAllocationResult,
} from "@/lib/domain/payments";
import type { Kobo } from "@/lib/domain/units";
import { paidByInvoice, syncInvoiceStatuses } from "@/lib/services/invoices";
import { nextDocNumber } from "@/lib/services/numbering";
import { dateOnlyToDate, notFound, runTx } from "@/lib/services/salesOrders";

/**
 * Customer payments (DOMAIN-ENGINE §9). Recorded, not processed.
 * Open invoices are locked FOR UPDATE ordered by id, outstanding is computed
 * fresh after the lock, then FIFO (oldest invoice_date first) or validated
 * manual picks decide the allocations. Leftover stays unallocated (credit).
 */

export type CustomerPayment = typeof customerPayments.$inferSelect;
export type CustomerPaymentAllocation = typeof customerPaymentAllocations.$inferSelect;

export type RecordPaymentInput = {
  customerId: string;
  amountKobo: Kobo;
  method: "cash" | "transfer" | "pos";
  paymentDate: string;
  reference?: string | null;
  note?: string | null;
  /** Manual override; omitted → FIFO. */
  allocations?: { invoiceId: string; amountKobo: Kobo }[];
};

export type RecordPaymentResult = {
  payment: CustomerPayment;
  allocations: CustomerPaymentAllocation[];
  unallocatedKobo: Kobo;
};

export async function recordCustomerPayment(
  db: DbOrTx,
  ctx: OrgContext,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  if (!Number.isSafeInteger(input.amountKobo) || input.amountKobo <= 0) {
    throw new DomainError("VALIDATION", "Payment amount must be a positive integer kobo value");
  }
  return runTx(db, async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.organisationId, ctx.orgId)));
    if (!customer) notFound("Customer");

    // Lock the payment targets (ordered by id → no deadlock), then read fresh outstanding.
    const open = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, ctx.orgId),
          eq(invoices.customerId, customer.id),
          inArray(invoices.status, ["issued", "part_paid"]),
        ),
      )
      .orderBy(asc(invoices.id))
      .for("update");
    const paid = await paidByInvoice(
      tx,
      ctx,
      open.map((i) => i.id),
    );
    const items: OpenItem[] = open.map((i) => ({
      id: i.id,
      date: dateOnlyToDate(i.invoiceDate),
      outstandingKobo: i.totalKobo - (paid.get(i.id) ?? 0),
    }));

    let decision: PaymentAllocationResult;
    if (input.allocations && input.allocations.length > 0) {
      decision = validateManualPaymentAllocation(
        input.amountKobo,
        input.allocations.map((a) => ({ id: a.invoiceId, amountKobo: a.amountKobo })),
        items.filter((i) => i.outstandingKobo > 0),
      );
    } else {
      decision = allocatePaymentFifo(input.amountKobo, items);
    }

    const paymentNumber = await nextDocNumber(tx, ctx.orgId, "cpm");
    const [payment] = await tx
      .insert(customerPayments)
      .values({
        organisationId: ctx.orgId,
        customerId: customer.id,
        paymentNumber,
        amountKobo: input.amountKobo,
        method: input.method,
        paymentDate: input.paymentDate,
        reference: input.reference ?? null,
        note: input.note ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    const allocations =
      decision.allocations.length > 0
        ? await tx
            .insert(customerPaymentAllocations)
            .values(
              decision.allocations.map((a) => ({
                organisationId: ctx.orgId,
                paymentId: payment.id,
                invoiceId: a.id,
                amountKobo: a.amountKobo,
              })),
            )
            .returning()
        : [];
    await writeAudit(tx, ctx, {
      action: "create",
      tableName: "customer_payments",
      recordId: payment.id,
      after: { ...payment, allocations, unallocatedKobo: decision.unallocatedKobo },
    });
    const touched = new Set(allocations.map((a) => a.invoiceId));
    await syncInvoiceStatuses(
      tx,
      ctx,
      open.filter((i) => touched.has(i.id)),
    );
    return { payment, allocations, unallocatedKobo: decision.unallocatedKobo };
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

export type CustomerPaymentListRow = CustomerPayment & {
  customerName: string;
  allocatedKobo: Kobo;
  unallocatedKobo: Kobo;
};

async function allocatedByPayment(db: DbOrTx, ctx: OrgContext, ids: string[]): Promise<Map<string, Kobo>> {
  const out = new Map<string, Kobo>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      paymentId: customerPaymentAllocations.paymentId,
      total: sql<string>`coalesce(sum(${customerPaymentAllocations.amountKobo}), 0)`,
    })
    .from(customerPaymentAllocations)
    .where(
      and(eq(customerPaymentAllocations.organisationId, ctx.orgId), inArray(customerPaymentAllocations.paymentId, ids)),
    )
    .groupBy(customerPaymentAllocations.paymentId);
  for (const r of rows) out.set(r.paymentId, Number(r.total));
  return out;
}

export async function listCustomerPayments(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { customerId?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: CustomerPaymentListRow[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;
  const where: SQL[] = [eq(customerPayments.organisationId, ctx.orgId)];
  if (opts.customerId) where.push(eq(customerPayments.customerId, opts.customerId));
  const rows = await db
    .select({ payment: customerPayments, customerName: customers.name })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .where(and(...where))
    .orderBy(desc(customerPayments.paymentDate), desc(customerPayments.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const alloc = await allocatedByPayment(
    db,
    ctx,
    rows.map((r) => r.payment.id),
  );
  const [c] = await db.select({ n: count() }).from(customerPayments).where(and(...where));
  return {
    rows: rows.map((r) => {
      const a = alloc.get(r.payment.id) ?? 0;
      return { ...r.payment, customerName: r.customerName, allocatedKobo: a, unallocatedKobo: r.payment.amountKobo - a };
    }),
    total: c?.n ?? 0,
  };
}

export type CustomerPaymentDetail = CustomerPaymentListRow & {
  allocations: { invoiceId: string; invoiceNumber: string; invoiceDate: string; amountKobo: Kobo }[];
};

export async function getCustomerPayment(
  db: DbOrTx,
  ctx: OrgContext,
  input: { id: string },
): Promise<CustomerPaymentDetail> {
  const [row] = await db
    .select({ payment: customerPayments, customerName: customers.name })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .where(and(eq(customerPayments.id, input.id), eq(customerPayments.organisationId, ctx.orgId)));
  if (!row) notFound("Payment");
  const allocations = await db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      amountKobo: customerPaymentAllocations.amountKobo,
    })
    .from(customerPaymentAllocations)
    .innerJoin(invoices, eq(invoices.id, customerPaymentAllocations.invoiceId))
    .where(
      and(
        eq(customerPaymentAllocations.organisationId, ctx.orgId),
        eq(customerPaymentAllocations.paymentId, row.payment.id),
      ),
    )
    .orderBy(asc(invoices.invoiceDate), asc(invoices.id));
  const a = allocations.reduce((s, x) => s + x.amountKobo, 0);
  return {
    ...row.payment,
    customerName: row.customerName,
    allocatedKobo: a,
    unallocatedKobo: row.payment.amountKobo - a,
    allocations,
  };
}
