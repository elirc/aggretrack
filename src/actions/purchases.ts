"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as purchasesSvc from "@/lib/services/purchases";
import * as receivingSvc from "@/lib/services/receiving";
import { enqueuePendingJobs } from "@/lib/services/suppliers";
import { zDateISO, zUuid } from "@/lib/validation/common";
import {
  idInput,
  purchaseCancelInput,
  purchaseCreateInput,
  purchaseLineInput,
  purchaseListInput,
  purchaseRejectInput,
  purchaseUpdateInput,
  receivePurchaseInput,
} from "@/lib/validation/buying";

/** Purchase + receiving server actions (P2-A). */

function refresh(id?: string, supplierId?: string) {
  revalidatePath("/purchases");
  if (id) revalidatePath(`/purchases/${id}`);
  if (supplierId) revalidatePath(`/suppliers/${supplierId}`);
}

export const createPurchaseAction = orgAction({
  permission: "purchase.create",
  schema: purchaseCreateInput,
  handler: async (input, ctx) => {
    const { purchase, duplicate } = await purchasesSvc.createPurchase(db, ctx, input);
    refresh(purchase.id, purchase.supplierId);
    return {
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      status: purchase.status,
      requiresApproval: purchase.requiresApproval,
      totalAmountKobo: purchase.totalAmountKobo,
      duplicate,
    };
  },
});

export const updatePurchaseAction = orgAction({
  permission: "purchase.create",
  schema: purchaseUpdateInput,
  handler: async (input, ctx) => {
    const p = await purchasesSvc.updatePurchase(db, ctx, input);
    refresh(p.id, p.supplierId);
    return { id: p.id, status: p.status, requiresApproval: p.requiresApproval };
  },
});

export const approvePurchaseAction = orgAction({
  permission: "purchase.approve",
  schema: idInput,
  handler: async (input, ctx) => {
    const p = await purchasesSvc.approvePurchase(db, ctx, input);
    refresh(p.id, p.supplierId);
    return { id: p.id, status: p.status };
  },
});

export const rejectPurchaseAction = orgAction({
  permission: "purchase.approve",
  schema: purchaseRejectInput,
  handler: async (input, ctx) => {
    const p = await purchasesSvc.rejectPurchase(db, ctx, input);
    refresh(p.id, p.supplierId);
    return { id: p.id, status: p.status };
  },
});

export const cancelPurchaseAction = orgAction({
  permission: "purchase.create",
  schema: purchaseCancelInput,
  handler: async (input, ctx) => {
    const p = await purchasesSvc.cancelPurchase(db, ctx, input);
    refresh(p.id, p.supplierId);
    return { id: p.id, status: p.status };
  },
});

export const listPurchasesAction = orgAction({
  permission: "purchase.read",
  schema: purchaseListInput,
  handler: async (input, ctx) => purchasesSvc.listPurchases(db, ctx, input),
});

export const getPurchaseAction = orgAction({
  permission: "purchase.read",
  schema: idInput,
  handler: async (input, ctx) => purchasesSvc.getPurchaseDetail(db, ctx, input.id),
});

/** Live net kg / amount / over-guide preview for the quick-entry line editor. */
export const previewPurchaseLinesAction = orgAction({
  permission: "purchase.create",
  schema: z.object({
    purchaseDate: zDateISO,
    buyingPointId: zUuid.nullable(),
    lines: z.array(purchaseLineInput).min(1).max(50),
  }),
  handler: async (input, ctx) => purchasesSvc.previewPurchaseLines(db, ctx, input),
});

/** Receive an approved purchase into a warehouse → lots + movements + GRN (PDF + optional SMS queued after commit). */
export const receivePurchaseAction = orgAction({
  permission: "purchase.receive",
  schema: receivePurchaseInput,
  handler: async (input, ctx) => {
    const res = await receivingSvc.receivePurchase(db, ctx, input);
    await enqueuePendingJobs(res.jobs);
    refresh(res.purchaseId);
    revalidatePath("/stock");
    return {
      purchaseId: res.purchaseId,
      grnNumber: res.grnNumber,
      totalNetKg: res.totalNetKg,
      lots: res.lots.map((l) => ({ id: l.id, lotNumber: l.lotNumber, originalKg: l.originalKg })),
    };
  },
});

export const listAwaitingReceiptAction = orgAction({
  permission: "purchase.read",
  schema: z.object({}),
  handler: async (_input, ctx) => receivingSvc.listAwaitingReceipt(db, ctx),
});
