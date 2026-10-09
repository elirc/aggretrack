import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/logistics/ResponsiveList";
import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { formatLagosDateTime } from "@/lib/domain/format";
import { cn } from "@/lib/utils";

import { AlertsList, type AlertItem } from "./_components/AlertsList";

export const metadata = { title: "Alerts · AggreTrack" };

const LIMIT = 100;

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "notification.read")) {
    return (
      <div>
        <PageHeader title="Alerts" />
        <p className="text-sm text-muted-foreground">You don&apos;t have access to alerts.</p>
      </div>
    );
  }
  const { show } = await searchParams;
  const unreadOnly = show === "unread";

  // Inline org-scoped read: org-wide (user_id NULL) + this user's notifications.
  const visible = and(
    eq(notifications.organisationId, ctx.orgId),
    or(isNull(notifications.userId), eq(notifications.userId, ctx.userId)),
  );
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
      .where(unreadOnly ? and(visible, isNull(notifications.readAt)) : visible)
      .orderBy(desc(notifications.createdAt))
      .limit(LIMIT),
    db
      .select({
        total: sql<string>`count(*)`,
        unread: sql<string>`count(*) FILTER (WHERE ${notifications.readAt} IS NULL)`,
      })
      .from(notifications)
      .where(visible),
  ]);

  const items: AlertItem[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    link: r.link,
    read: r.readAt !== null,
    when: formatLagosDateTime(r.createdAt),
  }));
  const unread = Number(counts?.unread ?? 0);
  const total = Number(counts?.total ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Alerts" description="Low stock, old stock, warehouse capacity, approvals and payments." />
      <nav aria-label="Filter alerts" className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
        {[
          { key: "all", label: `All (${total})`, href: "/alerts" },
          { key: "unread", label: `Unread (${unread})`, href: "/alerts?show=unread" },
        ].map((f) => {
          const active = (unreadOnly ? "unread" : "all") === f.key;
          return (
            <Link
              key={f.key}
              href={f.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-center",
                active ? "bg-background font-medium shadow-sm" : "text-muted-foreground",
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>
      {items.length === 0 ? (
        <EmptyState
          title={unreadOnly ? "No unread alerts" : "No alerts yet"}
          description="Alerts appear here when stock runs low, lots get old, a warehouse nears capacity or something needs approval."
        />
      ) : (
        <>
          <AlertsList items={items} unread={unread} />
          {total > LIMIT && !unreadOnly ? (
            <p className="text-center text-xs text-muted-foreground">Showing the newest {LIMIT} of {total}.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
