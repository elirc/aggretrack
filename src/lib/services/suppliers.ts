import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  buyingPoints,
  purchaseLineDeductions,
  purchaseLines,
  purchases,
  supplierAdvanceOffsets,
  supplierAdvances,
  supplierPayments,
  suppliers,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { can, type Permission } from "@/lib/authz/permissions";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams, type Grams, type Kobo } from "@/lib/domain/units";
import { QUEUES, type JobPayloads, type QueueName } from "@/lib/jobs";
import type { SupplierInput, SupplierListInput, SupplierUpdateInput } from "@/lib/validation/buying";

import { listAdvanceBalances, listOpenPurchases, type AdvanceBalance, type OpenPurchase } from "./payables";

/**
 * Suppliers service (P2-A) + the buying module's shared helpers.
 *
 * Every function takes (db-or-tx, ctx, input) and scopes by ctx.orgId — never
 * from input. Foreign-org ids behave exactly like missing ids (NOT_FOUND).
 * Every mutation runs in ONE transaction (savepoint when nested) with an
 * audit row. No "server-only" import: exercised by integration tests.
 */

// ════════════════════════════════════════════════════════════════════════════
// Shared buying-module helpers (used by priceGuides, purchases, receiving,
// advances, supplierPayments). Kept here so the module graph stays acyclic:
// payables (leaf) ← suppliers ← priceGuides ← purchases ← receiving.
// ════════════════════════════════════════════════════════════════════════════

/** Postgres SQLSTATE from a pg error, possibly wrapped by DrizzleQueryError. */
export function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function mapDbError(err: unknown): unknown {
  if (err instanceof DomainError) return err;
  const code = pgCode(err);
  if (code === "23505") return new DomainError("DUPLICATE", "That record already exists");
  if (code === "23503") return new DomainError("IN_USE", "This record is in use and cannot be removed");
  return err;
}

/** Run a mutation in ONE transaction (savepoint when already inside one). */
export async function inTx<T>(dbOrTx: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await (dbOrTx as Tx).transaction(fn);
  } catch (err) {
    throw mapDbError(err);
  }
}

export function notFound(what: string): never {
  throw new DomainError("NOT_FOUND", `${what} not found`);
}

/** Defence in depth on top of the orgAction guard. */
export function assertCan(ctx: OrgContext, permission: Permission): void {
  if (!can(ctx.role, permission)) {
    throw new DomainError("FORBIDDEN", `Role ${ctx.role} lacks ${permission}`);
  }
}

export function assertWritable(ctx: OrgContext): void {
  if (ctx.readOnly) throw new DomainError("READ_ONLY");
}

/** Procurement restricted to own buying points: null restriction = all allowed. */
export function assertBuyingPointAllowed(ctx: OrgContext, buyingPointId: string | null): void {
  const allowed = ctx.restrictions.buyingPointIds;
  if (allowed === null) return;
  if (!buyingPointId || !allowed.includes(buyingPointId)) {
    throw new DomainError("FORBIDDEN", "You are not assigned to this buying point");
  }
}

export function assertWarehouseAllowed(ctx: OrgContext, warehouseId: string): void {
  const allowed = ctx.restrictions.warehouseIds;
  if (allowed === null) return;
  if (!allowed.includes(warehouseId)) {
    throw new DomainError("FORBIDDEN", "You are not assigned to this warehouse");
  }
}

/** First row of a raw tx.execute() result (node-postgres returns { rows }). */
export function execRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

/**
 * A background job produced by a mutation. Services RETURN these instead of
 * enqueueing inside the transaction (pg-boss uses its own connection, so an
 * in-tx send would fire even if the tx rolls back). The caller enqueues after
 * commit with `enqueuePendingJobs`.
 */
export type PendingJob = {
  [K in QueueName]: { name: K; data: JobPayloads[K] };
}[QueueName];

/**
 * Enqueue jobs after the creating transaction committed. Best-effort: a queue
 * outage must not fail the already-committed business write (documents can be
 * regenerated). pg-boss is imported lazily so service modules stay loadable in
 * tests without a queue.
 */
