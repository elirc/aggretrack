"use client";

import Link from "next/link";

import { naira, SUPPLIER_TYPE_LABELS } from "@/components/buying/format";
import { ResponsiveTable, type BuyingColumn } from "@/components/buying/responsive-table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type SupplierRowView = {
  id: string;
  type: keyof typeof SUPPLIER_TYPE_LABELS;
  name: string;
  phone: string | null;
  village: string | null;
  lga: string | null;
  state: string | null;
  balance: { owedToSupplierKobo: number; owedBySupplierKobo: number; netKobo: number };
};

function NetBalance({ kobo }: { kobo: number }) {
  if (kobo === 0) return <span className="text-muted-foreground">Settled</span>;
  return (
    <span className={cn("tabular-nums", kobo > 0 ? "font-medium" : "text-emerald-700 dark:text-emerald-400")}>
      {kobo > 0 ? `We owe ${naira(kobo)}` : `Owes us ${naira(-kobo)}`}
    </span>
  );
}

export function SuppliersTable({ rows }: { rows: SupplierRowView[] }) {
  const columns: BuyingColumn<SupplierRowView>[] = [
    {
      id: "name",
      header: "Supplier",
      cell: ({ row }) => (
        <Link href={`/suppliers/${row.original.id}`} className="font-medium underline-offset-4 hover:underline">
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) => <Badge variant="secondary">{SUPPLIER_TYPE_LABELS[row.original.type]}</Badge>,
    },
    { id: "phone", header: "Phone", cell: ({ row }) => row.original.phone ?? "—" },
    {
      id: "place",
      header: "Location",
      cell: ({ row }) => [row.original.village, row.original.lga, row.original.state].filter(Boolean).join(", ") || "—",
    },
    {
      id: "balance",
      header: "Balance",
      meta: { className: "text-right" },
      cell: ({ row }) => <NetBalance kobo={row.original.balance.netKobo} />,
    },
  ];
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <Link href={`/suppliers/${r.id}`} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{r.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {SUPPLIER_TYPE_LABELS[r.type]}
              {r.village ? ` · ${r.village}` : ""}
              {r.phone ? ` · ${r.phone}` : ""}
            </p>
          </div>
          <span className="shrink-0 text-right text-sm">
            <NetBalance kobo={r.balance.netKobo} />
          </span>
        </Link>
      )}
    />
  );
}
