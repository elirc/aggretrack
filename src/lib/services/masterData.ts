import { and, asc, count, eq, inArray, type SQL } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db/client";
import {
  bagTypes,
  bins,
  buyingPoints,
  commodities,
  drivers,
  expenseCategories,
  expenses,
  grades,
  organisationSettings,
  vehicles,
  warehouses,
} from "@/db/schema";
import { lotIdsForTrips, recomputeLandedCost } from "@/lib/services/landedCost";
import type { OrgContext } from "@/lib/authz/context";
import { writeAudit } from "@/lib/audit/audit";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import type {
  BagTypeInput,
  BagTypeUpdateInput,
  BinInput,
  BinUpdateInput,
  BuyingPointInput,
  BuyingPointUpdateInput,
  CommodityInput,
  CommodityUpdateInput,
  DriverInput,
  DriverUpdateInput,
  ExpenseCategoryInput,
  ExpenseCategoryUpdateInput,
  GradeInput,
  GradeUpdateInput,
  SetActiveInput,
  VehicleInput,
  VehicleUpdateInput,
  WarehouseInput,
  WarehouseUpdateInput,
} from "@/lib/validation/masterData";

/**
 * Master data service (P1-B).
 *
 * Every function takes (db-or-tx, ctx, input) and scopes by ctx.orgId — the
 * organisation is NEVER read from input. Foreign-org ids behave exactly like
 * missing ids (NOT_FOUND). Every mutation writes an audit row in the same tx.
 *
 * Deletion policy: tables with an `active` flag (commodities, warehouses,
 * buying points) are never deleted — they are deactivated. Tables without one
 * (grades, bag types, bins, vehicles, drivers, expense categories) may be
 * removed only while unreferenced; a foreign-key violation maps to IN_USE.
 */

export type Commodity = typeof commodities.$inferSelect;
export type Grade = typeof grades.$inferSelect;
export type GradeWithCommodity = Grade & { commodityName: string };
export type BagType = typeof bagTypes.$inferSelect;
export type Warehouse = typeof warehouses.$inferSelect;
export type Bin = typeof bins.$inferSelect;
export type WarehouseWithBins = Warehouse & { bins: Bin[] };
export type BuyingPoint = typeof buyingPoints.$inferSelect;
export type Vehicle = typeof vehicles.$inferSelect;
export type Driver = typeof drivers.$inferSelect;
export type ExpenseCategory = typeof expenseCategories.$inferSelect;

export type ListOptions = { includeInactive?: boolean };

// ── helpers ──────────────────────────────────────────────────────────────────

/** Postgres SQLSTATE from a pg error, possibly wrapped by DrizzleQueryError. */
function pgCode(err: unknown): string | undefined {
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
  if (code === "23505") return new DomainError("DUPLICATE", "That name or code is already in use");
  if (code === "23503") return new DomainError("IN_USE", "This record is in use and cannot be removed");
  return err;
}

/** Run a mutation in a transaction (savepoint when already inside one). */
async function mutate<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await (db as Tx).transaction(fn);
  } catch (err) {
    throw mapDbError(err);
  }
}

/** Normalise a kg decimal string to exactly 3 decimals. */
function kg(s: string): string {
  return gramsToKg(kgToGrams(s));
}
function kgOrNull(s: string | null): string | null {
  return s === null ? null : kg(s);
}

function notFound(what: string): never {
  throw new DomainError("NOT_FOUND", `${what} not found`);
}

const now = () => new Date();

// ── Commodities ──────────────────────────────────────────────────────────────

export async function listCommodities(
  db: DbOrTx,
  ctx: OrgContext,
  opts: ListOptions = {},
): Promise<Commodity[]> {
  const where: SQL[] = [eq(commodities.organisationId, ctx.orgId)];
  if (!opts.includeInactive) where.push(eq(commodities.active, true));
  return db
    .select()
    .from(commodities)
    .where(and(...where))
    .orderBy(asc(commodities.name));
}

