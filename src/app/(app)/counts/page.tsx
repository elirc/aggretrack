import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { CountsList } from "@/components/warehouse/counts-list";
import { enumParam, pageParam, uuidParam, type SP } from "@/components/warehouse/params";
import { orgWarehouseLabels } from "@/components/warehouse/server/lookups";
import { EmptyState, NoAccess } from "@/components/warehouse/status";
import { UrlFilters, UrlPager } from "@/components/warehouse/url-filters";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { listCounts } from "@/lib/services/counts";

export const metadata = { title: "Stock counts · AggreTrack" };

const STATUSES = ["draft", "posted", "cancelled"] as const;
const STATUS_LABEL = { draft: "Draft", posted: "Posted", cancelled: "Cancelled" } as const;

export default async function CountsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "count.read")) return <NoAccess title="Stock counts" what="stock counts" />;

  const sp = await searchParams;
  const status = enumParam(sp, "status", STATUSES);
  const warehouseId = uuidParam(sp, "warehouse");
  const page = pageParam(sp);

  const [list, warehouses] = await Promise.all([
    listCounts(db, ctx, { status, warehouseId, page, pageSize: 50 }),
    orgWarehouseLabels(ctx),
  ]);
  const names = Object.fromEntries(warehouses.map((w) => [w.id, w.name]));
  const allowed = ctx.restrictions.warehouseIds;
  const filterWarehouses = allowed === null ? warehouses : warehouses.filter((w) => allowed.includes(w.id));
  const canCreate = can(ctx.role, "count.write") && !ctx.readOnly;
  const current = { status, warehouse: warehouseId };

  return (
    <div>
      <PageHeader
        title="Stock counts"
        description="Physical counts against system stock; differences become adjustments."
        actions={
          canCreate ? (
            <Button asChild size="sm" className="h-9">
              <Link href="/counts/new">
                <Plus /> New count
              </Link>
            </Button>
          ) : null
        }
      />
      <UrlFilters
        current={current}
        filters={[
          {
            kind: "select",
            param: "status",
            label: "Status",
            allLabel: "All statuses",
            options: STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
          },
          {
            kind: "select",
            param: "warehouse",
            label: "Warehouse",
            allLabel: "All warehouses",
            options: filterWarehouses.map((w) => ({ value: w.id, label: w.name })),
          },
        ]}
      />
      {list.rows.length === 0 ? (
        <EmptyState
          title={status || warehouseId ? "No counts match these filters" : "No stock counts yet"}
          description="Count a warehouse to find shrinkage and correct the books."
          href={canCreate ? "/counts/new" : undefined}
          actionLabel={canCreate ? "New count" : undefined}
        />
      ) : (
        <>
          <CountsList rows={list.rows} names={names} />
          <UrlPager page={list.page} pageSize={list.pageSize} total={list.total} current={current} />
        </>
      )}
    </div>
  );
}
