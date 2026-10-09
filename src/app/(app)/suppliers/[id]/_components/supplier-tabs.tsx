"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";

import { OffsetAdvanceDialog, RecordAdvanceDialog } from "@/components/buying/advance-dialogs";
import {
  DEDUCTION_REASON_LABELS,
  displayDate,
  displayKg,
  displayPeriod,
  naira,
  PAYMENT_METHOD_LABELS,
  SUPPLIER_TYPE_LABELS,
} from "@/components/buying/format";
import { ResponsiveTable, type BuyingColumn } from "@/components/buying/responsive-table";
import { PurchaseStatusBadge, type PurchaseStatusValue } from "@/components/buying/status-badge";
import { SupplierForm, supplierToValues } from "@/components/buying/supplier-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Reason = keyof typeof DEDUCTION_REASON_LABELS;
const REASONS = Object.keys(DEDUCTION_REASON_LABELS) as Reason[];

export type SupplierProfileView = {
  id: string;
  type: keyof typeof SUPPLIER_TYPE_LABELS;
  name: string;
  phone: string | null;
  village: string | null;
  lga: string | null;
  state: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  idNote: string | null;
  photoKey: string | null;
  createdAt: Date;
};

export type SupplierPurchaseView = {
  id: string;
  purchaseNumber: string | null;
  purchaseDate: string;
  status: PurchaseStatusValue;
  buyingPointName: string | null;
  totalAmountKobo?: number | null;
  netKg: string;
  grnNumber: string | null;
};

export type SupplierAdvanceView = {
  id: string;
  advanceNumber: string;
  advanceDate: string;
  amountKobo: number;
  offsetKobo: number;
  outstandingKobo: number;
  note: string | null;
};

export type SupplierPaymentView = {
  id: string;
  paymentNumber: string;
  paymentDate: string;
  amountKobo: number;
  method: keyof typeof PAYMENT_METHOD_LABELS;
  reference: string | null;
  allocatedKobo: number;
  unallocatedKobo: number;
};

export type SupplierDeductionsView = {
  byPeriod: Array<{ period: string; reason: Reason; kg: string }>;
  byReason: Array<{ reason: Reason; kg: string }>;
  grossKg: string;
};

const TABS = ["profile", "purchases", "deductions", "advances", "payments"] as const;
type Tab = (typeof TABS)[number];

