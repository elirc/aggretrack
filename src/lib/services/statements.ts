import { and, asc, eq, inArray, lte, ne } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import {
  customerPaymentAllocations,
  customerPayments,
  customers,
  invoices,
  organization,
  purchases,
  supplierAdvanceOffsets,
  supplierAdvances,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { formatNaira, type Kobo } from "@/lib/domain/units";
import { storeDocument } from "@/lib/services/documents";
import { lagosToday } from "@/lib/services/payables";
import { renderPdf } from "@/pdf/render";
import type {
  CustomerStatementProps,
  CustomerStatementRowKind,
  PdfOrg,
  StatementRow,
  SupplierStatementProps,
  SupplierStatementRowKind,
} from "@/pdf/types";

/**
 * Supplier / customer statements (P4-D): assemble date-ordered rows with a
 * running balance for a period, render the P1-D template, store the PDF.
 *
 * Sign conventions (src/pdf/types.ts StatementRow):
 *  - supplier: + received purchase (we owe more), − payment, − advance
 *    (supplier owes us), advance offsets are 0-effect memo rows (an offset
 *    reduces what we owe AND what the supplier owes by the same amount).
 *    Closing balance = Σ received − Σ payments − Σ advances, i.e.
 *    suppliers.supplierBalances().netKobo (P2-A never writes payment
 *    allocations to advances, the only term where the two could differ).
 *  - customer: + non-void invoice, − payment. Closing = invoiced − paid
 *    (customers.getCustomerDetail().balance.balanceKobo).
 * Rows dated before `from` collapse into the opening balance.
 *
 * Storage: the doc_type enum has no statement value (DECISIONS #4), so — as in
 * worker/jobs/documents.ts — supplier statements are filed as type `spm`,
 * customer statements as `cpm`, refType null, refId = supplier / customer id,
 * number null (unnumbered → a fresh documents row per generation).
 */

export type StatementRange = { from: string; to: string };

export type StatementLine<K extends string> = StatementRow<K> & { balanceKobo: Kobo };

export type AssembledStatement<K extends string, P> = {
  props: P;
  openingBalanceKobo: Kobo;
  rows: StatementLine<K>[];
  closingBalanceKobo: Kobo;
};

type Entry<K extends string> = StatementRow<K> & { date: string; order: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkRange(range: StatementRange): void {
  if (!DATE_RE.test(range.from) || !DATE_RE.test(range.to) || range.from > range.to) {
    throw new DomainError("VALIDATION", "Invalid statement period");
  }
}

/** Split entries at `from`, order the in-period ones, compute the running balance. */
function build<K extends string>(
  entries: Entry<K>[],
  range: StatementRange,
): { openingBalanceKobo: Kobo; rows: StatementLine<K>[]; closingBalanceKobo: Kobo } {
  let opening = 0;
  const inPeriod: Entry<K>[] = [];
  for (const e of entries) {
    if (e.date > range.to) continue;
    if (e.date < range.from) opening += e.amountKobo;
    else inPeriod.push(e);
  }
  inPeriod.sort((a, b) =>
    a.date !== b.date
      ? a.date < b.date
        ? -1
        : 1
      : a.order !== b.order
        ? a.order - b.order
        : a.reference.localeCompare(b.reference),
  );
  let balance = opening;
  const rows = inPeriod.map((e) => {
    balance += e.amountKobo;
    return { date: e.date, kind: e.kind, reference: e.reference, description: e.description, amountKobo: e.amountKobo, balanceKobo: balance };
  });
  return { openingBalanceKobo: opening, rows, closingBalanceKobo: balance };
}

const stripBalance = <K extends string>(rows: StatementLine<K>[]): StatementRow<K>[] =>
  rows.map((r) => ({ date: r.date, kind: r.kind, reference: r.reference, description: r.description, amountKobo: r.amountKobo }));

async function loadOrg(db: DbOrTx, orgId: string): Promise<PdfOrg> {
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return { name: org?.name ?? "" };
}

// ── Supplier ────────────────────────────────────────────────────────────────

const SUPPLIER_ORDER: Record<SupplierStatementRowKind, number> = { purchase: 0, advance: 1, offset: 2, payment: 3 };

export async function assembleSupplierStatement(
  db: DbOrTx,
  ctx: OrgContext,
  supplierId: string,
  range: StatementRange,
): Promise<AssembledStatement<SupplierStatementRowKind, SupplierStatementProps>> {
  checkRange(range);
  const [supplier] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.organisationId, ctx.orgId), eq(suppliers.id, supplierId)))
    .limit(1);
  if (!supplier) throw new DomainError("NOT_FOUND", "Supplier not found");

  const entries: Entry<SupplierStatementRowKind>[] = [];

  const purchaseRows = await db
    .select({
      id: purchases.id,
      purchaseNumber: purchases.purchaseNumber,
      grnNumber: purchases.grnNumber,
      purchaseDate: purchases.purchaseDate,
      totalKobo: purchases.totalAmountKobo,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.organisationId, ctx.orgId),
        eq(purchases.supplierId, supplierId),
        eq(purchases.status, "received"),
        lte(purchases.purchaseDate, range.to),
      ),
    )
    .orderBy(asc(purchases.purchaseDate), asc(purchases.id));
  const purchaseRef = new Map<string, string>();
  for (const p of purchaseRows) {
    const ref = p.grnNumber ?? p.purchaseNumber ?? p.id.slice(0, 8);
    purchaseRef.set(p.id, ref);
    entries.push({
      date: p.purchaseDate,
      order: SUPPLIER_ORDER.purchase,
      kind: "purchase",
      reference: ref,
      description: p.grnNumber && p.purchaseNumber ? p.purchaseNumber : null,
      amountKobo: p.totalKobo ?? 0,
    });
  }

  const payRows = await db
    .select({
      id: supplierPayments.id,
      paymentNumber: supplierPayments.paymentNumber,
      paymentDate: supplierPayments.paymentDate,
      amountKobo: supplierPayments.amountKobo,
      method: supplierPayments.method,
      reference: supplierPayments.reference,
    })
    .from(supplierPayments)
    .where(
      and(
        eq(supplierPayments.organisationId, ctx.orgId),
        eq(supplierPayments.supplierId, supplierId),
        lte(supplierPayments.paymentDate, range.to),
      ),
    );
  const allocs = payRows.length
    ? await db
        .select({
          paymentId: supplierPaymentAllocations.paymentId,
          purchaseId: supplierPaymentAllocations.purchaseId,
          grnNumber: purchases.grnNumber,
          purchaseNumber: purchases.purchaseNumber,
          amountKobo: supplierPaymentAllocations.amountKobo,
        })
        .from(supplierPaymentAllocations)
        .leftJoin(purchases, eq(purchases.id, supplierPaymentAllocations.purchaseId))
        .where(
          and(
            eq(supplierPaymentAllocations.organisationId, ctx.orgId),
            inArray(
              supplierPaymentAllocations.paymentId,
              payRows.map((p) => p.id),
            ),
          ),
        )
    : [];
  const allocsByPayment = new Map<string, typeof allocs>();
  for (const a of allocs) {
    const list = allocsByPayment.get(a.paymentId) ?? [];
    list.push(a);
    allocsByPayment.set(a.paymentId, list);
  }
  for (const p of payRows) {
    const list = allocsByPayment.get(p.id) ?? [];
    const toPurchases = list.filter((a) => a.purchaseId);
    const allocated = list.reduce((s, a) => s + a.amountKobo, 0);
    const parts: string[] = [p.method + (p.reference ? ` ref ${p.reference}` : "")];
    if (toPurchases.length) {
      parts.push(
        `for ${toPurchases
          .map((a) => `${a.grnNumber ?? a.purchaseNumber ?? "purchase"} ${formatNaira(a.amountKobo)}`)
          .join(", ")}`,
      );
    }
    if (p.amountKobo - allocated > 0) parts.push(`${formatNaira(p.amountKobo - allocated)} unallocated`);
    entries.push({
      date: p.paymentDate,
      order: SUPPLIER_ORDER.payment,
      kind: "payment",
      reference: p.paymentNumber,
      description: parts.join("; "),
      amountKobo: -p.amountKobo,
    });
  }

  const advRows = await db
    .select({
      advanceNumber: supplierAdvances.advanceNumber,
      advanceDate: supplierAdvances.advanceDate,
      amountKobo: supplierAdvances.amountKobo,
      note: supplierAdvances.note,
    })
    .from(supplierAdvances)
    .where(
      and(
        eq(supplierAdvances.organisationId, ctx.orgId),
        eq(supplierAdvances.supplierId, supplierId),
        lte(supplierAdvances.advanceDate, range.to),
      ),
    );
  for (const a of advRows) {
    entries.push({
      date: a.advanceDate,
      order: SUPPLIER_ORDER.advance,
      kind: "advance",
      reference: a.advanceNumber,
      description: a.note,
      amountKobo: -a.amountKobo,
    });
  }

  const offsetRows = await db
    .select({
      advanceNumber: supplierAdvances.advanceNumber,
      purchaseId: supplierAdvanceOffsets.purchaseId,
      amountKobo: supplierAdvanceOffsets.amountKobo,
      createdAt: supplierAdvanceOffsets.createdAt,
    })
    .from(supplierAdvanceOffsets)
    .innerJoin(supplierAdvances, eq(supplierAdvances.id, supplierAdvanceOffsets.advanceId))
    .where(and(eq(supplierAdvanceOffsets.organisationId, ctx.orgId), eq(supplierAdvances.supplierId, supplierId)));
  for (const o of offsetRows) {
    entries.push({
      date: lagosToday(o.createdAt),
      order: SUPPLIER_ORDER.offset,
      kind: "offset",
      reference: o.advanceNumber,
      // Memo row: the offset settles purchase debt with advance credit, net effect 0.
      description: `${formatNaira(o.amountKobo)} recovered against ${purchaseRef.get(o.purchaseId) ?? "purchase"}`,
      amountKobo: 0,
    });
  }

  const built = build(entries, range);
  const props: SupplierStatementProps = {
    org: await loadOrg(db, ctx.orgId),
    supplier: {
      name: supplier.name,
      phone: supplier.phone,
      addressLines: [supplier.village, supplier.lga, supplier.state],
    },
    periodFrom: range.from,
    periodTo: range.to,
    openingBalanceKobo: built.openingBalanceKobo,
    rows: stripBalance(built.rows),
    generatedAt: new Date().toISOString(),
  };
  return { props, ...built };
}

