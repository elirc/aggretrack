import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { auditLog, organisationSettings, priceGuides } from "@/db/schema";
import type { DbOrTx } from "@/db/client";
import { DomainError } from "@/lib/domain/errors";
import * as md from "@/lib/services/masterData";
import * as platform from "@/lib/services/platform";
import { createTestOrg, type TestOrg } from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import {
  bagTypeInput,
  commodityInput,
  driverInput,
  planInput,
  vehicleInput,
  warehouseInput,
} from "@/lib/validation/masterData";

let t: ReturnType<typeof makeTestDb>;
let db: TestDb;
let A: TestOrg;
let B: TestOrg;

const asDb = (d: TestDb) => d as unknown as DbOrTx;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

async function auditRows(orgId: string, tableName: string, recordId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.organisationId, orgId),
        eq(auditLog.tableName, tableName),
        eq(auditLog.recordId, recordId),
      ),
    );
}

beforeAll(async () => {
  t = makeTestDb();
  db = t.db;
  await truncateAll(db);
  A = await createTestOrg(db, { name: "Org A" });
  B = await createTestOrg(db, { name: "Org B" });
});

afterAll(async () => {
  await t.close();
});

describe("validation", () => {
  it("normalises codes/plates and empty optionals", () => {
    expect(commodityInput.parse({ name: " Maize ", code: "mz-1" })).toEqual({
      name: "Maize",
      code: "MZ-1",
      active: true,
    });
    expect(vehicleInput.parse({ plateNumber: "abc  123 xy", description: "", capacityKg: "" })).toEqual({
      plateNumber: "ABC 123 XY",
      description: null,
      capacityKg: null,
    });
    expect(bagTypeInput.parse({ name: "50kg", standardKg: "50", sackWeightKg: "" }).sackWeightKg).toBe("0");
    expect(bagTypeInput.safeParse({ name: "x", standardKg: "0" }).success).toBe(false);
    expect(warehouseInput.safeParse({ name: "W", capacityKg: "12.3456" }).success).toBe(false);
    expect(driverInput.safeParse({ name: "D", phone: "abc" }).success).toBe(false);
  });
});

describe("commodities", () => {
  it("CRUD round-trip with audit rows", async () => {
    const c = await md.createCommodity(asDb(db), A.ctx, commodityInput.parse({ name: "Maize", code: "mz" }));
    expect(c.code).toBe("MZ");
    expect(c.organisationId).toBe(A.orgId);

    const got = await md.getCommodity(asDb(db), A.ctx, c.id);
    expect(got.name).toBe("Maize");

    const upd = await md.updateCommodity(asDb(db), A.ctx, { id: c.id, name: "White Maize", code: "WMZ", active: true });
    expect(upd.name).toBe("White Maize");

    await md.setCommodityActive(asDb(db), A.ctx, { id: c.id, active: false });
    expect((await md.listCommodities(asDb(db), A.ctx)).find((x) => x.id === c.id)).toBeUndefined();
    expect(
      (await md.listCommodities(asDb(db), A.ctx, { includeInactive: true })).find((x) => x.id === c.id)?.active,
    ).toBe(false);
    await md.setCommodityActive(asDb(db), A.ctx, { id: c.id, active: true });

    const audits = await auditRows(A.orgId, "commodities", c.id);
    expect(audits.map((a) => a.action).sort()).toEqual(["create", "update", "update", "update"]);
    const updateRow = audits.find(
      (a) => a.action === "update" && (a.before as { name: string } | null)?.name === "Maize",
    );
    expect(updateRow).toBeDefined();
    expect((updateRow!.after as { name: string }).name).toBe("White Maize");
    expect(audits.every((a) => a.userId === A.userId)).toBe(true);
  });

  it("names/codes are unique per org but may repeat across orgs", async () => {
    await md.createCommodity(asDb(db), A.ctx, { name: "Soybean", code: "SOY", active: true });
    // same name + code in another org is fine
    const inB = await md.createCommodity(asDb(db), B.ctx, { name: "Soybean", code: "SOY", active: true });
    expect(inB.organisationId).toBe(B.orgId);
    // duplicate within org rejected (name, then code)
    await expectCode(md.createCommodity(asDb(db), A.ctx, { name: "Soybean", code: "SOY2", active: true }), "DUPLICATE");
    await expectCode(md.createCommodity(asDb(db), A.ctx, { name: "Soya", code: "SOY", active: true }), "DUPLICATE");
  });
});

