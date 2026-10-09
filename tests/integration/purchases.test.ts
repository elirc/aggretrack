import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { auditLog, buyingPoints, purchaseLines, purchases } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";
import { DomainError } from "@/lib/domain/errors";
import { lagosYear } from "@/lib/services/numbering";
import * as guides from "@/lib/services/priceGuides";
import * as svc from "@/lib/services/purchases";
import { createMasterData, createSupplier, createTestOrg, type TestMasterData, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { priceGuideInput, purchaseCreateInput } from "@/lib/validation/buying";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let md: TestMasterData;
let supplierId: string;

const asDb = (d: TestDb) => d as unknown as DbOrTx;
const YEAR = lagosYear();

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

function line(over: Record<string, unknown> = {}) {
  return {
    commodityId: md.commodityId,
    gradeId: md.gradeId,
    bagTypeId: null,
    bags: 0,
    grossKg: "100",
    pricePerKgKobo: 30_000,
    deductions: [],
    ...over,
  };
}

function input(over: Record<string, unknown> = {}) {
  return purchaseCreateInput.parse({
    supplierId,
    buyingPointId: md.buyingPointId,
    purchaseDate: "2026-10-05",
    lines: [line()],
    ...over,
  });
}

function restricted(bpIds: string[], role: OrgContext["role"] = "procurement"): OrgContext {
  return { ...A.ctx, role, restrictions: { ...A.ctx.restrictions, buyingPointIds: bpIds } };
}

beforeAll(() => {
  t = makeTestDb();
  db = t.db;
});

beforeEach(async () => {
  await truncateAll(db);
  A = await createTestOrg(db);
  md = await createMasterData(db, A.ctx);
  supplierId = await createSupplier(db, A.ctx);
});

afterAll(async () => {
  await t.close();
});

describe("net weight + amount", () => {
  it("deducts moisture + automatic sack weight and rounds the amount half-up", async () => {
    const { purchase, duplicate } = await svc.createPurchase(
      asDb(db),
      A.ctx,
      input({
        lines: [
          // 100.5 − 2×1.2 (sack, auto from bag type) − 3.25 (moisture) = 94.85 kg
          line({
            bagTypeId: md.bagTypeId,
            bags: 2,
            grossKg: "100.5",
            moisturePercent: "14.5",
            pricePerKgKobo: 30_555,
            deductions: [{ reason: "moisture", kg: "3.25" }],
          }),
          // explicit sack deduction overrides the automatic one: 50 − 1 = 49 kg
          line({
            bagTypeId: md.bagTypeId,
            bags: 5,
            grossKg: "50",
            pricePerKgKobo: 10_001,
            deductions: [{ reason: "sack_weight", kg: "1" }],
          }),
        ],
      }),
    );
    expect(duplicate).toBe(false);
    expect(purchase.purchaseNumber).toBe(`PO-${YEAR}-00001`);
    expect(purchase.status).toBe("approved");
    const [l1, l2] = purchase.lines;
    expect(l1.netKg).toBe("94.850");
    // 94 850 g × 30 555 kobo/kg / 1000 = 2 898 141.75 → 2 898 142
    expect(l1.amountKobo).toBe(2_898_142);
    expect(l1.moisturePercent).toBe("14.50");
    expect(l1.deductions.map((d) => [d.reason, d.kg]).sort()).toEqual([
      ["moisture", "3.250"],
      ["sack_weight", "2.400"],
    ]);
    expect(l2.netKg).toBe("49.000");
    // 49 000 × 10 001 / 1000 = 490 049
    expect(l2.amountKobo).toBe(490_049);
    expect(l2.deductions.map((d) => [d.reason, d.kg])).toEqual([["sack_weight", "1.000"]]);
    expect(purchase.totalAmountKobo).toBe(2_898_142 + 490_049);
    expect(purchase.netKg).toBe("143.850");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.organisationId, A.orgId), eq(auditLog.recordId, purchase.id)));
    expect(audits.map((a) => a.action)).toEqual(["create"]);
  });

  it("rejects deductions larger than gross and writes nothing", async () => {
    await expectCode(
      svc.createPurchase(asDb(db), A.ctx, input({ lines: [line({ grossKg: "10", deductions: [{ reason: "other", kg: "10.001" }] })] })),
      "NET_WEIGHT_NEGATIVE",
    );
    expect(await db.select().from(purchases)).toHaveLength(0);
    // the PO number was released with the rolled-back tx (gapless)
    const { purchase } = await svc.createPurchase(asDb(db), A.ctx, input());
    expect(purchase.purchaseNumber).toBe(`PO-${YEAR}-00001`);
  });

  it("previews the same math without writing", async () => {
    const [p] = await svc.previewPurchaseLines(asDb(db), A.ctx, {
      purchaseDate: "2026-10-05",
      buyingPointId: md.buyingPointId,
      lines: input({ lines: [line({ bagTypeId: md.bagTypeId, bags: 10, grossKg: "1000", pricePerKgKobo: 12_345 })] }).lines,
    });
    expect(p).toEqual({ netKg: "988.000", deductedKg: "12.000", amountKobo: 12_196_860, overGuide: false, guideMaxKobo: null });
    expect(await db.select().from(purchases)).toHaveLength(0);
  });
});

