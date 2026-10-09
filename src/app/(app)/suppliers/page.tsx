import Link from "next/link";
import { Plus } from "lucide-react";

import { FilterBar } from "@/components/buying/filter-bar";
import { SUPPLIER_TYPE_LABELS } from "@/components/buying/format";
import { requireOrgContext, sp, spPage, type RawSearchParams } from "@/components/buying/server";
import { EmptyState, NoAccess, Pager } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { listSuppliers } from "@/lib/services/suppliers";

import { SuppliersTable } from "./_components/suppliers-table";

export const metadata = { title: "Suppliers · AggreTrack" };

const PAGE_SIZE = 25;
type SupplierType = keyof typeof SUPPLIER_TYPE_LABELS;

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "supplier.read")) {
    return (
      <div>
        <PageHeader title="Suppliers" />
        <NoAccess what="suppliers" />
      </div>
    );
  }
  const params = await searchParams;
  const q = sp(params, "q")?.slice(0, 100);
  const typeRaw = sp(params, "type");
  const type = typeRaw && typeRaw in SUPPLIER_TYPE_LABELS ? (typeRaw as SupplierType) : undefined;
  const page = spPage(params);
  const result = await listSuppliers(db, ctx, { q, type, page, pageSize: PAGE_SIZE });
  const canWrite = can(ctx.role, "supplier.write") && !ctx.readOnly;
  const values = { q, type };
  const filtered = !!(q || type);

  return (
    <div>
      <PageHeader
        title="Suppliers"
        description={`${result.total} supplier${result.total === 1 ? "" : "s"}${filtered ? " matching" : ""}`}
        actions={
          canWrite ? (
            <Button asChild className="h-11 sm:h-9">
              <Link href="/suppliers/new">
                <Plus /> Add supplier
              </Link>
            </Button>
          ) : null
        }
      />
      <FilterBar
        basePath="/suppliers"
        values={values}
        filters={[
          { name: "q", label: "Search suppliers", kind: "search", placeholder: "Search name, phone or village" },
          {
            name: "type",
            label: "Type",
            kind: "select",
            allLabel: "All types",
            options: (Object.keys(SUPPLIER_TYPE_LABELS) as SupplierType[]).map((t) => ({
              value: t,
              label: SUPPLIER_TYPE_LABELS[t],
            })),
          },
        ]}
      />
      {result.rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No suppliers match" : "No suppliers yet"}
          description={filtered ? "Try another name, phone number or village." : "Add the farmers, agents and cooperatives you buy from."}
          action={
            canWrite && !filtered ? (
              <Button asChild className="h-11 sm:h-9">
                <Link href="/suppliers/new">
                  <Plus /> Add first supplier
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <SuppliersTable
          rows={result.rows.map((r) => ({
            id: r.id,
            type: r.type,
            name: r.name,
            phone: r.phone,
            village: r.village,
            lga: r.lga,
            state: r.state,
            balance: r.balance,
          }))}
        />
      )}
      <Pager basePath="/suppliers" params={values} page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
