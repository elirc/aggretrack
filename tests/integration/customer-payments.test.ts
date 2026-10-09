import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DbOrTx } from "@/db/client";
import { customerPaymentAllocations, invoices, salesOrders } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { getCustomerDetail, listCustomers } from "@/lib/services/customers";
import { getCustomerPayment, listCustomerPayments, recordCustomerPayment } from "@/lib/services/customerPayments";
import { voidInvoice } from "@/lib/services/invoices";
import { receivablesAgeing } from "@/lib/services/receivables";
import { createCustomer, createTestOrg, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

let seq = 0;
/**
 * Seed an issued invoice directly (payments only care about invoice totals +
 * dates; the dispatch → invoice path is covered in invoices.test.ts).
 */
async function seedInvoice(org: TestOrg, customerId: string, totalKobo: number, invoiceDate: string) {
  const n = ++seq;
  const [so] = await db
    .insert(salesOrders)
    .values({
      organisationId: org.orgId,
      orderNumber: `SO-T-${n}-${org.orgId.slice(0, 4)}`,
      customerId,
      orderDate: invoiceDate,
      status: "completed",
      totalAmountKobo: totalKobo,
    })
    .returning({ id: salesOrders.id });
  const [inv] = await db
    .insert(invoices)
    .values({
      organisationId: org.orgId,
      invoiceNumber: `INV-T-${n}-${org.orgId.slice(0, 4)}`,
      customerId,
      salesOrderId: so.id,
      invoiceDate,
      subtotalKobo: totalKobo,
      totalKobo,
      status: "issued",
    })
    .returning({ id: invoices.id });
  return inv.id;
}

async function statusOf(id: string) {
  const [r] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id));
  return r.status;
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Payments A" });
  B = await createTestOrg(db, { name: "Payments B" });
});

afterAll(async () => {
  await t.close();
});

describe("recordCustomerPayment — FIFO", () => {
  it("pays the oldest invoice_date first, partial on the last, overpay left unallocated", async () => {
    const customerId = await createCustomer(db, A.ctx);
    const other = await createCustomer(db, A.ctx);
    const march = await seedInvoice(A, customerId, 10_000, "2026-03-01");
    const jan = await seedInvoice(A, customerId, 5_000, "2026-01-01");
    const feb = await seedInvoice(A, customerId, 8_000, "2026-02-01");
    const othersInvoice = await seedInvoice(A, other, 7_000, "2025-12-01");

    const first = await recordCustomerPayment(asDb(db), A.ctx, {
      customerId,
      amountKobo: 9_000,
      method: "transfer",
      paymentDate: "2026-03-10",
      reference: "TRX-1",
    });
    expect(first.payment.paymentNumber).toMatch(/^CPM-\d{4}-00001$/);
    expect(first.allocations.map((a) => [a.invoiceId, a.amountKobo])).toEqual([
      [jan, 5_000],
      [feb, 4_000],
    ]);
    expect(first.unallocatedKobo).toBe(0);
    expect(await statusOf(jan)).toBe("paid");
    expect(await statusOf(feb)).toBe("part_paid");
    expect(await statusOf(march)).toBe("issued");
    expect(await statusOf(othersInvoice)).toBe("issued");

    const second = await recordCustomerPayment(asDb(db), A.ctx, {
      customerId,
      amountKobo: 20_000,
      method: "cash",
      paymentDate: "2026-03-11",
    });
    expect(second.payment.paymentNumber).toMatch(/^CPM-\d{4}-00002$/);
    expect(second.allocations.map((a) => [a.invoiceId, a.amountKobo])).toEqual([
      [feb, 4_000],
      [march, 10_000],
    ]);
    expect(second.unallocatedKobo).toBe(6_000);
    expect(await statusOf(feb)).toBe("paid");
    expect(await statusOf(march)).toBe("paid");

    const detail = await getCustomerDetail(asDb(db), A.ctx, { id: customerId });
    expect(detail.balance).toEqual({
      invoicedKobo: 23_000,
      paidKobo: 29_000,
      outstandingKobo: 0,
      unallocatedCreditKobo: 6_000,
      balanceKobo: -6_000,
    });
    expect(detail.invoices).toHaveLength(3);
    expect(detail.payments.map((p) => p.unallocatedKobo).sort()).toEqual([0, 6_000]);

    const pay = await getCustomerPayment(asDb(db), A.ctx, { id: second.payment.id });
    expect(pay.allocatedKobo).toBe(14_000);
    expect(pay.unallocatedKobo).toBe(6_000);
    expect((await listCustomerPayments(asDb(db), A.ctx, { customerId })).total).toBe(2);
  });

  it("a payment with no open invoices is stored fully unallocated", async () => {
    const customerId = await createCustomer(db, A.ctx);
    const res = await recordCustomerPayment(asDb(db), A.ctx, {
      customerId,
      amountKobo: 1_234,
      method: "pos",
      paymentDate: "2026-03-01",
    });
    expect(res.allocations).toHaveLength(0);
    expect(res.unallocatedKobo).toBe(1_234);
  });

  it("void invoices are skipped", async () => {
    const customerId = await createCustomer(db, A.ctx);
    const voidMe = await seedInvoice(A, customerId, 5_000, "2026-01-01");
    const live = await seedInvoice(A, customerId, 5_000, "2026-02-01");
    await voidInvoice(asDb(db), A.ctx, { id: voidMe });
    const res = await recordCustomerPayment(asDb(db), A.ctx, {
      customerId,
      amountKobo: 3_000,
      method: "cash",
      paymentDate: "2026-03-01",
    });
    expect(res.allocations.map((a) => a.invoiceId)).toEqual([live]);
    expect(await statusOf(voidMe)).toBe("void");
    expect(await statusOf(live)).toBe("part_paid");
  });
});

