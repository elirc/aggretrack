import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { Db, DbOrTx } from "@/db/client";
import {
  commodities,
  documents,
  grades,
  invoices,
  lots,
  notifications,
  purchaseLines,
  purchases,
  salesOrders,
  warehouses,
} from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { kgToGrams } from "@/lib/domain/units";
import { recordCustomerPayment } from "@/lib/services/customerPayments";
import { getDocumentFile } from "@/lib/services/documents";
import * as notif from "@/lib/services/notifications";
import * as purchasesSvc from "@/lib/services/purchases";
import { receivePurchase } from "@/lib/services/receiving";
import * as statements from "@/lib/services/statements";
import { postMovements } from "@/lib/services/stockCore";
import { recordSupplierPayment } from "@/lib/services/supplierPayments";
import { supplierBalances } from "@/lib/services/suppliers";
import {
  createCustomer,
  createMasterData,
  createSupplier,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { purchaseCreateInput, receivePurchaseInput, supplierPaymentInput } from "@/lib/validation/buying";

import { groupOldStock, runAlertsScan, scanOrgAlerts } from "../../worker/jobs/alerts";

/**
 * P4-D: alert scans (worker → alertRules → notifications, dedupe while
 * unread, old stock aggregated per commodity × warehouse), the notifications
 * service (org + user scoping), and statement generation (assembly math →
 * PDF → documents row).
 */

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;
let md: TestMasterData;
let supplierId: string;
let commodity2: string;
let grade2: string;
let smallWarehouse: string;
let lotSeq = 0;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const DAY = 86_400_000;
const NOW = new Date();

async function seedLot(
  ctx: OrgContext,
  o: { kg: string; warehouseId: string; commodityId: string; gradeId: string; receivedAt: Date },
): Promise<string> {
  const n = ++lotSeq;
  const [p] = await db
    .insert(purchases)
    .values({ organisationId: ctx.orgId, supplierId, officerId: ctx.userId, purchaseDate: "2026-06-01", status: "received" })
    .returning({ id: purchases.id });
  const [line] = await db
    .insert(purchaseLines)
    .values({
      purchaseId: p.id,
      organisationId: ctx.orgId,
      commodityId: o.commodityId,
      gradeId: o.gradeId,
      grossKg: o.kg,
      netKg: o.kg,
      pricePerKgKobo: 30_000,
      amountKobo: (kgToGrams(o.kg) * 30_000) / 1000,
    })
    .returning({ id: purchaseLines.id });
  const [lot] = await db
    .insert(lots)
    .values({
      organisationId: ctx.orgId,
      lotNumber: `LOT-AL-${n}`,
      commodityId: o.commodityId,
      gradeId: o.gradeId,
      supplierId,
      purchaseLineId: line.id,
      receivedAt: o.receivedAt,
      originalKg: o.kg,
      purchasePricePerKgKobo: 30_000,
      landedCostPerKgKobo: "30000.0000",
    })
    .returning({ id: lots.id });
  await (db as unknown as Db).transaction((tx) =>
    postMovements(tx, ctx, [
      { lotId: lot.id, warehouseId: o.warehouseId, type: "receive", grams: kgToGrams(o.kg), bags: 0, refType: "grn", refId: p.id },
    ]),
  );
  return lot.id;
}

async function orgNotifications(orgId: string) {
  return db.select().from(notifications).where(eq(notifications.organisationId, orgId));
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Alerts Org" });
  B = await createTestOrg(db, { name: "Other Org" }); // no master data → no alerts
  md = await createMasterData(db, A.ctx);
  supplierId = await createSupplier(db, A.ctx);

  const [c2] = await db
    .insert(commodities)
    .values({ organisationId: A.orgId, name: "Sorghum AL", code: "SORGAL" })
    .returning({ id: commodities.id });
  commodity2 = c2.id;
  const [g2] = await db
    .insert(grades)
    .values({ organisationId: A.orgId, commodityId: commodity2, name: "Grade A", code: "A" })
    .returning({ id: grades.id });
  grade2 = g2.id;
  const [w] = await db
    .insert(warehouses)
    .values({ organisationId: A.orgId, name: "Small Store", capacityKg: "1300.000" })
    .returning({ id: warehouses.id });
  smallWarehouse = w.id;

  // Commodity 1 (maize): 500 kg total < 1000 kg threshold → low stock; two lots
  // older than 90 days in the SAME warehouse → ONE aggregated old-stock alert.
  await seedLot(A.ctx, { kg: "200", warehouseId: md.warehouseId, commodityId: md.commodityId, gradeId: md.gradeId, receivedAt: new Date(NOW.getTime() - 120 * DAY) });
  await seedLot(A.ctx, { kg: "300", warehouseId: md.warehouseId, commodityId: md.commodityId, gradeId: md.gradeId, receivedAt: new Date(NOW.getTime() - 100 * DAY) });
  // Commodity 2: 1200 kg (not low), fresh (not old), in a 1300 kg store → 92% ≥ 90% capacity.
  await seedLot(A.ctx, { kg: "1200", warehouseId: smallWarehouse, commodityId: commodity2, gradeId: grade2, receivedAt: new Date(NOW.getTime() - 5 * DAY) });
});