describe("price guides + approval", () => {
  it("lookupGuide picks the most specific guide, latest date <= purchase date", async () => {
    const mk = (over: Record<string, unknown>) =>
      guides.createPriceGuide(
        asDb(db),
        A.ctx,
        priceGuideInput.parse({ commodityId: md.commodityId, guideDate: "2026-10-01", maxPricePerKgKobo: 30_000, ...over }),
      );
    await mk({});
    await mk({ guideDate: "2026-10-04", maxPricePerKgKobo: 30_500 });
    await mk({ buyingPointId: md.buyingPointId, maxPricePerKgKobo: 31_000 });
    await mk({ gradeId: md.gradeId, maxPricePerKgKobo: 32_000 });
    await expectCode(mk({}), "DUPLICATE"); // null-scoped duplicate caught despite NULLs

    const q = (over: Partial<Parameters<typeof guides.lookupGuide>[2]>) =>
      guides.lookupGuide(asDb(db), A.ctx, {
        commodityId: md.commodityId,
        gradeId: md.gradeId,
        buyingPointId: md.buyingPointId,
        date: "2026-10-05",
        ...over,
      });
    expect((await q({}))?.maxPricePerKgKobo).toBe(32_000); // grade beats point
    await mk({ gradeId: md.gradeId, buyingPointId: md.buyingPointId, maxPricePerKgKobo: 33_000 });
    expect((await q({}))?.maxPricePerKgKobo).toBe(33_000); // grade+point beats all
    expect((await q({ gradeId: null }))?.maxPricePerKgKobo).toBe(31_000); // point beats generic
    expect((await q({ gradeId: null, buyingPointId: null }))?.maxPricePerKgKobo).toBe(30_500); // latest generic
    expect((await q({ gradeId: null, buyingPointId: null, date: "2026-10-03" }))?.maxPricePerKgKobo).toBe(30_000);
    expect(await q({ date: "2026-09-30" })).toBeNull();
  });

  it("over-guide line → pending_approval; approve needs purchase.approve", async () => {
    await guides.createPriceGuide(
      asDb(db),
      A.ctx,
      priceGuideInput.parse({ commodityId: md.commodityId, guideDate: "2026-10-01", maxPricePerKgKobo: 30_000 }),
    );
    const atGuide = await svc.createPurchase(asDb(db), A.ctx, input({ lines: [line({ pricePerKgKobo: 30_000 })] }));
    expect(atGuide.purchase.status).toBe("approved");
    expect(atGuide.purchase.requiresApproval).toBe(false);

    const { purchase } = await svc.createPurchase(
      asDb(db),
      A.ctx,
      input({ lines: [line({ pricePerKgKobo: 30_000 }), line({ pricePerKgKobo: 30_001 })] }),
    );
    expect(purchase.status).toBe("pending_approval");
    expect(purchase.requiresApproval).toBe(true);
    expect(purchase.lines.map((l) => l.overGuide)).toEqual([false, true]);

    await expectCode(svc.approvePurchase(asDb(db), restricted([md.buyingPointId]), { id: purchase.id }), "FORBIDDEN");
    await expectCode(svc.approvePurchase(asDb(db), A.ctx, { id: atGuide.purchase.id }), "INVALID_STATUS");

    const approved = await svc.approvePurchase(asDb(db), { ...A.ctx, role: "manager" }, { id: purchase.id });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe(A.userId);
    expect(approved.approvedAt).toBeInstanceOf(Date);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.recordId, purchase.id), eq(auditLog.action, "approve")));
    expect(audits).toHaveLength(1);
    expect((audits[0].before as { status: string }).status).toBe("pending_approval");
    expect((audits[0].after as { status: string }).status).toBe("approved");
  });

  it("reject sends it back to draft with a reason; edit + resubmit at guide price approves", async () => {
    await guides.createPriceGuide(
      asDb(db),
      A.ctx,
      priceGuideInput.parse({ commodityId: md.commodityId, guideDate: "2026-10-01", maxPricePerKgKobo: 30_000 }),
    );
    const { purchase } = await svc.createPurchase(asDb(db), A.ctx, input({ lines: [line({ pricePerKgKobo: 35_000 })] }));
    const rejected = await svc.rejectPurchase(asDb(db), A.ctx, { id: purchase.id, reason: "Too high" });
    expect(rejected.status).toBe("draft");
    expect(rejected.rejectedReason).toBe("Too high");

    const updated = await svc.updatePurchase(asDb(db), A.ctx, {
      id: purchase.id,
      ...input({ lines: [line({ pricePerKgKobo: 29_000, grossKg: "10" })] }),
    });
    expect(updated.status).toBe("approved");
    expect(updated.rejectedReason).toBeNull();
    expect(updated.totalAmountKobo).toBe(290_000);
    expect(updated.lines).toHaveLength(1);
    expect(await db.select().from(purchaseLines).where(eq(purchaseLines.purchaseId, purchase.id))).toHaveLength(1);

    // approved purchases are no longer editable; cancel works until received
    await expectCode(svc.updatePurchase(asDb(db), A.ctx, { id: purchase.id, ...input() }), "NOT_EDITABLE");
    const cancelled = await svc.cancelPurchase(asDb(db), A.ctx, { id: purchase.id, reason: "supplier withdrew" });
    expect(cancelled.status).toBe("cancelled");
    await expectCode(svc.cancelPurchase(asDb(db), A.ctx, { id: purchase.id, reason: null }), "ALREADY_CANCELLED");
  });

  it("saveAsDraft keeps the purchase in draft", async () => {
    const { purchase } = await svc.createPurchase(asDb(db), A.ctx, input({ saveAsDraft: true }));
    expect(purchase.status).toBe("draft");
  });
});

