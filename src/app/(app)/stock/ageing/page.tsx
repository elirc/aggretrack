import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { AgeingView } from "@/components/warehouse/ageing-view";
import { uuidParam, type SP } from "@/components/warehouse/params";
import { EmptyState, NoAccess } from "@/components/warehouse/status";
import { UrlFilters } from "@/components/warehouse/url-filters";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import * as md from "@/lib/services/masterData";
import { getStockAgeing } from "@/lib/services/stockQueries";

export const metadata = { title: "Stock ageing · AggreTrack" };

export default async function StockAgeingPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "stock.read")) return <NoAccess title="Stock ageing" what="stock" />;

  const sp = await searchParams;
  const warehouseId = uuidParam(sp, "warehouse");
  const commodityId = uuidParam(sp, "commodity");

  const [ageing, warehouses, commodities] = await Promise.all([
    getStockAgeing(db, ctx, { warehouseId, commodityId }),
    md.listWarehouses(db, ctx, { includeInactive: true }),
    md.listCommodities(db, ctx, { includeInactive: true }),
  ]);

  return (
    <div>
      <PageHeader
        title="Stock ageing"
        description="How long stock has been held, from the lot's received date."
        actions={
          <Button asChild variant="outline" size="sm" className="h-9">
            <Link href="/stock">Position</Link>
          </Button>
        }
      />
      <UrlFilters
        current={{ warehouse: warehouseId, commodity: commodityId }}
        filters={[
          {
            kind: "select",
            param: "warehouse",
            label: "Warehouse",
            allLabel: "All warehouses",
            options: warehouses.map((w) => ({ value: w.id, label: w.name })),
          },
          {
            kind: "select",
            param: "commodity",
            label: "Commodity",
            allLabel: "All commodities",
            options: commodities.map((c) => ({ value: c.id, label: c.name })),
          },
        ]}
      />
      {ageing.rows.length === 0 ? (
        <EmptyState title="No stock to age" description="Ageing appears once there is stock on hand." />
      ) : (
        <AgeingView ageing={ageing} />
      )}
    </div>
  );
}
