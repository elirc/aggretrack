"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import type { MovementRow } from "@/lib/services/stockQueries";

import { MOVEMENT_TYPE_LABEL, formatLagosDateTime } from "./format";
import { ResponsiveTable } from "./responsive-table";
import { RefDocLink, SignedKg } from "./status";

const columns: ColumnDef<MovementRow, unknown>[] = [
  {
    id: "when",
    header: "When",
    cell: ({ row }) => <span className="whitespace-nowrap">{formatLagosDateTime(row.original.occurredAt)}</span>,
  },
  {
    id: "type",
    header: "Type",
    cell: ({ row }) => MOVEMENT_TYPE_LABEL[row.original.type] ?? row.original.type,
  },
  {
    id: "lot",
    header: "Lot",
    cell: ({ row }) => (
      <Link href={`/stock/lots/${row.original.lotId}`} className="font-mono underline-offset-4 hover:underline">
        {row.original.lotNumber}
      </Link>
    ),
  },
  {
    id: "warehouse",
    header: "Warehouse",
    cell: ({ row }) => (
      <>
        {row.original.warehouseName}
        {row.original.binName ? <span className="text-muted-foreground"> / {row.original.binName}</span> : null}
      </>
    ),
  },
  {
    id: "kg",
    header: () => <span className="block text-right">Kg</span>,
    cell: ({ row }) => (
      <span className="block text-right">
        <SignedKg grams={row.original.grams} />
      </span>
    ),
  },
  {
    id: "bags",
    header: () => <span className="block text-right">Bags</span>,
    cell: ({ row }) => (
      <span className="block text-right tabular-nums">
        {row.original.bags > 0 ? `+${row.original.bags}` : row.original.bags}
      </span>
    ),
  },
  {
    id: "ref",
    header: "Reference",
    cell: ({ row }) => <RefDocLink refType={row.original.refType} refId={row.original.refId} />,
  },
];

export function MovementsTable({ rows }: { rows: MovementRow[] }) {
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(m) => (
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{MOVEMENT_TYPE_LABEL[m.type] ?? m.type}</span>
            <SignedKg grams={m.grams} />
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
            <Link href={`/stock/lots/${m.lotId}`} className="font-mono underline-offset-4 hover:underline">
              {m.lotNumber}
            </Link>
            <span>
              {m.warehouseName}
              {m.binName ? ` / ${m.binName}` : ""}
              {m.bags ? ` · ${m.bags > 0 ? "+" : ""}${m.bags} bags` : ""}
            </span>
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
            <span>{formatLagosDateTime(m.occurredAt)}</span>
            <RefDocLink refType={m.refType} refId={m.refId} />
          </div>
        </div>
      )}
    />
  );
}
