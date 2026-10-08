"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { platformAction } from "@/lib/authz/guard";
import * as platform from "@/lib/services/platform";
import { zUuid } from "@/lib/validation/common";
import { planInput, planUpdateInput, setOrgReadOnlyInput } from "@/lib/validation/masterData";

/** Platform-admin actions (P1-B). Guarded by platformAction (user.is_platform_admin). */

export const setOrganisationReadOnlyAction = platformAction({
  schema: setOrgReadOnlyInput,
  handler: async (input, pctx) => {
    const res = await platform.setOrganisationReadOnly(db, pctx, input);
    revalidatePath("/platform", "layout");
    return res;
  },
});

export const createPlanAction = platformAction({
  schema: planInput,
  handler: async (input, pctx) => {
    const row = await platform.createPlan(db, pctx, input);
    revalidatePath("/platform/plans");
    return { id: row.id };
  },
});

export const updatePlanAction = platformAction({
  schema: planUpdateInput,
  handler: async (input, pctx) => {
    const row = await platform.updatePlan(db, pctx, input);
    revalidatePath("/platform/plans");
    return { id: row.id };
  },
});

export const setPlanActiveAction = platformAction({
  schema: z.object({ id: zUuid, active: z.boolean() }),
  handler: async (input, pctx) => {
    const row = await platform.setPlanActive(db, pctx, input);
    revalidatePath("/platform/plans");
    return { id: row.id, active: row.active };
  },
});
