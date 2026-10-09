import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import type { DbOrTx } from "@/db/client";
import { notifications } from "@/db/schema";
import type { OrgContext } from "@/lib/authz/context";

/**
 * Notification centre service (P4-D). Same semantics as the /alerts page
 * (P3-D): a user sees org-wide notifications (user_id NULL) plus their own,
 * always scoped by ctx.orgId. `read_at` lives on the row, so marking an
 * org-wide notification read marks it for the whole organisation — that is
 * also what lets the alert scan re-raise it later (dedupe is "while unread").
 *
 * Marking read is housekeeping, not a business mutation: no audit row and it
 * stays available to read-only (expired-subscription) organisations.
 */

export type NotificationRow = {
  id: string;
  type: (typeof notifications.$inferSelect)["type"];
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export function visibleTo(ctx: Pick<OrgContext, "orgId" | "userId">): SQL {
  return and(
    eq(notifications.organisationId, ctx.orgId),
    or(isNull(notifications.userId), eq(notifications.userId, ctx.userId)),
  )!;
}

export type ListNotificationsInput = {
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
};

export async function listNotifications(
  db: DbOrTx,
  ctx: OrgContext,
  input: ListNotificationsInput = {},
): Promise<{ rows: NotificationRow[]; total: number; unread: number }> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(input.pageSize ?? 20)));
  const visible = visibleTo(ctx);
  const where = input.unreadOnly ? and(visible, isNull(notifications.readAt)) : visible;

  const [rows, [counts]] = await Promise.all([
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({
        total: sql<string>`count(*)`,
        unread: sql<string>`count(*) filter (where ${notifications.readAt} is null)`,
      })
      .from(notifications)
      .where(visible),
  ]);

  const unread = Number(counts?.unread ?? 0);
  const all = Number(counts?.total ?? 0);
  return { rows, total: input.unreadOnly ? unread : all, unread };
}

export async function unreadCount(db: DbOrTx, ctx: OrgContext): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(notifications)
    .where(and(visibleTo(ctx), isNull(notifications.readAt)));
  return Number(row?.n ?? 0);
}

/** Mark the given notifications read. Foreign / invisible / already-read ids are silently ignored. */
export async function markRead(db: DbOrTx, ctx: OrgContext, ids: string[]): Promise<{ updated: number }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { updated: 0 };
  const now = new Date();
  const rows = await db
    .update(notifications)
    .set({ readAt: now, updatedAt: now })
    .where(and(visibleTo(ctx), inArray(notifications.id, unique), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: rows.length };
}

export async function markAllRead(db: DbOrTx, ctx: OrgContext): Promise<{ updated: number }> {
  const now = new Date();
  const rows = await db
    .update(notifications)
    .set({ readAt: now, updatedAt: now })
    .where(and(visibleTo(ctx), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { updated: rows.length };
}
