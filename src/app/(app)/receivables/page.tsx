import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { dateOnly, naira } from "@/components/selling/format";
import { EmptyState, NoAccess, Stat, sp } from "@/components/selling/page-states";
import { BANDS, ReceivablesTable } from "@/components/selling/receivables-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { receivablesAgeing } from "@/lib/services/receivables";
import { lagosToday } from "@/lib/services/salesOrders";
import { zDateISO } from "@/lib/validation/common";

export const metadata = { title: "Receivables · AggreTrack" };

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  // Matches receivablesAgeingAction's permission (invoice.read).
  if (!can(ctx.role, "invoice.read")) return <NoAccess title="Receivables" what="receivables" />;

  const params = await searchParams;
  const rawAsOf = sp(params.asOf);
  const asOf = rawAsOf && zDateISO.safeParse(rawAsOf).success ? rawAsOf : undefined;
  const report = await receivablesAgeing(db, ctx, { asOf });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Receivables" description={`What each customer owes, by age, as at ${dateOnly(report.asOf)}.`} />

      <form className="flex flex-wrap items-end gap-2" action="/receivables">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">As at</span>
          <Input type="date" name="asOf" defaultValue={asOf ?? lagosToday()} className="h-11 sm:h-9" />
        </label>
        <Button type="submit" variant="outline" className="h-11 sm:h-9">
          Update
        </Button>
      </form>

      <section aria-label="Totals" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {BANDS.map((b) => (
          <Stat
            key={b.key}
            label={b.label}
            value={naira(report.totals[b.key])}
            tone={b.key === "d90_plus" && report.totals[b.key] > 0 ? "bad" : undefined}
          />
        ))}
        <Stat label="Total owed" value={naira(report.totals.total)} tone={report.totals.total > 0 ? "warn" : undefined} />
      </section>

      {report.rows.length === 0 ? (
        <EmptyState title="Nothing outstanding." hint="Every issued invoice is paid as at this date." />
      ) : (
        <ReceivablesTable
          rows={report.rows.map((r) => ({
            customerId: r.customerId,
            customerName: r.customerName,
            buckets: r.buckets,
            totalOutstandingKobo: r.totalOutstandingKobo,
            invoiceCount: r.invoices.length,
          }))}
          totals={report.totals}
        />
      )}
    </div>
  );
}
