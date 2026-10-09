"use client";

import Link from "next/link";

import { naira } from "@/components/buying/format";
import { ResponsiveTable, type BuyingColumn } from "@/components/buying/responsive-table";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Band = "d0_30" | "d31_60" | "d61_90" | "d90_plus";

const BANDS: Array<{ key: Band; label: string; accent: string; chip: string }> = [
  {
    key: "d0_30",
    label: "0–30 days",
    accent: "border-t-4 border-t-emerald-500",
    chip: "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  },
  {
    key: "d31_60",
    label: "31–60 days",
    accent: "border-t-4 border-t-amber-400",
    chip: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  },
  {
    key: "d61_90",
    label: "61–90 days",
    accent: "border-t-4 border-t-orange-500",
    chip: "bg-orange-50 text-orange-900 dark:bg-orange-950 dark:text-orange-100",
  },
  {
    key: "d90_plus",
    label: "Over 90 days",
    accent: "border-t-4 border-t-red-600",
    chip: "bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  },
];

export type PayablesRowView = {
  supplierId: string;
  supplierName: string;
  supplierPhone: string | null;
  bands: Record<Band, number>;
  totalKobo: number;
  openPurchases: number;
  oldestDays: number;
};

export type PayablesTotalsView = { bands: Record<Band, number>; totalKobo: number; openPurchases: number };

export function PayablesTable({
  rows,
  totals,
  canPay,
}: {
  rows: PayablesRowView[];
  totals: PayablesTotalsView;
  canPay: boolean;
}) {
  const columns: BuyingColumn<PayablesRowView>[] = [
    {
      id: "supplier",
      header: "Supplier",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <Link href={`/suppliers/${row.original.supplierId}`} className="font-medium underline-offset-4 hover:underline">
            {row.original.supplierName}
          </Link>
          <span className="text-xs text-muted-foreground">
            {row.original.openPurchases} open · oldest {row.original.oldestDays} d
          </span>
        </div>
      ),
    },
    ...BANDS.map(
      (b): BuyingColumn<PayablesRowView> => ({
        id: b.key,
        header: b.label,
        meta: { className: "text-right tabular-nums", headerClassName: b.accent },
        cell: ({ row }) => (row.original.bands[b.key] > 0 ? naira(row.original.bands[b.key]) : "—"),
      }),
    ),
    {
      id: "total",
      header: "Total owed",
      meta: { className: "text-right tabular-nums font-semibold" },
      cell: ({ row }) => naira(row.original.totalKobo),
    },
    ...(canPay
      ? [
          {
            id: "pay",
            header: "",
            meta: { className: "text-right" },
            cell: ({ row }) => (
              <Link
                href={`/supplier-payments?supplierId=${row.original.supplierId}`}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Pay
              </Link>
            ),
          } satisfies BuyingColumn<PayablesRowView>,
        ]
      : []),
  ];

  const footer = [
    `Total · ${rows.length} supplier${rows.length === 1 ? "" : "s"}`,
    ...BANDS.map((b) => naira(totals.bands[b.key])),
    naira(totals.totalKobo),
    ...(canPay ? [""] : []),
  ];

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BANDS.map((b) => (
          <Card key={b.key} className={cn("gap-1 py-3", b.accent)}>
            <CardContent className="px-3">
              <p className="text-xs text-muted-foreground">{b.label}</p>
              <p className="font-semibold tabular-nums">{naira(totals.bands[b.key])}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <ResponsiveTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.supplierId}
        footer={footer}
        mobileFooter={
          <Card className="py-3">
            <CardContent className="flex items-baseline justify-between px-3">
              <span className="font-semibold">Total owed</span>
              <span className="text-lg font-semibold tabular-nums">{naira(totals.totalKobo)}</span>
            </CardContent>
          </Card>
        }
        card={(r) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/suppliers/${r.supplierId}`} className="block truncate font-medium">
                  {r.supplierName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {r.openPurchases} open · oldest {r.oldestDays} days
                </p>
              </div>
              <span className="font-semibold tabular-nums">{naira(r.totalKobo)}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BANDS.filter((b) => r.bands[b.key] > 0).map((b) => (
                <span key={b.key} className={cn("rounded-md px-2 py-1 text-xs tabular-nums", b.chip)}>
                  {b.label}: {naira(r.bands[b.key])}
                </span>
              ))}
            </div>
            {canPay ? (
              <Link
                href={`/supplier-payments?supplierId=${r.supplierId}`}
                className="inline-flex h-11 items-center justify-center rounded-lg border text-sm font-medium"
              >
                Record payment
              </Link>
            ) : null}
          </div>
        )}
      />
    </>
  );
}
