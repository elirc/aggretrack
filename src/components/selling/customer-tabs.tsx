"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { dateOnly, naira } from "./format";
import { EmptyStateInline } from "./inline-empty";
import { ResponsiveTable } from "./responsive-table";
import { InvoiceStatusBadge } from "./status";

export type CustomerInvoiceRow = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  totalKobo: number;
  paidKobo: number;
  outstandingKobo: number;
};

export type CustomerPaymentRow = {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  method: string;
  amountKobo: number;
  allocatedKobo: number;
  unallocatedKobo: number;
};

export type CustomerProfile = {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  note: string | null;
};

const METHOD: Record<string, string> = { cash: "Cash", transfer: "Transfer", pos: "POS" };

const invoiceColumns: ColumnDef<CustomerInvoiceRow, unknown>[] = [
  {
    header: "Invoice",
    id: "no",
    cell: ({ row }) => (
      <Link href={`/invoices/${row.original.id}`} className="font-medium hover:underline">
        {row.original.invoiceNumber}
      </Link>
    ),
  },
  { header: "Date", id: "date", cell: ({ row }) => dateOnly(row.original.invoiceDate) },
  { header: "Due", id: "due", cell: ({ row }) => dateOnly(row.original.dueDate) },
  { header: "Status", id: "status", cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} /> },
  {
    header: () => <span className="block text-right">Total</span>,
    id: "total",
    cell: ({ row }) => <span className="block text-right tabular-nums">{naira(row.original.totalKobo)}</span>,
  },
  {
    header: () => <span className="block text-right">Outstanding</span>,
    id: "out",
    cell: ({ row }) => <span className="block text-right tabular-nums">{naira(row.original.outstandingKobo)}</span>,
  },
];

const paymentColumns: ColumnDef<CustomerPaymentRow, unknown>[] = [
  { header: "Payment", id: "no", cell: ({ row }) => <span className="font-medium">{row.original.paymentNumber}</span> },
  { header: "Date", id: "date", cell: ({ row }) => dateOnly(row.original.paymentDate) },
  { header: "Method", id: "method", cell: ({ row }) => METHOD[row.original.method] ?? row.original.method },
  {
    header: () => <span className="block text-right">Amount</span>,
    id: "amount",
    cell: ({ row }) => <span className="block text-right tabular-nums">{naira(row.original.amountKobo)}</span>,
  },
  {
    header: () => <span className="block text-right">Unallocated</span>,
    id: "unalloc",
    cell: ({ row }) => <span className="block text-right tabular-nums">{naira(row.original.unallocatedKobo)}</span>,
  },
];

function ProfileRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0 sm:flex-row sm:gap-4">
      <dt className="w-28 shrink-0 text-xs text-muted-foreground sm:text-sm">{label}</dt>
      <dd className="text-sm break-words">{value || "—"}</dd>
    </div>
  );
}

export function CustomerTabs({
  profile,
  invoices,
  payments,
}: {
  profile: CustomerProfile;
  invoices: CustomerInvoiceRow[];
  payments: CustomerPaymentRow[];
}) {
  return (
    <Tabs defaultValue="invoices" className="w-full">
      <TabsList className="w-full sm:w-auto">
        <TabsTrigger value="invoices">Invoices ({invoices.length})</TabsTrigger>
        <TabsTrigger value="payments">Payments ({payments.length})</TabsTrigger>
        <TabsTrigger value="profile">Profile</TabsTrigger>
      </TabsList>
      <TabsContent value="invoices" className="mt-3">
        {invoices.length === 0 ? (
          <EmptyStateInline text="No invoices for this customer yet." />
        ) : (
          <ResponsiveTable
            data={invoices}
            columns={invoiceColumns}
            getRowId={(r) => r.id}
            card={(r) => (
              <Link href={`/invoices/${r.id}`} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{r.invoiceNumber}</p>
                  <p className="text-xs text-muted-foreground">{dateOnly(r.invoiceDate)}</p>
                  <div className="mt-1">
                    <InvoiceStatusBadge status={r.status} />
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm tabular-nums">{naira(r.totalKobo)}</p>
                  <p className="text-xs text-muted-foreground">Due {naira(r.outstandingKobo)}</p>
                </div>
              </Link>
            )}
          />
        )}
      </TabsContent>
      <TabsContent value="payments" className="mt-3">
        {payments.length === 0 ? (
          <EmptyStateInline text="No payments recorded for this customer yet." />
        ) : (
          <ResponsiveTable
            data={payments}
            columns={paymentColumns}
            getRowId={(r) => r.id}
            card={(r) => (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{r.paymentNumber}</p>
                  <p className="text-xs text-muted-foreground">
                    {dateOnly(r.paymentDate)} · {METHOD[r.method] ?? r.method}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums">{naira(r.amountKobo)}</p>
                  {r.unallocatedKobo > 0 ? (
                    <p className="text-xs text-muted-foreground">{naira(r.unallocatedKobo)} credit</p>
                  ) : null}
                </div>
              </div>
            )}
          />
        )}
      </TabsContent>
      <TabsContent value="profile" className="mt-3">
        <dl className="rounded-lg border px-3">
          <ProfileRow label="Name" value={profile.name} />
          <ProfileRow label="Phone" value={profile.phone} />
          <ProfileRow label="Email" value={profile.email} />
          <ProfileRow label="Address" value={profile.address} />
          <ProfileRow label="State" value={profile.state} />
          <ProfileRow label="Note" value={profile.note} />
        </dl>
      </TabsContent>
    </Tabs>
  );
}
