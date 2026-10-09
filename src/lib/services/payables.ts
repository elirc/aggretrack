import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { purchases, supplierAdvances, suppliers } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { AGE_BANDS, ageBand, ageInDays, bucketByAge, type AgeBand } from "@/lib/domain/ageing";
import type { Kobo } from "@/lib/domain/units";
import type { PayablesInput } from "@/lib/validation/buying";

/**
 * Payables (P2-A). Read-only; the leaf module of the buying services — it
 * defines the single "open purchase outstanding" query that supplier payments,
 * advance offsets, balances and ageing all share:
 *
 *   outstanding(purchase) = total_amount_kobo − Σ payment allocations − Σ advance offsets
 *
 * Only RECEIVED purchases are payable (DATA-MODEL supplier balance formula).
 */

/** Today's calendar date in Africa/Lagos, "yyyy-mm-dd". */
export function lagosToday(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** "yyyy-mm-dd" → Date at UTC midnight (how calendar dates are aged). */
export function dateOnly(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

export type OpenPurchase = {
  id: string;
  supplierId: string;
  purchaseNumber: string | null;
  purchaseDate: string;
  totalKobo: Kobo;
  paidKobo: Kobo;
  offsetKobo: Kobo;
  outstandingKobo: Kobo;
};

const paidSql = sql<string>`coalesce((select sum(spa.amount_kobo) from supplier_payment_allocations spa where spa.purchase_id = "purchases"."id" and spa.organisation_id = "purchases"."organisation_id"), 0)`;
const offsetSql = sql<string>`coalesce((select sum(sao.amount_kobo) from supplier_advance_offsets sao where sao.purchase_id = "purchases"."id" and sao.organisation_id = "purchases"."organisation_id"), 0)`;

/**
 * Received purchases with their paid/offset/outstanding amounts.
 * `onlyOpen` (default true) drops fully settled ones. Inside a payment tx,
 * call this AFTER locking the purchase rows so the numbers are fresh.
 */
export async function listOpenPurchases(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  opts: { supplierId?: string; supplierIds?: string[]; onlyOpen?: boolean } = {},
): Promise<OpenPurchase[]> {
  const where: SQL[] = [eq(purchases.organisationId, ctx.orgId), eq(purchases.status, "received")];
  if (opts.supplierId) where.push(eq(purchases.supplierId, opts.supplierId));
  if (opts.supplierIds) {
    if (opts.supplierIds.length === 0) return [];
    where.push(inArray(purchases.supplierId, opts.supplierIds));
  }
  const rows = await dbOrTx
    .select({
      id: purchases.id,
      supplierId: purchases.supplierId,
      purchaseNumber: purchases.purchaseNumber,
      purchaseDate: purchases.purchaseDate,
      totalKobo: purchases.totalAmountKobo,
      paid: paidSql,
      offset: offsetSql,
    })
    .from(purchases)
    .where(and(...where))
    .orderBy(asc(purchases.purchaseDate), asc(purchases.id));

  const out: OpenPurchase[] = rows.map((r) => {
    const paidKobo = Number(r.paid);
    const offsetKobo = Number(r.offset);
    return {
      id: r.id,
      supplierId: r.supplierId,
      purchaseNumber: r.purchaseNumber,
      purchaseDate: r.purchaseDate,
      totalKobo: r.totalKobo,
      paidKobo,
      offsetKobo,
      outstandingKobo: r.totalKobo - paidKobo - offsetKobo,
    };
  });
  return opts.onlyOpen === false ? out : out.filter((p) => p.outstandingKobo > 0);
}

export type PayablesRow = {
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  bands: Record<AgeBand, Kobo>;
  totalKobo: Kobo;
  openPurchases: number;
  oldestDays: number;
};

export type PayablesReport = {
  asOf: string;
  rows: PayablesRow[];
  totals: { bands: Record<AgeBand, Kobo>; totalKobo: Kobo; openPurchases: number };
};

const zeroBands = (): Record<AgeBand, number> => ({ d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

/**
 * Payables ageing: per supplier, what is owed by ageing band (origin =
 * purchase_date, value = outstanding kobo), sorted by total owed desc, plus a
 * totals row.
 */
export async function payablesAgeing(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: Partial<PayablesInput> = {},
): Promise<PayablesReport> {
  const asOf = input.asOf ?? lagosToday();
  const asOfDate = dateOnly(asOf);
  const open = (await listOpenPurchases(dbOrTx, ctx, { supplierId: input.supplierId })).filter(
    (p) => p.purchaseDate <= asOf,
  );

  const bySupplier = new Map<string, OpenPurchase[]>();
  for (const p of open) {
    const list = bySupplier.get(p.supplierId) ?? [];
    list.push(p);
    bySupplier.set(p.supplierId, list);
  }

  const supplierIds = [...bySupplier.keys()];
  const supplierRows =
    supplierIds.length === 0
      ? []
      : await dbOrTx
          .select({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone })
          .from(suppliers)
          .where(and(eq(suppliers.organisationId, ctx.orgId), inArray(suppliers.id, supplierIds)));
  const info = new Map(supplierRows.map((s) => [s.id, s]));

  const rows: PayablesRow[] = [];
  const totals = { bands: zeroBands(), totalKobo: 0, openPurchases: 0 };
  for (const [supplierId, items] of bySupplier) {
    const bands = bucketByAge(
      items,
      (p) => dateOnly(p.purchaseDate),
      (p) => p.outstandingKobo,
      asOfDate,
    );
    const totalKobo = AGE_BANDS.reduce((s, b) => s + bands[b], 0);
    const oldestDays = Math.max(...items.map((p) => ageInDays(asOfDate, dateOnly(p.purchaseDate))));
    const s = info.get(supplierId);
    rows.push({
      supplierId,
      supplierName: s?.name ?? "(unknown supplier)",
      supplierPhone: s?.phone ?? null,
      bands,
      totalKobo,
      openPurchases: items.length,
      oldestDays,
    });
    for (const b of AGE_BANDS) totals.bands[b] += bands[b];
    totals.totalKobo += totalKobo;
    totals.openPurchases += items.length;
  }
  rows.sort((a, b) => b.totalKobo - a.totalKobo || a.supplierName.localeCompare(b.supplierName));
  return { asOf, rows, totals };
}

/** Flat list for the payables UI: every open received purchase with its age. */
export async function listPayables(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: Partial<PayablesInput> = {},
): Promise<Array<OpenPurchase & { supplierName: string; ageDays: number; band: AgeBand }>> {
  const report = await payablesAgeing(dbOrTx, ctx, input);
  const asOfDate = dateOnly(report.asOf);
  const names = new Map(report.rows.map((r) => [r.supplierId, r.supplierName]));
  const open = (await listOpenPurchases(dbOrTx, ctx, { supplierId: input.supplierId })).filter(
    (p) => p.purchaseDate <= report.asOf,
  );
  return open.map((p) => {
    const ageDays = ageInDays(asOfDate, dateOnly(p.purchaseDate));
    const band = ageBand(ageDays);
    return { ...p, supplierName: names.get(p.supplierId) ?? "", ageDays, band };
  });
}

export type AdvanceBalance = {
  id: string;
  supplierId: string;
  advanceNumber: string;
  advanceDate: string;
  amountKobo: Kobo;
  offsetKobo: Kobo;
  outstandingKobo: Kobo;
  note: string | null;
  createdAt: Date;
};

/** Advances with outstanding = amount − Σ supplier_advance_offsets (no status column; derived). */
export async function listAdvanceBalances(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  opts: { supplierId?: string; advanceIds?: string[]; outstandingOnly?: boolean } = {},
): Promise<AdvanceBalance[]> {
  const where: SQL[] = [eq(supplierAdvances.organisationId, ctx.orgId)];
  if (opts.supplierId) where.push(eq(supplierAdvances.supplierId, opts.supplierId));
  if (opts.advanceIds) {
    if (opts.advanceIds.length === 0) return [];
    where.push(inArray(supplierAdvances.id, opts.advanceIds));
  }
  const rows = await dbOrTx
    .select({
      id: supplierAdvances.id,
      supplierId: supplierAdvances.supplierId,
      advanceNumber: supplierAdvances.advanceNumber,
      advanceDate: supplierAdvances.advanceDate,
      amountKobo: supplierAdvances.amountKobo,
      note: supplierAdvances.note,
      createdAt: supplierAdvances.createdAt,
      offset: sql<string>`coalesce((select sum(sao.amount_kobo) from supplier_advance_offsets sao where sao.advance_id = "supplier_advances"."id" and sao.organisation_id = "supplier_advances"."organisation_id"), 0)`,
    })
    .from(supplierAdvances)
    .where(and(...where))
    .orderBy(asc(supplierAdvances.advanceDate), asc(supplierAdvances.advanceNumber));
  const out = rows.map((r) => {
    const offsetKobo = Number(r.offset);
    return {
      id: r.id,
      supplierId: r.supplierId,
      advanceNumber: r.advanceNumber,
      advanceDate: r.advanceDate,
      amountKobo: r.amountKobo,
      offsetKobo,
      outstandingKobo: r.amountKobo - offsetKobo,
      note: r.note,
      createdAt: r.createdAt,
    };
  });
  return opts.outstandingOnly ? out.filter((a) => a.outstandingKobo > 0) : out;
}
