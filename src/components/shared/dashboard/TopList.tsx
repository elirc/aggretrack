import Link from "next/link";

import { kgLabel, money } from "@/components/logistics/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardTop } from "@/lib/services/dashboard";

/**
 * Top-5 ranking. Each row carries a thin proportional bar (single neutral
 * hue — magnitude, not identity) so rank and size read at a glance.
 * Ranks by value; when prices are hidden, the bar falls back to kg.
 */
export function TopList({
  title,
  windowDays,
  items,
  hrefBase,
  emptyText,
}: {
  title: string;
  windowDays: number;
  items: DashboardTop[];
  hrefBase: string;
  emptyText: string;
}) {
  const metric = (t: DashboardTop) => (t.valueKobo !== null ? t.valueKobo : Number.parseFloat(t.kg) || 0);
  const max = Math.max(1, ...items.map(metric));
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>Last {windowDays} days</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {items.map((t, i) => (
              <li key={t.id} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <Link href={`${hrefBase}/${t.id}`} className="min-w-0 truncate underline-offset-4 hover:underline">
                    <span className="mr-1.5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                    {t.name}
                  </Link>
                  <span className="shrink-0 text-right tabular-nums">
                    {t.valueKobo !== null ? money(t.valueKobo) : kgLabel(t.kg)}
                    {t.valueKobo !== null ? (
                      <span className="block text-xs text-muted-foreground">{kgLabel(t.kg)}</span>
                    ) : null}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full rounded-full bg-(--chart-2)"
                    style={{ width: `${Math.max(2, Math.round((metric(t) / max) * 100))}%` }}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
