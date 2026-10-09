import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  commodities,
  customerPaymentAllocations,
  customerPayments,
  customers,
  dispatches,
  dispatchLines,
  grades,
  invoices,
  lotAllocations,
  organisationSettings,
  salesLines,
  salesOrders,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, roundHalfUpKobo, type Kobo } from "@/lib/domain/units";
import { nextDocNumber } from "@/lib/services/numbering";
import {
  enqueueDocument,
  lagosToday,
  lineAmountKobo,
  notFound,
  runTx,
  type SellingDeps,
} from "@/lib/services/salesOrders";

/**
 * Invoices (P2-C). One invoice per dispatch. Subtotal = Σ over dispatch_lines
 * of roundHalfUp(grams × sales_line price / 1000). Optional tax line (off by
 * default) uses organisation_settings.invoice_tax_percent.
 * Outstanding = total − Σ customer_payment_allocations; status derived.
 */

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceStatus = Invoice["status"];

/** Parse a numeric(5,2) percent into integer basis points (7.50 → 750). */
function percentToBp(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid percent: ${s}`);
  return Math.round(n * 100);
}

export function computeTaxKobo(subtotalKobo: Kobo, taxPercent: string): Kobo {
  return roundHalfUpKobo((subtotalKobo * percentToBp(taxPercent)) / 10_000);
}

/** paid if outstanding 0, part_paid if 0 < paid < total, issued otherwise. void is sticky. */
export function deriveInvoiceStatus(current: InvoiceStatus, totalKobo: Kobo, paidKobo: Kobo): InvoiceStatus {
  if (current === "void") return "void";
  if (paidKobo <= 0) return "issued";
  if (paidKobo >= totalKobo) return "paid";
  return "part_paid";
}

/** Σ allocations per invoice. */
export async function paidByInvoice(db: DbOrTx, ctx: OrgContext, invoiceIds: string[]): Promise<Map<string, Kobo>> {
  const out = new Map<string, Kobo>();
  if (invoiceIds.length === 0) return out;
  const rows = await db
    .select({
      invoiceId: customerPaymentAllocations.invoiceId,
      paid: sql<string>`coalesce(sum(${customerPaymentAllocations.amountKobo}), 0)`,
    })
    .from(customerPaymentAllocations)
    .where(
      and(
        eq(customerPaymentAllocations.organisationId, ctx.orgId),
        inArray(customerPaymentAllocations.invoiceId, invoiceIds),
      ),
    )
    .groupBy(customerPaymentAllocations.invoiceId);
  for (const r of rows) out.set(r.invoiceId, Number(r.paid));
  return out;
}

export type CreateInvoiceInput = {
  dispatchId: string;
  invoiceDate?: string;
  dueDate?: string | null;
  applyTax?: boolean;
};

export async function createInvoiceFromDispatch(
  db: DbOrTx,
  ctx: OrgContext,
  input: CreateInvoiceInput,
  deps?: SellingDeps,
): Promise<Invoice> {
  const invoice = await runTx(db, async (tx) => {
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.organisationId, ctx.orgId)))
      .for("update");
    if (!dispatch) notFound("Dispatch");

    const [existing] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, ctx.orgId),
          eq(invoices.dispatchId, dispatch.id),
          ne(invoices.status, "void"),
        ),
      );
    if (existing) throw new DomainError("ALREADY_INVOICED", "This dispatch already has an invoice");

    const [order] = await tx
      .select({ id: salesOrders.id, customerId: salesOrders.customerId })
      .from(salesOrders)
      .where(and(eq(salesOrders.id, dispatch.salesOrderId), eq(salesOrders.organisationId, ctx.orgId)));
    if (!order) notFound("Sales order");

    const lines = await tx
      .select({ kg: dispatchLines.kg, pricePerKgKobo: salesLines.pricePerKgKobo })
      .from(dispatchLines)
      .innerJoin(lotAllocations, eq(lotAllocations.id, dispatchLines.lotAllocationId))
      .innerJoin(salesLines, eq(salesLines.id, lotAllocations.salesLineId))
      .where(and(eq(dispatchLines.organisationId, ctx.orgId), eq(dispatchLines.dispatchId, dispatch.id)));
    if (lines.length === 0) throw new DomainError("VALIDATION", "Dispatch has no lines");
    const subtotalKobo = lines.reduce((s, l) => s + lineAmountKobo(kgToGrams(l.kg), l.pricePerKgKobo), 0);

    let taxPercent = "0";
    let taxKobo = 0;
    if (input.applyTax) {
      const [settings] = await tx
        .select({ pct: organisationSettings.invoiceTaxPercent })
        .from(organisationSettings)
        .where(eq(organisationSettings.organisationId, ctx.orgId));
      taxPercent = settings?.pct ?? "0";
      taxKobo = computeTaxKobo(subtotalKobo, taxPercent);
    }

    const invoiceNumber = await nextDocNumber(tx, ctx.orgId, "inv");
    const [row] = await tx
      .insert(invoices)
      .values({
        organisationId: ctx.orgId,
        invoiceNumber,
        customerId: order.customerId,
        salesOrderId: order.id,
        dispatchId: dispatch.id,
        invoiceDate: input.invoiceDate ?? lagosToday(),
        dueDate: input.dueDate ?? null,
        subtotalKobo,
        taxPercent,
        taxKobo,
        totalKobo: subtotalKobo + taxKobo,
        status: "issued",
        createdBy: ctx.userId,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "invoices", recordId: row.id, after: row });
    return row;
  });
  await enqueueDocument(deps, ctx, "invoice", invoice.id);
  return invoice;
}

/** Void an invoice — only while no payment has been allocated to it. */
export async function voidInvoice(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<Invoice> {
  return runTx(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.id), eq(invoices.organisationId, ctx.orgId)))
      .for("update");
    if (!before) notFound("Invoice");
    if (before.status === "void") throw new DomainError("INVOICE_ALREADY_VOID");
    const paid = (await paidByInvoice(tx, ctx, [before.id])).get(before.id) ?? 0;
    if (paid > 0) {
      throw new DomainError("INVOICE_HAS_PAYMENTS", "Invoices with allocated payments cannot be voided");
    }
    const [after] = await tx
      .update(invoices)
      .set({ status: "void", updatedAt: new Date() })
      .where(and(eq(invoices.id, before.id), eq(invoices.organisationId, ctx.orgId)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "cancel",
      tableName: "invoices",
      recordId: after.id,
      before: { status: before.status },
      after: { status: after.status },
    });
    return after;
  });
}

/** Recompute + persist the status of locked invoices (caller holds the row locks). */
export async function syncInvoiceStatuses(tx: Tx, ctx: OrgContext, rows: Invoice[]): Promise<void> {
  const paid = await paidByInvoice(
    tx,
    ctx,
    rows.map((r) => r.id),
  );
  for (const r of rows) {
    const next = deriveInvoiceStatus(r.status, r.totalKobo, paid.get(r.id) ?? 0);
    if (next === r.status) continue;
    await tx
      .update(invoices)
      .set({ status: next, updatedAt: new Date() })
      .where(and(eq(invoices.id, r.id), eq(invoices.organisationId, ctx.orgId)));
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "invoices",
      recordId: r.id,
      before: { status: r.status },
      after: { status: next },
    });
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

export type InvoiceListRow = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  salesOrderId: string;
  dispatchId: string | null;
  invoiceDate: string;
  dueDate: string | null;
  totalKobo: Kobo;
  paidKobo: Kobo;
  outstandingKobo: Kobo;
  status: InvoiceStatus;
};

export async function listInvoices(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { status?: InvoiceStatus; customerId?: string; openOnly?: boolean; page?: number; pageSize?: number } = {},
): Promise<{ rows: InvoiceListRow[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;
  const where: SQL[] = [eq(invoices.organisationId, ctx.orgId)];
  if (opts.status) where.push(eq(invoices.status, opts.status));
  if (opts.customerId) where.push(eq(invoices.customerId, opts.customerId));
  if (opts.openOnly) where.push(inArray(invoices.status, ["issued", "part_paid"]));
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerId: invoices.customerId,
      customerName: customers.name,
      salesOrderId: invoices.salesOrderId,
      dispatchId: invoices.dispatchId,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      totalKobo: invoices.totalKobo,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...where))
    .orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const paid = await paidByInvoice(
    db,
    ctx,
    rows.map((r) => r.id),
  );
  const [c] = await db.select({ n: count() }).from(invoices).where(and(...where));
  return {
    rows: rows.map((r) => {
      const p = paid.get(r.id) ?? 0;
      return { ...r, paidKobo: p, outstandingKobo: r.status === "void" ? 0 : r.totalKobo - p };
    }),
    total: c?.n ?? 0,
  };
}

export type InvoiceDetail = Invoice & {
  customerName: string;
  orderNumber: string;
  waybillNumber: string | null;
  paidKobo: Kobo;
  outstandingKobo: Kobo;
  lines: {
    salesLineId: string;
    commodityName: string;
    gradeName: string;
    kg: string;
    pricePerKgKobo: Kobo;
    amountKobo: Kobo;
  }[];
  payments: { paymentId: string; paymentNumber: string; paymentDate: string; amountKobo: Kobo }[];
};

export async function getInvoice(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<InvoiceDetail> {
  const [row] = await db
    .select({
      invoice: invoices,
      customerName: customers.name,
      orderNumber: salesOrders.orderNumber,
      waybillNumber: dispatches.waybillNumber,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(salesOrders, eq(salesOrders.id, invoices.salesOrderId))
    .leftJoin(dispatches, eq(dispatches.id, invoices.dispatchId))
    .where(and(eq(invoices.id, input.id), eq(invoices.organisationId, ctx.orgId)));
  if (!row) notFound("Invoice");

  // Lines snapshot: dispatched kg grouped per sales line, priced at the line price.
  const raw = row.invoice.dispatchId
    ? await db
        .select({
          salesLineId: salesLines.id,
          commodityName: commodities.name,
          gradeName: grades.name,
          kg: dispatchLines.kg,
          pricePerKgKobo: salesLines.pricePerKgKobo,
        })
        .from(dispatchLines)
        .innerJoin(lotAllocations, eq(lotAllocations.id, dispatchLines.lotAllocationId))
        .innerJoin(salesLines, eq(salesLines.id, lotAllocations.salesLineId))
        .innerJoin(commodities, eq(commodities.id, salesLines.commodityId))
        .innerJoin(grades, eq(grades.id, salesLines.gradeId))
        .where(
          and(eq(dispatchLines.organisationId, ctx.orgId), eq(dispatchLines.dispatchId, row.invoice.dispatchId)),
        )
        .orderBy(asc(salesLines.createdAt), asc(dispatchLines.id))
    : [];
  const grouped = new Map<string, InvoiceDetail["lines"][number] & { grams: number }>();
  for (const r of raw) {
    const g = grouped.get(r.salesLineId) ?? {
      salesLineId: r.salesLineId,
      commodityName: r.commodityName,
      gradeName: r.gradeName,
      kg: "0.000",
      pricePerKgKobo: r.pricePerKgKobo,
      amountKobo: 0,
      grams: 0,
    };
    g.grams += kgToGrams(r.kg);
    g.amountKobo += lineAmountKobo(kgToGrams(r.kg), r.pricePerKgKobo);
    grouped.set(r.salesLineId, g);
  }
  const lines = [...grouped.values()].map(({ grams, ...l }) => ({
    ...l,
    kg: gramsToKg(grams),
  }));

  const payments = await db
    .select({
      paymentId: customerPayments.id,
      paymentNumber: customerPayments.paymentNumber,
      paymentDate: customerPayments.paymentDate,
      amountKobo: customerPaymentAllocations.amountKobo,
    })
    .from(customerPaymentAllocations)
    .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentAllocations.paymentId))
    .where(
      and(
        eq(customerPaymentAllocations.organisationId, ctx.orgId),
        eq(customerPaymentAllocations.invoiceId, row.invoice.id),
      ),
    )
    .orderBy(asc(customerPayments.paymentDate));
  const paidKobo = payments.reduce((s, p) => s + p.amountKobo, 0);
  return {
    ...row.invoice,
    customerName: row.customerName,
    orderNumber: row.orderNumber,
    waybillNumber: row.waybillNumber,
    paidKobo,
    outstandingKobo: row.invoice.status === "void" ? 0 : row.invoice.totalKobo - paidKobo,
    lines,
    payments,
  };
}