export async function getCommodity(db: DbOrTx, ctx: OrgContext, id: string): Promise<Commodity> {
  const [row] = await db
    .select()
    .from(commodities)
    .where(and(eq(commodities.organisationId, ctx.orgId), eq(commodities.id, id)))
    .limit(1);
  return row ?? notFound("Commodity");
}

export async function createCommodity(
  db: DbOrTx,
  ctx: OrgContext,
  input: CommodityInput,
): Promise<Commodity> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(commodities)
      .values({
        organisationId: ctx.orgId,
        name: input.name,
        code: input.code,
        active: input.active,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "commodities", recordId: row.id, after: row });
    return row;
  });
}

export async function updateCommodity(
  db: DbOrTx,
  ctx: OrgContext,
  input: CommodityUpdateInput,
): Promise<Commodity> {
  return mutate(db, async (tx) => {
    const before = await getCommodity(tx, ctx, input.id);
    const [row] = await tx
      .update(commodities)
      .set({ name: input.name, code: input.code, active: input.active, updatedAt: now() })
      .where(and(eq(commodities.organisationId, ctx.orgId), eq(commodities.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "commodities", recordId: row.id, before, after: row });
    return row;
  });
}

export async function setCommodityActive(
  db: DbOrTx,
  ctx: OrgContext,
  input: SetActiveInput,
): Promise<Commodity> {
  return mutate(db, async (tx) => {
    const before = await getCommodity(tx, ctx, input.id);
    const [row] = await tx
      .update(commodities)
      .set({ active: input.active, updatedAt: now() })
      .where(and(eq(commodities.organisationId, ctx.orgId), eq(commodities.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "commodities", recordId: row.id, before, after: row });
    return row;
  });
}

// ── Grades ───────────────────────────────────────────────────────────────────

export async function listGrades(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { commodityId?: string } = {},
): Promise<GradeWithCommodity[]> {
  const where: SQL[] = [eq(grades.organisationId, ctx.orgId)];
  if (opts.commodityId) where.push(eq(grades.commodityId, opts.commodityId));
  const rows = await db
    .select({ grade: grades, commodityName: commodities.name })
    .from(grades)
    .innerJoin(
      commodities,
      and(eq(commodities.id, grades.commodityId), eq(commodities.organisationId, ctx.orgId)),
    )
    .where(and(...where))
    .orderBy(asc(commodities.name), asc(grades.name));
  return rows.map((r) => ({ ...r.grade, commodityName: r.commodityName }));
}

export async function getGrade(db: DbOrTx, ctx: OrgContext, id: string): Promise<Grade> {
  const [row] = await db
    .select()
    .from(grades)
    .where(and(eq(grades.organisationId, ctx.orgId), eq(grades.id, id)))
    .limit(1);
  return row ?? notFound("Grade");
}

export async function createGrade(db: DbOrTx, ctx: OrgContext, input: GradeInput): Promise<Grade> {
  return mutate(db, async (tx) => {
    await getCommodity(tx, ctx, input.commodityId); // own-org commodity only
    const [row] = await tx
      .insert(grades)
      .values({
        organisationId: ctx.orgId,
        commodityId: input.commodityId,
        name: input.name,
        code: input.code,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "grades", recordId: row.id, after: row });
    return row;
  });
}

export async function updateGrade(
  db: DbOrTx,
  ctx: OrgContext,
  input: GradeUpdateInput,
): Promise<Grade> {
  return mutate(db, async (tx) => {
    const before = await getGrade(tx, ctx, input.id);
    await getCommodity(tx, ctx, input.commodityId);
    const [row] = await tx
      .update(grades)
      .set({ commodityId: input.commodityId, name: input.name, code: input.code, updatedAt: now() })
      .where(and(eq(grades.organisationId, ctx.orgId), eq(grades.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "grades", recordId: row.id, before, after: row });
    return row;
  });
}

export async function removeGrade(db: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  await mutate(db, async (tx) => {
    const before = await getGrade(tx, ctx, id);
    await tx.delete(grades).where(and(eq(grades.organisationId, ctx.orgId), eq(grades.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "grades", recordId: id, before });
  });
}

// ── Bag types ────────────────────────────────────────────────────────────────

export async function listBagTypes(db: DbOrTx, ctx: OrgContext): Promise<BagType[]> {
  return db
    .select()
    .from(bagTypes)
    .where(eq(bagTypes.organisationId, ctx.orgId))
    .orderBy(asc(bagTypes.name));
}

export async function getBagType(db: DbOrTx, ctx: OrgContext, id: string): Promise<BagType> {
  const [row] = await db
    .select()
    .from(bagTypes)
    .where(and(eq(bagTypes.organisationId, ctx.orgId), eq(bagTypes.id, id)))
    .limit(1);
  return row ?? notFound("Bag type");
}

export async function createBagType(
  db: DbOrTx,
  ctx: OrgContext,
  input: BagTypeInput,
): Promise<BagType> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(bagTypes)
      .values({
        organisationId: ctx.orgId,
        name: input.name,
        standardKg: kg(input.standardKg),
        sackWeightKg: kg(input.sackWeightKg),
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "bag_types", recordId: row.id, after: row });
    return row;
  });
}

export async function updateBagType(
  db: DbOrTx,
  ctx: OrgContext,
  input: BagTypeUpdateInput,
): Promise<BagType> {
  return mutate(db, async (tx) => {
    const before = await getBagType(tx, ctx, input.id);
    const [row] = await tx
      .update(bagTypes)
      .set({
        name: input.name,
        standardKg: kg(input.standardKg),
        sackWeightKg: kg(input.sackWeightKg),
        updatedAt: now(),
      })
      .where(and(eq(bagTypes.organisationId, ctx.orgId), eq(bagTypes.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "bag_types", recordId: row.id, before, after: row });
    return row;
  });
}

export async function removeBagType(db: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  await mutate(db, async (tx) => {
    const before = await getBagType(tx, ctx, id);
    await tx.delete(bagTypes).where(and(eq(bagTypes.organisationId, ctx.orgId), eq(bagTypes.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "bag_types", recordId: id, before });
  });
}

// ── Warehouses ───────────────────────────────────────────────────────────────

/** Read filter: own org + the caller's warehouse restriction (null = all). */
function warehouseReadScope(ctx: OrgContext): SQL[] {
  const where: SQL[] = [eq(warehouses.organisationId, ctx.orgId)];
  const allowed = ctx.restrictions.warehouseIds;
  if (allowed !== null) where.push(inArray(warehouses.id, allowed.length ? allowed : [NIL_UUID]));
  return where;
}
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function listWarehouses(
  db: DbOrTx,
  ctx: OrgContext,
  opts: ListOptions = {},
): Promise<WarehouseWithBins[]> {
  const where = warehouseReadScope(ctx);
  if (!opts.includeInactive) where.push(eq(warehouses.active, true));
  const rows = await db
    .select()
    .from(warehouses)
    .where(and(...where))
    .orderBy(asc(warehouses.name));
  if (rows.length === 0) return [];
  const binRows = await db
    .select()
    .from(bins)
    .where(
      and(
        eq(bins.organisationId, ctx.orgId),
        inArray(
          bins.warehouseId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(bins.name));
  return rows.map((w) => ({ ...w, bins: binRows.filter((b) => b.warehouseId === w.id) }));
}

export async function getWarehouse(db: DbOrTx, ctx: OrgContext, id: string): Promise<WarehouseWithBins> {
  const [row] = await db
    .select()
    .from(warehouses)
    .where(and(...warehouseReadScope(ctx), eq(warehouses.id, id)))
    .limit(1);
  if (!row) notFound("Warehouse");
  const binRows = await db
    .select()
    .from(bins)
    .where(and(eq(bins.organisationId, ctx.orgId), eq(bins.warehouseId, id)))
    .orderBy(asc(bins.name));
  return { ...row, bins: binRows };
}

/** Org-scoped lookup used by mutations (ignores read restrictions). */
async function ownWarehouse(tx: DbOrTx, ctx: OrgContext, id: string): Promise<Warehouse> {
  const [row] = await tx
    .select()
    .from(warehouses)
    .where(and(eq(warehouses.organisationId, ctx.orgId), eq(warehouses.id, id)))
    .limit(1);
  return row ?? notFound("Warehouse");
}

export async function createWarehouse(
  db: DbOrTx,
  ctx: OrgContext,
  input: WarehouseInput,
): Promise<Warehouse> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(warehouses)
      .values({
        organisationId: ctx.orgId,
        name: input.name,
        location: input.location,
        capacityKg: kgOrNull(input.capacityKg),
        active: input.active,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "warehouses", recordId: row.id, after: row });
    return row;
  });
}

export async function updateWarehouse(
  db: DbOrTx,
  ctx: OrgContext,
  input: WarehouseUpdateInput,
): Promise<Warehouse> {
  return mutate(db, async (tx) => {
    const before = await ownWarehouse(tx, ctx, input.id);
    const [row] = await tx
      .update(warehouses)
      .set({
        name: input.name,
        location: input.location,
        capacityKg: kgOrNull(input.capacityKg),
        active: input.active,
        updatedAt: now(),
      })
      .where(and(eq(warehouses.organisationId, ctx.orgId), eq(warehouses.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "warehouses", recordId: row.id, before, after: row });
    return row;
  });
}

export async function setWarehouseActive(
  db: DbOrTx,
  ctx: OrgContext,
  input: SetActiveInput,
): Promise<Warehouse> {
  return mutate(db, async (tx) => {
    const before = await ownWarehouse(tx, ctx, input.id);
    const [row] = await tx
      .update(warehouses)
      .set({ active: input.active, updatedAt: now() })
      .where(and(eq(warehouses.organisationId, ctx.orgId), eq(warehouses.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "warehouses", recordId: row.id, before, after: row });
    return row;
  });
}

// ── Bins ─────────────────────────────────────────────────────────────────────

export async function listBins(
  db: DbOrTx,
  ctx: OrgContext,
  opts: { warehouseId?: string } = {},
): Promise<Bin[]> {
  const where: SQL[] = [eq(bins.organisationId, ctx.orgId)];
  if (opts.warehouseId) where.push(eq(bins.warehouseId, opts.warehouseId));
  return db
    .select()
    .from(bins)
    .where(and(...where))
    .orderBy(asc(bins.name));
}

export async function getBin(db: DbOrTx, ctx: OrgContext, id: string): Promise<Bin> {
  const [row] = await db
    .select()
    .from(bins)
    .where(and(eq(bins.organisationId, ctx.orgId), eq(bins.id, id)))
    .limit(1);
  return row ?? notFound("Bin");
}

export async function createBin(db: DbOrTx, ctx: OrgContext, input: BinInput): Promise<Bin> {
  return mutate(db, async (tx) => {
    await ownWarehouse(tx, ctx, input.warehouseId);
    const [row] = await tx
      .insert(bins)
      .values({ organisationId: ctx.orgId, warehouseId: input.warehouseId, name: input.name })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "bins", recordId: row.id, after: row });
    return row;
  });
}

export async function updateBin(db: DbOrTx, ctx: OrgContext, input: BinUpdateInput): Promise<Bin> {
  return mutate(db, async (tx) => {
    const before = await getBin(tx, ctx, input.id);
    const [row] = await tx
      .update(bins)
      .set({ name: input.name, updatedAt: now() })
      .where(and(eq(bins.organisationId, ctx.orgId), eq(bins.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "bins", recordId: row.id, before, after: row });
    return row;
  });
}

export async function removeBin(db: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  await mutate(db, async (tx) => {
    const before = await getBin(tx, ctx, id);
    await tx.delete(bins).where(and(eq(bins.organisationId, ctx.orgId), eq(bins.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "bins", recordId: id, before });
  });
}

// ── Buying points ────────────────────────────────────────────────────────────

function buyingPointReadScope(ctx: OrgContext): SQL[] {
  const where: SQL[] = [eq(buyingPoints.organisationId, ctx.orgId)];
  const allowed = ctx.restrictions.buyingPointIds;
  if (allowed !== null) where.push(inArray(buyingPoints.id, allowed.length ? allowed : [NIL_UUID]));
  return where;
}

export async function listBuyingPoints(
  db: DbOrTx,
  ctx: OrgContext,
  opts: ListOptions = {},
): Promise<BuyingPoint[]> {
  const where = buyingPointReadScope(ctx);
  if (!opts.includeInactive) where.push(eq(buyingPoints.active, true));
  return db
    .select()
    .from(buyingPoints)
    .where(and(...where))
    .orderBy(asc(buyingPoints.name));
}

export async function getBuyingPoint(db: DbOrTx, ctx: OrgContext, id: string): Promise<BuyingPoint> {
  const [row] = await db
    .select()
    .from(buyingPoints)
    .where(and(...buyingPointReadScope(ctx), eq(buyingPoints.id, id)))
    .limit(1);
  return row ?? notFound("Buying point");
}

async function ownBuyingPoint(tx: DbOrTx, ctx: OrgContext, id: string): Promise<BuyingPoint> {
  const [row] = await tx
    .select()
    .from(buyingPoints)
    .where(and(eq(buyingPoints.organisationId, ctx.orgId), eq(buyingPoints.id, id)))
    .limit(1);
  return row ?? notFound("Buying point");
}

export async function createBuyingPoint(
  db: DbOrTx,
  ctx: OrgContext,
  input: BuyingPointInput,
): Promise<BuyingPoint> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(buyingPoints)
      .values({
        organisationId: ctx.orgId,
        name: input.name,
        lga: input.lga,
        state: input.state,
        active: input.active,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "buying_points", recordId: row.id, after: row });
    return row;
  });
}

export async function updateBuyingPoint(
  db: DbOrTx,
  ctx: OrgContext,
  input: BuyingPointUpdateInput,
): Promise<BuyingPoint> {
  return mutate(db, async (tx) => {
    const before = await ownBuyingPoint(tx, ctx, input.id);
    const [row] = await tx
      .update(buyingPoints)
      .set({
        name: input.name,
        lga: input.lga,
        state: input.state,
        active: input.active,
        updatedAt: now(),
      })
      .where(and(eq(buyingPoints.organisationId, ctx.orgId), eq(buyingPoints.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "buying_points", recordId: row.id, before, after: row });
    return row;
  });
}

export async function setBuyingPointActive(
  db: DbOrTx,
  ctx: OrgContext,
  input: SetActiveInput,
): Promise<BuyingPoint> {
  return mutate(db, async (tx) => {
    const before = await ownBuyingPoint(tx, ctx, input.id);
    const [row] = await tx
      .update(buyingPoints)
      .set({ active: input.active, updatedAt: now() })
      .where(and(eq(buyingPoints.organisationId, ctx.orgId), eq(buyingPoints.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "buying_points", recordId: row.id, before, after: row });
    return row;
  });
}

// ── Vehicles ─────────────────────────────────────────────────────────────────

export async function listVehicles(db: DbOrTx, ctx: OrgContext): Promise<Vehicle[]> {
  return db
    .select()
    .from(vehicles)
    .where(eq(vehicles.organisationId, ctx.orgId))
    .orderBy(asc(vehicles.plateNumber));
}

export async function getVehicle(db: DbOrTx, ctx: OrgContext, id: string): Promise<Vehicle> {
  const [row] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.organisationId, ctx.orgId), eq(vehicles.id, id)))
    .limit(1);
  return row ?? notFound("Vehicle");
}

