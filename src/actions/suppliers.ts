"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/suppliers";
import { idInput, supplierInput, supplierListInput, supplierUpdateInput } from "@/lib/validation/buying";

/** Supplier server actions (P2-A). Org always comes from the session via orgAction. */

function refresh(id?: string) {
  revalidatePath("/suppliers");
  if (id) revalidatePath(`/suppliers/${id}`);
}

export const createSupplierAction = orgAction({
  permission: "supplier.write",
  schema: supplierInput,
  handler: async (input, ctx) => {
    const row = await svc.createSupplier(db, ctx, input);
    refresh(row.id);
    return { id: row.id, name: row.name };
  },
});

export const updateSupplierAction = orgAction({
  permission: "supplier.write",
  schema: supplierUpdateInput,
  handler: async (input, ctx) => {
    const row = await svc.updateSupplier(db, ctx, input);
    refresh(row.id);
    return { id: row.id };
  },
});

export const deleteSupplierAction = orgAction({
  permission: "supplier.write",
  schema: idInput,
  handler: async (input, ctx) => {
    await svc.deleteSupplier(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

export const listSuppliersAction = orgAction({
  permission: "supplier.read",
  schema: supplierListInput,
  handler: async (input, ctx) => svc.listSuppliers(db, ctx, input),
});

export const supplierOptionsAction = orgAction({
  permission: "supplier.read",
  schema: z.object({}),
  handler: async (_input, ctx) => svc.listSupplierOptions(db, ctx),
});

export const getSupplierDetailAction = orgAction({
  permission: "supplier.read",
  schema: idInput,
  handler: async (input, ctx) => svc.getSupplierDetail(db, ctx, input.id),
});
