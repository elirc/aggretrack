import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { commodities, organisationSettings } from "@/db/schema";
import type { DbOrTx } from "@/db/client";
import { DomainError } from "@/lib/domain/errors";
import * as md from "@/lib/services/masterData";
import {
  createMasterData,
  createTestOrg,
  type TestMasterData,
  type TestOrg,
} from "@/lib/test/factories";
import { makeTestDb, truncateAll, type TestDb } from "@/lib/test/setup";
import { commodityInput } from "@/lib/validation/masterData";

/**
 * Tenancy DoD (SPEC Engineering rules; ARCHITECTURE §Multi-tenancy):
 * two organisations, every wave-1 master-data list/get service returns zero
 * cross-tenant rows, and every mutation on a foreign-org id is NOT_FOUND
 * and leaves the foreign row untouched.
 */

let t: ReturnType<typeof makeTestDb>;
let db: DbOrTx;
let raw: TestDb;
let A: TestOrg;
let B: TestOrg;
let mA: TestMasterData;
let mB: TestMasterData;

async function expectNotFound(p: Promise<unknown>) {
  await expect(p).rejects.toSatisfy(
    (e: unknown) => e instanceof DomainError && e.code === "NOT_FOUND",
  );
}

beforeAll(async () => {
  t = makeTestDb();
  raw = t.db;
  db = t.db as unknown as DbOrTx;
  await truncateAll(raw);
  A = await createTestOrg(raw, { name: "Tenant A" });
  B = await createTestOrg(raw, { name: "Tenant B" });
  mA = await createMasterData(raw, A.ctx);
  mB = await createMasterData(raw, B.ctx);
});

afterAll(async () => {
  await t.close();
});

function idsOf(rows: { id: string }[]) {
  return new Set(rows.map((r) => r.id));
}

describe("list services never return another org's rows", () => {
  const cases: [string, (o: TestOrg) => Promise<{ id: string; organisationId: string }[]>][] = [
    ["commodities", (o) => md.listCommodities(db, o.ctx, { includeInactive: true })],
    ["grades", (o) => md.listGrades(db, o.ctx)],
    ["bag types", (o) => md.listBagTypes(db, o.ctx)],
    ["warehouses", (o) => md.listWarehouses(db, o.ctx, { includeInactive: true })],
    ["bins", (o) => md.listBins(db, o.ctx)],
    ["buying points", (o) => md.listBuyingPoints(db, o.ctx, { includeInactive: true })],
    ["vehicles", (o) => md.listVehicles(db, o.ctx)],
    ["drivers", (o) => md.listDrivers(db, o.ctx)],
    ["expense categories", (o) => md.listExpenseCategories(db, o.ctx)],
  ];

  for (const [name, list] of cases) {
    it(name, async () => {
      const a = await list(A);
      const b = await list(B);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      expect(a.every((r) => r.organisationId === A.orgId)).toBe(true);
      expect(b.every((r) => r.organisationId === B.orgId)).toBe(true);
      const aIds = idsOf(a);
      expect(b.filter((r) => aIds.has(r.id))).toHaveLength(0);
    });
  }

  it("filtered lists with a foreign parent id are empty", async () => {
    expect(await md.listGrades(db, A.ctx, { commodityId: mB.commodityId })).toHaveLength(0);
    expect(await md.listBins(db, A.ctx, { warehouseId: mB.warehouseId })).toHaveLength(0);
  });

  it("nested bins in warehouse lists stay in-org", async () => {
    const ws = await md.listWarehouses(db, A.ctx, { includeInactive: true });
    expect(ws.flatMap((w) => w.bins).every((b) => b.organisationId === A.orgId)).toBe(true);
  });

  it("setup status counts only own rows", async () => {
    const s = await md.getSetupStatus(db, A.ctx);
    expect(s.counts).toEqual({ commodities: 1, grades: 1, bagTypes: 1, warehouses: 1, buyingPoints: 1 });
  });
});

describe("get services treat a foreign id as NOT_FOUND", () => {
  it("every getter", async () => {
    await expectNotFound(md.getCommodity(db, A.ctx, mB.commodityId));
    await expectNotFound(md.getGrade(db, A.ctx, mB.gradeId));
    await expectNotFound(md.getBagType(db, A.ctx, mB.bagTypeId));
    await expectNotFound(md.getWarehouse(db, A.ctx, mB.warehouseId));
    await expectNotFound(md.getBin(db, A.ctx, mB.binId));
    await expectNotFound(md.getBuyingPoint(db, A.ctx, mB.buyingPointId));
    await expectNotFound(md.getVehicle(db, A.ctx, mB.vehicleId));
    await expectNotFound(md.getDriver(db, A.ctx, mB.driverId));
    await expectNotFound(md.getExpenseCategory(db, A.ctx, mB.handlingCategoryId));
    // and the reverse direction
    await expectNotFound(md.getCommodity(db, B.ctx, mA.commodityId));
    await expectNotFound(md.getWarehouse(db, B.ctx, mA.warehouseId));
    // own ids resolve
    expect((await md.getCommodity(db, A.ctx, mA.commodityId)).id).toBe(mA.commodityId);
    expect((await md.getWarehouse(db, B.ctx, mB.warehouseId)).bins).toHaveLength(1);
  });
});

