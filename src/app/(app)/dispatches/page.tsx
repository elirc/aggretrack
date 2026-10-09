import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { DispatchesTable } from "@/components/selling/dispatches-table";
import { EmptyState, FilterChips, NoAccess, Pager, pageParam, sp } from "@/components/selling/page-states";
import { db } from "@/db/client";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { listDispatches } from "@/lib/services/dispatches";

export const metadata = { title: "Dispatches · AggreTrack" };

const PAGE_SIZE = 50;

export default async function DispatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "dispatch.read")) return <NoAccess title="Dispatches" what="dispatches" />;

  const params = await searchParams;
  const raw = sp(params.status);
  const status = raw === "in_transit" || raw === "delivered" ? raw : undefined;
  const page = pageParam(params.page);
  const { rows, total } = await listDispatches(db, ctx, { status, page, pageSize: PAGE_SIZE });

  return (
    <div>
      <PageHeader title="Dispatches" description="Waybills on the road and delivered weights." />
      <FilterChips
        basePath="/dispatches"
        current={status}
        options={[
          { value: undefined, label: "All" },
          { value: "in_transit", label: "In transit" },
          { value: "delivered", label: "Delivered" },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyState
          title={status ? "No dispatches with this status." : "No dispatches yet."}
          hint={status ? undefined : "Dispatches are created from a sales order once stock is reserved."}
        />
      ) : (
        <DispatchesTable rows={rows} />
      )}
      <Pager basePath="/dispatches" page={page} pageSize={PAGE_SIZE} total={total} params={{ status }} />
    </div>
  );
}
