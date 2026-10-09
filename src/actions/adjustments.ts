"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/adjustments";
import {
  adjustmentIdInput,
  createAdjustmentInput,
  listAdjustmentsInput,
  rejectAdjustmentInput,
} from "@/lib/validation/warehouse";

/** Adjustment server actions (P2-B). */

function refresh(id?: string) {
  revalidatePath("/adjustments");
  if (id) revalidatePath(`/adjustments/${id}`);
  revalidatePath("/stock");
  revalidatePath("/movements");
}

export const createAdjustmentAction = orgAction({
  permission: "adjustment.write",
  schema: createAdjustmentInput,
  handler: async (input, ctx) => {
    const a = await svc.createAdjustment(db, ctx, input);
    refresh(a.id);
    return { id: a.id, adjustmentNumber: a.adjustmentNumber, status: a.status };
  },
});

export const approveAdjustmentAction = orgAction({
  permission: "adjustment.approve",
  schema: adjustmentIdInput,
  handler: async (input, ctx) => {
    const a = await svc.approveAdjustment(db, ctx, input);
    refresh(a.id);
    return { id: a.id, status: a.status };
  },
});

export const rejectAdjustmentAction = orgAction({
  permission: "adjustment.approve",
  schema: rejectAdjustmentInput,
  handler: async (input, ctx) => {
    const a = await svc.rejectAdjustment(db, ctx, input);
    refresh(a.id);
    return { id: a.id, status: a.status };
  },
});

export const listAdjustmentsAction = orgAction({
  permission: "adjustment.read",
  schema: listAdjustmentsInput,
  handler: (input, ctx) => svc.listAdjustments(db, ctx, input),
});

export const approvalQueueAction = orgAction({
  permission: "adjustment.read",
  schema: z.object({}),
  handler: (_input, ctx) => svc.approvalQueue(db, ctx),
});
