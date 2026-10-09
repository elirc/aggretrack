import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Pencil, Plus, Wallet } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { CustomerSheet } from "@/components/selling/customer-form";
import { CustomerTabs } from "@/components/selling/customer-tabs";
import { naira } from "@/components/selling/format";
import { NoAccess, ReadOnlyBanner, Stat, isUuid } from "@/components/selling/page-states";
import { StatementButton } from "@/components/selling/statement-button";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { DomainError } from "@/lib/domain/errors";
import { getCustomerDetail, type CustomerDetail } from "@/lib/services/customers";

export const metadata = { title: "Customer · AggreTrack" };

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "customer.read")) return <NoAccess title="Customer" what="customers" />;

  const { id } = await params;
  if (!isUuid(id)) notFound();
  let c: CustomerDetail;
  try {
    c = await getCustomerDetail(db, ctx, { id });
  } catch (err) {
    if (err instanceof DomainError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const canWrite = can(ctx.role, "customer.write") && !ctx.readOnly;
  const canPay = can(ctx.role, "customer-payment.write") && !ctx.readOnly;
  const canSell = can(ctx.role, "sale.write") && !ctx.readOnly;
  const b = c.balance;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/customers" className="text-sm text-muted-foreground hover:underline">
          ← Customers
        </Link>
        <PageHeader
          title={c.name}
          description={[c.phone, c.state].filter(Boolean).join(" · ") || undefined}
          actions={
            <div className="flex flex-wrap gap-2">
              {canWrite ? (
                <CustomerSheet
                  title="Edit customer"
                  defaults={{
                    id: c.id,
                    name: c.name,
                    phone: c.phone,
                    email: c.email,
                    address: c.address,
                    state: c.state,
                    note: c.note,
                  }}
                  trigger={
                    <Button variant="outline" className="h-11 sm:h-9">
                      <Pencil /> Edit
                    </Button>
                  }
                />
              ) : null}
              <StatementButton />
            </div>
          }
        />
      </div>
      <ReadOnlyBanner show={ctx.readOnly} />

      <section aria-label="Balance" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Outstanding" value={naira(b.outstandingKobo)} tone={b.outstandingKobo > 0 ? "warn" : undefined} />
        <Stat
          label="Unallocated credit"
          value={naira(b.unallocatedCreditKobo)}
          tone={b.unallocatedCreditKobo > 0 ? "good" : undefined}
        />
        <Stat label="Invoiced" value={naira(b.invoicedKobo)} />
        <Stat label="Paid" value={naira(b.paidKobo)} />
      </section>
      <p className="text-sm text-muted-foreground">
        Balance:{" "}
        <span className="font-medium text-foreground tabular-nums">
          {b.balanceKobo >= 0 ? `${naira(b.balanceKobo)} owed to you` : `${naira(-b.balanceKobo)} credit held`}
        </span>
      </p>

      {canPay || canSell ? (
        <div className="flex flex-wrap gap-2">
          {canSell ? (
            <Button asChild className="h-11 sm:h-9">
              <Link href={`/sales/new?customerId=${c.id}`}>
                <Plus /> New sale
              </Link>
            </Button>
          ) : null}
          {canPay ? (
            <Button asChild variant="outline" className="h-11 sm:h-9">
              <Link href={`/customer-payments?customerId=${c.id}`}>
                <Wallet /> Record payment
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      <CustomerTabs
        profile={{
          name: c.name,
          phone: c.phone,
          email: c.email,
          address: c.address,
          state: c.state,
          note: c.note,
        }}
        invoices={c.invoices}
        payments={c.payments}
      />
    </div>
  );
}
