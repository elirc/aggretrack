import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { CustomerSheet } from "@/components/selling/customer-form";
import { CustomersTable } from "@/components/selling/customers-table";
import { EmptyState, NoAccess, Pager, ReadOnlyBanner, pageParam, sp } from "@/components/selling/page-states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { listCustomers } from "@/lib/services/customers";

export const metadata = { title: "Customers · AggreTrack" };

const PAGE_SIZE = 50;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "customer.read")) return <NoAccess title="Customers" what="customers" />;

  const params = await searchParams;
  const search = sp(params.q)?.slice(0, 200);
  const page = pageParam(params.page);
  const { rows, total } = await listCustomers(db, ctx, { search, page, pageSize: PAGE_SIZE });
  const canWrite = can(ctx.role, "customer.write") && !ctx.readOnly;
  const hide = ctx.restrictions.hidePrices;

  return (
    <div>
      <PageHeader
        title="Customers"
        description="Buyers, what they owe and their history."
        actions={
          canWrite ? (
            <CustomerSheet
              title="New customer"
              trigger={
                <Button className="h-11 sm:h-9">
                  <Plus /> New customer
                </Button>
              }
            />
          ) : null
        }
      />
      <ReadOnlyBanner show={ctx.readOnly} />
      <form className="mb-3 flex gap-2" role="search" action="/customers">
        <Input
          name="q"
          defaultValue={search ?? ""}
          placeholder="Search name or phone"
          className="h-11 sm:h-9"
          aria-label="Search customers"
        />
        <Button type="submit" variant="outline" className="h-11 sm:h-9">
          Search
        </Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState
          title={search ? "No customers match that search." : "No customers yet."}
          hint={search ? "Try a different name or phone number." : "Add the buyers you sell produce to."}
        />
      ) : (
        <CustomersTable
          rows={rows.map((r) => ({
            id: r.id,
            name: r.name,
            phone: r.phone,
            state: r.state,
            outstandingKobo: hide ? 0 : r.outstandingKobo,
          }))}
        />
      )}
      <Pager basePath="/customers" page={page} pageSize={PAGE_SIZE} total={total} params={{ q: search }} />
    </div>
  );
}
