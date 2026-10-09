import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { CountSheet } from "@/components/warehouse/count-sheet";
import { fmtGrams } from "@/components/warehouse/format";
import { lotsByWarehouse } from "@/components/warehouse/position";
import { EmptyState, NoAccess } from "@/components/warehouse/status";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { approvalThresholdGrams } from "@/lib/services/adjustments";
import * as md from "@/lib/services/masterData";
import { getStockPosition } from "@/lib/services/stockQueries";

export const metadata = { title: "New count · AggreTrack" };

export default async function NewCountPage() {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "count.write")) return <NoAccess title="New count" what="stock counts" />;
  if (ctx.readOnly) {
    return (
      <div>
        <PageHeader title="New count" />
        <EmptyState title="Read only" description="Subscription inactive — counts can't be entered." />
      </div>
    );
  }

  const [position, warehouses, threshold] = await Promise.all([
    getStockPosition(db, ctx),
    md.listWarehouses(db, ctx),
    approvalThresholdGrams(db, ctx.orgId),
  ]);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="New stock count"
        description={`Enter what is physically there. Differences over ${fmtGrams(threshold)} need approval when posted.`}
      />
      {warehouses.length === 0 ? (
        <EmptyState title="No warehouses" description="Add a warehouse in master data first." />
      ) : (
        <CountSheet
          warehouses={warehouses.map((w) => ({
            id: w.id,
            name: w.name,
            bins: w.bins.map((b) => ({ id: b.id, name: b.name })),
          }))}
          lots={lotsByWarehouse(position)}
          thresholdGrams={threshold}
        />
      )}
    </div>
  );
}
