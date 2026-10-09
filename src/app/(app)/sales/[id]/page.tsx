import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { DispatchForm } from "@/components/selling/dispatch-form";
import { dateOnly, kg, lagosDateTime, naira } from "@/components/selling/format";
import { EmptyStateInline } from "@/components/selling/inline-empty";
import { AllocationLines, OrderActions } from "@/components/selling/order-panel";
import { NoAccess, ReadOnlyBanner, Stat, isUuid } from "@/components/selling/page-states";
import { SaleTracePanel } from "@/components/selling/sale-trace-panel";
import { DispatchStatusBadge, InvoiceStatusBadge, SalesStatusBadge } from "@/components/selling/status";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { DomainError } from "@/lib/domain/errors";
import { gramsToKg, kgToGrams } from "@/lib/domain/units";
import { listDrivers, listVehicles } from "@/lib/services/masterData";
import { getSalesOrder, type SalesOrderDetail } from "@/lib/services/salesOrders";

export const metadata = { title: "Sales order · AggreTrack" };

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export default async function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "sale.read")) return <NoAccess title="Sales order" what="sales orders" />;

  const { id } = await params;
  if (!isUuid(id)) notFound();
  let order: SalesOrderDetail;
  try {
    order = await getSalesOrder(db, ctx, { id });
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const hide = ctx.restrictions.hidePrices;
  const writable = !ctx.readOnly;
  const canWrite = writable && can(ctx.role, "sale.write");
  const canAllocate = writable && can(ctx.role, "sale.allocate") && can(ctx.role, "stock.read");
  const canDispatch = writable && can(ctx.role, "dispatch.write");
  const canTrace = can(ctx.role, "report.read");
  const dispatchable = order.status === "confirmed" || order.status === "allocated";

  const totals = order.lines.reduce(
    (acc, l) => ({
      requestedG: acc.requestedG + kgToGrams(l.kg),
      reservedG: acc.reservedG + kgToGrams(l.reservedKg),
      dispatchedG: acc.dispatchedG + kgToGrams(l.dispatchedKg),
    }),
    { requestedG: 0, reservedG: 0, dispatchedG: 0 },
  );
  const hasRemaining = order.lines.some((l) => !l.fullyAllocated);

  const reserved = order.lines.flatMap((l) =>
    l.allocations
      .filter((a) => a.status === "reserved")
      .map((a) => ({
        id: a.id,
        lineLabel: `${l.commodityName} · ${l.gradeName}`,
        lotNumber: a.lotNumber,
        warehouseName: a.warehouseName,
        kg: a.kg,
      })),
  );

  const [vehicles, drivers] =
    canDispatch && dispatchable && reserved.length > 0
      ? await Promise.all([listVehicles(db, ctx), listDrivers(db, ctx)])
      : [[], []];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/sales" className="text-sm text-muted-foreground hover:underline">
          ← Sales
        </Link>
        <PageHeader
          title={order.orderNumber}
          description={`${order.customerName} · ${dateOnly(order.orderDate)}`}
          actions={<SalesStatusBadge status={order.status} />}
        />
        <Link href={`/customers/${order.customerId}`} className="text-sm text-primary hover:underline">
          View customer
        </Link>
      </div>
      <ReadOnlyBanner show={ctx.readOnly} />

      <section aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Ordered" value={kg(gramsToKg(totals.requestedG))} />
        <Stat label="Reserved" value={kg(gramsToKg(totals.reservedG))} tone={totals.reservedG > 0 ? "warn" : undefined} />
        <Stat
          label="Dispatched"
          value={kg(gramsToKg(totals.dispatchedG))}
          tone={totals.dispatchedG > 0 ? "good" : undefined}
        />
        <Stat label="Total" value={hide ? "—" : naira(order.totalAmountKobo)} />
      </section>

      <OrderActions
        orderId={order.id}
        status={order.status}
        canWrite={canWrite}
        canAllocate={canAllocate}
        hasRemaining={hasRemaining}
      />
      {order.status === "draft" ? (
        <p className="text-sm text-muted-foreground">Confirm the order to start allocating stock.</p>
      ) : null}

      <Section title="Lines & allocation">
        <AllocationLines
          status={order.status}
          canAllocate={canAllocate}
          hidePrices={hide}
          lines={order.lines.map((l) => ({
            id: l.id,
            commodityId: l.commodityId,
            gradeId: l.gradeId,
            commodityName: l.commodityName,
            gradeName: l.gradeName,
            kg: l.kg,
            pricePerKgKobo: hide ? null : l.pricePerKgKobo,
            amountKobo: hide ? null : l.amountKobo,
            reservedKg: l.reservedKg,
            dispatchedKg: l.dispatchedKg,
            remainingKg: l.remainingKg,
            fullyAllocated: l.fullyAllocated,
            allocations: l.allocations.map((a) => ({
              id: a.id,
              lotNumber: a.lotNumber,
              warehouseName: a.warehouseName,
              kg: a.kg,
              status: a.status,
              receivedAt: a.receivedAt,
            })),
          }))}
        />
      </Section>

      {canDispatch && dispatchable ? (
        <Section title="Dispatch">
          <DispatchForm
            salesOrderId={order.id}
            allocations={reserved}
            vehicles={vehicles.map((v) => ({
              id: v.id,
              label: v.description ? `${v.plateNumber} · ${v.description}` : v.plateNumber,
            }))}
            drivers={drivers.map((d) => ({ id: d.id, label: d.name }))}
          />
        </Section>
      ) : null}

      <Section title="Dispatches">
        {order.dispatches.length === 0 ? (
          <EmptyStateInline text="No dispatches yet." />
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {order.dispatches.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/dispatches/${d.id}`}
                  className="flex items-center justify-between gap-3 px-3 py-3 hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{d.waybillNumber ?? "Waybill pending"}</p>
                    <p className="text-xs text-muted-foreground">{lagosDateTime(d.dispatchedAt)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-sm tabular-nums">
                    <DispatchStatusBadge status={d.status} />
                    <span>
                      {kg(d.dispatchedKg)}
                      {d.deliveredKg ? ` → ${kg(d.deliveredKg)}` : ""}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {can(ctx.role, "invoice.read") ? (
        <Section title="Invoices">
          {order.invoices.length === 0 ? (
            <EmptyStateInline text="No invoices yet. Create one from a dispatch." />
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {order.invoices.map((i) => (
                <li key={i.id}>
                  <Link
                    href={`/invoices/${i.id}`}
                    className="flex items-center justify-between gap-3 px-3 py-3 hover:bg-muted/50"
                  >
                    <div>
                      <p className="font-medium">{i.invoiceNumber}</p>
                      <p className="text-xs text-muted-foreground">{dateOnly(i.invoiceDate)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <InvoiceStatusBadge status={i.status} />
                      <span className="text-sm tabular-nums">{hide ? "—" : naira(i.totalKobo)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {canTrace ? (
        <Section title="Suppliers behind this sale">
          <SaleTracePanel salesOrderId={order.id} />
        </Section>
      ) : null}
    </div>
  );
}
