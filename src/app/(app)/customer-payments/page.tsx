import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState, NoAccess, Pager, ReadOnlyBanner, isUuid, pageParam, sp } from "@/components/selling/page-states";
import { PaymentForm } from "@/components/selling/payment-form";
import { PaymentsTable } from "@/components/selling/payments-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { listCustomerPayments } from "@/lib/services/customerPayments";
import { listCustomers } from "@/lib/services/customers";
import { listInvoices } from "@/lib/services/invoices";
import { lagosToday } from "@/lib/services/salesOrders";

export const metadata = { title: "Customer payments · AggreTrack" };

const PAGE_SIZE = 50;

export default async function CustomerPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "customer-payment.read")) {
    return <NoAccess title="Customer payments" what="customer payments" />;
  }

  const params = await searchParams;
  const customerParam = sp(params.customerId);
  const customerId = isUuid(customerParam) ? customerParam : undefined;
  const page = pageParam(params.page);
  const canRecord = !ctx.readOnly && can(ctx.role, "customer-payment.write");
  const canReadCustomers = can(ctx.role, "customer.read");
  const canReadInvoices = can(ctx.role, "invoice.read");

  const [payments, customers, openInvoices] = await Promise.all([
    listCustomerPayments(db, ctx, { customerId, page, pageSize: PAGE_SIZE }),
    canRecord && canReadCustomers ? listCustomers(db, ctx, { pageSize: 200 }) : Promise.resolve(null),
    canRecord && canReadInvoices
      ? listInvoices(db, ctx, { openOnly: true, pageSize: 200 })
      : Promise.resolve(null),
  ]);
  const filteredName = customerId ? payments.rows[0]?.customerName : undefined;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Customer payments"
        description="Record cash, transfer or POS payments and allocate them to invoices."
      />
      <ReadOnlyBanner show={ctx.readOnly} />

      {canRecord && customers ? (
        <Card>
          <CardHeader>
            <CardTitle>Record payment</CardTitle>
          </CardHeader>
          <CardContent>
            <PaymentForm
              customers={customers.rows.map((c) => ({ id: c.id, name: c.name }))}
              openInvoices={(openInvoices?.rows ?? []).map((i) => ({
                id: i.id,
                customerId: i.customerId,
                invoiceNumber: i.invoiceNumber,
                invoiceDate: i.invoiceDate,
                outstandingKobo: i.outstandingKobo,
              }))}
              defaultCustomerId={customerId}
              defaultDate={lagosToday()}
            />
          </CardContent>
        </Card>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Payments">
        <h2 className="text-base font-semibold">
          {filteredName ? `Payments from ${filteredName}` : "Recent payments"}
        </h2>
        {payments.rows.length === 0 ? (
          <EmptyState title="No payments recorded yet." hint="Payments are recorded by hand; nothing is processed." />
        ) : (
          <PaymentsTable
            rows={payments.rows.map((p) => ({
              id: p.id,
              paymentNumber: p.paymentNumber,
              paymentDate: p.paymentDate,
              customerId: p.customerId,
              customerName: p.customerName,
              method: p.method,
              reference: p.reference,
              amountKobo: p.amountKobo,
              allocatedKobo: p.allocatedKobo,
              unallocatedKobo: p.unallocatedKobo,
            }))}
          />
        )}
        <Pager
          basePath="/customer-payments"
          page={page}
          pageSize={PAGE_SIZE}
          total={payments.total}
          params={{ customerId }}
        />
      </section>
    </div>
  );
}
