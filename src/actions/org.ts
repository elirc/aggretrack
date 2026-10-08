"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import {
  initialiseOrganisation,
  setHidePricesFromWarehouse,
  updateOrgSettings,
} from "@/lib/services/users";
import {
  hidePricesSchema,
  initialiseOrgSchema,
  orgSettingsSchema,
} from "@/lib/validation/users";

/** Register flow: called after authClient.organization.create set the org active. */
export const initialiseOrganisationAction = orgAction({
  permission: "org.settings",
  schema: initialiseOrgSchema,
  handler: async (_input, ctx) => initialiseOrganisation(db, ctx),
});

export const updateOrgSettingsAction = orgAction({
  permission: "org.settings",
  schema: orgSettingsSchema,
  handler: async (input, ctx) => {
    const res = await updateOrgSettings(db, ctx, input);
    revalidatePath("/", "layout");
    return res;
  },
});

export const setHidePricesAction = orgAction({
  permission: "org.settings",
  schema: hidePricesSchema,
  handler: async (input, ctx) => {
    const res = await setHidePricesFromWarehouse(db, ctx, input.hide);
    revalidatePath("/", "layout");
    return res;
  },
});
