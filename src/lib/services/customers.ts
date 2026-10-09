import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { customerPaymentAllocations, customerPayments, customers, invoices } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import type { Kobo } from "@/lib/domain/units";
import { paidByInvoice } from "@/lib/services/invoices";
import { notFound, runTx } from "@/lib/services/salesOrders";

/** Customers (P2-C): CRUD + detail aggregate (invoices w/ outstanding, payments, balance). */

export type Customer = typeof customers.$inferSelect;

export type CustomerFields = {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  state?: string | null;
  note?: string | null;
};

function fields(input: CustomerFields) {
  return {
    name: input.name.trim(),
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    state: input.state ?? null,
    note: input.note ?? null,
  };
}

export async function createCustomer(db: DbOrTx, ctx: OrgContext, input: CustomerFields): Promise<Customer> {
  return runTx(db, async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({ organisationId: ctx.orgId, ...fields(input), createdBy: ctx.userId })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "customers", recordId: row.id, after: row });
    return row;
  });
}

export async function updateCustomer(
  db: DbOrTx,
  ctx: OrgContext,
  input: CustomerFields & { id: string },
): Promise<Customer> {
  return runTx(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, input.id), eq(customers.organisationId, ctx.orgId)))
      .for("update");
    if (!before) notFound("Customer");
    const [after] = await tx
      .update(customers)
      .set({ ...fields(input), updatedAt: new Date() })
      .where(and(eq(customers.id, before.id), eq(customers.organisationId, ctx.orgId)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "customers", recordId: after.id, before, after });
    return after;
  });
}

export async function getCustomer(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<Customer> {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, input.id), eq(customers.organisationId, ctx.orgId)));
  if (!row) notFound("Customer");
  return row;
}

export type CustomerListRow = Customer & { outstandingKobo: Kobo };

export async function listCustomers(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { search?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: CustomerListRow[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;
  const where: SQL[] = [eq(customers.organisationId, ctx.orgId)];
  if (opts.search) {
    const q = `%${opts.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(customers.name, q), ilike(customers.phone, q))!);
  }
  const rows = await db
    .select()
    .from(customers)
    .where(and(...where))
    .orderBy(asc(customers.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [c] = await db.select({ n: count() }).from(customers).where(and(...where));

  // Outstanding per customer = Σ open invoice totals − Σ allocations to them.
  const ids = rows.map((r) => r.id);
  const outstanding = new Map<string, Kobo>();
  if (ids.length > 0) {
    const inv = await db
      .select({ id: invoices.id, customerId: invoices.customerId, totalKobo: invoices.totalKobo })
      .from(invoices)
      .where(
        and(
          eq(invoices.organisationId, ctx.orgId),
          inArray(invoices.customerId, ids),
          ne(invoices.status, "void"),
        ),
      );
    const paid = await paidByInvoice(
      db,
      ctx,
      inv.map((i) => i.id),
    );
    for (const i of inv) {
      outstanding.set(i.customerId, (outstanding.get(i.customerId) ?? 0) + i.totalKobo - (paid.get(i.id) ?? 0));
    }
  }
  return { rows: rows.map((r) => ({ ...r, outstandingKobo: outstanding.get(r.id) ?? 0 })), total: c?.n ?? 0 };
}

export type CustomerDetail = Customer & {
  invoices: {
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string | null;
    status: (typeof invoices.$inferSelect)["status"];
    totalKobo: Kobo;
    paidKobo: Kobo;
    outstandingKobo: Kobo;
  }[];
  payments: {
    id: string;
    paymentNumber: string;
    paymentDate: string;
    method: (typeof customerPayments.$inferSelect)["method"];
    amountKobo: Kobo;
    allocatedKobo: Kobo;
    unallocatedKobo: Kobo;
  }[];
  balance: {
    /** Σ non-void invoice totals */
    invoicedKobo: Kobo;
    /** Σ payments received */
    paidKobo: Kobo;
    /** Σ outstanding on open invoices */
    outstandingKobo: Kobo;
    /** Σ unallocated payment amounts (credit on account) */
    unallocatedCreditKobo: Kobo;
    /** invoiced − paid: positive = customer owes us; negative = we hold credit */
    balanceKobo: Kobo;
  };
};

export async function getCustomerDetail(db: DbOrTx, ctx: OrgContext, input: { id: string }): Promise<CustomerDetail> {
  const customer = await getCustomer(db, ctx, input);
  const inv = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      status: invoices.status,
      totalKobo: invoices.totalKobo,
    })
    .from(invoices)
    .where(and(eq(invoices.organisationId, ctx.orgId), eq(invoices.customerId, customer.id)))
    .orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt));
  const paid = await paidByInvoice(
    db,
    ctx,
    inv.map((i) => i.id),
  );
  const invoiceRows = inv.map((i) => {
    const p = paid.get(i.id) ?? 0;
    return { ...i, paidKobo: p, outstandingKobo: i.status === "void" ? 0 : i.totalKobo - p };
  });

  const pays = await db
    .select({
      id: customerPayments.id,
      paymentNumber: customerPayments.paymentNumber,
      paymentDate: customerPayments.paymentDate,
      method: customerPayments.method,
      amountKobo: customerPayments.amountKobo,
    })
    .from(customerPayments)
    .where(and(eq(customerPayments.organisationId, ctx.orgId), eq(customerPayments.customerId, customer.id)))
    .orderBy(desc(customerPayments.paymentDate), desc(customerPayments.createdAt));
  const allocated = new Map<string, Kobo>();
  if (pays.length > 0) {
    const sums = await db
      .select({
        paymentId: customerPaymentAllocations.paymentId,
        total: sql<string>`coalesce(sum(${customerPaymentAllocations.amountKobo}), 0)`,
      })
      .from(customerPaymentAllocations)
      .where(
        and(
          eq(customerPaymentAllocations.organisationId, ctx.orgId),
          inArray(
            customerPaymentAllocations.paymentId,
            pays.map((p) => p.id),
          ),
        ),
      )
      .groupBy(customerPaymentAllocations.paymentId);
    for (const r of sums) allocated.set(r.paymentId, Number(r.total));
  }
  const paymentRows = pays.map((p) => {
    const a = allocated.get(p.id) ?? 0;
    return { ...p, allocatedKobo: a, unallocatedKobo: p.amountKobo - a };
  });

  const invoicedKobo = invoiceRows.filter((i) => i.status !== "void").reduce((s, i) => s + i.totalKobo, 0);
  const paidKobo = paymentRows.reduce((s, p) => s + p.amountKobo, 0);
  return {
    ...customer,
    invoices: invoiceRows,
    payments: paymentRows,
    balance: {
      invoicedKobo,
      paidKobo,
      outstandingKobo: invoiceRows.reduce((s, i) => s + i.outstandingKobo, 0),
      unallocatedCreditKobo: paymentRows.reduce((s, p) => s + p.unallocatedKobo, 0),
      balanceKobo: invoicedKobo - paidKobo,
    },
  };
}