export function SupplierTabs({
  supplier,
  purchases,
  deductions,
  advances,
  payments,
  hidePrices,
  canEdit,
  canRecordAdvance,
  canPay,
  canBuy,
  initialTab,
}: {
  supplier: SupplierProfileView;
  purchases: SupplierPurchaseView[];
  deductions: SupplierDeductionsView;
  advances: SupplierAdvanceView[];
  payments: SupplierPaymentView[];
  hidePrices: boolean;
  canEdit: boolean;
  canRecordAdvance: boolean;
  canPay: boolean;
  canBuy: boolean;
  initialTab?: string;
}) {
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : "profile");
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
      <div className="-mx-4 overflow-x-auto px-4">
        <TabsList className="h-11 w-max">
          <TabsTrigger value="profile" className="px-3">Profile</TabsTrigger>
          <TabsTrigger value="purchases" className="px-3">Purchases ({purchases.length})</TabsTrigger>
          <TabsTrigger value="deductions" className="px-3">Deductions</TabsTrigger>
          <TabsTrigger value="advances" className="px-3">Advances ({advances.length})</TabsTrigger>
          <TabsTrigger value="payments" className="px-3">Payments ({payments.length})</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="profile">
        <ProfileTab supplier={supplier} canEdit={canEdit} />
      </TabsContent>
      <TabsContent value="purchases">
        <PurchasesTab supplierId={supplier.id} rows={purchases} hidePrices={hidePrices} canBuy={canBuy} />
      </TabsContent>
      <TabsContent value="deductions">
        <DeductionsTab data={deductions} />
      </TabsContent>
      <TabsContent value="advances">
        <AdvancesTab supplier={supplier} rows={advances} canRecord={canRecordAdvance} canOffset={canPay} />
      </TabsContent>
      <TabsContent value="payments">
        <PaymentsTab supplierId={supplier.id} rows={payments} canPay={canPay} />
      </TabsContent>
    </Tabs>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function ProfileTab({ supplier, canEdit }: { supplier: SupplierProfileView; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string | null]> = [
    ["Type", SUPPLIER_TYPE_LABELS[supplier.type]],
    ["Phone", supplier.phone],
    ["Village", supplier.village],
    ["LGA", supplier.lga],
    ["State", supplier.state],
    ["Bank", supplier.bankName],
    ["Account number", supplier.bankAccountNumber],
    ["Account name", supplier.bankAccountName],
    ["ID note", supplier.idNote],
  ];
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-4 px-4">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="text-sm">{v || "—"}</dd>
            </div>
          ))}
        </dl>
        {canEdit ? (
          <Button variant="outline" className="h-11 self-start sm:h-9" onClick={() => setOpen(true)}>
            <Pencil /> Edit profile
          </Button>
        ) : null}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Edit {supplier.name}</DialogTitle>
              <DialogDescription>Update the supplier&apos;s details.</DialogDescription>
            </DialogHeader>
            {open ? (
              <SupplierForm
                supplierId={supplier.id}
                defaultValues={supplierToValues(supplier)}
                onSaved={() => {
                  setOpen(false);
                  router.refresh();
                }}
                secondary={
                  <Button type="button" variant="outline" className="h-12 sm:h-9" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                }
              />
            ) : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function PurchasesTab({
  supplierId,
  rows,
  hidePrices,
  canBuy,
}: {
  supplierId: string;
  rows: SupplierPurchaseView[];
  hidePrices: boolean;
  canBuy: boolean;
}) {
  const columns: BuyingColumn<SupplierPurchaseView>[] = [
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
    { id: "point", header: "Buying point", cell: ({ row }) => row.original.buyingPointName ?? "—" },
    { id: "net", header: "Net", meta: { className: "text-right tabular-nums" }, cell: ({ row }) => displayKg(row.original.netKg) },
    ...(hidePrices
      ? []
      : [
          {
            id: "amount",
            header: "Amount",
            meta: { className: "text-right tabular-nums" },
            cell: ({ row }) => naira(row.original.totalAmountKobo),
          } satisfies BuyingColumn<SupplierPurchaseView>,
        ]),
    { id: "status", header: "Status", cell: ({ row }) => <PurchaseStatusBadge status={row.original.status} /> },
  ];
  return (
    <div className="flex flex-col gap-3">
      {canBuy ? (
        <Button asChild className="h-11 self-start sm:h-9">
          <Link href={`/purchases/new?supplierId=${supplierId}`}>
            <Plus /> New purchase
          </Link>
        </Button>
      ) : null}
      {rows.length === 0 ? (
        <Empty>No purchases from this supplier yet.</Empty>
      ) : (
        <ResponsiveTable
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          card={(r) => (
            <Link href={`/purchases/${r.id}`} className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">{r.purchaseNumber ?? "Unnumbered"}</p>
                <p className="text-xs text-muted-foreground">
                  {displayDate(r.purchaseDate)} · {displayKg(r.netKg)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <PurchaseStatusBadge status={r.status} />
                {hidePrices ? null : <span className="text-sm font-semibold tabular-nums">{naira(r.totalAmountKobo)}</span>}
              </div>
            </Link>
          )}
        />
      )}
    </div>
  );
}

function pct(kg: string, grossKg: string): string {
  const g = Number(grossKg);
  if (!g) return "";
  return `${((Number(kg) / g) * 100).toFixed(1)}%`;
}

function DeductionsTab({ data }: { data: SupplierDeductionsView }) {
  if (data.byPeriod.length === 0) return <Empty>No quality deductions recorded for this supplier.</Empty>;
  const periods = [...new Set(data.byPeriod.map((r) => r.period))].sort().reverse();
  const cell = (period: string, reason: Reason) => data.byPeriod.find((r) => r.period === period && r.reason === reason)?.kg;
  const totalFor = (reason: Reason) => data.byReason.find((r) => r.reason === reason)?.kg;
  const used = REASONS.filter((r) => totalFor(r));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {used.map((r) => (
          <Card key={r} className="gap-1 py-3">
            <CardContent className="px-3">
              <p className="text-xs text-muted-foreground">{DEDUCTION_REASON_LABELS[r]}</p>
              <p className="font-semibold tabular-nums">{displayKg(totalFor(r))}</p>
              <p className="text-xs text-muted-foreground">{pct(totalFor(r) ?? "0", data.grossKg)} of gross</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Over {displayKg(data.grossKg)} gross bought (cancelled purchases excluded). Monthly breakdown:
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              {used.map((r) => (
                <TableHead key={r} className="text-right">
                  {DEDUCTION_REASON_LABELS[r]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {periods.map((p) => (
              <TableRow key={p}>
                <TableCell className="whitespace-nowrap">{displayPeriod(p)}</TableCell>
                {used.map((r) => (
                  <TableCell key={r} className="text-right tabular-nums">
                    {cell(p, r) ? displayKg(cell(p, r)) : "—"}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">Total</TableCell>
              {used.map((r) => (
                <TableCell key={r} className="text-right font-semibold tabular-nums">
                  {displayKg(totalFor(r))}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}

function AdvancesTab({
  supplier,
  rows,
  canRecord,
  canOffset,
}: {
  supplier: SupplierProfileView;
  rows: SupplierAdvanceView[];
  canRecord: boolean;
  canOffset: boolean;
}) {
  const sorted = [...rows].sort((a, b) => b.advanceDate.localeCompare(a.advanceDate));
  const columns: BuyingColumn<SupplierAdvanceView>[] = [
    { id: "number", header: "Advance", cell: ({ row }) => <span className="font-medium">{row.original.advanceNumber}</span> },
    { id: "date", header: "Date", cell: ({ row }) => displayDate(row.original.advanceDate) },
    { id: "amount", header: "Amount", meta: { className: "text-right tabular-nums" }, cell: ({ row }) => naira(row.original.amountKobo) },
    { id: "offset", header: "Recovered", meta: { className: "text-right tabular-nums" }, cell: ({ row }) => naira(row.original.offsetKobo) },
    {
      id: "outstanding",
      header: "Outstanding",
      meta: { className: "text-right tabular-nums" },
      cell: ({ row }) => <span className="font-semibold">{naira(row.original.outstandingKobo)}</span>,
    },
    {
      id: "actions",
      header: "",
      meta: { className: "text-right" },
      cell: ({ row }) =>
        canOffset && row.original.outstandingKobo > 0 ? <OffsetAdvanceDialog advance={row.original} /> : null,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      {canRecord ? <RecordAdvanceDialog supplier={{ id: supplier.id, name: supplier.name }} triggerClassName="h-11 self-start sm:h-9" /> : null}
      {sorted.length === 0 ? (
        <Empty>No advances paid to this supplier.</Empty>
      ) : (
        <ResponsiveTable
          data={sorted}
          columns={columns}
          getRowId={(r) => r.id}
          card={(r) => (
            <div className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{r.advanceNumber}</p>
                  <p className="text-xs text-muted-foreground">
                    {displayDate(r.advanceDate)} · {naira(r.amountKobo)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Outstanding</p>
                  <p className="font-semibold tabular-nums">{naira(r.outstandingKobo)}</p>
                </div>
              </div>
              {canOffset && r.outstandingKobo > 0 ? <OffsetAdvanceDialog advance={r} triggerClassName="h-11 w-full" /> : null}
            </div>
          )}
        />
      )}
    </div>
  );
}

function PaymentsTab({ supplierId, rows, canPay }: { supplierId: string; rows: SupplierPaymentView[]; canPay: boolean }) {
  const columns: BuyingColumn<SupplierPaymentView>[] = [
    { id: "number", header: "Payment", cell: ({ row }) => <span className="font-medium">{row.original.paymentNumber}</span> },
    { id: "date", header: "Date", cell: ({ row }) => displayDate(row.original.paymentDate) },
    { id: "method", header: "Method", cell: ({ row }) => PAYMENT_METHOD_LABELS[row.original.method] },
    { id: "ref", header: "Reference", cell: ({ row }) => row.original.reference ?? "—" },
    { id: "amount", header: "Amount", meta: { className: "text-right tabular-nums" }, cell: ({ row }) => naira(row.original.amountKobo) },
    {
      id: "unallocated",
      header: "Unallocated",
      meta: { className: "text-right tabular-nums" },
      cell: ({ row }) => (row.original.unallocatedKobo > 0 ? naira(row.original.unallocatedKobo) : "—"),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      {canPay ? (
        <Button asChild className="h-11 self-start sm:h-9">
          <Link href={`/supplier-payments?supplierId=${supplierId}`}>
            <Plus /> Record payment
          </Link>
        </Button>
      ) : null}
      {rows.length === 0 ? (
        <Empty>No payments recorded for this supplier.</Empty>
      ) : (
        <ResponsiveTable
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          card={(r) => (
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">{r.paymentNumber}</p>
                <p className="text-xs text-muted-foreground">
                  {displayDate(r.paymentDate)} · {PAYMENT_METHOD_LABELS[r.method]}
                  {r.reference ? ` · ${r.reference}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="font-semibold tabular-nums">{naira(r.amountKobo)}</p>
                {r.unallocatedKobo > 0 ? (
                  <p className="text-xs text-muted-foreground">{naira(r.unallocatedKobo)} unallocated</p>
                ) : null}
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}