describe("grades", () => {
  it("CRUD per commodity, unique per commodity, removable when unreferenced", async () => {
    const c = await md.createCommodity(asDb(db), A.ctx, { name: "Sorghum", code: "SRG", active: true });
    const c2 = await md.createCommodity(asDb(db), A.ctx, { name: "Millet", code: "MLT", active: true });
    const g = await md.createGrade(asDb(db), A.ctx, { commodityId: c.id, name: "Grade A", code: "A" });
    // same grade name under another commodity is fine
    await md.createGrade(asDb(db), A.ctx, { commodityId: c2.id, name: "Grade A", code: "A" });
    await expectCode(md.createGrade(asDb(db), A.ctx, { commodityId: c.id, name: "Grade A", code: null }), "DUPLICATE");

    const list = await md.listGrades(asDb(db), A.ctx, { commodityId: c.id });
    expect(list).toHaveLength(1);
    expect(list[0].commodityName).toBe("Sorghum");

    const upd = await md.updateGrade(asDb(db), A.ctx, { id: g.id, commodityId: c.id, name: "Grade 1", code: "G1" });
    expect(upd.name).toBe("Grade 1");

    await md.removeGrade(asDb(db), A.ctx, g.id);
    await expectCode(md.getGrade(asDb(db), A.ctx, g.id), "NOT_FOUND");
    const audits = await auditRows(A.orgId, "grades", g.id);
    expect(audits.map((a) => a.action).sort()).toEqual(["cancel", "create", "update"]);
  });
});

describe("bag types", () => {
  it("normalises kg to 3 decimals and round-trips", async () => {
    const b = await md.createBagType(asDb(db), A.ctx, bagTypeInput.parse({ name: "100kg poly", standardKg: "100", sackWeightKg: "1.2" }));
    expect(b.standardKg).toBe("100.000");
    expect(b.sackWeightKg).toBe("1.200");
    const u = await md.updateBagType(asDb(db), A.ctx, { id: b.id, name: "100kg poly", standardKg: "99.5", sackWeightKg: "0" });
    expect(u.standardKg).toBe("99.500");
    await expectCode(
      md.createBagType(asDb(db), A.ctx, { name: "100kg poly", standardKg: "10", sackWeightKg: "0" }),
      "DUPLICATE",
    );
    await md.removeBagType(asDb(db), A.ctx, b.id);
    expect((await md.listBagTypes(asDb(db), A.ctx)).find((x) => x.id === b.id)).toBeUndefined();
    expect(await auditRows(A.orgId, "bag_types", b.id)).toHaveLength(3);
  });
});

describe("warehouses + bins", () => {
  it("creates warehouses with capacity and bins; deactivates instead of deleting", async () => {
    const w = await md.createWarehouse(asDb(db), A.ctx, warehouseInput.parse({ name: "Gombe Main", location: "Gombe", capacityKg: "500000" }));
    expect(w.capacityKg).toBe("500000.000");
    const bin = await md.createBin(asDb(db), A.ctx, { warehouseId: w.id, name: "A1" });
    await md.createBin(asDb(db), A.ctx, { warehouseId: w.id, name: "A2" });
    await expectCode(md.createBin(asDb(db), A.ctx, { warehouseId: w.id, name: "A1" }), "DUPLICATE");

    const full = await md.getWarehouse(asDb(db), A.ctx, w.id);
    expect(full.bins.map((b) => b.name)).toEqual(["A1", "A2"]);

    await md.updateBin(asDb(db), A.ctx, { id: bin.id, name: "A1-North" });
    await md.updateWarehouse(asDb(db), A.ctx, { id: w.id, name: "Gombe Main", location: null, capacityKg: null, active: true });
    expect((await md.getWarehouse(asDb(db), A.ctx, w.id)).capacityKg).toBeNull();

    await md.setWarehouseActive(asDb(db), A.ctx, { id: w.id, active: false });
    expect((await md.listWarehouses(asDb(db), A.ctx)).find((x) => x.id === w.id)).toBeUndefined();
    const inactive = (await md.listWarehouses(asDb(db), A.ctx, { includeInactive: true })).find((x) => x.id === w.id);
    expect(inactive?.active).toBe(false);
    expect(inactive?.bins).toHaveLength(2);

    expect(await auditRows(A.orgId, "warehouses", w.id)).toHaveLength(3);
    expect(await auditRows(A.orgId, "bins", bin.id)).toHaveLength(2);
  });

  it("honours warehouse read restrictions", async () => {
    const w1 = await md.createWarehouse(asDb(db), A.ctx, { name: "R1", location: null, capacityKg: null, active: true });
    await md.createWarehouse(asDb(db), A.ctx, { name: "R2", location: null, capacityKg: null, active: true });
    const restricted = { ...A.ctx, restrictions: { ...A.ctx.restrictions, warehouseIds: [w1.id] } };
    const list = await md.listWarehouses(asDb(db), restricted);
    expect(list.map((w) => w.id)).toEqual([w1.id]);
  });
});