afterAll(async () => {
  await t.close();
});

describe("alert scan → notifications", () => {
  it("first run creates one low-stock, one aggregated old-stock and one capacity notification", async () => {
    const r = await runAlertsScan(asDb(db), NOW);
    expect(r).toEqual({ orgs: 2, lowStock: 1, oldStock: 1, capacity: 1 });

    const rows = await orgNotifications(A.orgId);
    expect(rows).toHaveLength(3);
    for (const n of rows) {
      expect(n.userId).toBeNull();
      expect(n.readAt).toBeNull();
    }
    const byType = new Map(rows.map((n) => [n.type, n]));
    expect(byType.get("low_stock")?.link).toBe(`/stock?commodity=${md.commodityId}`);
    expect(byType.get("low_stock")?.body).toContain("500.000 kg on hand");
    const old = byType.get("old_stock")!;
    expect(old.link).toBe(`/stock/ageing?commodity=${md.commodityId}&warehouse=${md.warehouseId}`);
    expect(old.body).toContain("2 lots");
    expect(old.body).toContain("500.000 kg");
    expect(old.body).toContain("oldest 120 days");
    expect(byType.get("capacity")?.link).toBe(`/stock?warehouse=${smallWarehouse}`);
    expect(byType.get("capacity")?.body).toContain("92.31% full");

    expect(await orgNotifications(B.orgId)).toHaveLength(0);
  });

  it("re-running while unread creates no duplicates", async () => {
    expect(await runAlertsScan(asDb(db), NOW)).toEqual({ orgs: 2, lowStock: 0, oldStock: 0, capacity: 0 });
    expect(await scanOrgAlerts(asDb(db), A.orgId, NOW)).toEqual({ lowStock: 0, oldStock: 0, capacity: 0 });
    expect(await orgNotifications(A.orgId)).toHaveLength(3);
  });

  it("once read, the next scan may raise the alert again", async () => {
    const [old] = (await orgNotifications(A.orgId)).filter((n) => n.type === "old_stock");
    expect(await notif.markRead(asDb(db), A.ctx, [old.id])).toEqual({ updated: 1 });
    expect(await scanOrgAlerts(asDb(db), A.orgId, NOW)).toEqual({ lowStock: 0, oldStock: 1, capacity: 0 });
    const rows = await orgNotifications(A.orgId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((n) => n.type === "old_stock" && n.readAt === null)).toHaveLength(1);
  });

  it("groupOldStock aggregates per commodity × warehouse and skips unknown lots", () => {
    const base = { commodityName: "Maize", warehouseName: "W", receivedAt: NOW, onHandKg: "1.000" };
    const groups = groupOldStock(
      [
        { ...base, lotId: "l1", lotNumber: "L1", warehouseId: "w1", ageDays: 95, onHandGrams: 1000 },
        { ...base, lotId: "l2", lotNumber: "L2", warehouseId: "w1", ageDays: 140, onHandGrams: 2000 },
        { ...base, lotId: "l1", lotNumber: "L1", warehouseId: "w2", ageDays: 95, onHandGrams: 500 },
        { ...base, lotId: "zz", lotNumber: "ZZ", warehouseId: "w1", ageDays: 99, onHandGrams: 7 },
      ],
      new Map([
        ["l1", "c1"],
        ["l2", "c1"],
      ]),
    );
    expect(groups).toEqual([
      expect.objectContaining({ commodityId: "c1", warehouseId: "w1", lotCount: 2, onHandGrams: 3000, oldestAgeDays: 140 }),
      expect.objectContaining({ commodityId: "c1", warehouseId: "w2", lotCount: 1, onHandGrams: 500, oldestAgeDays: 95 }),
    ]);
  });
});

