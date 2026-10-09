"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { formatLagosDate, formatLagosDateTime } from "./format";
import { ResponsiveTable } from "./responsive-table";
import { StatusBadge } from "./status";

export type CountListRow = {
  id: string;
  countNumber: string;
  warehouseId: string;
  status: string;
  countedAt: Date;
  postedAt: Date | null;
};

export function CountsList({ rows, names }: { rows: CountListRow[]; names: Record<string, string> }) {
  const wh = (id: string) => names[id] ?? "Unknown warehouse";
  const columns: ColumnDef<CountListRow, unknown>[] = [
    {
      id: "number",
      header: "Count",
      cell: ({ row }) => (
        <Link href={`/counts/${row.original.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
          {row.original.countNumber}
        </Link>
      ),
    },
    { id: "warehouse", header: "Warehouse", cell: ({ row }) => wh(row.original.warehouseId) },
    { id: "counted", header: "Counted", cell: ({ row }) => formatLagosDateTime(row.original.countedAt) },
    { id: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    {
      id: "posted",
      header: "Posted",
      cell: ({ row }) => (row.original.postedAt ? formatLagosDate(row.original.postedAt) : "—"),
    },
  ];
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(c) => (
        <Link href={`/counts/${c.id}`} className="flex flex-col gap-1 text-sm">
          <span className="flex items-center justify-between gap-2">
            <span className="font-mono font-medium">{c.countNumber}</span>
            <StatusBadge status={c.status} />
          </span>
          <span>{wh(c.warehouseId)}</span>
          <span className="text-xs text-muted-foreground">Counted {formatLagosDateTime(c.countedAt)}</span>
        </Link>
      )}
    />
  );
}
