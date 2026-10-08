import { randomUUID } from "node:crypto";

import type { OrgContext } from "@/lib/authz/context";
import {
  bagTypes,
  bins,
  buyingPoints,
  commodities,
  customers,
  drivers,
  expenseCategories,
  grades,
  member,
  organisationSettings,
  organization,
  plans,
  subscriptions,
  suppliers,
  user,
  vehicles,
  warehouses,
} from "@/db/schema";
import type { TestDb } from "@/lib/test/setup";

/**
 * Test factories. Direct inserts are allowed HERE ONLY — production code goes
 * through services. Keep these minimal: just enough rows to run a service.
 */

let seq = 0;
const next = () => ++seq;

export type TestOrg = {
  orgId: string;
  userId: string;
  memberId: string;
  planId: string;
  ctx: OrgContext;
};

export async function createTestOrg(
  db: TestDb,
  opts: { name?: string; role?: OrgContext["role"] } = {},
): Promise<TestOrg> {
  const n = next();
  const name = opts.name ?? `Test Org ${n}`;
  const orgId = randomUUID();
  const userId = randomUUID();
  const memberId = randomUUID();
  const now = new Date();

  await db.insert(user).values({
    id: userId,
    name: `Test User ${n}`,
    email: `user${n}-${orgId.slice(0, 8)}@test.local`,
    emailVerified: true,
    phoneNumber: `23480${String(10000000 + n).slice(-8)}`,
    phoneNumberVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(organization).values({
    id: orgId,
    name,
    slug: `test-org-${n}-${orgId.slice(0, 8)}`,
    createdAt: now,
  });

  await db.insert(member).values({
    id: memberId,
    organizationId: orgId,
    userId,
    role: opts.role ?? "owner",
    createdAt: now,
  });

  await db.insert(organisationSettings).values({ organisationId: orgId });

  const [plan] = await db
    .insert(plans)
    .values({
      code: `test-plan-${n}-${orgId.slice(0, 8)}`,
      name: "Test Plan",
      monthlyPriceKobo: 5_000_000,
      userLimit: 25,
    })
    .returning({ id: plans.id });

  await db.insert(subscriptions).values({
    organisationId: orgId,
    planId: plan.id,
    status: "trialing",
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

  const ctx: OrgContext = {
    orgId,
    userId,
    role: opts.role ?? "owner",
    restrictions: { warehouseIds: null, buyingPointIds: null, hidePrices: false },
    readOnly: false,
  };

  return { orgId, userId, memberId, planId: plan.id, ctx };
}

export type TestMasterData = {
  commodityId: string;
  gradeId: string;
  bagTypeId: string;
  warehouseId: string;
  binId: string;
  buyingPointId: string;
  vehicleId: string;
  driverId: string;
  /** affects_landed_cost = true (e.g. loading/handling). */
  handlingCategoryId: string;
  /** affects_landed_cost = false (e.g. storage). */
  storageCategoryId: string;
};

export async function createMasterData(db: TestDb, ctx: OrgContext): Promise<TestMasterData> {
  const n = next();
  const orgCol = { organisationId: ctx.orgId };

  const [commodity] = await db
    .insert(commodities)
    .values({ ...orgCol, name: `Maize ${n}`, code: `MAIZE${n}` })
    .returning({ id: commodities.id });
  const [grade] = await db
    .insert(grades)
    .values({ ...orgCol, commodityId: commodity.id, name: "Grade A", code: "A" })
    .returning({ id: grades.id });
  const [bagType] = await db
    .insert(bagTypes)
    .values({ ...orgCol, name: `100kg bag ${n}`, standardKg: "100.000", sackWeightKg: "1.200" })
    .returning({ id: bagTypes.id });
  const [warehouse] = await db
    .insert(warehouses)
    .values({ ...orgCol, name: `Main Warehouse ${n}`, capacityKg: "500000.000" })
    .returning({ id: warehouses.id });
  const [bin] = await db
    .insert(bins)
    .values({ ...orgCol, warehouseId: warehouse.id, name: "A1" })
    .returning({ id: bins.id });
  const [buyingPoint] = await db
    .insert(buyingPoints)
    .values({ ...orgCol, name: `Market ${n}`, lga: "Akko", state: "Gombe" })
    .returning({ id: buyingPoints.id });
  const [vehicle] = await db
    .insert(vehicles)
    .values({ ...orgCol, plateNumber: `ABC-${1000 + n}`, description: "Truck" })
    .returning({ id: vehicles.id });
  const [driver] = await db
    .insert(drivers)
    .values({ ...orgCol, name: `Driver ${n}`, phone: "2348000000000" })
    .returning({ id: drivers.id });
  const [handling] = await db
    .insert(expenseCategories)
    .values({ ...orgCol, name: `Loading & Handling ${n}`, affectsLandedCost: true })
    .returning({ id: expenseCategories.id });
  const [storage] = await db
    .insert(expenseCategories)
    .values({ ...orgCol, name: `Storage ${n}`, affectsLandedCost: false })
    .returning({ id: expenseCategories.id });

  return {
    commodityId: commodity.id,
    gradeId: grade.id,
    bagTypeId: bagType.id,
    warehouseId: warehouse.id,
    binId: bin.id,
    buyingPointId: buyingPoint.id,
    vehicleId: vehicle.id,
    driverId: driver.id,
    handlingCategoryId: handling.id,
    storageCategoryId: storage.id,
  };
}

export async function createSupplier(
  db: TestDb,
  ctx: OrgContext,
  overrides: Partial<typeof suppliers.$inferInsert> = {},
): Promise<string> {
  const n = next();
  const [row] = await db
    .insert(suppliers)
    .values({
      organisationId: ctx.orgId,
      type: "farmer",
      name: `Supplier ${n}`,
      phone: `23481${String(10000000 + n).slice(-8)}`,
      village: "Kwadon",
      lga: "Yamaltu/Deba",
      state: "Gombe",
      createdBy: ctx.userId,
      ...overrides,
    })
    .returning({ id: suppliers.id });
  return row.id;
}

export async function createCustomer(
  db: TestDb,
  ctx: OrgContext,
  overrides: Partial<typeof customers.$inferInsert> = {},
): Promise<string> {
  const n = next();
  const [row] = await db
    .insert(customers)
    .values({
      organisationId: ctx.orgId,
      name: `Customer ${n}`,
      phone: `23482${String(10000000 + n).slice(-8)}`,
      state: "Lagos",
      createdBy: ctx.userId,
      ...overrides,
    })
    .returning({ id: customers.id });
  return row.id;
}
