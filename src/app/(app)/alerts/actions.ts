"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { orgAction } from "@/lib/authz/guard";
import type { OrgContext } from "@/lib/authz/context";
import { zUuid } from "@/lib/validation/common";

/**
 * Notification-centre mutations (P3-D, local to /alerts). Org-scoped from the
 * server-resolved context; a user may only mark their own or org-wide
 * (user_id IS NULL) notifications. Marking read is not a business mutation,
 * so it rides on notification.read and stays available to read-only orgs.
 */

function visibleTo(ctx: OrgContext) {
  return and(
    eq(notifications.organisationId, ctx.orgId),
    or(isNull(notifications.userId), eq(notifications.userId, ctx.userId)),
  );
}

export const markNotificationReadAction = orgAction({
  permission: "notification.read",
  schema: z.object({ id: zUuid }),
  handler: async (input, ctx) => {
    const rows = await db
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(and(visibleTo(ctx), eq(notifications.id, input.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    revalidatePath("/alerts");
    revalidatePath("/");
    return { updated: rows.length };
  },
});

export const markAllNotificationsReadAction = orgAction({
  permission: "notification.read",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    const rows = await db
      .update(notifications)
      .set({ readAt: new Date(), updatedAt: new Date() })
      .where(and(visibleTo(ctx), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    revalidatePath("/alerts");
    revalidatePath("/");
    return { updated: rows.length };
  },
});