export async function createVehicle(
  db: DbOrTx,
  ctx: OrgContext,
  input: VehicleInput,
): Promise<Vehicle> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(vehicles)
      .values({
        organisationId: ctx.orgId,
        plateNumber: input.plateNumber,
        description: input.description,
        capacityKg: kgOrNull(input.capacityKg),
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "vehicles", recordId: row.id, after: row });
    return row;
  });
}

export async function updateVehicle(
  db: DbOrTx,
  ctx: OrgContext,
  input: VehicleUpdateInput,
): Promise<Vehicle> {
  return mutate(db, async (tx) => {
    const before = await getVehicle(tx, ctx, input.id);
    const [row] = await tx
      .update(vehicles)
      .set({
        plateNumber: input.plateNumber,
        description: input.description,
        capacityKg: kgOrNull(input.capacityKg),
        updatedAt: now(),
      })
      .where(and(eq(vehicles.organisationId, ctx.orgId), eq(vehicles.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "vehicles", recordId: row.id, before, after: row });
    return row;
  });
}

export async function removeVehicle(db: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  await mutate(db, async (tx) => {
    const before = await getVehicle(tx, ctx, id);
    await tx.delete(vehicles).where(and(eq(vehicles.organisationId, ctx.orgId), eq(vehicles.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "vehicles", recordId: id, before });
  });
}

// ── Drivers ──────────────────────────────────────────────────────────────────

export async function listDrivers(db: DbOrTx, ctx: OrgContext): Promise<Driver[]> {
  return db
    .select()
    .from(drivers)
    .where(eq(drivers.organisationId, ctx.orgId))
    .orderBy(asc(drivers.name));
}

export async function getDriver(db: DbOrTx, ctx: OrgContext, id: string): Promise<Driver> {
  const [row] = await db
    .select()
    .from(drivers)
    .where(and(eq(drivers.organisationId, ctx.orgId), eq(drivers.id, id)))
    .limit(1);
  return row ?? notFound("Driver");
}

export async function createDriver(db: DbOrTx, ctx: OrgContext, input: DriverInput): Promise<Driver> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(drivers)
      .values({
        organisationId: ctx.orgId,
        name: input.name,
        phone: input.phone,
        licenceNote: input.licenceNote,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "drivers", recordId: row.id, after: row });
    return row;
  });
}

