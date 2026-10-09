"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { dateOnly, naira } from "./format";
import { ResponsiveTable } from "./responsive-table";
import { InvoiceStatusBadge } from "./status";

export type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  totalKobo: number;
  outstandingKobo: number;
};

const columns: ColumnDef<InvoiceRow, unknown>[] = [
  {
    header: "Invoice",
    id: "no",
    cell: ({ row }) => (
      <Link href={`/invoices/${row.original.id}`} className="font-medium hover:underline">
        {row.original.invoiceNumber}
      </Link>
    ),
  },
  { header: "Customer", id: "customer", cell: ({ row }) => row.original.customerName },
  { header: "Date", id: "date", cell: ({ row }) => dateOnly(row.original.invoiceDate) },
  { header: "Due", id: "due", cell: ({ row }) => dateOnly(row.original.dueDate) },
  { header: "Status", id: "status", cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} /> },
  {
    header: () => <span className="block text-right">Total</span>,
    id: "total",
    cell: ({ row }) => <span className="block text-right tabular-nums">{naira(row.original.totalKobo)}</span>,
  },
  {
    header: () => <span className="block text-right">Outstanding</span>,
    id: "out",
    cell: ({ row }) => (
      <span className="block text-right font-medium tabular-nums">{naira(row.original.outstandingKobo)}</span>
    ),
  },
];

export function InvoicesTable({ rows }: { rows: InvoiceRow[] }) {
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <Link href={`/invoices/${r.id}`} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{r.invoiceNumber}</p>
            <p className="truncate text-sm">{r.customerName}</p>
            <p className="text-xs text-muted-foreground">{dateOnly(r.invoiceDate)}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <InvoiceStatusBadge status={r.status} />
            <p className="text-sm tabular-nums">{naira(r.totalKobo)}</p>
            {r.outstandingKobo > 0 ? (
              <p className="text-xs text-muted-foreground tabular-nums">Owes {naira(r.outstandingKobo)}</p>
            ) : null}
          </div>
        </Link>
      )}
    />
  );
}
