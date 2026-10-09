"use client";

import { useState } from "react";
import Link from "next/link";
import { Plus, X } from "lucide-react";

import { displayDate, naira, PAYMENT_METHOD_LABELS } from "@/components/buying/format";
import { ResponsiveTable, type BuyingColumn } from "@/components/buying/responsive-table";
import type { SupplierOption } from "@/components/buying/supplier-combobox";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { PaymentForm } from "./payment-form";

export type PaymentRowView = {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  supplierId: string;
  supplierName: string;
  amountKobo: number;
  method: keyof typeof PAYMENT_METHOD_LABELS;
  reference: string | null;
  allocatedKobo: number;
  unallocatedKobo: number;
};

/** Collapsible "record payment" card (opens itself when a supplier is preselected). */
export function RecordPaymentPanel({
  suppliers,
  initialSupplierId,
  supplierPhones,
  canOffset,
}: {
  suppliers: SupplierOption[];
  initialSupplierId?: string;
  supplierPhones: Record<string, boolean>;
  canOffset: boolean;
}) {
  const [open, setOpen] = useState(!!initialSupplierId);
  if (!open) {
    return (
      <Button className="mb-4 h-12 w-full sm:h-9 sm:w-auto" onClick={() => setOpen(true)}>
        <Plus /> Record payment
      </Button>
    );
  }
  return (
    <Card className="mb-4 gap-3 py-4">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="text-base">Record a supplier payment</CardTitle>
        <Button variant="ghost" size="icon-lg" aria-label="Close payment form" onClick={() => setOpen(false)}>
          <X />
        </Button>
      </CardHeader>
      <CardContent className="px-4">
        <PaymentForm
          suppliers={suppliers}
          initialSupplierId={initialSupplierId}
          supplierPhones={supplierPhones}
          canOffset={canOffset}
        />
      </CardContent>
    </Card>
  );
}

export function PaymentsTable({ rows }: { rows: PaymentRowView[] }) {
  const columns: BuyingColumn<PaymentRowView>[] = [
    { id: "number", header: "Payment", cell: ({ row }) => <span className="font-medium">{row.original.paymentNumber}</span> },
    { id: "date", header: "Date", cell: ({ row }) => displayDate(row.original.paymentDate) },
    {
      id: "supplier",
      header: "Supplier",
      cell: ({ row }) => (
        <Link href={`/suppliers/${row.original.supplierId}?tab=payments`} className="underline-offset-4 hover:underline">
          {row.original.supplierName}
        </Link>
      ),
    },
    { id: "method", header: "Method", cell: ({ row }) => PAYMENT_METHOD_LABELS[row.original.method] },
    { id: "ref", header: "Reference", cell: ({ row }) => row.original.reference ?? "—" },
    { id: "amount", header: "Amount", meta: { className: "text-right tabular-nums" }, cell: ({ row }) => naira(row.original.amountKobo) },
    {
      id: "unallocated",
      header: "On account",
      meta: { className: "text-right tabular-nums" },
      cell: ({ row }) => (row.original.unallocatedKobo > 0 ? naira(row.original.unallocatedKobo) : "—"),
    },
  ];
  return (
    <ResponsiveTable
      data={rows}
      columns={columns}
      getRowId={(r) => r.id}
      card={(r) => (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={`/suppliers/${r.supplierId}?tab=payments`} className="block truncate font-medium">
              {r.supplierName}
            </Link>
            <p className="text-xs text-muted-foreground">
              {r.paymentNumber} · {displayDate(r.paymentDate)} · {PAYMENT_METHOD_LABELS[r.method]}
            </p>
          </div>
          <div className="text-right">
            <p className="font-semibold tabular-nums">{naira(r.amountKobo)}</p>
            {r.unallocatedKobo > 0 ? <p className="text-xs text-muted-foreground">{naira(r.unallocatedKobo)} on account</p> : null}
          </div>
        </div>
      )}
    />
  );
}
