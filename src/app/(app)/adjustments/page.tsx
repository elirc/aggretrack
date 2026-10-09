import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { AdjustmentsView, type AdjustmentRow } from "@/components/warehouse/adjustments-view";
import { enumParam, one, pageParam, uuidParam, type SP } from "@/components/warehouse/params";
import { lotLabels, orgWarehouseLabels } from "@/components/warehouse/server/lookups";
import { NoAccess } from "@/components/warehouse/status";
import { UrlFilters, UrlPager } from "@/components/warehouse/url-filters";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { approvalQueue, listAdjustments, type Adjustment } from "@/lib/services/adjustments";

export const metadata = { title: "Adjustments · AggreTrack" };

const STATUSES = ["pending_approval", "posted", "rejected"] as const;
const STATUS_LABEL = { pending_approval: "Pending approval", posted: "Posted", rejected: "Rejected" } as const;

export default async function AdjustmentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "adjustment.read")) return <NoAccess title="Adjustments" what="adjustments" />;

  const sp = await searchParams;
  const status = enumParam(sp, "status", STATUSES);
  const warehouseId = uuidParam(sp, "warehouse");
  const lotId = uuidParam(sp, "lot");
  const page = pageParam(sp);
  const canApprove = can(ctx.role, "adjustment.approve") && !ctx.readOnly;
  const tabParam = one(sp, "tab");

  const [list, queue, warehouses] = await Promise.all([
    listAdjustments(db, ctx, { status, warehouseId, lotId, page, pageSize: 50 }),
    approvalQueue(db, ctx),
    orgWarehouseLabels(ctx),
  ]);
  const lotMap = await lotLabels(ctx, [...list.rows, ...queue].map((a) => a.lotId));
  const names = new Map(warehouses.map((w) => [w.id, w.name]));
  const toRow = (a: Adjustment): AdjustmentRow => {
    const lot = lotMap.get(a.lotId);
    return {
      id: a.id,
      adjustmentNumber: a.adjustmentNumber,
      lotId: a.lotId,
      lotLabel: lot ? `${lot.lotNumber} · ${lot.commodityName} ${lot.gradeName}` : a.lotId.slice(0, 8),
      warehouseName: names.get(a.warehouseId) ?? "Unknown warehouse",
      reason: a.reason,
      kg: a.kg,
      bags: a.bags,
      status: a.status,
      note: a.note,
      rejectedReason: a.rejectedReason,
      sourceCountId: a.sourceCountId,
      createdAt: a.createdAt,
    };
  };

  const allowed = ctx.restrictions.warehouseIds;
  const filterWarehouses = allowed === null ? warehouses : warehouses.filter((w) => allowed.includes(w.id));
  const current = { status, warehouse: warehouseId, lot: lotId };
  const initialTab = tabParam === "queue" || (tabParam !== "all" && canApprove && queue.length > 0) ? "queue" : "all";
  const canCreate = can(ctx.role, "adjustment.write") && !ctx.readOnly;

  return (
    <div>
      <PageHeader
        title="Adjustments"
        description="Shrinkage, spoilage, theft, re-bagging and count differences."
        actions={
          canCreate ? (
            <Button asChild size="sm" className="h-9">
              <Link href="/adjustments/new">
                <Plus /> New adjustment
              </Link>
            </Button>
          ) : null
        }
      />
      <UrlFilters
        current={current}
        chips={lotId ? [{ param: "lot", label: `Lot ${lotMap.get(lotId)?.lotNumber ?? lotId.slice(0, 8)}` }] : undefined}
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
      <AdjustmentsView
        rows={list.rows.map(toRow)}
        queue={queue.map(toRow)}
        canApprove={canApprove}
        initialTab={initialTab}
        listFooter={<UrlPager page={list.page} pageSize={list.pageSize} total={list.total} current={current} />}
      />
    </div>
  );
}
