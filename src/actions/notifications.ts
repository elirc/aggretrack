"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/notifications";
import { zUuid } from "@/lib/validation/common";

/**
 * Notification bell actions (P4-D). Thin wrappers; all ride on
 * notification.read (non-mutating permission) so read-only orgs can still
 * clear their bell — same choice as the /alerts page's local actions.
 */

export const listNotificationsAction = orgAction({
  permission: "notification.read",
  schema: z.object({
    unreadOnly: z.boolean().optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
  }),
  handler: async (input, ctx) => {
    const res = await svc.listNotifications(db, ctx, input);
    // Dates serialise fine through server actions; keep ISO strings for the client anyway.
    return {
      ...res,
      rows: res.rows.map((r) => ({ ...r, readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })),
    };
  },
});

export const unreadNotificationCountAction = orgAction({
  permission: "notification.read",
  schema: z.object({}),
  handler: async (_input, ctx) => ({ unread: await svc.unreadCount(db, ctx) }),
});

export const markNotificationsReadAction = orgAction({
  permission: "notification.read",
  schema: z.object({ ids: z.array(zUuid).min(1).max(200) }),
  handler: async (input, ctx) => {
    const res = await svc.markRead(db, ctx, input.ids);
    revalidatePath("/alerts");
    return res;
  },
});

export const markAllNotificationsReadAction = orgAction({
  permission: "notification.read",
  schema: z.object({}),
  handler: async (_input, ctx) => {
    const res = await svc.markAllRead(db, ctx);
    revalidatePath("/alerts");
    return res;
  },
});
