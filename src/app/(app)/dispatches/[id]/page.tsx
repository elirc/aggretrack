import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";

import { PageHeader } from "@/components/layout/PageHeader";
import { CreateInvoiceForm } from "@/components/selling/create-invoice-form";
import { DeliveryForm } from "@/components/selling/delivery-form";
import { kg, lagosDateTime } from "@/components/selling/format";
import { NoAccess, ReadOnlyBanner, Stat, isUuid } from "@/components/selling/page-states";
import { PdfLink } from "@/components/selling/pdf-link";
import { DispatchStatusBadge, InvoiceStatusBadge } from "@/components/selling/status";
import { db } from "@/db/client";
import { invoices } from "@/db/schema";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { DomainError } from "@/lib/domain/errors";
import { getDispatch, type DispatchDetail } from "@/lib/services/dispatches";
import { lagosToday } from "@/lib/services/salesOrders";

export const metadata = { title: "Dispatch · AggreTrack" };

export default async function DispatchPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "dispatch.read")) return <NoAccess title="Dispatch" what="dispatches" />;

  const { id } = await params;
  if (!isUuid(id)) notFound();
  let d: DispatchDetail;
  try {
    d = await getDispatch(db, ctx, { id });
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const canInvoiceRead = can(ctx.role, "invoice.read");
  const [invoice] = canInvoiceRead
    ? await db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status })
        .from(invoices)
        .where(
          and(eq(invoices.organisationId, ctx.orgId), eq(invoices.dispatchId, d.id), ne(invoices.status, "void")),
        )
        .limit(1)
    : [];

  const writable = !ctx.readOnly;
  const canDeliver = writable && can(ctx.role, "dispatch.deliver") && d.status === "in_transit";
  // createInvoiceFromDispatch accepts in_transit or delivered dispatches (one live invoice each).
  const canInvoice = writable && can(ctx.role, "invoice.write") && !invoice;
  const canSeeOrder = can(ctx.role, "sale.read");

  return (
    <div className="flex flex-col gap-5">
      <div>
        {canSeeOrder ? (
          <Link href={`/sales/${d.salesOrderId}`} className="text-sm text-muted-foreground hover:underline">
            ← {d.orderNumber}
          </Link>
        ) : (
          <Link href="/dispatches" className="text-sm text-muted-foreground hover:underline">
            ← Dispatches
          </Link>
        )}
        <PageHeader
          title={d.waybillNumber ?? "Waybill pending"}
          description={`${d.customerName} · ${d.orderNumber}`}
          actions={<DispatchStatusBadge status={d.status} />}
        />
      </div>
      <ReadOnlyBanner show={ctx.readOnly} />

      <section aria-label="Waybill" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Vehicle" value={d.vehiclePlate ?? "—"} />
        <Stat label="Driver" value={d.driverName ?? "—"} />
        <Stat label="Dispatched" value={kg(d.dispatchedKg)} />
        <Stat
          label="Delivered"
          value={d.deliveredKg ? kg(d.deliveredKg) : "—"}
          tone={d.deliveredKg ? "good" : undefined}
        />
      </section>
      <div className="flex flex-wrap items-start gap-3 text-sm text-muted-foreground">
        <span>Dispatched {lagosDateTime(d.dispatchedAt)}</span>
        {d.deliveredAt ? <span>· Delivered {lagosDateTime(d.deliveredAt)}</span> : null}
        {d.transitLossKg ? (
          <span className="font-medium text-amber-700 dark:text-amber-300">· Transit loss {kg(d.transitLossKg)}</span>
        ) : null}
      </div>
      <div>
        <PdfLink documentId={d.waybillDocumentId} label="Waybill PDF" />
      </div>

      <section className="flex flex-col gap-3" aria-label="Lines">
        <h2 className="text-base font-semibold">Lines</h2>
        <ul className="flex flex-col divide-y rounded-lg border">
          {d.lines.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{l.lotNumber}</p>
                <p className="truncate text-xs text-muted-foreground">{l.warehouseName}</p>
              </div>
              <span className="text-sm tabular-nums">{kg(l.kg)}</span>
            </li>
          ))}
        </ul>
      </section>

      {canDeliver ? (
        <section className="flex flex-col gap-3" aria-label="Record delivery">
          <h2 className="text-base font-semibold">Record delivery</h2>
          <DeliveryForm dispatchId={d.id} dispatchedKg={d.dispatchedKg} />
        </section>
      ) : null}

      {canInvoiceRead ? (
        <section className="flex flex-col gap-3" aria-label="Invoice">
          <h2 className="text-base font-semibold">Invoice</h2>
          {invoice ? (
            <Link
              href={`/invoices/${invoice.id}`}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3 hover:bg-muted/50"
            >
              <span className="font-medium">{invoice.invoiceNumber}</span>
              <InvoiceStatusBadge status={invoice.status} />
            </Link>
          ) : canInvoice ? (
            <>
              {d.status === "in_transit" ? (
                <p className="text-sm text-muted-foreground">
                  You can invoice now or after recording delivery. Invoices bill the dispatched weight.
                </p>
              ) : null}
              <CreateInvoiceForm dispatchId={d.id} defaultDate={lagosToday()} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Not invoiced yet.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
