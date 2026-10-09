import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DbOrTx } from "@/db/client";
import { grades, invoices, lots, organisationSettings, purchaseLines, purchases } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { QUEUES } from "@/lib/jobs";
import { reserveForSalesLine } from "@/lib/services/allocation";
import { recordCustomerPayment } from "@/lib/services/customerPayments";
import { createDispatch } from "@/lib/services/dispatches";
import {
  computeTaxKobo,
  createInvoiceFromDispatch,
  getInvoice,
  listInvoices,
  voidInvoice,
} from "@/lib/services/invoices";
import { confirmSalesOrder, createSalesOrder } from "@/lib/services/salesOrders";
import { postMovements } from "@/lib/services/stockCore";
import {
  createCustomer,
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let md: TestMasterData;
let supplierId: string;
let customerId: string;

const jobs: { queue: string; data: object }[] = [];
const deps = {
  enqueue: async (queue: string, data: object) => {
    jobs.push({ queue, data });
    return null;
  },
};

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

let seq = 0;
async function seedLot(opts: { kg: string; receivedAt: Date; gradeId: string }) {
  const n = ++seq;
  const [p] = await db
    .insert(purchases)
    .values({ organisationId: A.orgId, supplierId, officerId: A.userId, purchaseDate: "2026-01-01", status: "received" })
    .returning({ id: purchases.id });
  const [pl] = await db
    .insert(purchaseLines)
    .values({
      purchaseId: p.id,
      organisationId: A.orgId,
      commodityId: md.commodityId,
      gradeId: opts.gradeId,
      grossKg: opts.kg,
      netKg: opts.kg,
      pricePerKgKobo: 20_000,
      amountKobo: 0,
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: A.orgId,
      lotNumber: `LOT-IV-${n}-${randomUUID().slice(0, 6)}`,
      commodityId: md.commodityId,
      gradeId: opts.gradeId,
      supplierId,
      purchaseLineId: pl.id,
      receivedAt: opts.receivedAt,
      originalKg: opts.kg,
      purchasePricePerKgKobo: 20_000,
      landedCostPerKgKobo: "20000",
    })
    .returning({ id: lots.id });
  await asDb(db).transaction((tx) =>
    postMovements(tx, A.ctx, [
      {
        lotId: lot.id,
        warehouseId: md.warehouseId,
        type: "receive",
        grams: kgToGrams(opts.kg),
        bags: 0,
        refType: "grn",
        refId: p.id,
      },
    ]),
  );
  return lot.id;
}

async function newGrade(): Promise<string> {
  const n = ++seq;
  const [g] = await db
    .insert(grades)
    .values({ organisationId: A.orgId, commodityId: md.commodityId, name: `IG-${n}`, code: `IG${n}` })
    .returning({ id: grades.id });
  return g.id;
}

/** Lots → confirmed order (one line) → FIFO reserve → dispatch everything. */
async function dispatched(lotKgs: string[], lineKg: string, pricePerKgKobo: number) {
  const gradeId = await newGrade();
  for (let i = 0; i < lotKgs.length; i++) {
    await seedLot({ kg: lotKgs[i], receivedAt: new Date(Date.UTC(2026, 0, 1 + i)), gradeId });
  }
  const order = await createSalesOrder(asDb(db), A.ctx, {
    customerId,
    orderDate: "2026-02-01",
    lines: [{ commodityId: md.commodityId, gradeId, kg: lineKg, pricePerKgKobo }],
  });
  await confirmSalesOrder(asDb(db), A.ctx, { id: order.id });
  const allocs = await reserveForSalesLine(asDb(db), A.ctx, { salesLineId: order.lines[0].id, mode: "fifo" });
  const { dispatch } = await createDispatch(
    asDb(db),
    A.ctx,
    { salesOrderId: order.id, allocationIds: allocs.map((a) => a.id) },
    deps,
  );
  return { order, dispatch };
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Invoice A" });
  B = await createTestOrg(db, { name: "Invoice B" });
  md = await createMasterData(db, A.ctx);
  supplierId = await createSupplier(db, A.ctx);
  customerId = await createCustomer(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("createInvoiceFromDispatch", () => {
  it("subtotal = Σ dispatch-line grams × line price, half-up per line; tax off by default", async () => {
    jobs.length = 0;
    // Two lots split the 100 kg line: 33.333 kg + 66.667 kg at ₦305.55/kg.
    const { order, dispatch } = await dispatched(["33.333", "70"], "100", 30_555);
    const inv = await createInvoiceFromDispatch(
      asDb(db),
      A.ctx,
      { dispatchId: dispatch.id, invoiceDate: "2026-02-03", dueDate: "2026-03-05" },
      deps,
    );
    // 33333 × 30555 / 1000 = 1,018,489.815 → 1,018,490 ; 66667 × 30555 / 1000 = 2,037,009.685 → 2,037,010
    expect(inv.subtotalKobo).toBe(1_018_490 + 2_037_010);
    expect(inv.taxKobo).toBe(0);
    expect(Number(inv.taxPercent)).toBe(0);
    expect(inv.totalKobo).toBe(3_055_500);
    expect(inv.status).toBe("issued");
    expect(inv.invoiceNumber).toMatch(/^INV-\d{4}-00001$/);
    expect(inv.customerId).toBe(customerId);
    expect(inv.salesOrderId).toBe(order.id);
    expect(inv.dueDate).toBe("2026-03-05");
    expect(jobs.filter((j) => (j.data as { kind: string }).kind === "invoice")).toEqual([
      { queue: QUEUES.DOCUMENT_GENERATE, data: { kind: "invoice", refId: inv.id, orgId: A.orgId } },
    ]);

    const detail = await getInvoice(asDb(db), A.ctx, { id: inv.id });
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0].kg).toBe("100.000");
    expect(detail.lines[0].amountKobo).toBe(3_055_500);
    expect(detail.outstandingKobo).toBe(3_055_500);
    expect(detail.waybillNumber).toBe(dispatch.waybillNumber);

    await expectCode(createInvoiceFromDispatch(asDb(db), A.ctx, { dispatchId: dispatch.id }, deps), "ALREADY_INVOICED");
    await expectCode(getInvoice(asDb(db), B.ctx, { id: inv.id }), "NOT_FOUND");
    await expectCode(createInvoiceFromDispatch(asDb(db), B.ctx, { dispatchId: dispatch.id }, deps), "NOT_FOUND");
  });

  it("applyTax uses organisation_settings.invoice_tax_percent; void allows re-invoicing", async () => {
    await db
      .update(organisationSettings)
      .set({ invoiceTaxPercent: "7.50" })
      .where(eq(organisationSettings.organisationId, A.orgId));
    const { dispatch } = await dispatched(["50"], "50", 30_555);

    const plain = await createInvoiceFromDispatch(asDb(db), A.ctx, { dispatchId: dispatch.id }, deps);
    expect(plain.taxKobo).toBe(0); // still off unless asked
    expect(plain.subtotalKobo).toBe(1_527_750);

    const voided = await voidInvoice(asDb(db), A.ctx, { id: plain.id });
    expect(voided.status).toBe("void");
    await expectCode(voidInvoice(asDb(db), A.ctx, { id: plain.id }), "INVOICE_ALREADY_VOID");

    const taxed = await createInvoiceFromDispatch(asDb(db), A.ctx, { dispatchId: dispatch.id, applyTax: true }, deps);
    expect(taxed.taxPercent).toBe("7.50");
    // 1,527,750 × 7.5% = 114,581.25 → 114,581
    expect(taxed.taxKobo).toBe(114_581);
    expect(taxed.totalKobo).toBe(1_527_750 + 114_581);
    expect(computeTaxKobo(3_055_500, "7.50")).toBe(229_163); // 229,162.5 → half-up

    await db
      .update(organisationSettings)
      .set({ invoiceTaxPercent: "0" })
      .where(eq(organisationSettings.organisationId, A.orgId));
  });
});

describe("invoice status with payments", () => {
  it("issued → part_paid → paid, and an invoice with payments cannot be voided", async () => {
    const { dispatch } = await dispatched(["10"], "10", 10_000); // ₦100/kg × 10 kg = 100,000 kobo
    const inv = await createInvoiceFromDispatch(
      asDb(db),
      A.ctx,
      { dispatchId: dispatch.id, invoiceDate: "2026-02-04" },
      deps,
    );
    expect(inv.totalKobo).toBe(100_000);
    // Isolate from earlier invoices for this customer: allocate manually.
    await recordCustomerPayment(asDb(db), A.ctx, {
      customerId,
      amountKobo: 40_000,
      method: "cash",
      paymentDate: "2026-02-05",
      allocations: [{ invoiceId: inv.id, amountKobo: 40_000 }],
    });
    let detail = await getInvoice(asDb(db), A.ctx, { id: inv.id });
    expect(detail.status).toBe("part_paid");
    expect(detail.paidKobo).toBe(40_000);
    expect(detail.outstandingKobo).toBe(60_000);

    await expectCode(voidInvoice(asDb(db), A.ctx, { id: inv.id }), "INVOICE_HAS_PAYMENTS");

    await recordCustomerPayment(asDb(db), A.ctx, {
      customerId,
      amountKobo: 60_000,
      method: "transfer",
      paymentDate: "2026-02-06",
      allocations: [{ invoiceId: inv.id, amountKobo: 60_000 }],
    });
    detail = await getInvoice(asDb(db), A.ctx, { id: inv.id });
    expect(detail.status).toBe("paid");
    expect(detail.outstandingKobo).toBe(0);
    expect(detail.payments).toHaveLength(2);

    const open = await listInvoices(asDb(db), A.ctx, { openOnly: true });
    expect(open.rows.find((r) => r.id === inv.id)).toBeUndefined();
    const all = await listInvoices(asDb(db), A.ctx, { customerId });
    const row = all.rows.find((r) => r.id === inv.id)!;
    expect(row.paidKobo).toBe(100_000);
    expect(row.outstandingKobo).toBe(0);
    expect((await listInvoices(asDb(db), B.ctx)).total).toBe(0);

    const [persisted] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(persisted.status).toBe("paid");
  });
});
