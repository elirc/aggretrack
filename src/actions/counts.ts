"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/counts";
import { countIdInput, createCountInput, listCountsInput } from "@/lib/validation/warehouse";

/** Stock count server actions (P2-B). */

function refresh(id?: string) {
  revalidatePath("/counts");
  if (id) revalidatePath(`/counts/${id}`);
  revalidatePath("/adjustments");
  revalidatePath("/stock");
}

export const createCountAction = orgAction({
  permission: "count.write",
  schema: createCountInput,
  handler: async (input, ctx) => {
    const c = await svc.createCount(db, ctx, input);
    refresh(c.id);
    return { id: c.id, countNumber: c.countNumber };
  },
});

export const postCountAction = orgAction({
  permission: "count.post",
  schema: countIdInput,
  handler: async (input, ctx) => {
    const r = await svc.postCount(db, ctx, input);
    refresh(r.count.id);
    return {
      id: r.count.id,
      status: r.count.status,
      adjustments: r.adjustments.map((a) => ({ id: a.id, number: a.adjustmentNumber, status: a.status })),
    };
  },
});

export const cancelCountAction = orgAction({
  permission: "count.write",
  schema: countIdInput,
  handler: async (input, ctx) => {
    const c = await svc.cancelCount(db, ctx, input);
    refresh(c.id);
    return { id: c.id, status: c.status };
  },
});

export const listCountsAction = orgAction({
  permission: "count.read",
  schema: listCountsInput,
  handler: (input, ctx) => svc.listCounts(db, ctx, input),
});

export const getCountAction = orgAction({
  permission: "count.read",
  schema: countIdInput,
  handler: (input, ctx) => svc.getCount(db, ctx, input.countId),
});
