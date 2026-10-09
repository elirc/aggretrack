import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { AdjustmentForm } from "@/components/warehouse/adjustment-form";
import { uuidParam, type SP } from "@/components/warehouse/params";
import { lotsByWarehouse } from "@/components/warehouse/position";
import { EmptyState, NoAccess } from "@/components/warehouse/status";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { approvalThresholdGrams } from "@/lib/services/adjustments";
import * as md from "@/lib/services/masterData";
import { getStockPosition } from "@/lib/services/stockQueries";

export const metadata = { title: "New adjustment · AggreTrack" };

export default async function NewAdjustmentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "adjustment.write")) return <NoAccess title="New adjustment" what="adjustments" />;
  if (ctx.readOnly) {
    return (
      <div>
        <PageHeader title="New adjustment" />
        <EmptyState title="Read only" description="Subscription inactive — adjustments can't be entered." />
      </div>
    );
  }

  const sp = await searchParams;
  const [position, warehouses, threshold] = await Promise.all([
    getStockPosition(db, ctx),
    md.listWarehouses(db, ctx),
    approvalThresholdGrams(db, ctx.orgId),
  ]);
  const opts = warehouses.map((w) => ({ id: w.id, name: w.name, bins: w.bins.map((b) => ({ id: b.id, name: b.name })) }));
  const initialWarehouseId = uuidParam(sp, "warehouse");

  return (
    <div className="max-w-xl">
      <PageHeader
        title="New adjustment"
        description="Record shrinkage, spoilage, theft or re-bagging against a lot."
      />
      {opts.length === 0 ? (
        <EmptyState title="No warehouses" description="Add a warehouse in master data first." />
      ) : (
        <AdjustmentForm
          warehouses={opts}
          lots={lotsByWarehouse(position)}
          thresholdGrams={threshold}
          initialWarehouseId={opts.some((w) => w.id === initialWarehouseId) ? initialWarehouseId : undefined}
          initialLotId={uuidParam(sp, "lot")}
        />
      )}
    </div>
  );
}
