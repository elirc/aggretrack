"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { kg, lagosDateTime } from "./format";
import { ResponsiveTable } from "./responsive-table";
import { DispatchStatusBadge } from "./status";

export type DispatchRow = {
  id: string;
  waybillNumber: string | null;
  orderNumber: string;
  customerName: string;
  status: string;
  dispatchedKg: string;
  deliveredKg: string | null;
  transitLossKg: string | null;
  dispatchedAt: Date | string;
};

const columns: ColumnDef<DispatchRow, unknown>[] = [
  {
    header: "Waybill",
    id: "wb",
    cell: ({ row }) => (
      <Link href={`/dispatches/${row.original.id}`} className="font-medium hover:underline">
        {row.original.waybillNumber ?? "Pending"}
      </Link>
    ),
  },
  { header: "Order", id: "order", cell: ({ row }) => row.original.orderNumber },
  { header: "Customer", id: "customer", cell: ({ row }) => row.original.customerName },
  { header: "Dispatched at", id: "at", cell: ({ row }) => lagosDateTime(row.original.dispatchedAt) },
  { header: "Status", id: "status", cell: ({ row }) => <DispatchStatusBadge status={row.original.status} /> },
  {
    header: () => <span className="block text-right">Dispatched</span>,
    id: "kg",
    cell: ({ row }) => <span className="block text-right tabular-nums">{kg(row.original.dispatchedKg)}</span>,
  },
  {
    header: () => <span className="block text-right">Delivered</span>,
    id: "dkg",
    cell: ({ row }) => <span className="block text-right tabular-nums">{kg(row.original.deliveredKg)}</span>,
  },
  {
    header: () => <span className="block text-right">Loss</span>,
    id: "loss",
    cell: ({ row }) => <span className="block text-right tabular-nums">{kg(row.original.transitLossKg)}</span>,
  },
];

export function DispatchesTable({ rows }: { rows: DispatchRow[] }) {
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <Link href={`/dispatches/${r.id}`} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{r.waybillNumber ?? "Waybill pending"}</p>
            <p className="truncate text-sm">{r.customerName}</p>
            <p className="text-xs text-muted-foreground">
              {r.orderNumber} · {lagosDateTime(r.dispatchedAt)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 text-sm tabular-nums">
            <DispatchStatusBadge status={r.status} />
            <span>{kg(r.dispatchedKg)}</span>
          </div>
        </Link>
      )}
    />
  );
}
