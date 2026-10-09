"use client";

import Link from "next/link";

import { displayDate, displayKg, naira } from "@/components/buying/format";
import { ResponsiveTable, type BuyingColumn } from "@/components/buying/responsive-table";
import { PurchaseStatusBadge, type PurchaseStatusValue } from "@/components/buying/status-badge";

export type PurchaseRowView = {
  id: string;
  purchaseNumber: string | null;
  purchaseDate: string;
  status: PurchaseStatusValue;
  requiresApproval: boolean;
  supplierId: string;
  supplierName: string;
  buyingPointName: string | null;
  /** Absent/null when prices are hidden from the viewer. */
  totalAmountKobo?: number | null;
  netKg: string;
  grnNumber: string | null;
  createdOffline: boolean;
};

export function PurchasesTable({
  rows,
  hidePrices,
  linkSuppliers = true,
}: {
  rows: PurchaseRowView[];
  hidePrices: boolean;
  linkSuppliers?: boolean;
}) {
  const columns: BuyingColumn<PurchaseRowView>[] = [
    {
      id: "number",
      header: "Purchase",
      cell: ({ row }) => (
        <Link href={`/purchases/${row.original.id}`} className="font-medium underline-offset-4 hover:underline">
          {row.original.purchaseNumber ?? "Unnumbered"}
        </Link>
      ),
    },
    { id: "date", header: "Date", cell: ({ row }) => displayDate(row.original.purchaseDate) },
    {
      id: "supplier",
      header: "Supplier",
      cell: ({ row }) =>
        linkSuppliers ? (
          <Link href={`/suppliers/${row.original.supplierId}`} className="underline-offset-4 hover:underline">
            {row.original.supplierName}
          </Link>
        ) : (
          row.original.supplierName
        ),
    },
    { id: "point", header: "Buying point", cell: ({ row }) => row.original.buyingPointName ?? "—" },
    {
      id: "net",
      header: "Net",
      meta: { className: "text-right tabular-nums" },
      cell: ({ row }) => displayKg(row.original.netKg),
    },
    ...(hidePrices
      ? []
      : [
          {
            id: "amount",
            header: "Amount",
            meta: { className: "text-right tabular-nums" },
            cell: ({ row }) => naira(row.original.totalAmountKobo),
          } satisfies BuyingColumn<PurchaseRowView>,
        ]),
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-0.5">
          <PurchaseStatusBadge status={row.original.status} />
          {row.original.grnNumber ? (
            <span className="text-xs text-muted-foreground">{row.original.grnNumber}</span>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <Link href={`/purchases/${r.id}`} className="flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium">{r.supplierName}</p>
              <p className="text-xs text-muted-foreground">
                {r.purchaseNumber ?? "Unnumbered"} · {displayDate(r.purchaseDate)}
                {r.buyingPointName ? ` · ${r.buyingPointName}` : ""}
              </p>
            </div>
            <PurchaseStatusBadge status={r.status} />
          </div>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="tabular-nums">{displayKg(r.netKg)}</span>
            {hidePrices ? null : <span className="font-semibold tabular-nums">{naira(r.totalAmountKobo)}</span>}
          </div>
        </Link>
      )}
    />
  );
}