export async function enqueuePendingJobs(jobs: PendingJob[]): Promise<void> {
  if (jobs.length === 0) return;
  try {
    const { enqueue } = await import("../../../worker/boss");
    for (const job of jobs) {
      await enqueue(job.name, job.data, { retryLimit: 3, retryBackoff: true });
    }
  } catch (err) {
    console.error("[buying] enqueue failed", err);
  }
}

export { QUEUES };

export async function getSupplierRow(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<Supplier> {
  const [row] = await dbOrTx
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.organisationId, ctx.orgId), eq(suppliers.id, id)))
    .limit(1);
  return row ?? notFound("Supplier");
}

// ════════════════════════════════════════════════════════════════════════════
// Suppliers CRUD
// ════════════════════════════════════════════════════════════════════════════

export type Supplier = typeof suppliers.$inferSelect;

export type SupplierBalance = {
  /** Σ received purchases − Σ payment allocations to purchases − Σ advance offsets. */
  owedToSupplierKobo: Kobo;
  /** Σ advances − Σ advance offsets. */
  owedBySupplierKobo: Kobo;
  /** Payments not allocated to anything (credit in the supplier's favour of ours). */
  unallocatedPaymentsKobo: Kobo;
  /** owedTo − owedBy − unallocated: > 0 we owe the supplier, < 0 the supplier owes us. */
  netKobo: Kobo;
};

const zeroBalance = (): SupplierBalance => ({
  owedToSupplierKobo: 0,
  owedBySupplierKobo: 0,
  unallocatedPaymentsKobo: 0,
  netKobo: 0,
});

function supplierValues(input: SupplierInput) {
  return {
    type: input.type,
    name: input.name,
    phone: input.phone,
    village: input.village,
    lga: input.lga,
    state: input.state,
    bankName: input.bankName,
    bankAccountNumber: input.bankAccountNumber,
    bankAccountName: input.bankAccountName,
    idNote: input.idNote,
    photoKey: input.photoKey,
  };
}

export async function createSupplier(dbOrTx: DbOrTx, ctx: OrgContext, input: SupplierInput): Promise<Supplier> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    const [row] = await tx
      .insert(suppliers)
      .values({ organisationId: ctx.orgId, ...supplierValues(input), createdBy: ctx.userId })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "suppliers", recordId: row.id, after: row });
    return row;
  });
}

export async function updateSupplier(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: SupplierUpdateInput,
): Promise<Supplier> {
  assertWritable(ctx);
  return inTx(dbOrTx, async (tx) => {
    const [before] = await tx
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.organisationId, ctx.orgId), eq(suppliers.id, input.id)))
      .for("update");
    if (!before) notFound("Supplier");
    const [after] = await tx
      .update(suppliers)
      .set({ ...supplierValues(input), updatedAt: new Date() })
      .where(and(eq(suppliers.organisationId, ctx.orgId), eq(suppliers.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "suppliers", recordId: after.id, before, after });
    return after;
  });
}

