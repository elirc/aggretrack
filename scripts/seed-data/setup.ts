/**
 * Seed phase 1: database reset/migrate, platform admin, plans, the demo
 * organisation, one login per role, master data, price guides, suppliers and
 * customers. Business rows go through the services; only the auth/tenant
 * bootstrap (what Better Auth's sign-up + organization plugin would write)
 * is inserted directly.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

import type { Db } from "../../src/db/client";
import { account, member, organization, subscriptions, user } from "../../src/db/schema";
import type { OrgContext } from "../../src/lib/authz/context";
import { can, type Permission } from "../../src/lib/authz/permissions";
import * as md from "../../src/lib/services/masterData";
import { createPlan } from "../../src/lib/services/platform";
import { createPriceGuide } from "../../src/lib/services/priceGuides";
import { createSupplier } from "../../src/lib/services/suppliers";
import { createCustomer } from "../../src/lib/services/customers";
import { addMember, initialiseOrganisation, setMemberRestrictions } from "../../src/lib/services/users";
import { priceGuideInput, supplierInput } from "../../src/lib/validation/buying";
import {
  bagTypeInput,
  binInput,
  buyingPointInput,
  commodityInput,
  driverInput,
  expenseCategoryInput,
  gradeInput,
  planInput,
  vehicleInput,
  warehouseInput,
} from "../../src/lib/validation/masterData";
import { addMemberSchema } from "../../src/lib/validation/users";

import {
  AGENT_NAMES,
  BAG_TYPES,
  BANKS,
  BUYING_POINTS,
  COMMODITIES,
  COOPERATIVES,
  CUSTOMERS,
  DEMO_ORG,
  DEMO_PASSWORD,
  DRIVERS,
  EXPENSE_CATEGORIES,
  FIRST_NAMES,
  GRADES,
  LAST_NAMES,
  PLANS,
  PLATFORM_ADMIN,
  ROLE_USERS,
  VEHICLES,
  VILLAGES,
  WAREHOUSES,
  type BuyingPointKey,
  type CommodityCode,
  type CommoditySpec,
  type ExpenseKey,
  type GradeKey,
  type SeedRole,
} from "./constants";
import type { Calendar } from "./dates";
import type { Rng } from "./rng";

// ── DB lifecycle ─────────────────────────────────────────────────────────────

export const RESETTABLE_DBS = ["aggretrack_dev", "aggretrack_e2e"] as const;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aggretrack_dev";
}

export function databaseName(url = databaseUrl()): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Drop + recreate the DATABASE_URL database. Only aggretrack_dev / aggretrack_e2e. */
export async function resetDatabase(): Promise<void> {
  const url = databaseUrl();
  const name = databaseName(url);
  if (!(RESETTABLE_DBS as readonly string[]).includes(name)) {
    throw new Error(`--reset refused: database "${name}" is not one of ${RESETTABLE_DBS.join(", ")}`);
  }
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  console.log(`reset     ${name} (dropped + created)`);
}

/** Apply drizzle migrations (idempotent) on a dedicated single connection. */
export async function migrateDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
  } finally {
    await pool.end();
  }
  console.log(`migrated  ${databaseName()}`);
}

// ── guard helper (mirrors the orgAction permission check) ───────────────────

export function act(ctx: OrgContext, permission: Permission): void {
  if (!can(ctx.role, permission)) {
    throw new Error(`seed bug: role ${ctx.role} lacks ${permission}`);
  }
}

// ── types handed to the history phase ───────────────────────────────────────

export type Ctxs = Record<SeedRole, OrgContext>;

export type CommodityRef = CommoditySpec & { id: string; grades: Record<GradeKey, string> };

export type Master = {
  orgId: string;
  commodities: Record<CommodityCode, CommodityRef>;
  bagTypes: Record<"100" | "50", string>;
  warehouses: Record<"main" | "billiri", { id: string; name: string; bins: string[] }>;
  buyingPoints: Record<BuyingPointKey, { id: string; name: string; priceFactor: number }>;
  vehicles: string[];
  drivers: string[];
  categories: Record<ExpenseKey, string>;
  /** guide[commodityCode][bpKey][monthStart] = max kobo/kg */
  guides: Record<string, Record<string, Record<string, number>>>;
};

