"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export type PeriodPoint = { period: string; purchases: number; sales: number };

/**
 * Purchases vs sales for the two periods the dashboard payload provides
 * (week-to-date, month-to-date). One y-axis, one unit: naira when prices are
 * visible, kg when they are hidden. Colours come from the theme's chart
 * tokens (fixed order: purchases = slot A, sales = slot B), stepped
 * separately for dark mode.
 */
const config = {
  purchases: { label: "Purchases", theme: { light: "var(--chart-2)", dark: "var(--chart-1)" } },
  sales: { label: "Sales", theme: { light: "var(--chart-4)", dark: "var(--chart-3)" } },
} satisfies ChartConfig;

function compact(n: number, unit: "naira" | "kg"): string {
  const abs = Math.abs(n);
  const s =
    abs >= 1e9
      ? `${(n / 1e9).toFixed(1)}B`
      : abs >= 1e6
        ? `${(n / 1e6).toFixed(1)}M`
        : abs >= 1e3
          ? `${(n / 1e3).toFixed(1)}k`
          : n.toFixed(0);
  const t = s.replace(/\.0(?=[kMB]?$)/, "");
  return unit === "naira" ? `₦${t}` : `${t} kg`;
}

function full(n: number, unit: "naira" | "kg"): string {
  return unit === "naira"
    ? `₦${n.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${n.toLocaleString("en-NG", { maximumFractionDigits: 3 })} kg`;
}

export function PeriodChart({ data, unit }: { data: PeriodPoint[]; unit: "naira" | "kg" }) {
  const empty = data.every((d) => d.purchases === 0 && d.sales === 0);
  return (
    <figure className="flex flex-col gap-2">
      {empty ? (
        <p className="flex h-48 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          No purchases or sales yet this month.
        </p>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <BarChart data={data} barGap={2} barCategoryGap="28%" margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="period" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => compact(v, unit)}
            />
            <ChartTooltip
              cursor={{ fillOpacity: 0.4 }}
              content={
                <ChartTooltipContent
                  formatter={(value, name, item) => (
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: item.color }} aria-hidden />
                        {config[name as keyof typeof config]?.label ?? String(name)}
                      </span>
                      <span className="font-mono font-medium text-foreground tabular-nums">
                        {typeof value === "number" ? full(value, unit) : String(value)}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="purchases" fill="var(--color-purchases)" radius={[4, 4, 0, 0]} maxBarSize={56} />
            <Bar dataKey="sales" fill="var(--color-sales)" radius={[4, 4, 0, 0]} maxBarSize={56} />
          </BarChart>
        </ChartContainer>
      )}
      {/* Table view of the same numbers (screen readers; never colour-alone). */}
      <table className="sr-only">
        <caption>Purchases and sales ({unit === "naira" ? "naira" : "kilograms"})</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Purchases</th>
            <th scope="col">Sales</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.period}>
              <th scope="row">{d.period}</th>
              <td>{full(d.purchases, unit)}</td>
              <td>{full(d.sales, unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
