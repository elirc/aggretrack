import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Wallet } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { dateOnly, kg, naira } from "@/components/selling/format";
import { EmptyStateInline } from "@/components/selling/inline-empty";
import { NoAccess, ReadOnlyBanner, Stat, isUuid } from "@/components/selling/page-states";
import { PdfLink } from "@/components/selling/pdf-link";
import { InvoiceStatusBadge } from "@/components/selling/status";
import { VoidInvoiceButton } from "@/components/selling/void-invoice-button";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { DomainError } from "@/lib/domain/errors";
import { getInvoice, type InvoiceDetail } from "@/lib/services/invoices";

export const metadata = { title: "Invoice · AggreTrack" };

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className={strong ? "font-semibold" : "text-muted-foreground"}>{label}</span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</span>
    </div>
  );
}

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "invoice.read")) return <NoAccess title="Invoice" what="invoices" />;

  const { id } = await params;
  if (!isUuid(id)) notFound();
  let inv: InvoiceDetail;
  try {
    inv = await getInvoice(db, ctx, { id });
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const writable = !ctx.readOnly;
  // voidInvoice rejects invoices with allocated payments; only offer it while nothing is paid.
  const canVoid = writable && can(ctx.role, "invoice.write") && inv.status !== "void" && inv.paidKobo === 0;
  const canPay =
    writable && can(ctx.role, "customer-payment.write") && inv.status !== "void" && inv.outstandingKobo > 0;
  const hasTax = inv.taxKobo > 0 || Number(inv.taxPercent) > 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/invoices" className="text-sm text-muted-foreground hover:underline">
          ← Invoices
        </Link>
        <PageHeader
          title={inv.invoiceNumber}
          description={`${inv.customerName} · ${dateOnly(inv.invoiceDate)}`}
          actions={<InvoiceStatusBadge status={inv.status} />}
        />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={`/customers/${inv.customerId}`} className="text-primary hover:underline">
            {inv.customerName}
          </Link>
          {can(ctx.role, "sale.read") ? (
            <Link href={`/sales/${inv.salesOrderId}`} className="text-primary hover:underline">
              Order {inv.orderNumber}
            </Link>
          ) : null}
          {inv.dispatchId && can(ctx.role, "dispatch.read") ? (
            <Link href={`/dispatches/${inv.dispatchId}`} className="text-primary hover:underline">
              Waybill {inv.waybillNumber ?? ""}
            </Link>
          ) : null}
        </div>
      </div>
      <ReadOnlyBanner show={ctx.readOnly} />

      <section aria-label="Amounts" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Total" value={naira(inv.totalKobo)} />
        <Stat label="Paid" value={naira(inv.paidKobo)} tone={inv.paidKobo > 0 ? "good" : undefined} />
        <Stat
          label="Outstanding"
          value={naira(inv.outstandingKobo)}
          tone={inv.outstandingKobo > 0 ? "warn" : undefined}
        />
        <Stat label="Due" value={dateOnly(inv.dueDate)} />
      </section>

      <div className="flex flex-wrap items-start gap-2">
        <PdfLink documentId={inv.documentId} />
        {canPay ? (
          <Button asChild className="h-11 sm:h-9">
            <Link href={`/customer-payments?customerId=${inv.customerId}`}>
              <Wallet /> Record payment
            </Link>
          </Button>
        ) : null}
        {canVoid ? <VoidInvoiceButton invoiceId={inv.id} invoiceNumber={inv.invoiceNumber} /> : null}
      </div>

      <section className="flex flex-col gap-3" aria-label="Lines">
        <h2 className="text-base font-semibold">Lines</h2>
        <ul className="flex flex-col divide-y rounded-lg border">
          {inv.lines.map((l) => (
            <li key={l.salesLineId} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="font-medium">
                  {l.commodityName} · {l.gradeName}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {kg(l.kg)} @ {naira(l.pricePerKgKobo)}/kg
                </p>
              </div>
              <span className="shrink-0 font-medium tabular-nums">{naira(l.amountKobo)}</span>
            </li>
          ))}
        </ul>
        <div className="rounded-lg border px-3 py-1 text-sm">
          <Row label="Subtotal" value={naira(inv.subtotalKobo)} />
          {hasTax ? <Row label={`Tax (${Number(inv.taxPercent)}%)`} value={naira(inv.taxKobo)} /> : null}
          <Row label="Total" value={naira(inv.totalKobo)} strong />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label="Payments received">
        <h2 className="text-base font-semibold">Payments received</h2>
        {inv.payments.length === 0 ? (
          <EmptyStateInline text="No payments allocated to this invoice yet." />
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {inv.payments.map((p) => (
              <li key={`${p.paymentId}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <div>
                  <p className="font-medium">{p.paymentNumber}</p>
                  <p className="text-xs text-muted-foreground">{dateOnly(p.paymentDate)}</p>
                </div>
                <span className="tabular-nums">{naira(p.amountKobo)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="rounded-lg border px-3 py-1 text-sm">
          <Row label="Paid" value={naira(inv.paidKobo)} />
          <Row label="Outstanding" value={naira(inv.outstandingKobo)} strong />
        </div>
      </section>
    </div>
  );
}
