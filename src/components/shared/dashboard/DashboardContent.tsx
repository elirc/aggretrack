import { getDashboardAction } from "@/actions/reports";
import { isoDateLabel, kgLabel, money } from "@/components/logistics/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { OrgContext } from "@/lib/authz/context";
import { can } from "@/lib/authz/permissions";
import { kgToGrams } from "@/lib/domain/units";
import type { DashboardData } from "@/lib/services/dashboard";

import { PeriodChart, type PeriodPoint } from "./PeriodChart";
import { StatCard } from "./StatCard";
import { StatusChips } from "./StatusChips";
import { TopList } from "./TopList";

/** kg string → number for the chart (display only). */
function kgNum(kg: string): number {
  return kgToGrams(kg) / 1000;
}

function chartSeries(d: DashboardData): { unit: "naira" | "kg"; data: PeriodPoint[] } {
  const { weekKobo: pw, monthKobo: pm } = d.purchases;
  const { weekKobo: sw, monthKobo: sm } = d.sales;
  if (pw !== null && pm !== null && sw !== null && sm !== null) {
    return {
      unit: "naira",
      data: [
        { period: "This week", purchases: pw / 100, sales: sw / 100 },
        { period: "This month", purchases: pm / 100, sales: sm / 100 },
      ],
    };
  }
  return {
    unit: "kg",
    data: [
      { period: "This week", purchases: kgNum(d.purchases.weekKg), sales: kgNum(d.sales.weekKg) },
      { period: "This month", purchases: kgNum(d.purchases.monthKg), sales: kgNum(d.sales.monthKg) },
    ],
  };
}

function approvalsHref(ctx: OrgContext, d: DashboardData): string | null {
  const p = can(ctx.role, "purchase.read");
  const a = can(ctx.role, "adjustment.read");
  if (p && (d.pendingApprovals.purchases >= d.pendingApprovals.adjustments || !a)) {
    return "/purchases?status=pending_approval";
  }
  if (a) return "/adjustments";
  return null;
}

/** Async dashboard body; the page wraps it in <Suspense> with DashboardSkeleton. */
export async function DashboardContent({ ctx }: { ctx: OrgContext }) {
  const res = await getDashboardAction({});
  if (!res.ok) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        {res.error === "FORBIDDEN"
          ? "You don't have access to the dashboard."
          : "Couldn't load the dashboard. Refresh to try again."}
      </div>
    );
  }
  const d = res.data;
  const hidden = ctx.restrictions.hidePrices;
  const chart = chartSeries(d);
  const m = d.grossMarginMonth;

  return (
    <div className="flex flex-col gap-4">
      <StatusChips approvals={d.pendingApprovals} unreadAlerts={d.unreadAlerts} approvalsHref={approvalsHref(ctx, d)} />

      {hidden ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Prices are hidden for your role — money figures show as —. Weights are still shown.
        </p>
      ) : null}

      <section aria-label="Key figures" className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        <StatCard
          label="Stock value"
          value={d.stock.valueKobo === null ? null : money(d.stock.valueKobo)}
          sub={`${kgLabel(d.stock.kg)} · ${d.stock.lots} lot${d.stock.lots === 1 ? "" : "s"}`}
          href={can(ctx.role, "stock.read") ? "/stock" : undefined}
        />
        <StatCard
          label="Gross margin (month)"
          value={m === null ? null : money(m.marginKobo)}
          sub={m === null ? "Revenue − landed cost − expenses" : `${m.marginPercent.toFixed(1)}% on ${money(m.revenueKobo)}`}
          href={can(ctx.role, "report.read") ? "/reports/margin" : undefined}
        />
        <StatCard
          label="Purchases this week"
          value={d.purchases.weekKobo === null ? null : money(d.purchases.weekKobo)}
          sub={kgLabel(d.purchases.weekKg)}
          href={can(ctx.role, "purchase.read") ? "/purchases" : undefined}
        />
        <StatCard
          label="Purchases this month"
          value={d.purchases.monthKobo === null ? null : money(d.purchases.monthKobo)}
          sub={kgLabel(d.purchases.monthKg)}
          href={can(ctx.role, "purchase.read") ? "/purchases" : undefined}
        />
        <StatCard
          label="Sales this week"
          value={d.sales.weekKobo === null ? null : money(d.sales.weekKobo)}
          sub={kgLabel(d.sales.weekKg)}
          href={can(ctx.role, "sale.read") ? "/sales" : undefined}
        />
        <StatCard
          label="Sales this month"
          value={d.sales.monthKobo === null ? null : money(d.sales.monthKobo)}
          sub={kgLabel(d.sales.monthKg)}
          href={can(ctx.role, "sale.read") ? "/sales" : undefined}
        />
        <StatCard
          label="Owed to suppliers"
          value={d.owedToSuppliersKobo === null ? null : money(d.owedToSuppliersKobo)}
          sub="Open payables"
          href={can(ctx.role, "supplier-payment.read") ? "/payables" : undefined}
        />
        <StatCard
          label="Owed by customers"
          value={d.owedByCustomersKobo === null ? null : money(d.owedByCustomersKobo)}
          sub="Open receivables"
          href={can(ctx.role, "customer-payment.read") ? "/receivables" : undefined}
        />
      </section>

      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-base">Purchases vs sales</CardTitle>
          <CardDescription>
            {chart.unit === "naira" ? "Value (₦)" : "Weight (kg)"} — week from {isoDateLabel(d.weekStart)}, month from{" "}
            {isoDateLabel(d.monthStart)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PeriodChart data={chart.data} unit={chart.unit} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <TopList
          title="Top suppliers"
          windowDays={d.topWindowDays}
          items={d.topSuppliers}
          hrefBase="/suppliers"
          emptyText="No purchases in this window."
        />
        <TopList
          title="Top customers"
          windowDays={d.topWindowDays}
          items={d.topCustomers}
          hrefBase="/customers"
          emptyText="No sales in this window."
        />
      </div>
      <p className="text-right text-xs text-muted-foreground">As of {isoDateLabel(d.asOf)} (Lagos)</p>
    </div>
  );
}
