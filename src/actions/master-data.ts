"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as md from "@/lib/services/masterData";
import {
  bagTypeInput,
  bagTypeUpdateInput,
  binInput,
  binUpdateInput,
  buyingPointInput,
  buyingPointUpdateInput,
  commodityInput,
  commodityUpdateInput,
  completeSetupInput,
  driverInput,
  driverUpdateInput,
  expenseCategoryInput,
  expenseCategoryUpdateInput,
  gradeInput,
  gradeUpdateInput,
  idInput,
  setActiveInput,
  vehicleInput,
  vehicleUpdateInput,
  warehouseInput,
  warehouseUpdateInput,
} from "@/lib/validation/masterData";

/**
 * Master data server actions (P1-B). Every action goes through orgAction:
 * the organisation comes from the session, never from input.
 */

function refresh() {
  revalidatePath("/settings/master-data");
  revalidatePath("/onboarding");
}

const W = "master-data.write" as const;

// ── Commodities ──
export const createCommodityAction = orgAction({
  permission: W,
  schema: commodityInput,
  handler: async (input, ctx) => {
    const row = await md.createCommodity(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateCommodityAction = orgAction({
  permission: W,
  schema: commodityUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateCommodity(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const setCommodityActiveAction = orgAction({
  permission: W,
  schema: setActiveInput,
  handler: async (input, ctx) => {
    const row = await md.setCommodityActive(db, ctx, input);
    refresh();
    return { id: row.id, active: row.active };
  },
});

// ── Grades ──
export const createGradeAction = orgAction({
  permission: W,
  schema: gradeInput,
  handler: async (input, ctx) => {
    const row = await md.createGrade(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateGradeAction = orgAction({
  permission: W,
  schema: gradeUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateGrade(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const removeGradeAction = orgAction({
  permission: W,
  schema: idInput,
  handler: async (input, ctx) => {
    await md.removeGrade(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

// ── Bag types ──
export const createBagTypeAction = orgAction({
  permission: W,
  schema: bagTypeInput,
  handler: async (input, ctx) => {
    const row = await md.createBagType(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateBagTypeAction = orgAction({
  permission: W,
  schema: bagTypeUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateBagType(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const removeBagTypeAction = orgAction({
  permission: W,
  schema: idInput,
  handler: async (input, ctx) => {
    await md.removeBagType(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

// ── Warehouses ──
export const createWarehouseAction = orgAction({
  permission: W,
  schema: warehouseInput,
  handler: async (input, ctx) => {
    const row = await md.createWarehouse(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateWarehouseAction = orgAction({
  permission: W,
  schema: warehouseUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateWarehouse(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const setWarehouseActiveAction = orgAction({
  permission: W,
  schema: setActiveInput,
  handler: async (input, ctx) => {
    const row = await md.setWarehouseActive(db, ctx, input);
    refresh();
    return { id: row.id, active: row.active };
  },
});

// ── Bins ──
export const createBinAction = orgAction({
  permission: W,
  schema: binInput,
  handler: async (input, ctx) => {
    const row = await md.createBin(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateBinAction = orgAction({
  permission: W,
  schema: binUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateBin(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const removeBinAction = orgAction({
  permission: W,
  schema: idInput,
  handler: async (input, ctx) => {
    await md.removeBin(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

// ── Buying points ──
export const createBuyingPointAction = orgAction({
  permission: W,
  schema: buyingPointInput,
  handler: async (input, ctx) => {
    const row = await md.createBuyingPoint(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateBuyingPointAction = orgAction({
  permission: W,
  schema: buyingPointUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateBuyingPoint(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const setBuyingPointActiveAction = orgAction({
  permission: W,
  schema: setActiveInput,
  handler: async (input, ctx) => {
    const row = await md.setBuyingPointActive(db, ctx, input);
    refresh();
    return { id: row.id, active: row.active };
  },
});

// ── Vehicles ──
export const createVehicleAction = orgAction({
  permission: W,
  schema: vehicleInput,
  handler: async (input, ctx) => {
    const row = await md.createVehicle(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateVehicleAction = orgAction({
  permission: W,
  schema: vehicleUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateVehicle(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const removeVehicleAction = orgAction({
  permission: W,
  schema: idInput,
  handler: async (input, ctx) => {
    await md.removeVehicle(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

// ── Drivers ──
export const createDriverAction = orgAction({
  permission: W,
  schema: driverInput,
  handler: async (input, ctx) => {
    const row = await md.createDriver(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateDriverAction = orgAction({
  permission: W,
  schema: driverUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateDriver(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const removeDriverAction = orgAction({
  permission: W,
  schema: idInput,
  handler: async (input, ctx) => {
    await md.removeDriver(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

// ── Expense categories ──
export const createExpenseCategoryAction = orgAction({
  permission: W,
  schema: expenseCategoryInput,
  handler: async (input, ctx) => {
    const row = await md.createExpenseCategory(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const updateExpenseCategoryAction = orgAction({
  permission: W,
  schema: expenseCategoryUpdateInput,
  handler: async (input, ctx) => {
    const row = await md.updateExpenseCategory(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});
export const removeExpenseCategoryAction = orgAction({
  permission: W,
  schema: idInput,
  handler: async (input, ctx) => {
    await md.removeExpenseCategory(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

// ── Onboarding ──
export const completeSetupAction = orgAction({
  permission: "org.settings",
  schema: completeSetupInput,
  handler: async (_input, ctx) => {
    const res = await md.completeSetup(db, ctx);
    revalidatePath("/", "layout");
    return res;
  },
});
