"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { dateOnly, naira } from "./format";
import { ResponsiveTable } from "./responsive-table";
import { SalesStatusBadge } from "./status";

export type SalesRow = {
  id: string;
  orderNumber: string;
  customerName: string;
  orderDate: string;
  status: string;
  totalAmountKobo: number | null;
};

const columns: ColumnDef<SalesRow, unknown>[] = [
  {
    header: "Order",
    id: "no",
    cell: ({ row }) => (
      <Link href={`/sales/${row.original.id}`} className="font-medium hover:underline">
        {row.original.orderNumber}
      </Link>
    ),
  },
  { header: "Customer", id: "customer", cell: ({ row }) => row.original.customerName },
  { header: "Date", id: "date", cell: ({ row }) => dateOnly(row.original.orderDate) },
  { header: "Status", id: "status", cell: ({ row }) => <SalesStatusBadge status={row.original.status} /> },
  {
    header: () => <span className="block text-right">Total</span>,
    id: "total",
    cell: ({ row }) => <span className="block text-right tabular-nums">{naira(row.original.totalAmountKobo)}</span>,
  },
];

export function SalesTable({ rows }: { rows: SalesRow[] }) {
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <Link href={`/sales/${r.id}`} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{r.orderNumber}</p>
            <p className="truncate text-sm">{r.customerName}</p>
            <p className="text-xs text-muted-foreground">{dateOnly(r.orderDate)}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <SalesStatusBadge status={r.status} />
            <p className="text-sm font-semibold tabular-nums">{naira(r.totalAmountKobo)}</p>
          </div>
        </Link>
      )}
    />
  );
}
