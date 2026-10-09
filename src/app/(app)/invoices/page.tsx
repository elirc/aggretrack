import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { naira } from "@/components/selling/format";
import { InvoicesTable } from "@/components/selling/invoices-table";
import { EmptyState, FilterChips, NoAccess, Pager, isUuid, pageParam, sp } from "@/components/selling/page-states";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { listInvoices, type InvoiceStatus } from "@/lib/services/invoices";

export const metadata = { title: "Invoices · AggreTrack" };

const PAGE_SIZE = 50;
const STATUSES: InvoiceStatus[] = ["issued", "part_paid", "paid", "void"];

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "invoice.read")) return <NoAccess title="Invoices" what="invoices" />;

  const params = await searchParams;
  const raw = sp(params.status);
  const openOnly = raw === "open";
  const status = (STATUSES as string[]).includes(raw ?? "") ? (raw as InvoiceStatus) : undefined;
  const customerParam = sp(params.customerId);
  const customerId = isUuid(customerParam) ? customerParam : undefined;
  const page = pageParam(params.page);
  const { rows, total } = await listInvoices(db, ctx, {
    status,
    openOnly: openOnly || undefined,
    customerId,
    page,
    pageSize: PAGE_SIZE,
  });
  const outstanding = rows.reduce((s, r) => s + r.outstandingKobo, 0);

  return (
    <div>
      <PageHeader title="Invoices" description="Issued from dispatches. Outstanding updates as payments land." />
      <FilterChips
        basePath="/invoices"
        current={openOnly ? "open" : status}
        keep={{ customerId }}
        options={[
          { value: undefined, label: "All" },
          { value: "open", label: "Open" },
          { value: "issued", label: "Issued" },
          { value: "part_paid", label: "Part paid" },
          { value: "paid", label: "Paid" },
          { value: "void", label: "Void" },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyState
          title={status || openOnly ? "No invoices match this filter." : "No invoices yet."}
          hint={status || openOnly ? undefined : "Create an invoice from a dispatch's page."}
        />
      ) : (
        <>
          <InvoicesTable
            rows={rows.map((r) => ({
              id: r.id,
              invoiceNumber: r.invoiceNumber,
              customerName: r.customerName,
              invoiceDate: r.invoiceDate,
              dueDate: r.dueDate,
              status: r.status,
              totalKobo: r.totalKobo,
              outstandingKobo: r.outstandingKobo,
            }))}
          />
          <p className="mt-3 text-right text-sm text-muted-foreground">
            Outstanding on this page:{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {naira(outstanding)}
            </span>
          </p>
        </>
      )}
      <Pager
        basePath="/invoices"
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        params={{ status: openOnly ? "open" : status, customerId }}
      />
    </div>
  );
}
