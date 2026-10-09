import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { enumParam, pageParam, uuidParam, type SP } from "@/components/warehouse/params";
import { orgWarehouseLabels } from "@/components/warehouse/server/lookups";
import { EmptyState, NoAccess } from "@/components/warehouse/status";
import { TransfersList } from "@/components/warehouse/transfers-list";
import { UrlFilters, UrlPager } from "@/components/warehouse/url-filters";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { listTransfers } from "@/lib/services/transfers";

export const metadata = { title: "Transfers · AggreTrack" };

const STATUSES = ["draft", "in_transit", "received", "cancelled"] as const;
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  draft: "Draft",
  in_transit: "In transit",
  received: "Received",
  cancelled: "Cancelled",
};

export default async function TransfersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "transfer.read")) return <NoAccess title="Transfers" what="transfers" />;

  const sp = await searchParams;
  const status = enumParam(sp, "status", STATUSES);
  const warehouseId = uuidParam(sp, "warehouse");
  const page = pageParam(sp);

  const [list, warehouses] = await Promise.all([
    listTransfers(db, ctx, { status, warehouseId, page, pageSize: 50 }),
    orgWarehouseLabels(ctx),
  ]);
  const names = Object.fromEntries(warehouses.map((w) => [w.id, w.name]));
  const allowed = ctx.restrictions.warehouseIds;
  const filterWarehouses = allowed === null ? warehouses : warehouses.filter((w) => allowed.includes(w.id));
  const canCreate = can(ctx.role, "transfer.write") && !ctx.readOnly;
  const current = { status, warehouse: warehouseId };

  return (
    <div>
      <PageHeader
        title="Transfers"
        description="Move stock between warehouses; record any loss on receipt."
        actions={
          canCreate ? (
            <Button asChild size="sm" className="h-9">
              <Link href="/transfers/new">
                <Plus /> New transfer
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
          title={status || warehouseId ? "No transfers match these filters" : "No transfers yet"}
          description="Transfers move lots from one warehouse to another, with an in-transit step."
          href={canCreate ? "/transfers/new" : undefined}
          actionLabel={canCreate ? "New transfer" : undefined}
        />
      ) : (
        <>
          <TransfersList rows={list.rows} names={names} />
          <UrlPager page={list.page} pageSize={list.pageSize} total={list.total} current={current} />
        </>
      )}
    </div>
  );
}
