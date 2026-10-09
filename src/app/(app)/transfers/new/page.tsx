import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { lotsByWarehouse } from "@/components/warehouse/position";
import { orgWarehouseLabels } from "@/components/warehouse/server/lookups";
import { EmptyState, NoAccess } from "@/components/warehouse/status";
import { TransferForm } from "@/components/warehouse/transfer-form";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { getStockPosition } from "@/lib/services/stockQueries";

export const metadata = { title: "New transfer · AggreTrack" };

export default async function NewTransferPage() {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "transfer.write")) return <NoAccess title="New transfer" what="create transfers" />;
  if (ctx.readOnly) {
    return (
      <div>
        <PageHeader title="New transfer" />
        <EmptyState title="Read only" description="Subscription inactive — transfers can't be created." />
      </div>
    );
  }

  const [position, warehouses] = await Promise.all([getStockPosition(db, ctx), orgWarehouseLabels(ctx)]);
  const active = warehouses.filter((w) => w.active);
  const allowed = ctx.restrictions.warehouseIds;
  const sources = active
    .filter((w) => allowed === null || allowed.includes(w.id))
    .map((w) => ({ id: w.id, name: w.name }));
  const destinations = active.map((w) => ({ id: w.id, name: w.name }));

  return (
    <div className="max-w-2xl">
      <PageHeader title="New transfer" description="Saved as a draft. Dispatch it when the load leaves." />
      {sources.length === 0 || destinations.length < 2 ? (
        <EmptyState
          title="Transfers need two warehouses"
          description="Add another warehouse in master data, or ask for access to a source warehouse."
        />
      ) : (
        <TransferForm sources={sources} destinations={destinations} lots={lotsByWarehouse(position)} />
      )}
    </div>
  );
}
