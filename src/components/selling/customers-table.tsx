"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { naira } from "./format";
import { ResponsiveTable } from "./responsive-table";

export type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  state: string | null;
  outstandingKobo: number;
};

const columns: ColumnDef<CustomerRow, unknown>[] = [
  {
    header: "Customer",
    accessorKey: "name",
    cell: ({ row }) => (
      <Link href={`/customers/${row.original.id}`} className="font-medium hover:underline">
        {row.original.name}
      </Link>
    ),
  },
  { header: "Phone", accessorKey: "phone", cell: ({ row }) => row.original.phone ?? "—" },
  { header: "State", accessorKey: "state", cell: ({ row }) => row.original.state ?? "—" },
  {
    header: () => <span className="block text-right">Outstanding</span>,
    id: "outstanding",
    cell: ({ row }) => <span className="block text-right tabular-nums">{naira(row.original.outstandingKobo)}</span>,
  },
];

export function CustomersTable({ rows }: { rows: CustomerRow[] }) {
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <Link href={`/customers/${r.id}`} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{r.name}</p>
            <p className="text-xs text-muted-foreground">{[r.phone, r.state].filter(Boolean).join(" · ") || "—"}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Owes</p>
            <p className="font-semibold tabular-nums">{naira(r.outstandingKobo)}</p>
          </div>
        </Link>
      )}
    />
  );
}
