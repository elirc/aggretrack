import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/logistics/ResponsiveList";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { auditLog, user } from "@/db/schema";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { formatLagosDateTime } from "@/lib/domain/format";

import { AuditFilters } from "./_components/AuditFilters";
import { AuditTable, type AuditRow } from "./_components/AuditTable";

export const metadata = { title: "Audit log · AggreTrack" };

const PAGE_SIZE = 25;
const ACTIONS = ["create", "update", "cancel", "approve", "reject", "post"] as const;
type Action = (typeof ACTIONS)[number];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lagos (UTC+1, no DST) calendar day → UTC instant at its start. */
function lagosDayStart(iso: string, plusDays = 0): Date {
  const d = new Date(`${iso}T00:00:00+01:00`);
  return new Date(d.getTime() + plusDays * 86_400_000);
}

type Search = { table?: string; action?: string; from?: string; to?: string; page?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "audit.read")) {
    return (
      <div>
        <PageHeader title="Audit log" />
        <p className="text-sm text-muted-foreground">You don&apos;t have access to the audit log.</p>
      </div>
    );
  }

  const sp = await searchParams;
  const table = sp.table && /^[a-z_]{1,64}$/.test(sp.table) ? sp.table : undefined;
  const action = ACTIONS.includes(sp.action as Action) ? (sp.action as Action) : undefined;
  const from = sp.from && DATE_RE.test(sp.from) && !Number.isNaN(lagosDayStart(sp.from).getTime()) ? sp.from : undefined;
  const to = sp.to && DATE_RE.test(sp.to) && !Number.isNaN(lagosDayStart(sp.to).getTime()) ? sp.to : undefined;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const where: SQL[] = [eq(auditLog.organisationId, ctx.orgId)];
  if (table) where.push(eq(auditLog.tableName, table));
  if (action) where.push(eq(auditLog.action, action));
  if (from) where.push(gte(auditLog.createdAt, lagosDayStart(from)));
  if (to) where.push(lt(auditLog.createdAt, lagosDayStart(to, 1)));
  const filter = and(...where);

  const [rows, [countRow], tables] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        tableName: auditLog.tableName,
        recordId: auditLog.recordId,
        before: auditLog.before,
        after: auditLog.after,
        createdAt: auditLog.createdAt,
        userName: user.name,
      })
      .from(auditLog)
      .leftJoin(user, eq(user.id, auditLog.userId))
      .where(filter)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ n: sql<string>`count(*)` }).from(auditLog).where(filter),
    db
      .selectDistinct({ tableName: auditLog.tableName })
      .from(auditLog)
      .where(eq(auditLog.organisationId, ctx.orgId))
      .orderBy(auditLog.tableName),
  ]);

  const total = Number(countRow?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items: AuditRow[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    tableName: r.tableName,
    recordId: r.recordId,
    before: r.before ?? null,
    after: r.after ?? null,
    when: formatLagosDateTime(r.createdAt),
    userName: r.userName ?? "System",
  }));
  const filtered = Boolean(table || action || from || to);

  const pageHref = (p: number) => {
    const qs = new URLSearchParams();
    if (table) qs.set("table", table);
    if (action) qs.set("action", action);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return s ? `/settings/audit?${s}` : "/settings/audit";
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Audit log"
        description="Every create, update, cancel and approval, with before and after values."
      />
      <AuditFilters
        tables={tables.map((t) => t.tableName)}
        actions={[...ACTIONS]}
        value={{ table: table ?? "", action: action ?? "", from: from ?? "", to: to ?? "" }}
      />
      {items.length === 0 ? (
        <EmptyState
          title={filtered ? "No audit entries match these filters" : "No audit entries yet"}
          description={filtered ? "Widen the date range or clear a filter." : "Changes appear here as people work."}
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {total} entr{total === 1 ? "y" : "ies"} · page {Math.min(page, pages)} of {pages}
          </p>
          <AuditTable rows={items} />
          <nav aria-label="Audit pages" className="flex items-center justify-between gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" className="h-11 sm:h-9">
                <Link href={pageHref(page - 1)}>
                  <ChevronLeft /> Newer
                </Link>
              </Button>
            ) : (
              <span />
            )}
            {page < pages ? (
              <Button asChild variant="outline" className="h-11 sm:h-9">
                <Link href={pageHref(page + 1)}>
                  Older <ChevronRight />
                </Link>
              </Button>
            ) : (
              <span />
            )}
          </nav>
        </>
      )}
    </div>
  );
}
