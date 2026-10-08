import { z } from "zod";

import { zKgString, zKobo, zUuid } from "./common";

/**
 * Master data + platform admin schemas (P1-B).
 * Shared by react-hook-form (zodResolver), server actions and services.
 * Form inputs are strings/booleans; empty optional text becomes null.
 */

const zName = z.string().trim().min(1, "Required").max(120, "Too long");

/** Optional free text: "" / undefined → null. */
const zOptText = z
  .string()
  .trim()
  .max(200, "Too long")
  .nullish()
  .transform((v) => (v ? v : null));

/** Optional kg string: "" / undefined → null. */
const zOptKg = z
  .union([z.literal(""), zKgString])
  .nullish()
  .transform((v) => (v ? v : null));

const zPositiveKg = zKgString.refine((s) => Number(s) > 0, "Must be more than 0 kg");

const zCode = z
  .string()
  .trim()
  .min(1, "Required")
  .max(20, "Max 20 characters")
  .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only")
  .transform((s) => s.toUpperCase());

const zOptCode = z
  .union([z.literal(""), zCode])
  .nullish()
  .transform((v) => (v ? v : null));

export const idInput = z.object({ id: zUuid });
export type IdInput = z.output<typeof idInput>;

export const setActiveInput = z.object({ id: zUuid, active: z.boolean() });
export type SetActiveInput = z.output<typeof setActiveInput>;

// ── Commodities ──────────────────────────────────────────────────────────────
export const commodityInput = z.object({
  name: zName,
  code: zCode,
  active: z.boolean().default(true),
});
export const commodityUpdateInput = commodityInput.extend({ id: zUuid });
export type CommodityInput = z.output<typeof commodityInput>;
export type CommodityUpdateInput = z.output<typeof commodityUpdateInput>;

// ── Grades ───────────────────────────────────────────────────────────────────
export const gradeInput = z.object({
  commodityId: zUuid,
  name: zName,
  code: zOptCode,
});
export const gradeUpdateInput = gradeInput.extend({ id: zUuid });
export type GradeInput = z.output<typeof gradeInput>;
export type GradeUpdateInput = z.output<typeof gradeUpdateInput>;

// ── Bag types ────────────────────────────────────────────────────────────────
export const bagTypeInput = z.object({
  name: zName,
  standardKg: zPositiveKg,
  sackWeightKg: z
    .union([z.literal(""), zKgString])
    .nullish()
    .transform((v) => (v ? v : "0")),
});
export const bagTypeUpdateInput = bagTypeInput.extend({ id: zUuid });
export type BagTypeInput = z.output<typeof bagTypeInput>;
export type BagTypeUpdateInput = z.output<typeof bagTypeUpdateInput>;

// ── Warehouses + bins ────────────────────────────────────────────────────────
export const warehouseInput = z.object({
  name: zName,
  location: zOptText,
  capacityKg: zOptKg,
  active: z.boolean().default(true),
});
export const warehouseUpdateInput = warehouseInput.extend({ id: zUuid });
export type WarehouseInput = z.output<typeof warehouseInput>;
export type WarehouseUpdateInput = z.output<typeof warehouseUpdateInput>;

export const binInput = z.object({ warehouseId: zUuid, name: zName });
export const binUpdateInput = z.object({ id: zUuid, name: zName });
export type BinInput = z.output<typeof binInput>;
export type BinUpdateInput = z.output<typeof binUpdateInput>;

// ── Buying points ────────────────────────────────────────────────────────────
export const buyingPointInput = z.object({
  name: zName,
  lga: zOptText,
  state: zOptText,
  active: z.boolean().default(true),
});
export const buyingPointUpdateInput = buyingPointInput.extend({ id: zUuid });
export type BuyingPointInput = z.output<typeof buyingPointInput>;
export type BuyingPointUpdateInput = z.output<typeof buyingPointUpdateInput>;

// ── Vehicles ─────────────────────────────────────────────────────────────────
export const vehicleInput = z.object({
  plateNumber: z
    .string()
    .trim()
    .min(1, "Required")
    .max(20, "Max 20 characters")
    .transform((s) => s.toUpperCase().replace(/\s+/g, " ")),
  description: zOptText,
  capacityKg: zOptKg,
});
export const vehicleUpdateInput = vehicleInput.extend({ id: zUuid });
export type VehicleInput = z.output<typeof vehicleInput>;
export type VehicleUpdateInput = z.output<typeof vehicleUpdateInput>;

// ── Drivers ──────────────────────────────────────────────────────────────────
export const driverInput = z.object({
  name: zName,
  phone: z
    .string()
    .trim()
    .max(20, "Too long")
    .regex(/^[+\d\s()-]*$/, "Digits only")
    .nullish()
    .transform((v) => (v ? v : null)),
  licenceNote: zOptText,
});
export const driverUpdateInput = driverInput.extend({ id: zUuid });
export type DriverInput = z.output<typeof driverInput>;
export type DriverUpdateInput = z.output<typeof driverUpdateInput>;

// ── Expense categories ───────────────────────────────────────────────────────
export const expenseCategoryInput = z.object({
  name: zName,
  affectsLandedCost: z.boolean().default(false),
});
export const expenseCategoryUpdateInput = expenseCategoryInput.extend({ id: zUuid });
export type ExpenseCategoryInput = z.output<typeof expenseCategoryInput>;
export type ExpenseCategoryUpdateInput = z.output<typeof expenseCategoryUpdateInput>;

// ── Onboarding ───────────────────────────────────────────────────────────────
export const completeSetupInput = z.object({});

// ── Platform admin ───────────────────────────────────────────────────────────
export const planInput = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Required")
    .max(40, "Too long")
    .regex(/^[a-z0-9_-]+$/i, "Letters, numbers, - and _ only")
    .transform((s) => s.toLowerCase()),
  name: zName,
  monthlyPriceKobo: zKobo,
  userLimit: z.number().int("Whole number").min(1, "At least 1"),
  paystackPlanCode: zOptText,
  active: z.boolean().default(true),
});
export const planUpdateInput = planInput.extend({ id: zUuid });
export type PlanInput = z.output<typeof planInput>;
export type PlanUpdateInput = z.output<typeof planUpdateInput>;

export const setOrgReadOnlyInput = z.object({
  organisationId: z.string().trim().min(1),
  readOnly: z.boolean(),
});
export type SetOrgReadOnlyInput = z.output<typeof setOrgReadOnlyInput>;

const zOptDate = z
  .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd")])
  .nullish()
  .transform((v) => (v ? v : null));

export const platformAuditQuery = z.object({
  organisationId: zOptText,
  tableName: zOptText,
  from: zOptDate,
  to: zOptDate,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type PlatformAuditQuery = z.output<typeof platformAuditQuery>;

export const platformOrgQuery = z.object({
  q: zOptText,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type PlatformOrgQuery = z.output<typeof platformOrgQuery>;
