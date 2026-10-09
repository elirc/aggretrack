import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import {
  EmptyState,
  FilterChips,
  NoAccess,
  Pager,
  ReadOnlyBanner,
  isUuid,
  pageParam,
  sp,
} from "@/components/selling/page-states";
import { SalesTable } from "@/components/selling/sales-table";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { listSalesOrders, type SalesOrderStatus } from "@/lib/services/salesOrders";
import { salesOrderStatusValues } from "@/lib/validation/selling";

export const metadata = { title: "Sales · AggreTrack" };

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: SalesOrderStatus | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Confirmed" },
  { value: "allocated", label: "Allocated" },
  { value: "dispatched", label: "Dispatched" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "sale.read")) return <NoAccess title="Sales" what="sales orders" />;

  const params = await searchParams;
  const rawStatus = sp(params.status);
  const status = (salesOrderStatusValues as readonly string[]).includes(rawStatus ?? "")
    ? (rawStatus as SalesOrderStatus)
    : undefined;
  const customerParam = sp(params.customerId);
  const customerId = isUuid(customerParam) ? customerParam : undefined;
  const page = pageParam(params.page);
  const { rows, total } = await listSalesOrders(db, ctx, { status, customerId, page, pageSize: PAGE_SIZE });
  const canWrite = can(ctx.role, "sale.write") && !ctx.readOnly;
  const hide = ctx.restrictions.hidePrices;

  return (
    <div>
      <PageHeader
        title="Sales"
        description="Sales orders, allocation and dispatch."
        actions={
          canWrite ? (
            <Button asChild className="h-11 sm:h-9">
              <Link href="/sales/new">
                <Plus /> New sale
              </Link>
            </Button>
          ) : null
        }
      />
      <ReadOnlyBanner show={ctx.readOnly} />
      <FilterChips basePath="/sales" current={status} options={STATUS_OPTIONS} keep={{ customerId }} />
      {rows.length === 0 ? (
        <EmptyState
          title={status ? "No orders with this status." : "No sales orders yet."}
          hint={status ? undefined : "Create a sales order to reserve stock for a customer."}
          action={
            canWrite && !status ? (
              <Button asChild className="h-11 sm:h-9">
                <Link href="/sales/new">New sale</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <SalesTable
          rows={rows.map((r) => ({
            id: r.id,
            orderNumber: r.orderNumber,
            customerName: r.customerName,
            orderDate: r.orderDate,
            status: r.status,
            totalAmountKobo: hide ? null : r.totalAmountKobo,
          }))}
        />
      )}
      <Pager basePath="/sales" page={page} pageSize={PAGE_SIZE} total={total} params={{ status, customerId }} />
    </div>
  );
}
