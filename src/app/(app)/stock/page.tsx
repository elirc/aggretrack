import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { fmtGrams } from "@/components/warehouse/format";
import { uuidParam, type SP } from "@/components/warehouse/params";
import { EmptyState, NoAccess } from "@/components/warehouse/status";
import { StockPositionView } from "@/components/warehouse/stock-position-view";
import { UrlFilters } from "@/components/warehouse/url-filters";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import * as md from "@/lib/services/masterData";
import { getInTransit, getStockPosition } from "@/lib/services/stockQueries";

export const metadata = { title: "Stock · AggreTrack" };

export default async function StockPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "stock.read")) return <NoAccess title="Stock" what="stock" />;

  const sp = await searchParams;
  const warehouseId = uuidParam(sp, "warehouse");
  const commodityId = uuidParam(sp, "commodity");

  const [position, warehouses, commodities, inTransit] = await Promise.all([
    getStockPosition(db, ctx, { warehouseId, commodityId }),
    md.listWarehouses(db, ctx, { includeInactive: true }),
    md.listCommodities(db, ctx, { includeInactive: true }),
    getInTransit(db, ctx, { warehouseId }),
  ]);

  const transitGrams = inTransit.reduce((s, r) => s + r.grams, 0);
  const transitCount = new Set(inTransit.map((r) => r.transferId)).size;
  const filtered = Boolean(warehouseId || commodityId);

  return (
    <div>
      <PageHeader
        title="Stock"
        description="On hand by commodity, grade and warehouse."
        actions={
          <>
            <Button asChild variant="outline" size="sm" className="h-9">
              <Link href="/stock/ageing">Ageing</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="h-9">
              <Link href="/movements">Movements</Link>
            </Button>
          </>
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
      {transitCount > 0 ? (
        <Link
          href="/transfers?status=in_transit"
          className="mb-3 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <span>
            {transitCount} transfer{transitCount === 1 ? "" : "s"} in transit
          </span>
          <span className="font-medium tabular-nums">{fmtGrams(transitGrams)}</span>
        </Link>
      ) : null}
      {position.commodities.length === 0 ? (
        <EmptyState
          title={filtered ? "No stock matches these filters" : "No stock on hand yet"}
          description={
            filtered
              ? "Try another warehouse or commodity."
              : "Stock appears here once purchases are received into a warehouse."
          }
          href={filtered ? undefined : "/purchases"}
          actionLabel={filtered ? undefined : "Go to purchases"}
        />
      ) : (
        <StockPositionView position={position} />
      )}
    </div>
  );
}