describe("buying points, vehicles, drivers, expense categories", () => {
  it("round-trips each with uniqueness and audit", async () => {
    const bp = await md.createBuyingPoint(asDb(db), A.ctx, { name: "Kumo Market", lga: "Akko", state: "Gombe", active: true });
    await expectCode(md.createBuyingPoint(asDb(db), A.ctx, { name: "Kumo Market", lga: null, state: null, active: true }), "DUPLICATE");
    await md.createBuyingPoint(asDb(db), B.ctx, { name: "Kumo Market", lga: null, state: null, active: true });
    await md.updateBuyingPoint(asDb(db), A.ctx, { id: bp.id, name: "Kumo Market", lga: "Akko", state: "Gombe", active: true });
    await md.setBuyingPointActive(asDb(db), A.ctx, { id: bp.id, active: false });
    expect((await md.getBuyingPoint(asDb(db), A.ctx, bp.id)).active).toBe(false);
    expect(await auditRows(A.orgId, "buying_points", bp.id)).toHaveLength(3);

    const v = await md.createVehicle(asDb(db), A.ctx, vehicleInput.parse({ plateNumber: "gme 123 aa", capacityKg: "30000" }));
    expect(v.plateNumber).toBe("GME 123 AA");
    await expectCode(md.createVehicle(asDb(db), A.ctx, vehicleInput.parse({ plateNumber: "GME 123 AA" })), "DUPLICATE");
    await md.updateVehicle(asDb(db), A.ctx, { id: v.id, plateNumber: "GME 123 AA", description: "Trailer", capacityKg: null });
    await md.removeVehicle(asDb(db), A.ctx, v.id);
    expect(await auditRows(A.orgId, "vehicles", v.id)).toHaveLength(3);

    const d = await md.createDriver(asDb(db), A.ctx, driverInput.parse({ name: "Musa", phone: "0803 000 0000" }));
    await expectCode(md.createDriver(asDb(db), A.ctx, driverInput.parse({ name: "Musa" })), "DUPLICATE");
    await md.updateDriver(asDb(db), A.ctx, { id: d.id, name: "Musa Bello", phone: null, licenceNote: "Class E" });
    expect((await md.getDriver(asDb(db), A.ctx, d.id)).licenceNote).toBe("Class E");
    await md.removeDriver(asDb(db), A.ctx, d.id);
    expect(await auditRows(A.orgId, "drivers", d.id)).toHaveLength(3);

    const e = await md.createExpenseCategory(asDb(db), A.ctx, { name: "Loading", affectsLandedCost: true });
    expect(e.affectsLandedCost).toBe(true);
    await md.updateExpenseCategory(asDb(db), A.ctx, { id: e.id, name: "Loading", affectsLandedCost: false });
    expect((await md.getExpenseCategory(asDb(db), A.ctx, e.id)).affectsLandedCost).toBe(false);
    await expectCode(md.createExpenseCategory(asDb(db), A.ctx, { name: "Loading", affectsLandedCost: false }), "DUPLICATE");
    await md.removeExpenseCategory(asDb(db), A.ctx, e.id);
    expect(await auditRows(A.orgId, "expense_categories", e.id)).toHaveLength(3);
  });

  it("refuses to remove a referenced row (IN_USE)", async () => {
    const w = await md.createWarehouse(asDb(db), A.ctx, { name: "WithBin", location: null, capacityKg: null, active: true });
    const c = await md.createCommodity(asDb(db), A.ctx, { name: "Cowpea", code: "CPA", active: true });
    const g = await md.createGrade(asDb(db), A.ctx, { commodityId: c.id, name: "Std", code: null });
    // a price guide referencing the grade blocks deletion
    await db.insert(priceGuides).values({
      organisationId: A.orgId,
      commodityId: c.id,
      gradeId: g.id,
      guideDate: "2026-01-01",
      maxPricePerKgKobo: 50_000,
    });
    await expectCode(md.removeGrade(asDb(db), A.ctx, g.id), "IN_USE");
    expect((await md.getGrade(asDb(db), A.ctx, g.id)).id).toBe(g.id);
    expect(w.id).toBeTruthy();
  });
});