// ── Customer ────────────────────────────────────────────────────────────────

const CUSTOMER_ORDER: Record<CustomerStatementRowKind, number> = { invoice: 0, payment: 1 };

export async function assembleCustomerStatement(
  db: DbOrTx,
  ctx: OrgContext,
  customerId: string,
  range: StatementRange,
): Promise<AssembledStatement<CustomerStatementRowKind, CustomerStatementProps>> {
  checkRange(range);
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.organisationId, ctx.orgId), eq(customers.id, customerId)))
    .limit(1);
  if (!customer) throw new DomainError("NOT_FOUND", "Customer not found");

  const entries: Entry<CustomerStatementRowKind>[] = [];

  const invRows = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      totalKobo: invoices.totalKobo,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organisationId, ctx.orgId),
        eq(invoices.customerId, customerId),
        ne(invoices.status, "void"),
        lte(invoices.invoiceDate, range.to),
      ),
    );
  for (const i of invRows) {
    entries.push({
      date: i.invoiceDate,
      order: CUSTOMER_ORDER.invoice,
      kind: "invoice",
      reference: i.invoiceNumber,
      description: i.dueDate ? `due ${i.dueDate}` : null,
      amountKobo: i.totalKobo,
    });
  }

  const payRows = await db
    .select({
      id: customerPayments.id,
      paymentNumber: customerPayments.paymentNumber,
      paymentDate: customerPayments.paymentDate,
      amountKobo: customerPayments.amountKobo,
      method: customerPayments.method,
      reference: customerPayments.reference,
    })
    .from(customerPayments)
    .where(
      and(
        eq(customerPayments.organisationId, ctx.orgId),
        eq(customerPayments.customerId, customerId),
        lte(customerPayments.paymentDate, range.to),
      ),
    );
  const allocs = payRows.length
    ? await db
        .select({
          paymentId: customerPaymentAllocations.paymentId,
          invoiceNumber: invoices.invoiceNumber,
          amountKobo: customerPaymentAllocations.amountKobo,
        })
        .from(customerPaymentAllocations)
        .innerJoin(invoices, eq(invoices.id, customerPaymentAllocations.invoiceId))
        .where(
          and(
            eq(customerPaymentAllocations.organisationId, ctx.orgId),
            inArray(
              customerPaymentAllocations.paymentId,
              payRows.map((p) => p.id),
            ),
          ),
        )
    : [];
  for (const p of payRows) {
    const list = allocs.filter((a) => a.paymentId === p.id);
    const allocated = list.reduce((s, a) => s + a.amountKobo, 0);
    const parts: string[] = [p.method + (p.reference ? ` ref ${p.reference}` : "")];
    if (list.length) parts.push(`for ${list.map((a) => `${a.invoiceNumber} ${formatNaira(a.amountKobo)}`).join(", ")}`);
    if (p.amountKobo - allocated > 0) parts.push(`${formatNaira(p.amountKobo - allocated)} on account`);
    entries.push({
      date: p.paymentDate,
      order: CUSTOMER_ORDER.payment,
      kind: "payment",
      reference: p.paymentNumber,
      description: parts.join("; "),
      amountKobo: -p.amountKobo,
    });
  }

  const built = build(entries, range);
  const props: CustomerStatementProps = {
    org: await loadOrg(db, ctx.orgId),
    customer: {
      name: customer.name,
      phone: customer.phone,
      addressLines: [customer.address, customer.state],
    },
    periodFrom: range.from,
    periodTo: range.to,
    openingBalanceKobo: built.openingBalanceKobo,
    rows: stripBalance(built.rows),
    generatedAt: new Date().toISOString(),
  };
  return { props, ...built };
}