export async function updateDriver(
  db: DbOrTx,
  ctx: OrgContext,
  input: DriverUpdateInput,
): Promise<Driver> {
  return mutate(db, async (tx) => {
    const before = await getDriver(tx, ctx, input.id);
    const [row] = await tx
      .update(drivers)
      .set({ name: input.name, phone: input.phone, licenceNote: input.licenceNote, updatedAt: now() })
      .where(and(eq(drivers.organisationId, ctx.orgId), eq(drivers.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, { action: "update", tableName: "drivers", recordId: row.id, before, after: row });
    return row;
  });
}

export async function removeDriver(db: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  await mutate(db, async (tx) => {
    const before = await getDriver(tx, ctx, id);
    await tx.delete(drivers).where(and(eq(drivers.organisationId, ctx.orgId), eq(drivers.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "drivers", recordId: id, before });
  });
}

// ── Expense categories ───────────────────────────────────────────────────────

export async function listExpenseCategories(db: DbOrTx, ctx: OrgContext): Promise<ExpenseCategory[]> {
  return db
    .select()
    .from(expenseCategories)
    .where(eq(expenseCategories.organisationId, ctx.orgId))
    .orderBy(asc(expenseCategories.name));
}

export async function getExpenseCategory(
  db: DbOrTx,
  ctx: OrgContext,
  id: string,
): Promise<ExpenseCategory> {
  const [row] = await db
    .select()
    .from(expenseCategories)
    .where(and(eq(expenseCategories.organisationId, ctx.orgId), eq(expenseCategories.id, id)))
    .limit(1);
  return row ?? notFound("Expense category");
}

export async function createExpenseCategory(
  db: DbOrTx,
  ctx: OrgContext,
  input: ExpenseCategoryInput,
): Promise<ExpenseCategory> {
  return mutate(db, async (tx) => {
    const [row] = await tx
      .insert(expenseCategories)
      .values({
        organisationId: ctx.orgId,
        name: input.name,
        affectsLandedCost: input.affectsLandedCost,
      })
      .returning();
    await writeAudit(tx, ctx, { action: "create", tableName: "expense_categories", recordId: row.id, after: row });
    return row;
  });
}

export async function updateExpenseCategory(
  db: DbOrTx,
  ctx: OrgContext,
  input: ExpenseCategoryUpdateInput,
): Promise<ExpenseCategory> {
  return mutate(db, async (tx) => {
    const before = await getExpenseCategory(tx, ctx, input.id);
    const [row] = await tx
      .update(expenseCategories)
      .set({ name: input.name, affectsLandedCost: input.affectsLandedCost, updatedAt: now() })
      .where(and(eq(expenseCategories.organisationId, ctx.orgId), eq(expenseCategories.id, input.id)))
      .returning();
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "expense_categories",
      recordId: row.id,
      before,
      after: row,
    });
    // Flipping affects_landed_cost changes which expenses share into lot
    // costs, so every lot touched by this category's expenses (directly or
    // via a trip) must be re-costed.
    if (before.affectsLandedCost !== row.affectsLandedCost) {
      const catExpenses = await tx
        .select({ lotId: expenses.lotId, tripId: expenses.tripId })
        .from(expenses)
        .where(and(eq(expenses.organisationId, ctx.orgId), eq(expenses.categoryId, row.id)));
      const lotIds = new Set(catExpenses.map((e) => e.lotId).filter((v): v is string => !!v));
      const tripIds = [...new Set(catExpenses.map((e) => e.tripId).filter((v): v is string => !!v))];
      if (tripIds.length > 0) {
        for (const id of await lotIdsForTrips(tx, ctx, tripIds)) lotIds.add(id);
      }
      if (lotIds.size > 0) {
        await recomputeLandedCost(tx, ctx, [...lotIds]);
      }
    }
    return row;
  });
}

export async function removeExpenseCategory(db: DbOrTx, ctx: OrgContext, id: string): Promise<void> {
  await mutate(db, async (tx) => {
    const before = await getExpenseCategory(tx, ctx, id);
    await tx
      .delete(expenseCategories)
      .where(and(eq(expenseCategories.organisationId, ctx.orgId), eq(expenseCategories.id, id)));
    await writeAudit(tx, ctx, { action: "cancel", tableName: "expense_categories", recordId: id, before });
  });
}

// ── Setup wizard ─────────────────────────────────────────────────────────────

export type SetupStatus = {
  setupCompletedAt: Date | null;
  counts: {
    commodities: number;
    grades: number;
    bagTypes: number;
    warehouses: number;
    buyingPoints: number;
  };
};

export async function getSetupStatus(db: DbOrTx, ctx: OrgContext): Promise<SetupStatus> {
  const [settings] = await db
    .select({ setupCompletedAt: organisationSettings.setupCompletedAt })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, ctx.orgId))
    .limit(1);
  const c = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [nCommodities, nGrades, nBagTypes, nWarehouses, nBuyingPoints] = await Promise.all([
    c(db.select({ n: count() }).from(commodities).where(eq(commodities.organisationId, ctx.orgId))),
    c(db.select({ n: count() }).from(grades).where(eq(grades.organisationId, ctx.orgId))),
    c(db.select({ n: count() }).from(bagTypes).where(eq(bagTypes.organisationId, ctx.orgId))),
    c(db.select({ n: count() }).from(warehouses).where(eq(warehouses.organisationId, ctx.orgId))),
    c(db.select({ n: count() }).from(buyingPoints).where(eq(buyingPoints.organisationId, ctx.orgId))),
  ]);
  return {
    setupCompletedAt: settings?.setupCompletedAt ?? null,
    counts: {
      commodities: nCommodities,
      grades: nGrades,
      bagTypes: nBagTypes,
      warehouses: nWarehouses,
      buyingPoints: nBuyingPoints,
    },
  };
}

/** Marks the onboarding wizard finished (idempotent: keeps the first timestamp). */
export async function completeSetup(db: DbOrTx, ctx: OrgContext): Promise<{ setupCompletedAt: Date }> {
  return mutate(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, ctx.orgId))
      .limit(1);
    if (before?.setupCompletedAt) return { setupCompletedAt: before.setupCompletedAt };

    const at = now();
    const [row] = await tx
      .insert(organisationSettings)
      .values({ organisationId: ctx.orgId, setupCompletedAt: at })
      .onConflictDoUpdate({
        target: organisationSettings.organisationId,
        set: { setupCompletedAt: at, updatedAt: at },
      })
      .returning();
    await writeAudit(tx, ctx, {
      action: "update",
      tableName: "organisation_settings",
      recordId: ctx.orgId,
      before: before ?? null,
      after: row,
    });
    return { setupCompletedAt: at };
  });
}
