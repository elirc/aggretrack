"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import {
  addMember,
  changeMemberRole,
  removeMember,
  setMemberRestrictions,
} from "@/lib/services/users";
import {
  addMemberSchema,
  changeRoleSchema,
  memberRestrictionsSchema,
  removeMemberSchema,
} from "@/lib/validation/users";

const USERS_PATH = "/settings/users";

export const addMemberAction = orgAction({
  permission: "users.manage",
  schema: addMemberSchema,
  handler: async (input, ctx) => {
    const res = await addMember(db, ctx, input);
    revalidatePath(USERS_PATH);
    return res;
  },
});

export const changeMemberRoleAction = orgAction({
  permission: "users.manage",
  schema: changeRoleSchema,
  handler: async (input, ctx) => {
    const res = await changeMemberRole(db, ctx, input);
    revalidatePath(USERS_PATH);
    return res;
  },
});

export const removeMemberAction = orgAction({
  permission: "users.manage",
  schema: removeMemberSchema,
  handler: async (input, ctx) => {
    const res = await removeMember(db, ctx, input);
    revalidatePath(USERS_PATH);
    return res;
  },
});

export const setMemberRestrictionsAction = orgAction({
  permission: "users.manage",
  schema: memberRestrictionsSchema,
  handler: async (input, ctx) => {
    const res = await setMemberRestrictions(db, ctx, input);
    revalidatePath(USERS_PATH);
    return res;
  },
});
