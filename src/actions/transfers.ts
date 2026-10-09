"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/transfers";
import {
  createTransferInput,
  listTransfersInput,
  receiveTransferInput,
  transferIdInput,
} from "@/lib/validation/warehouse";

/** Transfer server actions (P2-B). */

function refresh(id?: string) {
  revalidatePath("/transfers");
  if (id) revalidatePath(`/transfers/${id}`);
  revalidatePath("/stock");
  revalidatePath("/movements");
}

export const createTransferAction = orgAction({
  permission: "transfer.write",
  schema: createTransferInput,
  handler: async (input, ctx) => {
    const t = await svc.createTransfer(db, ctx, input);
    refresh(t.id);
    return { id: t.id, transferNumber: t.transferNumber };
  },
});

export const dispatchTransferAction = orgAction({
  permission: "transfer.write",
  schema: transferIdInput,
  handler: async (input, ctx) => {
    const t = await svc.dispatchTransfer(db, ctx, input);
    refresh(t.id);
    return { id: t.id, status: t.status };
  },
});

export const receiveTransferAction = orgAction({
  permission: "transfer.receive",
  schema: receiveTransferInput,
  handler: async (input, ctx) => {
    const t = await svc.receiveTransfer(db, ctx, input);
    refresh(t.id);
    return { id: t.id, status: t.status };
  },
});

export const cancelTransferAction = orgAction({
  permission: "transfer.write",
  schema: transferIdInput,
  handler: async (input, ctx) => {
    const t = await svc.cancelTransfer(db, ctx, input);
    refresh(t.id);
    return { id: t.id, status: t.status };
  },
});

export const listTransfersAction = orgAction({
  permission: "transfer.read",
  schema: listTransfersInput,
  handler: (input, ctx) => svc.listTransfers(db, ctx, input),
});

export const getTransferAction = orgAction({
  permission: "transfer.read",
  schema: transferIdInput,
  handler: (input, ctx) => svc.getTransfer(db, ctx, input.transferId),
});