describe("recordCustomerPayment — manual", () => {
  it("allocates to the picked invoices and validates limits", async () => {
    const customerId = await createCustomer(db, A.ctx);
    const old = await seedInvoice(A, customerId, 5_000, "2026-01-01");
    const newer = await seedInvoice(A, customerId, 8_000, "2026-02-01");
    const foreignCustomer = await createCustomer(db, A.ctx);
    const foreign = await seedInvoice(A, foreignCustomer, 1_000, "2026-01-01");

    await expectCode(
      recordCustomerPayment(asDb(db), A.ctx, {
        customerId,
        amountKobo: 10_000,
        method: "cash",
        paymentDate: "2026-03-01",
        allocations: [{ invoiceId: newer, amountKobo: 8_001 }],
      }),
      "PAYMENT_ALLOCATION_INVALID",
    );
    await expectCode(
      recordCustomerPayment(asDb(db), A.ctx, {
        customerId,
        amountKobo: 1_000,
        method: "cash",
        paymentDate: "2026-03-01",
        allocations: [{ invoiceId: newer, amountKobo: 2_000 }],
      }),
      "PAYMENT_ALLOCATION_INVALID",
    );
    await expectCode(
      recordCustomerPayment(asDb(db), A.ctx, {
        customerId,
        amountKobo: 1_000,
        method: "cash",
        paymentDate: "2026-03-01",
        allocations: [{ invoiceId: foreign, amountKobo: 1_000 }],
      }),
      "PAYMENT_ALLOCATION_INVALID",
    );
    // nothing was written by the failures
    expect(await db.select().from(customerPaymentAllocations).where(eq(customerPaymentAllocations.invoiceId, newer))).toHaveLength(0);

    const res = await recordCustomerPayment(asDb(db), A.ctx, {
      customerId,
      amountKobo: 10_000,
      method: "transfer",
      paymentDate: "2026-03-01",
      allocations: [{ invoiceId: newer, amountKobo: 8_000 }],
    });
    expect(res.allocations.map((a) => [a.invoiceId, a.amountKobo])).toEqual([[newer, 8_000]]);
    expect(res.unallocatedKobo).toBe(2_000);
    expect(await statusOf(newer)).toBe("paid");
    expect(await statusOf(old)).toBe("issued");
  });

  it("another organisation cannot pay into this customer", async () => {
    const customerId = await createCustomer(db, A.ctx);
    await expectCode(
      recordCustomerPayment(asDb(db), B.ctx, { customerId, amountKobo: 100, method: "cash", paymentDate: "2026-03-01" }),
      "NOT_FOUND",
    );
    await expectCode(getCustomerDetail(asDb(db), B.ctx, { id: customerId }), "NOT_FOUND");
  });
});

describe("receivables ageing", () => {
  it("buckets outstanding by invoice_date and totals per customer", async () => {
    const C = await createTestOrg(db, { name: "Ageing Org" });
    const c1 = await createCustomer(db, C.ctx, { name: "Alpha Foods" });
    const c2 = await createCustomer(db, C.ctx, { name: "Beta Mills" });
    // asOf 2026-06-30
    await seedInvoice(C, c1, 1_000, "2026-06-30"); // 0 d
    await seedInvoice(C, c1, 2_000, "2026-05-31"); // 30 d → d0_30
    await seedInvoice(C, c1, 3_000, "2026-05-30"); // 31 d → d31_60
    const partly = await seedInvoice(C, c2, 4_000, "2026-03-31"); // 91 d → d90_plus
    await seedInvoice(C, c2, 5_000, "2026-04-01"); // 90 d → d61_90
    await recordCustomerPayment(asDb(db), C.ctx, {
      customerId: c2,
      amountKobo: 1_500,
      method: "cash",
      paymentDate: "2026-06-01",
      allocations: [{ invoiceId: partly, amountKobo: 1_500 }],
    });

    const r = await receivablesAgeing(asDb(db), C.ctx, { asOf: "2026-06-30" });
    expect(r.rows.map((x) => x.customerName)).toEqual(["Beta Mills", "Alpha Foods"]);
    const alpha = r.rows.find((x) => x.customerId === c1)!;
    const beta = r.rows.find((x) => x.customerId === c2)!;
    expect(alpha.buckets).toEqual({ d0_30: 3_000, d31_60: 3_000, d61_90: 0, d90_plus: 0 });
    expect(alpha.totalOutstandingKobo).toBe(6_000);
    expect(beta.buckets).toEqual({ d0_30: 0, d31_60: 0, d61_90: 5_000, d90_plus: 2_500 });
    expect(r.totals).toEqual({ d0_30: 3_000, d31_60: 3_000, d61_90: 5_000, d90_plus: 2_500, total: 13_500 });

    const list = await listCustomers(asDb(db), C.ctx, { search: "alpha" });
    expect(list.rows.map((x) => [x.name, x.outstandingKobo])).toEqual([["Alpha Foods", 6_000]]);
    expect((await receivablesAgeing(asDb(db), B.ctx, { asOf: "2026-06-30" })).rows).toHaveLength(0);
  });
});
