"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/advances";
import { advanceInput, advanceListInput, idInput } from "@/lib/validation/buying";

/** Supplier advance server actions (P2-A). Offsetting lives in supplier-payments. */

export const createAdvanceAction = orgAction({
  permission: "advance.write",
  schema: advanceInput,
  handler: async (input, ctx) => {
    const row = await svc.createAdvance(db, ctx, input);
    revalidatePath("/advances");
    revalidatePath(`/suppliers/${row.supplierId}`);
    return { id: row.id, advanceNumber: row.advanceNumber };
  },
});

export const listAdvancesAction = orgAction({
  permission: "advance.read",
  schema: advanceListInput,
  handler: async (input, ctx) => svc.listAdvances(db, ctx, input),
});

export const getAdvancesForSupplierAction = orgAction({
  permission: "advance.read",
  schema: idInput,
  handler: async (input, ctx) => svc.getAdvancesForSupplier(db, ctx, input.id),
});