describe("offline idempotency", () => {
  it("same client id twice → one purchase, second flagged duplicate and unchanged", async () => {
    const id = randomUUID();
    const lineId = randomUUID();
    const first = await svc.createPurchase(
      asDb(db),
      A.ctx,
      input({ id, createdOffline: true, clientCreatedAt: "2026-10-05T08:30:00.000Z", lines: [line({ id: lineId })] }),
    );
    expect(first.duplicate).toBe(false);
    expect(first.purchase.id).toBe(id);
    expect(first.purchase.lines[0].id).toBe(lineId);
    expect(first.purchase.createdOffline).toBe(true);

    // replay with different contents: returned unchanged
    const second = await svc.createPurchase(
      asDb(db),
      A.ctx,
      input({ id, createdOffline: true, lines: [line({ id: lineId, grossKg: "999" })] }),
    );
    expect(second.duplicate).toBe(true);
    expect(second.purchase.purchaseNumber).toBe(first.purchase.purchaseNumber);
    expect(second.purchase.lines[0].netKg).toBe("100.000");

    expect(await db.select().from(purchases).where(eq(purchases.organisationId, A.orgId))).toHaveLength(1);
    // the duplicate consumed no PO number
    const third = await svc.createPurchase(asDb(db), A.ctx, input());
    expect(third.purchase.purchaseNumber).toBe(`PO-${YEAR}-00002`);
  });

  it("concurrent replays of one client id create exactly one row", async () => {
    const id = randomUUID();
    const results = await Promise.all([
      svc.createPurchase(asDb(db), A.ctx, input({ id })),
      svc.createPurchase(asDb(db), A.ctx, input({ id })),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await db.select().from(purchases).where(eq(purchases.id, id))).toHaveLength(1);
  });
});

describe("buying-point restriction", () => {
  it("restricted officer cannot buy at, list or open another point's purchases", async () => {
    const [bp2] = await db
      .insert(buyingPoints)
      .values({ organisationId: A.orgId, name: "Second Market" })
      .returning({ id: buyingPoints.id });
    const officer = restricted([bp2.id]);

    await expectCode(svc.createPurchase(asDb(db), officer, input()), "FORBIDDEN");
    await expectCode(svc.createPurchase(asDb(db), officer, input({ buyingPointId: null })), "FORBIDDEN");
    expect(await db.select().from(purchases)).toHaveLength(0);

    const own = await svc.createPurchase(asDb(db), officer, input({ buyingPointId: bp2.id }));
    expect(own.purchase.officerId).toBe(A.userId);
    const other = await svc.createPurchase(asDb(db), A.ctx, input()); // owner, unrestricted, at bp1

    const listed = await svc.listPurchases(asDb(db), officer, {});
    expect(listed.rows.map((r) => r.id)).toEqual([own.purchase.id]);
    expect(listed.total).toBe(1);
    expect((await svc.listPurchases(asDb(db), A.ctx, {})).total).toBe(2);

    await expectCode(svc.getPurchaseDetail(asDb(db), officer, other.purchase.id), "NOT_FOUND");
    await expectCode(svc.cancelPurchase(asDb(db), officer, { id: other.purchase.id, reason: null }), "NOT_FOUND");
  });

  it("list filters by status, supplier and date range; hidePrices strips amounts", async () => {
    const s2 = await createSupplier(db, A.ctx);
    await svc.createPurchase(asDb(db), A.ctx, input({ purchaseDate: "2026-09-01" }));
    await svc.createPurchase(asDb(db), A.ctx, input({ purchaseDate: "2026-09-15", supplierId: s2 }));
    await svc.createPurchase(asDb(db), A.ctx, input({ purchaseDate: "2026-10-01", saveAsDraft: true }));

    expect((await svc.listPurchases(asDb(db), A.ctx, { status: "draft" })).total).toBe(1);
    expect((await svc.listPurchases(asDb(db), A.ctx, { supplierId: s2 })).total).toBe(1);
    const ranged = await svc.listPurchases(asDb(db), A.ctx, { from: "2026-09-01", to: "2026-09-30" });
    expect(ranged.rows.map((r) => r.purchaseDate)).toEqual(["2026-09-15", "2026-09-01"]);
    expect(ranged.rows[0].netKg).toBe("100.000");
    expect(ranged.rows[0].totalAmountKobo).toBe(3_000_000);

    const keeper: OrgContext = { ...A.ctx, role: "warehouse", restrictions: { ...A.ctx.restrictions, hidePrices: true } };
    const hidden = await svc.listPurchases(asDb(db), keeper, {});
    expect(hidden.rows.every((r) => r.totalAmountKobo === null)).toBe(true);
    const detail = await svc.getPurchaseDetail(asDb(db), keeper, hidden.rows[0].id);
    expect(detail.lines[0].pricePerKgKobo).toBeNull();
    expect(detail.lines[0].netKg).toBe("100.000");
  });

  it("foreign-org references are NOT_FOUND", async () => {
    const B = await createTestOrg(db);
    const mdB = await createMasterData(db, B.ctx);
    const supplierB = await createSupplier(db, B.ctx);
    await expectCode(svc.createPurchase(asDb(db), A.ctx, input({ supplierId: supplierB })), "NOT_FOUND");
    await expectCode(svc.createPurchase(asDb(db), A.ctx, input({ buyingPointId: mdB.buyingPointId })), "NOT_FOUND");
    await expectCode(
      svc.createPurchase(asDb(db), A.ctx, input({ lines: [line({ commodityId: mdB.commodityId, gradeId: mdB.gradeId })] })),
      "NOT_FOUND",
    );
    const { purchase } = await svc.createPurchase(asDb(db), A.ctx, input());
    await expectCode(svc.getPurchaseDetail(asDb(db), B.ctx, purchase.id), "NOT_FOUND");
    await expectCode(svc.approvePurchase(asDb(db), B.ctx, { id: purchase.id }), "NOT_FOUND");
  });
});
