"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { dateOnly, naira } from "./format";
import { ResponsiveTable } from "./responsive-table";

export type PaymentRow = {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  customerId: string;
  customerName: string;
  method: string;
  reference: string | null;
  amountKobo: number;
  allocatedKobo: number;
  unallocatedKobo: number;
};

const METHOD: Record<string, string> = { cash: "Cash", transfer: "Transfer", pos: "POS" };

const right = (v: string) => <span className="block text-right tabular-nums">{v}</span>;

const columns: ColumnDef<PaymentRow, unknown>[] = [
  { header: "Payment", id: "no", cell: ({ row }) => <span className="font-medium">{row.original.paymentNumber}</span> },
  { header: "Date", id: "date", cell: ({ row }) => dateOnly(row.original.paymentDate) },
  {
    header: "Customer",
    id: "customer",
    cell: ({ row }) => (
      <Link href={`/customers/${row.original.customerId}`} className="hover:underline">
        {row.original.customerName}
      </Link>
    ),
  },
  {
    header: "Method",
    id: "method",
    cell: ({ row }) => (
      <span>
        {METHOD[row.original.method] ?? row.original.method}
        {row.original.reference ? (
          <span className="block text-xs text-muted-foreground">{row.original.reference}</span>
        ) : null}
      </span>
    ),
  },
  { header: () => right("Amount"), id: "amount", cell: ({ row }) => right(naira(row.original.amountKobo)) },
  { header: () => right("Allocated"), id: "alloc", cell: ({ row }) => right(naira(row.original.allocatedKobo)) },
  { header: () => right("Credit"), id: "credit", cell: ({ row }) => right(naira(row.original.unallocatedKobo)) },
];

export function PaymentsTable({ rows }: { rows: PaymentRow[] }) {
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{r.paymentNumber}</p>
            <Link href={`/customers/${r.customerId}`} className="block truncate text-sm hover:underline">
              {r.customerName}
            </Link>
            <p className="text-xs text-muted-foreground">
              {dateOnly(r.paymentDate)} · {METHOD[r.method] ?? r.method}
            </p>
          </div>
          <div className="text-right">
            <p className="font-semibold tabular-nums">{naira(r.amountKobo)}</p>
            {r.unallocatedKobo > 0 ? (
              <p className="text-xs text-muted-foreground tabular-nums">{naira(r.unallocatedKobo)} credit</p>
            ) : null}
          </div>
        </div>
      )}
    />
  );
}
