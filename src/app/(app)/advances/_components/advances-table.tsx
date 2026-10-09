"use client";

import Link from "next/link";

import { OffsetAdvanceDialog } from "@/components/buying/advance-dialogs";
import { displayDate, naira } from "@/components/buying/format";
import { ResponsiveTable, type BuyingColumn } from "@/components/buying/responsive-table";
import { Badge } from "@/components/ui/badge";

export type AdvanceRowView = {
  id: string;
  supplierId: string;
  supplierName: string;
  advanceNumber: string;
  advanceDate: string;
  amountKobo: number;
  offsetKobo: number;
  outstandingKobo: number;
  note: string | null;
};

function State({ r }: { r: AdvanceRowView }) {
  if (r.outstandingKobo <= 0) return <Badge variant="secondary">Recovered</Badge>;
  if (r.offsetKobo > 0) return <Badge variant="outline">Part recovered</Badge>;
  return (
    <Badge variant="outline" className="border-amber-300 text-amber-900 dark:border-amber-800 dark:text-amber-100">
      Outstanding
    </Badge>
  );
}

export function AdvancesTable({ rows, canOffset }: { rows: AdvanceRowView[]; canOffset: boolean }) {
  const columns: BuyingColumn<AdvanceRowView>[] = [
    { id: "number", header: "Advance", cell: ({ row }) => <span className="font-medium">{row.original.advanceNumber}</span> },
    { id: "date", header: "Date", cell: ({ row }) => displayDate(row.original.advanceDate) },
    {
      id: "supplier",
      header: "Supplier",
      cell: ({ row }) => (
        <Link href={`/suppliers/${row.original.supplierId}?tab=advances`} className="underline-offset-4 hover:underline">
          {row.original.supplierName}
        </Link>
      ),
    },
    { id: "amount", header: "Amount", meta: { className: "text-right tabular-nums" }, cell: ({ row }) => naira(row.original.amountKobo) },
    {
      id: "outstanding",
      header: "Outstanding",
      meta: { className: "text-right tabular-nums" },
      cell: ({ row }) => <span className="font-semibold">{naira(row.original.outstandingKobo)}</span>,
    },
    { id: "state", header: "Status", cell: ({ row }) => <State r={row.original} /> },
    {
      id: "actions",
      header: "",
      meta: { className: "text-right" },
      cell: ({ row }) =>
        canOffset && row.original.outstandingKobo > 0 ? <OffsetAdvanceDialog advance={row.original} /> : null,
    },
  ];
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link href={`/suppliers/${r.supplierId}?tab=advances`} className="block truncate font-medium">
                {r.supplierName}
              </Link>
              <p className="text-xs text-muted-foreground">
                {r.advanceNumber} · {displayDate(r.advanceDate)} · {naira(r.amountKobo)}
              </p>
              {r.note ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.note}</p> : null}
            </div>
            <div className="flex flex-col items-end gap-1">
              <State r={r} />
              <span className="font-semibold tabular-nums">{naira(r.outstandingKobo)}</span>
            </div>
          </div>
          {canOffset && r.outstandingKobo > 0 ? (
            <OffsetAdvanceDialog advance={r} triggerClassName="h-11 w-full" />
          ) : null}
        </div>
      )}
    />
  );
}
