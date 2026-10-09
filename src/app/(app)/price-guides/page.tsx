import { FilterBar } from "@/components/buying/filter-bar";
import { requireOrgContext, spDate, spPage, spUuid, type RawSearchParams } from "@/components/buying/server";
import { NoAccess, Pager, ReadOnlyNotice } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import * as md from "@/lib/services/masterData";
import { listPriceGuides } from "@/lib/services/priceGuides";

import { PriceGuidesView } from "./_components/price-guides-view";

export const metadata = { title: "Price guides · AggreTrack" };

const PAGE_SIZE = 100;

export default async function PriceGuidesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "price-guide.read") || ctx.restrictions.hidePrices) {
    return (
      <div>
        <PageHeader title="Price guides" />
        <NoAccess what="price guides" />
      </div>
    );
  }
  const params = await searchParams;
  const date = spDate(params, "date");
  const commodityId = spUuid(params, "commodityId");
  const buyingPointId = spUuid(params, "buyingPointId");
  const page = spPage(params);

  const [result, commodities, grades, buyingPoints] = await Promise.all([
    listPriceGuides(db, ctx, { commodityId, buyingPointId, from: date, to: date, page, pageSize: PAGE_SIZE }),
    md.listCommodities(db, ctx),
    md.listGrades(db, ctx),
    md.listBuyingPoints(db, ctx),
  ]);
  const canWrite = can(ctx.role, "price-guide.write") && !ctx.readOnly;
  const values = { date, commodityId, buyingPointId };

  return (
    <div>
      <PageHeader title="Price guides" description="The day's maximum buying price per kg. Purchases above it need approval." />
      {ctx.readOnly ? <ReadOnlyNotice /> : null}
      <FilterBar
        basePath="/price-guides"
        values={values}
        filters={[
          { name: "date", label: "Date", kind: "date" },
          {
            name: "commodityId",
            label: "Commodity",
            kind: "select",
            allLabel: "All commodities",
            options: commodities.map((c) => ({ value: c.id, label: c.name })),
          },
          ...(buyingPoints.length > 0
            ? [
                {
                  name: "buyingPointId",
                  label: "Buying point",
                  kind: "select" as const,
                  allLabel: "All points",
                  options: buyingPoints.map((b) => ({ value: b.id, label: b.name })),
                },
              ]
            : []),
        ]}
      />
      <PriceGuidesView
        rows={result.rows.map((r) => ({
          id: r.id,
          guideDate: r.guideDate,
          commodityId: r.commodityId,
          commodityName: r.commodityName,
          gradeId: r.gradeId,
          gradeName: r.gradeName,
          buyingPointId: r.buyingPointId,
          buyingPointName: r.buyingPointName,
          maxPricePerKgKobo: r.maxPricePerKgKobo,
        }))}
        commodities={commodities.map((c) => ({ id: c.id, name: c.name }))}
        grades={grades.map((g) => ({ id: g.id, name: g.name, commodityId: g.commodityId }))}
        buyingPoints={buyingPoints.map((b) => ({ id: b.id, name: b.name }))}
        canWrite={canWrite}
        defaultDate={date}
      />
      <Pager basePath="/price-guides" params={values} page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
