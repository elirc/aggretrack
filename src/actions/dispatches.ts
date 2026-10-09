"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/dispatches";
import { deliveryInput, dispatchInput, dispatchListInput, idInput } from "@/lib/validation/selling";

/** Dispatch server actions (P2-C). */

export const createDispatchAction = orgAction({
  permission: "dispatch.write",
  schema: dispatchInput,
  handler: async (input, ctx) => {
    const res = await svc.createDispatch(db, ctx, input);
    revalidatePath("/dispatches");
    revalidatePath(`/sales/${input.salesOrderId}`);
    return { id: res.dispatch.id, waybillNumber: res.dispatch.waybillNumber, duplicate: res.duplicate };
  },
});

export const recordDeliveryAction = orgAction({
  permission: "dispatch.deliver",
  schema: deliveryInput,
  handler: async (input, ctx) => {
    const row = await svc.recordDelivery(db, ctx, input);
    revalidatePath("/dispatches");
    revalidatePath(`/dispatches/${row.id}`);
    return { id: row.id, transitLossKg: row.transitLossKg };
  },
});

export const listDispatchesAction = orgAction({
  permission: "dispatch.read",
  schema: dispatchListInput,
  handler: (input, ctx) => svc.listDispatches(db, ctx, input),
});

export const getDispatchAction = orgAction({
  permission: "dispatch.read",
  schema: idInput,
  handler: (input, ctx) => svc.getDispatch(db, ctx, input),
});
