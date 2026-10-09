"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/priceGuides";
import {
  idInput,
  priceGuideInput,
  priceGuideListInput,
  priceGuideLookupInput,
  priceGuideUpdateInput,
} from "@/lib/validation/buying";

/** Price guide server actions (P2-A). */

function refresh() {
  revalidatePath("/price-guides");
}

export const createPriceGuideAction = orgAction({
  permission: "price-guide.write",
  schema: priceGuideInput,
  handler: async (input, ctx) => {
    const row = await svc.createPriceGuide(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});

export const updatePriceGuideAction = orgAction({
  permission: "price-guide.write",
  schema: priceGuideUpdateInput,
  handler: async (input, ctx) => {
    const row = await svc.updatePriceGuide(db, ctx, input);
    refresh();
    return { id: row.id };
  },
});

export const deletePriceGuideAction = orgAction({
  permission: "price-guide.write",
  schema: idInput,
  handler: async (input, ctx) => {
    await svc.deletePriceGuide(db, ctx, input.id);
    refresh();
    return { id: input.id };
  },
});

export const listPriceGuidesAction = orgAction({
  permission: "price-guide.read",
  schema: priceGuideListInput,
  handler: async (input, ctx) => svc.listPriceGuides(db, ctx, input),
});

/** Today's applicable guide for the purchase form's over-guide warning. */
export const lookupPriceGuideAction = orgAction({
  permission: "price-guide.read",
  schema: priceGuideLookupInput,
  handler: async (input, ctx) => {
    const g = await svc.lookupGuide(db, ctx, input);
    return g ? { id: g.id, maxPricePerKgKobo: g.maxPricePerKgKobo, guideDate: g.guideDate } : null;
  },
});