describe("mutations on a foreign id are NOT_FOUND and change nothing", () => {
  it("updates, toggles and removes", async () => {
    const ctx = A.ctx;
    await expectNotFound(md.updateCommodity(db, ctx, { id: mB.commodityId, name: "Hijack", code: "HJK", active: true }));
    await expectNotFound(md.setCommodityActive(db, ctx, { id: mB.commodityId, active: false }));
    await expectNotFound(md.updateGrade(db, ctx, { id: mB.gradeId, commodityId: mA.commodityId, name: "X", code: null }));
    await expectNotFound(md.removeGrade(db, ctx, mB.gradeId));
    await expectNotFound(md.updateBagType(db, ctx, { id: mB.bagTypeId, name: "X", standardKg: "1", sackWeightKg: "0" }));
    await expectNotFound(md.removeBagType(db, ctx, mB.bagTypeId));
    await expectNotFound(md.updateWarehouse(db, ctx, { id: mB.warehouseId, name: "X", location: null, capacityKg: null, active: true }));
    await expectNotFound(md.setWarehouseActive(db, ctx, { id: mB.warehouseId, active: false }));
    await expectNotFound(md.updateBin(db, ctx, { id: mB.binId, name: "X" }));
    await expectNotFound(md.removeBin(db, ctx, mB.binId));
    await expectNotFound(md.updateBuyingPoint(db, ctx, { id: mB.buyingPointId, name: "X", lga: null, state: null, active: true }));
    await expectNotFound(md.setBuyingPointActive(db, ctx, { id: mB.buyingPointId, active: false }));
    await expectNotFound(md.updateVehicle(db, ctx, { id: mB.vehicleId, plateNumber: "X", description: null, capacityKg: null }));
    await expectNotFound(md.removeVehicle(db, ctx, mB.vehicleId));
    await expectNotFound(md.updateDriver(db, ctx, { id: mB.driverId, name: "X", phone: null, licenceNote: null }));
    await expectNotFound(md.removeDriver(db, ctx, mB.driverId));
    await expectNotFound(md.updateExpenseCategory(db, ctx, { id: mB.storageCategoryId, name: "X", affectsLandedCost: true }));
    await expectNotFound(md.removeExpenseCategory(db, ctx, mB.storageCategoryId));

    // B's data is intact and visible to B
    expect((await md.getCommodity(db, B.ctx, mB.commodityId)).active).toBe(true);
    expect((await md.getGrade(db, B.ctx, mB.gradeId)).name).toBe("Grade A");
    expect((await md.getWarehouse(db, B.ctx, mB.warehouseId)).active).toBe(true);
    expect((await md.getBin(db, B.ctx, mB.binId)).name).toBe("A1");
    expect((await md.getBuyingPoint(db, B.ctx, mB.buyingPointId)).active).toBe(true);
    expect((await md.getVehicle(db, B.ctx, mB.vehicleId)).description).toBe("Truck");
    expect((await md.getDriver(db, B.ctx, mB.driverId)).phone).toBe("2348000000000");
    expect((await md.getExpenseCategory(db, B.ctx, mB.storageCategoryId)).affectsLandedCost).toBe(false);
    expect(await md.listBagTypes(db, B.ctx)).toHaveLength(1);
  });

  it("creating a child under a foreign parent is NOT_FOUND", async () => {
    await expectNotFound(md.createGrade(db, A.ctx, { commodityId: mB.commodityId, name: "Sneaky", code: null }));
    await expectNotFound(md.createBin(db, A.ctx, { warehouseId: mB.warehouseId, name: "Sneaky" }));
    await expectNotFound(
      md.updateGrade(db, A.ctx, { id: mA.gradeId, commodityId: mB.commodityId, name: "Moved", code: null }),
    );
    expect(await md.listGrades(db, B.ctx)).toHaveLength(1);
    expect(await md.listBins(db, B.ctx)).toHaveLength(1);
  });

  it("organisation comes from ctx, never input (extra keys are stripped)", async () => {
    const input = commodityInput.parse({ name: "Ginger", code: "GNG", organisationId: B.orgId } as never);
    expect("organisationId" in input).toBe(false);
    const row = await md.createCommodity(db, A.ctx, input);
    expect(row.organisationId).toBe(A.orgId);
    expect(await raw.select().from(commodities).where(eq(commodities.organisationId, B.orgId))).toHaveLength(1);
  });

  it("completeSetup only touches the caller's organisation", async () => {
    await md.completeSetup(db, A.ctx);
    const [b] = await raw
      .select()
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, B.orgId));
    expect(b.setupCompletedAt).toBeNull();
  });
});