// ── Generate (assemble → render → store) ────────────────────────────────────

export type GeneratedStatement = { documentId: string; closingBalanceKobo: Kobo };

export async function generateSupplierStatement(
  db: DbOrTx,
  ctx: OrgContext,
  supplierId: string,
  range: StatementRange,
): Promise<GeneratedStatement> {
  const st = await assembleSupplierStatement(db, ctx, supplierId, range);
  const buffer = await renderPdf("supplier_statement", st.props);
  // Unnumbered → a single insert; no transaction needed.
  const { id } = await storeDocument(db, ctx, { type: "spm", number: null, refType: null, refId: supplierId, buffer });
  return { documentId: id, closingBalanceKobo: st.closingBalanceKobo };
}

export async function generateCustomerStatement(
  db: DbOrTx,
  ctx: OrgContext,
  customerId: string,
  range: StatementRange,
): Promise<GeneratedStatement> {
  const st = await assembleCustomerStatement(db, ctx, customerId, range);
  const buffer = await renderPdf("customer_statement", st.props);
  // Unnumbered → a single insert; no transaction needed.
  const { id } = await storeDocument(db, ctx, { type: "cpm", number: null, refType: null, refId: customerId, buffer });
  return { documentId: id, closingBalanceKobo: st.closingBalanceKobo };
}
