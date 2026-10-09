"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { formatLagosDate } from "./format";
import { ResponsiveTable } from "./responsive-table";
import { StatusBadge } from "./status";

export type TransferListRow = {
  id: string;
  transferNumber: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  status: string;
  createdAt: Date;
  dispatchedAt: Date | null;
  receivedAt: Date | null;
};

function lastDate(t: TransferListRow): string {
  if (t.receivedAt) return `Received ${formatLagosDate(t.receivedAt)}`;
  if (t.dispatchedAt) return `Dispatched ${formatLagosDate(t.dispatchedAt)}`;
  return `Created ${formatLagosDate(t.createdAt)}`;
}

export function TransfersList({ rows, names }: { rows: TransferListRow[]; names: Record<string, string> }) {
  const wh = (id: string) => names[id] ?? "Unknown warehouse";
  const columns: ColumnDef<TransferListRow, unknown>[] = [
    {
      id: "number",
      header: "Transfer",
      cell: ({ row }) => (
        <Link href={`/transfers/${row.original.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
          {row.original.transferNumber}
        </Link>
      ),
    },
    {
      id: "route",
      header: "Route",
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1">
          {wh(row.original.fromWarehouseId)} <ArrowRight className="size-3.5" /> {wh(row.original.toWarehouseId)}
        </span>
      ),
    },
    { id: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { id: "date", header: "Last update", cell: ({ row }) => lastDate(row.original) },
  ];
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(t) => (
        <Link href={`/transfers/${t.id}`} className="flex flex-col gap-1 text-sm">
          <span className="flex items-center justify-between gap-2">
            <span className="font-mono font-medium">{t.transferNumber}</span>
            <StatusBadge status={t.status} />
          </span>
          <span className="inline-flex flex-wrap items-center gap-1">
            {wh(t.fromWarehouseId)} <ArrowRight className="size-3.5" /> {wh(t.toWarehouseId)}
          </span>
          <span className="text-xs text-muted-foreground">{lastDate(t)}</span>
        </Link>
      )}
    />
  );
}
