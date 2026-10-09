import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { MOVEMENT_TYPE_LABEL } from "@/components/warehouse/format";
import { MovementsTable } from "@/components/warehouse/movements-table";
import { dateParam, movementTypeParam, pageParam, uuidParam, type SP } from "@/components/warehouse/params";
import { lotLabels } from "@/components/warehouse/server/lookups";
import { EmptyState, NoAccess, Notice } from "@/components/warehouse/status";
import { UrlFilters, UrlPager } from "@/components/warehouse/url-filters";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import * as md from "@/lib/services/masterData";
import { getMovementHistory } from "@/lib/services/stockQueries";
import { MOVEMENT_TYPES } from "@/lib/validation/warehouse";

export const metadata = { title: "Movements · AggreTrack" };

const PAGE_SIZE = 50;

export default async function MovementsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "stock.read")) return <NoAccess title="Movements" what="stock movements" />;

  const sp = await searchParams;
  const lotId = uuidParam(sp, "lot");
  const warehouseId = uuidParam(sp, "warehouse");
  const type = movementTypeParam(sp);
  const fromDate = dateParam(sp, "from");
  const toDate = dateParam(sp, "to");
  const page = pageParam(sp);
  const badRange = Boolean(fromDate && toDate && fromDate > toDate);

  const [history, warehouses, lotMap] = await Promise.all([
    badRange
      ? Promise.resolve({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE })
      : getMovementHistory(db, ctx, { lotId, warehouseId, type, fromDate, toDate, page, pageSize: PAGE_SIZE }),
    md.listWarehouses(db, ctx, { includeInactive: true }),
    lotId ? lotLabels(ctx, [lotId]) : Promise.resolve(new Map()),
  ]);

  const current = { lot: lotId, warehouse: warehouseId, type, from: fromDate, to: toDate };
  const lot = lotId ? lotMap.get(lotId) : undefined;
  const filtered = Object.values(current).some(Boolean);

  return (
    <div>
      <PageHeader title="Movements" description="Every change to stock, newest first." />
      <UrlFilters
        current={current}
        chips={lotId ? [{ param: "lot", label: `Lot ${lot?.lotNumber ?? lotId.slice(0, 8)}` }] : undefined}
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
            param: "type",
            label: "Type",
            allLabel: "All types",
            options: MOVEMENT_TYPES.map((t) => ({ value: t, label: MOVEMENT_TYPE_LABEL[t] ?? t })),
          },
          { kind: "date", param: "from", label: "From" },
          { kind: "date", param: "to", label: "To" },
        ]}
      />
      {badRange ? <Notice tone="warn">The “from” date must be on or before the “to” date.</Notice> : null}
      {history.rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No movements match these filters" : "No stock movements yet"}
          description={filtered ? "Widen the date range or clear a filter." : "Receipts, transfers, adjustments and dispatches appear here."}
        />
      ) : (
        <>
          <MovementsTable rows={history.rows} />
          <UrlPager page={history.page} pageSize={history.pageSize} total={history.total} current={current} />
        </>
      )}
    </div>
  );
}