export type SupplierRef = { id: string; name: string; type: "farmer" | "agent" | "cooperative"; bp: BuyingPointKey };
export type CustomerRef = { id: string; name: string; city: "Lagos" | "Kano" | "Port Harcourt"; weight: number };

// ── identity bootstrap ──────────────────────────────────────────────────────

async function insertUserWithPassword(
  db: Db,
  u: { name: string; phone: string; email: string; isPlatformAdmin?: boolean },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const hash = await hashPassword(DEMO_PASSWORD);
  await db.insert(user).values({
    id,
    name: u.name,
    email: u.email,
    emailVerified: true,
    phoneNumber: u.phone,
    phoneNumberVerified: true,
    isPlatformAdmin: u.isPlatformAdmin ?? false,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(account).values({
    id: randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: hash,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function demoOrgExists(db: Db): Promise<boolean> {
  const rows = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, DEMO_ORG.slug));
  return rows.length > 0;
}

function ctxFor(orgId: string, userId: string, role: SeedRole, r: Partial<OrgContext["restrictions"]> = {}): OrgContext {
  return {
    orgId,
    userId,
    role,
    restrictions: { warehouseIds: r.warehouseIds ?? null, buyingPointIds: r.buyingPointIds ?? null, hidePrices: false },
    readOnly: false,
  };
}

export async function seedIdentity(db: Db): Promise<{ orgId: string; ctxs: Ctxs; memberIds: Record<SeedRole, string>; platformAdminId: string }> {
  // 1. platform admin (no org membership)
  const platformAdminId = await insertUserWithPassword(db, {
    name: PLATFORM_ADMIN.name,
    phone: PLATFORM_ADMIN.phone,
    email: PLATFORM_ADMIN.email,
    isPlatformAdmin: true,
  });

  // 2. plans (platform service)
  const planIds: Record<string, string> = {};
  for (const p of PLANS) {
    const row = await createPlan(db, { userId: platformAdminId }, planInput.parse({ ...p, active: true }));
    planIds[p.code] = row.id;
  }

  // 3. demo org + owner — what the register flow (Better Auth sign-up +
  //    organization.create) writes, then our initialiseOrganisation service.
  const ownerSpec = ROLE_USERS.find((u) => u.role === "owner")!;
  const ownerId = await insertUserWithPassword(db, ownerSpec);
  const orgId = randomUUID();
  await db.insert(organization).values({ id: orgId, name: DEMO_ORG.name, slug: DEMO_ORG.slug, createdAt: new Date() });
  const ownerMemberId = randomUUID();
  await db.insert(member).values({ id: ownerMemberId, organizationId: orgId, userId: ownerId, role: "owner", createdAt: new Date() });
  // Subscription first so initialiseOrganisation keeps it (idempotent: it only
  // inserts the settings row when a subscription already exists).
  // DEVIATION: on "growth" not "starter" — starter's user_limit 5 cannot hold
  // the 6 role logins (addMember enforces the plan limit).
  await db.insert(subscriptions).values({
    organisationId: orgId,
    planId: planIds.growth,
    status: "trialing",
    trialEndsAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
  });
  const owner = ctxFor(orgId, ownerId, "owner");
  act(owner, "org.settings");
  await initialiseOrganisation(db, owner);

  // 4. the other five roles via the users service
  const ctxs = { owner } as Ctxs;
  const memberIds = { owner: ownerMemberId } as Record<SeedRole, string>;
  for (const u of ROLE_USERS) {
    if (u.role === "owner") continue;
    act(owner, "users.manage");
    const res = await addMember(
      db,
      owner,
      addMemberSchema.parse({ name: u.name, phone: u.phone, role: u.role, email: u.email, password: DEMO_PASSWORD }),
    );
    ctxs[u.role] = ctxFor(orgId, res.userId, u.role);
    memberIds[u.role] = res.memberId;
  }
  return { orgId, ctxs, memberIds, platformAdminId };
}

/** Warehouse keeper → warehouse 1 only; procurement → buying points 1 + 2. */
export async function applyRestrictions(db: Db, ctxs: Ctxs, memberIds: Record<SeedRole, string>, m: Master): Promise<void> {
  act(ctxs.owner, "users.manage");
  await setMemberRestrictions(db, ctxs.owner, {
    memberId: memberIds.warehouse,
    warehouseIds: [m.warehouses.main.id],
    buyingPointIds: [],
  });
  await setMemberRestrictions(db, ctxs.owner, {
    memberId: memberIds.procurement,
    warehouseIds: [],
    buyingPointIds: [m.buyingPoints.kwadon.id, m.buyingPoints.billiri.id],
  });
  ctxs.warehouse.restrictions.warehouseIds = [m.warehouses.main.id];
  ctxs.procurement.restrictions.buyingPointIds = [m.buyingPoints.kwadon.id, m.buyingPoints.billiri.id];
}

// ── master data ─────────────────────────────────────────────────────────────

export async function seedMasterData(db: Db, ctxs: Ctxs, cal: Calendar): Promise<Master> {
  const ctx = ctxs.owner;
  act(ctx, "master-data.write");

  const commodities = {} as Record<CommodityCode, CommodityRef>;
  for (const c of COMMODITIES) {
    const row = await md.createCommodity(db, ctx, commodityInput.parse({ name: c.name, code: c.code }));
    const grades = {} as Record<GradeKey, string>;
    for (const g of GRADES) {
      const gr = await md.createGrade(db, ctx, gradeInput.parse({ commodityId: row.id, name: g.name, code: g.key }));
      grades[g.key] = gr.id;
    }
    commodities[c.code] = { ...c, id: row.id, grades };
  }

  const bagTypes = {} as Record<"100" | "50", string>;
  for (const b of BAG_TYPES) {
    const row = await md.createBagType(
      db,
      ctx,
      bagTypeInput.parse({ name: b.name, standardKg: b.standardKg, sackWeightKg: b.sackWeightKg }),
    );
    bagTypes[b.key] = row.id;
  }

  const warehouses = {} as Master["warehouses"];
  for (const w of WAREHOUSES) {
    const row = await md.createWarehouse(
      db,
      ctx,
      warehouseInput.parse({ name: w.name, location: w.location, capacityKg: w.capacityKg }),
    );
    const bins: string[] = [];
    for (const b of w.bins) {
      const bin = await md.createBin(db, ctx, binInput.parse({ warehouseId: row.id, name: b }));
      bins.push(bin.id);
    }
    warehouses[w.key] = { id: row.id, name: w.name, bins };
  }

  const buyingPoints = {} as Master["buyingPoints"];
  for (const bp of BUYING_POINTS) {
    const row = await md.createBuyingPoint(db, ctx, buyingPointInput.parse({ name: bp.name, lga: bp.lga, state: bp.state }));
    buyingPoints[bp.key] = { id: row.id, name: bp.name, priceFactor: bp.priceFactor };
  }

  const vehicles: string[] = [];
  for (const v of VEHICLES) vehicles.push((await md.createVehicle(db, ctx, vehicleInput.parse(v))).id);
  const drivers: string[] = [];
  for (const d of DRIVERS) drivers.push((await md.createDriver(db, ctx, driverInput.parse(d))).id);

  const categories = {} as Record<ExpenseKey, string>;
  for (const e of EXPENSE_CATEGORIES) {
    const row = await md.createExpenseCategory(
      db,
      ctx,
      expenseCategoryInput.parse({ name: e.name, affectsLandedCost: e.affectsLandedCost }),
    );
    categories[e.key] = row.id;
  }

  await md.completeSetup(db, ctx);

  const m: Master = {
    orgId: ctx.orgId,
    commodities,
    bagTypes,
    warehouses,
    buyingPoints,
    vehicles,
    drivers,
    categories,
    guides: {},
  };
  await seedPriceGuides(db, ctxs.manager, cal, m);
  return m;
}

/** Daily drift of farm-gate prices across the window (~+7% over 90 days). */
export function priceIndex(day: number): number {
  return 1 + 0.0008 * day;
}

async function seedPriceGuides(db: Db, ctx: OrgContext, cal: Calendar, m: Master): Promise<void> {
  act(ctx, "price-guide.write");
  for (const c of COMMODITIES.filter((x) => x.guided)) {
    m.guides[c.code] = {};
    for (const bp of BUYING_POINTS) {
      m.guides[c.code][bp.key] = {};
      for (const monthStart of cal.monthStarts()) {
        const day = cal.dayOf(monthStart);
        // A guide is the MAX buying price: ~6% above the typical grade A price.
        const kobo = Math.round((c.baseBuyKobo * priceIndex(Math.max(day, 0)) * bp.priceFactor * 1.06) / 500) * 500;
        await createPriceGuide(
          db,
          ctx,
          priceGuideInput.parse({
            commodityId: m.commodities[c.code].id,
            gradeId: null,
            buyingPointId: m.buyingPoints[bp.key].id,
            guideDate: monthStart,
            maxPricePerKgKobo: kobo,
          }),
        );
        m.guides[c.code][bp.key][monthStart] = kobo;
      }
    }
  }
}

/** Guide in force on a date (latest month start ≤ date). */
export function guideFor(m: Master, code: CommodityCode, bp: BuyingPointKey, date: string): number | null {
  const byMonth = m.guides[code]?.[bp];
  if (!byMonth) return null;
  const keys = Object.keys(byMonth).filter((k) => k <= date).sort();
  return keys.length ? byMonth[keys[keys.length - 1]] : null;
}

// ── parties ─────────────────────────────────────────────────────────────────

export async function seedSuppliers(db: Db, ctx: OrgContext, rng: Rng): Promise<SupplierRef[]> {
  act(ctx, "supplier.write");
  const out: SupplierRef[] = [];
  const usedPhones = new Set<string>();
  const phone = () => {
    let p: string;
    do p = `23481${rng.digits(8)}`;
    while (usedPhones.has(p));
    usedPhones.add(p);
    return p;
  };
  const bank = () =>
    rng.chance(0.6)
      ? { bankName: rng.pick(BANKS), bankAccountNumber: `0${rng.digits(9)}` }
      : { bankName: null, bankAccountNumber: null };

  const specs: Array<{ type: SupplierRef["type"]; name: string; village: string }> = [];
  for (const c of COOPERATIVES) specs.push({ type: "cooperative", name: c.name, village: c.village });
  for (const a of AGENT_NAMES) specs.push({ type: "agent", name: a, village: rng.pick(VILLAGES).village });
  const usedNames = new Set(specs.map((s) => s.name));
  while (specs.length < 40) {
    const name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    specs.push({ type: "farmer", name, village: rng.pick(VILLAGES).village });
  }

  for (const s of rng.shuffle(specs)) {
    const v = VILLAGES.find((x) => x.village === s.village)!;
    const b = bank();
    const row = await createSupplier(
      db,
      ctx,
      supplierInput.parse({
        type: s.type,
        name: s.name,
        phone: phone(),
        village: v.village,
        lga: v.lga,
        state: "Gombe",
        bankName: b.bankName,
        bankAccountNumber: b.bankAccountNumber,
        bankAccountName: b.bankName ? s.name : null,
        idNote: s.type === "farmer" && rng.chance(0.5) ? `NIN on file (${rng.digits(4)})` : null,
        photoKey: null,
      }),
    );
    out.push({ id: row.id, name: row.name, type: s.type, bp: v.bp });
  }
  return out;
}

export async function seedCustomers(db: Db, ctx: OrgContext): Promise<CustomerRef[]> {
  act(ctx, "customer.write");
  const out: CustomerRef[] = [];
  for (const c of CUSTOMERS) {
    const row = await createCustomer(db, ctx, {
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,
      state: c.state,
      note: `Delivery to ${c.city}`,
    });
    out.push({ id: row.id, name: row.name, city: c.city, weight: c.weight });
  }
  return out;
}
