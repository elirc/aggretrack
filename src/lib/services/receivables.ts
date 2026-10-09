import { and, asc, eq, inArray, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { customers, invoices } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { AGE_BANDS, ageBand, ageInDays, bucketByAge, type AgeBand } from "@/lib/domain/ageing";
import type { Kobo } from "@/lib/domain/units";
import { paidByInvoice } from "@/lib/services/invoices";
import { dateOnlyToDate, lagosToday } from "@/lib/services/salesOrders";

/**
 * Receivables ageing (DOMAIN-ENGINE §10): origin = invoice_date, value =
 * outstanding kobo (total − allocations) of issued / part_paid invoices.
 */

export type ReceivableInvoice = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  totalKobo: Kobo;
  outstandingKobo: Kobo;
  ageDays: number;
  band: AgeBand;
};

export type ReceivablesRow = {
  customerId: string;
  customerName: string;
  buckets: Record<AgeBand, Kobo>;
  totalOutstandingKobo: Kobo;
  invoices: ReceivableInvoice[];
};

export type ReceivablesReport = {
  asOf: string;
  rows: ReceivablesRow[];
  totals: Record<AgeBand, Kobo> & { total: Kobo };
};

export async function receivablesAgeing(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { asOf?: string; customerId?: string } = {},
): Promise<ReceivablesReport> {
  const asOf = opts.asOf ?? lagosToday();
  const asOfDate = dateOnlyToDate(asOf);
  const where: SQL[] = [eq(invoices.organisationId, ctx.orgId), inArray(invoices.status, ["issued", "part_paid"])];
  if (opts.customerId) where.push(eq(invoices.customerId, opts.customerId));
  const open = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      totalKobo: invoices.totalKobo,
      customerId: invoices.customerId,
      customerName: customers.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...where))
    .orderBy(asc(customers.name), asc(invoices.invoiceDate), asc(invoices.id));
  const paid = await paidByInvoice(
    db,
    ctx,
    open.map((i) => i.id),
  );

  const byCustomer = new Map<string, { name: string; items: ReceivableInvoice[] }>();
  for (const i of open) {
    const outstandingKobo = i.totalKobo - (paid.get(i.id) ?? 0);
    if (outstandingKobo <= 0) continue;
    const ageDays = ageInDays(asOfDate, dateOnlyToDate(i.invoiceDate));
    const entry = byCustomer.get(i.customerId) ?? { name: i.customerName, items: [] };
    entry.items.push({
      invoiceId: i.id,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      dueDate: i.dueDate,
      totalKobo: i.totalKobo,
      outstandingKobo,
      ageDays,
      band: ageBand(ageDays),
    });
    byCustomer.set(i.customerId, entry);
  }

  const totals = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 };
  const rows: ReceivablesRow[] = [];
  for (const [customerId, { name, items }] of byCustomer) {
    const buckets = bucketByAge(
      items,
      (x) => dateOnlyToDate(x.invoiceDate),
      (x) => x.outstandingKobo,
      asOfDate,
    );
    const totalOutstandingKobo = items.reduce((s, x) => s + x.outstandingKobo, 0);
    for (const b of AGE_BANDS) totals[b] += buckets[b];
    totals.total += totalOutstandingKobo;
    rows.push({ customerId, customerName: name, buckets, totalOutstandingKobo, invoices: items });
  }
  rows.sort((a, b) => b.totalOutstandingKobo - a.totalOutstandingKobo || a.customerName.localeCompare(b.customerName));
  return { asOf, rows, totals };
}
