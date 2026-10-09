import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeftRight,
  Clock,
  HandCoins,
  PackageSearch,
  Percent,
  ShoppingCart,
  TrendingDown,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { REPORT_LIST } from "@/components/reports/definitions";
import { Card, CardContent } from "@/components/ui/card";
import { NoAccess } from "@/components/warehouse/status";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import type { ReportKey } from "@/lib/validation/logistics";

export const metadata = { title: "Reports · AggreTrack" };

const ICONS: Record<ReportKey, LucideIcon> = {
  purchases: ShoppingCart,
  "stock-position": PackageSearch,
  "stock-movements": ArrowLeftRight,
  "sales-by-customer": Users,
  margin: Percent,
  "payables-ageing": Wallet,
  "receivables-ageing": HandCoins,
  "supplier-performance": Clock,
  shrinkage: TrendingDown,
  "trip-costs": Truck,
};

export default async function ReportsPage() {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "report.read")) return <NoAccess title="Reports" what="reports" />;

  return (
    <div>
      <PageHeader
        title="Reports"
        description={
          can(ctx.role, "report.export")
            ? "Pick a report, set the dates and filters, then export to Excel or PDF."
            : "Pick a report and set the dates and filters."
        }
      />
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORT_LIST.map((r) => {
          const Icon = ICONS[r.key];
          return (
            <li key={r.key}>
              <Link
                href={`/reports/${r.key}`}
                className="block h-full rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Card className="h-full py-4 transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-start gap-3 px-4">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">{r.title}</p>
                      <p className="text-sm text-muted-foreground">{r.description}</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
