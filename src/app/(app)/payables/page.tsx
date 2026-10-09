import { FilterBar } from "@/components/buying/filter-bar";
import { displayDate } from "@/components/buying/format";
import { requireOrgContext, spDate, type RawSearchParams } from "@/components/buying/server";
import { EmptyState, NoAccess } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { payablesAgeing } from "@/lib/services/payables";

import { PayablesTable } from "./_components/payables-table";

export const metadata = { title: "Payables · AggreTrack" };

export default async function PayablesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "supplier-payment.read") || ctx.restrictions.hidePrices) {
    return (
      <div>
        <PageHeader title="Payables" />
        <NoAccess what="payables" />
      </div>
    );
  }
  const asOf = spDate(await searchParams, "asOf");
  const report = await payablesAgeing(db, ctx, { asOf });

  return (
    <div>
      <PageHeader
        title="Payables"
        description={`What is owed to suppliers on received purchases, by age · as of ${displayDate(report.asOf)}`}
      />
      <FilterBar basePath="/payables" values={{ asOf }} filters={[{ name: "asOf", label: "As of", kind: "date" }]} />
      {report.rows.length === 0 ? (
        <EmptyState title="Nothing owed to suppliers" description="Every received purchase is paid or offset." />
      ) : (
        <PayablesTable
          rows={report.rows}
          totals={report.totals}
          canPay={can(ctx.role, "supplier-payment.write") && !ctx.readOnly}
        />
      )}
    </div>
  );
}
