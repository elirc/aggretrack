"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { TableCell, TableRow } from "@/components/ui/table";

import { naira } from "./format";
import { ResponsiveTable } from "./responsive-table";

export type AgeBandKey = "d0_30" | "d31_60" | "d61_90" | "d90_plus";

export type ReceivableRow = {
  customerId: string;
  customerName: string;
  buckets: Record<AgeBandKey, number>;
  totalOutstandingKobo: number;
  invoiceCount: number;
};

export const BANDS: { key: AgeBandKey; label: string }[] = [
  { key: "d0_30", label: "0–30 days" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "d90_plus", label: "90+ days" },
];

const right = (v: string, strong = false) => (
  <span className={`block text-right tabular-nums${strong ? " font-semibold" : ""}`}>{v}</span>
);

const columns: ColumnDef<ReceivableRow, unknown>[] = [
  {
    header: "Customer",
    id: "customer",
    cell: ({ row }) => (
      <Link href={`/customers/${row.original.customerId}`} className="font-medium hover:underline">
        {row.original.customerName}
      </Link>
    ),
  },
  ...BANDS.map(
    (b): ColumnDef<ReceivableRow, unknown> => ({
      header: () => right(b.label),
      id: b.key,
      cell: ({ row }) => {
        const v = row.original.buckets[b.key];
        return right(v > 0 ? naira(v) : "—");
      },
    }),
  ),
  {
    header: () => right("Total"),
    id: "total",
    cell: ({ row }) => right(naira(row.original.totalOutstandingKobo), true),
  },
];

export function ReceivablesTable({
  rows,
  totals,
}: {
  rows: ReceivableRow[];
  totals: Record<AgeBandKey, number> & { total: number };
}) {
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.customerId}
      footer={
        <TableRow>
          <TableCell className="font-semibold">Total</TableCell>
          {BANDS.map((b) => (
            <TableCell key={b.key}>{right(naira(totals[b.key]), true)}</TableCell>
          ))}
          <TableCell>{right(naira(totals.total), true)}</TableCell>
        </TableRow>
      }
      card={(r) => (
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <Link href={`/customers/${r.customerId}`} className="min-w-0 truncate font-medium hover:underline">
              {r.customerName}
            </Link>
            <span className="font-semibold tabular-nums">{naira(r.totalOutstandingKobo)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {BANDS.map((b) => (
              <div key={b.key} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{b.label}</dt>
                <dd className="tabular-nums">{r.buckets[b.key] > 0 ? naira(r.buckets[b.key]) : "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {r.invoiceCount} open invoice{r.invoiceCount === 1 ? "" : "s"}
          </p>
        </div>
      )}
      mobileFooter={
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold">Total</span>
            <span className="font-semibold tabular-nums">{naira(totals.total)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {BANDS.map((b) => (
              <div key={b.key} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{b.label}</dt>
                <dd className="tabular-nums">{naira(totals[b.key])}</dd>
              </div>
            ))}
          </dl>
        </div>
      }
    />
  );
}