/** Remove a supplier only while unreferenced (no purchases/advances/payments) — else IN_USE. */
export async function deleteSupplier(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  assertWritable(ctx);
  await inTx(dbOrTx, async (tx) => {
    const before = await getSupplierRow(tx, ctx, id);
    await tx.delete(suppliers).where(and(eq(suppliers.organisationId, ctx.orgId), eq(suppliers.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "suppliers", recordId: id, before });
  });
}

export async function getSupplier(dbOrTx: DbOrTx, ctx: OrgContext, id: string): Promise<Supplier> {
  return getSupplierRow(dbOrTx, ctx, id);
}

/**
 * Balance both ways per supplier (DATA-MODEL formula). Pass ids to limit;
 * omit for every supplier with activity. Suppliers without activity are
 * absent from the map (treat as zero).
 */
export async function supplierBalances(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  supplierIds?: string[],
): Promise<Map<string, SupplierBalance>> {
  const out = new Map<string, SupplierBalance>();
  if (supplierIds && supplierIds.length === 0) return out;
  const get = (id: string) => {
    let b = out.get(id);
    if (!b) {
      b = zeroBalance();
      out.set(id, b);
    }
    return b;
  };
  const supplierFilter = (col: typeof purchases.supplierId | typeof supplierAdvances.supplierId | typeof supplierPayments.supplierId) =>
    supplierIds ? [inArray(col, supplierIds)] : [];

  // Received purchase totals
  const received = await dbOrTx
    .select({ supplierId: purchases.supplierId, total: sql<string>`coalesce(sum(${purchases.totalAmountKobo}), 0)` })
    .from(purchases)
    .where(and(eq(purchases.organisationId, ctx.orgId), eq(purchases.status, "received"), ...supplierFilter(purchases.supplierId)))
    .groupBy(purchases.supplierId);
  for (const r of received) get(r.supplierId).owedToSupplierKobo += Number(r.total);

  // Payments + their allocations
  const pays = await dbOrTx
    .select({
      supplierId: supplierPayments.supplierId,
      total: sql<string>`coalesce(sum(${supplierPayments.amountKobo}), 0)`,
      allocated: sql<string>`coalesce(sum((select coalesce(sum(a.amount_kobo), 0) from supplier_payment_allocations a where a.payment_id = "supplier_payments"."id")), 0)`,
      toPurchases: sql<string>`coalesce(sum((select coalesce(sum(a.amount_kobo), 0) from supplier_payment_allocations a where a.payment_id = "supplier_payments"."id" and a.purchase_id is not null)), 0)`,
    })
    .from(supplierPayments)
    .where(and(eq(supplierPayments.organisationId, ctx.orgId), ...supplierFilter(supplierPayments.supplierId)))
    .groupBy(supplierPayments.supplierId);
  for (const r of pays) {
    const b = get(r.supplierId);
    b.owedToSupplierKobo -= Number(r.toPurchases);
    b.unallocatedPaymentsKobo += Number(r.total) - Number(r.allocated);
  }

  // Advances + offsets
  const advs = await dbOrTx
    .select({
      supplierId: supplierAdvances.supplierId,
      total: sql<string>`coalesce(sum(${supplierAdvances.amountKobo}), 0)`,
      offsets: sql<string>`coalesce(sum((select coalesce(sum(o.amount_kobo), 0) from supplier_advance_offsets o where o.advance_id = "supplier_advances"."id")), 0)`,
    })
    .from(supplierAdvances)
    .where(and(eq(supplierAdvances.organisationId, ctx.orgId), ...supplierFilter(supplierAdvances.supplierId)))
    .groupBy(supplierAdvances.supplierId);
  for (const r of advs) {
    const b = get(r.supplierId);
    const offsets = Number(r.offsets);
    b.owedBySupplierKobo += Number(r.total) - offsets;
    b.owedToSupplierKobo -= offsets;
  }

  for (const b of out.values()) {
    b.netKobo = b.owedToSupplierKobo - b.owedBySupplierKobo - b.unallocatedPaymentsKobo;
  }
  return out;
}

export async function getSupplierBalance(dbOrTx: DbOrTx, ctx: OrgContext, supplierId: string): Promise<SupplierBalance> {
  await getSupplierRow(dbOrTx, ctx, supplierId);
  return (await supplierBalances(dbOrTx, ctx, [supplierId])).get(supplierId) ?? zeroBalance();
}

export type SupplierListRow = Supplier & { balance: SupplierBalance };

/**
 * Supplier list. Procurement officers see the full list even when restricted
 * to buying points — the restriction applies to purchases, not supplier CRUD.
 */
export async function listSuppliers(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
  input: Partial<SupplierListInput> = {},
): Promise<{ rows: SupplierListRow[]; total: number; page: number; pageSize: number }> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 50;
  const where: SQL[] = [eq(suppliers.organisationId, ctx.orgId)];
  if (input.type) where.push(eq(suppliers.type, input.type));
  if (input.q) {
    const like = `%${input.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(suppliers.name, like), ilike(suppliers.phone, like), ilike(suppliers.village, like))!);
  }
  const [{ n }] = await dbOrTx
    .select({ n: sql<string>`count(*)` })
    .from(suppliers)
    .where(and(...where));
  const rows = await dbOrTx
    .select()
    .from(suppliers)
    .where(and(...where))
    .orderBy(asc(suppliers.name), asc(suppliers.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const balances = await supplierBalances(
    dbOrTx,
    ctx,
    rows.map((r) => r.id),
  );
  return {
    rows: rows.map((r) => ({ ...r, balance: balances.get(r.id) ?? zeroBalance() })),
    total: Number(n),
    page,
    pageSize,
  };
}

/** Compact picker list for the purchase quick-entry form (and offline refData cache). */
export async function listSupplierOptions(
  dbOrTx: DbOrTx,
  ctx: OrgContext,
): Promise<Array<{ id: string; name: string; phone: string | null; village: string | null; type: Supplier["type"] }>> {
  return dbOrTx
    .select({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone, village: suppliers.village, type: suppliers.type })
    .from(suppliers)
    .where(eq(suppliers.organisationId, ctx.orgId))
    .orderBy(asc(suppliers.name));
}

// ════════════════════════════════════════════════════════════════════════════
// Supplier detail aggregate
// ════════════════════════════════════════════════════════════════════════════

export type SupplierPurchaseRow = {
  id: string;
  purchaseNumber: string | null;
  purchaseDate: string;
  status: (typeof purchases.$inferSelect)["status"];
  buyingPointId: string | null;
  buyingPointName: string | null;
  totalAmountKobo: Kobo | null;
  netKg: string;
  grnNumber: string | null;
};

export type DeductionPeriodRow = {
  /** "yyyy-mm" of the purchase date */
  period: string;
  reason: (typeof purchaseLineDeductions.$inferSelect)["reason"];
  kg: string;
};

export type SupplierPaymentRow = {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  amountKobo: Kobo;
  method: (typeof supplierPayments.$inferSelect)["method"];
  reference: string | null;
  allocatedKobo: Kobo;
  unallocatedKobo: Kobo;
};

export type SupplierDetail = {
  supplier: Supplier;
  balance: SupplierBalance;
  purchases: SupplierPurchaseRow[];
  deductions: {
    byPeriod: DeductionPeriodRow[];
    byReason: Array<{ reason: DeductionPeriodRow["reason"]; kg: string }>;
    /** Σ gross kg of the same purchases — lets the UI show deduction % */
    grossKg: string;
  };
  advances: AdvanceBalance[];
  payments: SupplierPaymentRow[];
  openPurchases: OpenPurchase[];
};

export async function getSupplierDetail(dbOrTx: DbOrTx, ctx: OrgContext, supplierId: string): Promise<SupplierDetail> {
  const supplier = await getSupplierRow(dbOrTx, ctx, supplierId);
  const hide = ctx.restrictions.hidePrices;

  // Purchase history — restricted to the caller's buying points when restricted.
  const pWhere: SQL[] = [eq(purchases.organisationId, ctx.orgId), eq(purchases.supplierId, supplierId)];
  const bpIds = ctx.restrictions.buyingPointIds;
  if (bpIds !== null) {
    if (bpIds.length === 0) pWhere.push(sql`false`);
    else pWhere.push(inArray(purchases.buyingPointId, bpIds));
  }
  const history = await dbOrTx
    .select({
      id: purchases.id,
      purchaseNumber: purchases.purchaseNumber,
      purchaseDate: purchases.purchaseDate,
      status: purchases.status,
      buyingPointId: purchases.buyingPointId,
      buyingPointName: buyingPoints.name,
      totalAmountKobo: purchases.totalAmountKobo,
      grnNumber: purchases.grnNumber,
      netKg: sql<string>`coalesce((select sum(pl.net_kg) from purchase_lines pl where pl.purchase_id = "purchases"."id"), 0)`,
    })
    .from(purchases)
    .leftJoin(buyingPoints, eq(buyingPoints.id, purchases.buyingPointId))
    .where(and(...pWhere))
    .orderBy(desc(purchases.purchaseDate), desc(purchases.createdAt));

  // Quality deductions over time (non-cancelled purchases)
  const dWhere = and(
    eq(purchases.organisationId, ctx.orgId),
    eq(purchases.supplierId, supplierId),
    ne(purchases.status, "cancelled"),
  );
  const period = sql<string>`to_char(${purchases.purchaseDate}, 'YYYY-MM')`;
  const byPeriodRaw = await dbOrTx
    .select({
      period,
      reason: purchaseLineDeductions.reason,
      kg: sql<string>`coalesce(sum(${purchaseLineDeductions.kg}), 0)`,
    })
    .from(purchaseLineDeductions)
    .innerJoin(purchaseLines, eq(purchaseLines.id, purchaseLineDeductions.purchaseLineId))
    .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
    .where(dWhere)
    .groupBy(period, purchaseLineDeductions.reason)
    .orderBy(period, purchaseLineDeductions.reason);
  const byPeriod = byPeriodRaw.map((r) => ({ period: r.period, reason: r.reason, kg: gramsToKg(kgToGrams(r.kg)) }));
  const reasonTotals = new Map<DeductionPeriodRow["reason"], Grams>();
  for (const r of byPeriod) reasonTotals.set(r.reason, (reasonTotals.get(r.reason) ?? 0) + kgToGrams(r.kg));
  const [gross] = await dbOrTx
    .select({ kg: sql<string>`coalesce(sum(${purchaseLines.grossKg}), 0)` })
    .from(purchaseLines)
    .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
    .where(dWhere);

  const advances = await listAdvanceBalances(dbOrTx, ctx, { supplierId });

  const payRows = await dbOrTx
    .select({
      id: supplierPayments.id,
      paymentNumber: supplierPayments.paymentNumber,
      paymentDate: supplierPayments.paymentDate,
      amountKobo: supplierPayments.amountKobo,
      method: supplierPayments.method,
      reference: supplierPayments.reference,
      allocated: sql<string>`coalesce((select sum(a.amount_kobo) from supplier_payment_allocations a where a.payment_id = "supplier_payments"."id"), 0)`,
    })
    .from(supplierPayments)
    .where(and(eq(supplierPayments.organisationId, ctx.orgId), eq(supplierPayments.supplierId, supplierId)))
    .orderBy(desc(supplierPayments.paymentDate), desc(supplierPayments.paymentNumber));

  return {
    supplier,
    balance: await getSupplierBalance(dbOrTx, ctx, supplierId),
    purchases: history.map((h) => ({
      ...h,
      totalAmountKobo: hide ? null : h.totalAmountKobo,
      netKg: gramsToKg(kgToGrams(h.netKg)),
    })),
    deductions: {
      byPeriod,
      byReason: [...reasonTotals.entries()].map(([reason, g]) => ({ reason, kg: gramsToKg(g) })),
      grossKg: gramsToKg(kgToGrams(gross?.kg ?? "0")),
    },
    advances,
    payments: payRows.map((p) => ({
      id: p.id,
      paymentNumber: p.paymentNumber,
      paymentDate: p.paymentDate,
      amountKobo: p.amountKobo,
      method: p.method,
      reference: p.reference,
      allocatedKobo: Number(p.allocated),
      unallocatedKobo: p.amountKobo - Number(p.allocated),
    })),
    openPurchases: await listOpenPurchases(dbOrTx, ctx, { supplierId }),
  };
}

/** Advance-offset rows for a supplier's purchases (statement/detail helpers). */
export async function listAdvanceOffsetsForSupplier(dbOrTx: DbOrTx, ctx: OrgContext, supplierId: string) {
  return dbOrTx
    .select({
      id: supplierAdvanceOffsets.id,
      advanceId: supplierAdvanceOffsets.advanceId,
      advanceNumber: supplierAdvances.advanceNumber,
      purchaseId: supplierAdvanceOffsets.purchaseId,
      amountKobo: supplierAdvanceOffsets.amountKobo,
      createdAt: supplierAdvanceOffsets.createdAt,
    })
    .from(supplierAdvanceOffsets)
    .innerJoin(supplierAdvances, eq(supplierAdvances.id, supplierAdvanceOffsets.advanceId))
    .where(and(eq(supplierAdvanceOffsets.organisationId, ctx.orgId), eq(supplierAdvances.supplierId, supplierId)))
    .orderBy(asc(supplierAdvanceOffsets.createdAt));
}