describe("setup wizard completion", () => {
  it("sets setup_completed_at once and audits it", async () => {
    const before = await md.getSetupStatus(asDb(db), B.ctx);
    expect(before.setupCompletedAt).toBeNull();
    expect(before.counts.commodities).toBe(1);
    const first = await md.completeSetup(asDb(db), B.ctx);
    const second = await md.completeSetup(asDb(db), B.ctx);
    expect(second.setupCompletedAt.getTime()).toBe(first.setupCompletedAt.getTime());
    const [row] = await db
      .select()
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, B.orgId));
    expect(row.setupCompletedAt).not.toBeNull();
    expect(await auditRows(B.orgId, "organisation_settings", B.orgId)).toHaveLength(1);
    // org A untouched
    expect((await md.getSetupStatus(asDb(db), A.ctx)).setupCompletedAt).toBeNull();
  });
});

describe("platform service (cross-tenant by design)", () => {
  it("health counts, org list/detail, read-only toggle audited into the target org", async () => {
    const h = await platform.getHealthOverview(asDb(db));
    expect(h.organisations).toBe(2);
    expect(h.users).toBe(2);
    expect(h.subscriptionsByStatus.trialing).toBe(2);

    const list = await platform.listOrganisations(asDb(db), { q: "Org A", page: 1, pageSize: 25 });
    expect(list.rows.map((r) => r.id)).toEqual([A.orgId]);
    expect(list.rows[0].memberCount).toBe(1);
    expect(list.rows[0].readOnly).toBe(false);

    await platform.setOrganisationReadOnly(asDb(db), { userId: B.userId }, { organisationId: A.orgId, readOnly: true });
    const detail = await platform.getOrganisation(asDb(db), A.orgId);
    expect(detail.subscriptionStatus).toBe("past_due");
    expect(detail.readOnly).toBe(true);
    expect(detail.members).toHaveLength(1);
    expect(detail.memberCount).toBe(1);
    expect(detail.usage.commodities).toBeGreaterThan(0);

    await platform.setOrganisationReadOnly(asDb(db), { userId: B.userId }, { organisationId: A.orgId, readOnly: false });
    expect((await platform.getOrganisation(asDb(db), A.orgId)).subscriptionStatus).toBe("active");

    const audit = await platform.listAuditLog(asDb(db), {
      organisationId: A.orgId,
      tableName: "subscriptions",
      from: null,
      to: null,
      page: 1,
      pageSize: 50,
    });
    expect(audit.total).toBe(2);
    expect(audit.rows.every((r) => r.organisationId === A.orgId && r.organisationName === "Org A")).toBe(true);

    const all = await platform.listAuditLog(asDb(db), { organisationId: null, tableName: null, from: null, to: null, page: 1, pageSize: 5 });
    expect(all.rows).toHaveLength(5);
    expect(all.total).toBeGreaterThan(5);
    expect(new Set((await platform.listAuditLog(asDb(db), { organisationId: B.orgId, tableName: null, from: null, to: null, page: 1, pageSize: 200 })).rows.map((r) => r.organisationId))).toEqual(new Set([B.orgId]));

    // date window in the far past → nothing
    const none = await platform.listAuditLog(asDb(db), { organisationId: null, tableName: null, from: "2000-01-01", to: "2000-01-02", page: 1, pageSize: 50 });
    expect(none.total).toBe(0);

    await expectCode(platform.getOrganisation(asDb(db), "no-such-org"), "NOT_FOUND");
  });

  it("plans CRUD with unique code", async () => {
    const p = await platform.createPlan(asDb(db), { userId: A.userId }, planInput.parse({
      code: "Growth",
      name: "Growth",
      monthlyPriceKobo: 1_500_000,
      userLimit: 10,
    }));
    expect(p.code).toBe("growth");
    await expectCode(
      platform.createPlan(asDb(db), { userId: A.userId }, planInput.parse({ code: "growth", name: "Dup", monthlyPriceKobo: 1, userLimit: 1 })),
      "DUPLICATE",
    );
    const u = await platform.updatePlan(asDb(db), { userId: A.userId }, { ...planInput.parse({ code: "growth", name: "Growth+", monthlyPriceKobo: 2_000_000, userLimit: 20 }), id: p.id });
    expect(u.monthlyPriceKobo).toBe(2_000_000);
    const off = await platform.setPlanActive(asDb(db), { userId: A.userId }, { id: p.id, active: false });
    expect(off.active).toBe(false);
    const plans = await platform.listPlans(asDb(db));
    expect(plans.find((x) => x.id === p.id)?.subscriptionCount).toBe(0);
    expect(plans.find((x) => x.id === A.planId)?.subscriptionCount).toBe(1);
  });
});