describe("notifications service", () => {
  let personalForB: string;

  beforeAll(async () => {
    // A notification addressed to another user inside org A — A's owner must not see it.
    const [row] = await db
      .insert(notifications)
      .values({ organisationId: A.orgId, userId: B.userId, type: "system", title: "Not for A's owner", link: "/x" })
      .returning({ id: notifications.id });
    personalForB = row.id;
  });

  it("lists org-wide + own notifications, newest first, with unread filter and paging", async () => {
    const all = await notif.listNotifications(asDb(db), A.ctx);
    expect(all.total).toBe(4);
    expect(all.unread).toBe(3);
    expect(all.rows.map((r) => r.id)).not.toContain(personalForB);
    const times = all.rows.map((r) => r.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const unread = await notif.listNotifications(asDb(db), A.ctx, { unreadOnly: true });
    expect(unread.total).toBe(3);
    expect(unread.rows.every((r) => r.readAt === null)).toBe(true);

    const page1 = await notif.listNotifications(asDb(db), A.ctx, { pageSize: 3, page: 1 });
    const page2 = await notif.listNotifications(asDb(db), A.ctx, { pageSize: 3, page: 2 });
    expect(page1.rows).toHaveLength(3);
    expect(page2.rows).toHaveLength(1);
    expect(new Set([...page1.rows, ...page2.rows].map((r) => r.id)).size).toBe(4);

    expect(await notif.unreadCount(asDb(db), A.ctx)).toBe(3);
  });

  it("is org-scoped: the second org sees nothing and cannot mark A's notifications", async () => {
    const list = await notif.listNotifications(asDb(db), B.ctx);
    expect(list).toEqual({ rows: [], total: 0, unread: 0 });
    expect(await notif.unreadCount(asDb(db), B.ctx)).toBe(0);

    const aIds = (await orgNotifications(A.orgId)).map((n) => n.id);
    expect(await notif.markRead(asDb(db), B.ctx, aIds)).toEqual({ updated: 0 });
    expect(await notif.markAllRead(asDb(db), B.ctx)).toEqual({ updated: 0 });
    expect(await notif.unreadCount(asDb(db), A.ctx)).toBe(3);
  });

  it("markRead ignores invisible / already-read ids; markAllRead clears only what the user sees", async () => {
    expect(await notif.markRead(asDb(db), A.ctx, [personalForB])).toEqual({ updated: 0 });
    expect(await notif.markRead(asDb(db), A.ctx, [])).toEqual({ updated: 0 });
    expect(await notif.markAllRead(asDb(db), A.ctx)).toEqual({ updated: 3 });
    expect(await notif.unreadCount(asDb(db), A.ctx)).toBe(0);
    const [personal] = await db.select().from(notifications).where(eq(notifications.id, personalForB));
    expect(personal.readAt).toBeNull();
  });
});

describe("statements", () => {
  let C: TestOrg;
  let cmd: TestMasterData;
  let cSupplier: string;

  beforeAll(async () => {
    C = await createTestOrg(db, { name: "Statement Org" });
    cmd = await createMasterData(db, C.ctx);
    cSupplier = await createSupplier(db, C.ctx, { name: "Musa Statement" });
    // Purchase 100 kg × ₦10/kg = 100,000 kobo, received.
    const { purchase } = await purchasesSvc.createPurchase(
      asDb(db),
      C.ctx,
      purchaseCreateInput.parse({
        supplierId: cSupplier,
        buyingPointId: cmd.buyingPointId,
        purchaseDate: "2026-09-10",
        lines: [{ commodityId: cmd.commodityId, gradeId: cmd.gradeId, grossKg: "100", pricePerKgKobo: 1000 }],
      }),
    );
    expect(purchase.totalAmountKobo).toBe(100_000);
    await receivePurchase(asDb(db), C.ctx, receivePurchaseInput.parse({ purchaseId: purchase.id, warehouseId: cmd.warehouseId }));
    await recordSupplierPayment(
      asDb(db),
      C.ctx,
      supplierPaymentInput.parse({ supplierId: cSupplier, amountKobo: 40_000, method: "transfer", paymentDate: "2026-09-20" }),
    );
  });

  it("supplier statement: purchase 100k, payment 40k → closing 60k owed, matching the supplier balance", async () => {
    const st = await statements.assembleSupplierStatement(asDb(db), C.ctx, cSupplier, { from: "2026-09-01", to: "2026-09-30" });
    expect(st.openingBalanceKobo).toBe(0);
    expect(st.rows.map((r) => [r.kind, r.date, r.amountKobo, r.balanceKobo])).toEqual([
      ["purchase", "2026-09-10", 100_000, 100_000],
      ["payment", "2026-09-20", -40_000, 60_000],
    ]);
    expect(st.closingBalanceKobo).toBe(60_000);
    expect(st.rows[1].description).toContain("transfer");
    expect(st.props.rows).toHaveLength(2);
    expect(st.props.supplier.name).toBe("Musa Statement");
    const bal = (await supplierBalances(asDb(db), C.ctx, [cSupplier])).get(cSupplier);
    expect(bal?.netKobo).toBe(60_000);

    // Period starting after the purchase: it rolls into the opening balance.
    const later = await statements.assembleSupplierStatement(asDb(db), C.ctx, cSupplier, { from: "2026-09-15", to: "2026-09-30" });
    expect(later.openingBalanceKobo).toBe(100_000);
    expect(later.rows.map((r) => r.balanceKobo)).toEqual([60_000]);
    expect(later.closingBalanceKobo).toBe(60_000);

    // Period ending before the payment excludes it.
    const early = await statements.assembleSupplierStatement(asDb(db), C.ctx, cSupplier, { from: "2026-09-01", to: "2026-09-12" });
    expect(early.closingBalanceKobo).toBe(100_000);
  });

  it("generates a supplier statement PDF stored as an spm document for the supplier", async () => {
    const res = await statements.generateSupplierStatement(asDb(db), C.ctx, cSupplier, { from: "2026-09-01", to: "2026-09-30" });
    expect(res.closingBalanceKobo).toBe(60_000);
    const [doc] = await db.select().from(documents).where(eq(documents.id, res.documentId));
    expect(doc).toMatchObject({ organisationId: C.orgId, type: "spm", refId: cSupplier, refType: null, number: null });
    const file = await getDocumentFile(C.ctx, res.documentId, asDb(db));
    expect(file.buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(file.mime).toBe("application/pdf");
    // Another organisation cannot read it.
    await expect(getDocumentFile(A.ctx, res.documentId, asDb(db))).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND",
    );
  });

  it("customer statement: invoices (void skipped) minus payments, PDF stored as cpm", async () => {
    const customerId = await createCustomer(db, C.ctx, { name: "Ada Foods" });
    const seedInvoice = async (n: number, total: number, date: string, status: "issued" | "void" = "issued") => {
      const [so] = await db
        .insert(salesOrders)
        .values({ organisationId: C.orgId, orderNumber: `SO-ST-${n}`, customerId, orderDate: date, status: "completed", totalAmountKobo: total })
        .returning({ id: salesOrders.id });
      await db.insert(invoices).values({
        organisationId: C.orgId,
        invoiceNumber: `INV-ST-${n}`,
        customerId,
        salesOrderId: so.id,
        invoiceDate: date,
        subtotalKobo: total,
        totalKobo: total,
        status,
      });
    };
    await seedInvoice(1, 250_000, "2026-08-20");
    await seedInvoice(2, 150_000, "2026-09-05");
    await seedInvoice(3, 999_000, "2026-09-06", "void");
    await recordCustomerPayment(asDb(db), C.ctx, {
      customerId,
      amountKobo: 300_000,
      method: "transfer",
      paymentDate: "2026-09-10",
    });

    const st = await statements.assembleCustomerStatement(asDb(db), C.ctx, customerId, { from: "2026-09-01", to: "2026-09-30" });
    expect(st.openingBalanceKobo).toBe(250_000);
    expect(st.rows.map((r) => [r.kind, r.reference, r.amountKobo, r.balanceKobo])).toEqual([
      ["invoice", "INV-ST-2", 150_000, 400_000],
      ["payment", expect.stringMatching(/^CPM-/), -300_000, 100_000],
    ]);
    expect(st.closingBalanceKobo).toBe(100_000);

    const res = await statements.generateCustomerStatement(asDb(db), C.ctx, customerId, { from: "2026-09-01", to: "2026-09-30" });
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, res.documentId), eq(documents.organisationId, C.orgId)));
    expect(doc).toMatchObject({ type: "cpm", refId: customerId });
    const file = await getDocumentFile(C.ctx, res.documentId, asDb(db));
    expect(file.buffer.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("rejects foreign counterparties and bad periods", async () => {
    const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
    await expect(
      statements.assembleSupplierStatement(asDb(db), A.ctx, cSupplier, { from: "2026-09-01", to: "2026-09-30" }),
    ).rejects.toSatisfy(isCode("NOT_FOUND"));
    await expect(
      statements.assembleSupplierStatement(asDb(db), C.ctx, cSupplier, { from: "2026-09-30", to: "2026-09-01" }),
    ).rejects.toSatisfy(isCode("VALIDATION"));
  });
});
