import Link from "next/link";
import { Plus } from "lucide-react";

import { FilterBar } from "@/components/buying/filter-bar";
import { requireOrgContext, sp, spDate, spPage, spUuid, type RawSearchParams } from "@/components/buying/server";
import { EmptyState, NoAccess, Pager } from "@/components/buying/states";
import { PURCHASE_STATUS_OPTIONS, type PurchaseStatusValue } from "@/components/buying/status-badge";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { listPurchases } from "@/lib/services/purchases";
import { listSupplierOptions } from "@/lib/services/suppliers";

import { PurchasesTable } from "./_components/purchases-table";

export const metadata = { title: "Purchases · AggreTrack" };

const PAGE_SIZE = 25;

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "purchase.read")) {
    return (
      <div>
        <PageHeader title="Purchases" />
        <NoAccess what="purchases" />
      </div>
    );
  }
  const params = await searchParams;
  const statusRaw = sp(params, "status");
  const status = PURCHASE_STATUS_OPTIONS.some((o) => o.value === statusRaw)
    ? (statusRaw as PurchaseStatusValue)
    : undefined;
  const supplierId = spUuid(params, "supplierId");
  const from = spDate(params, "from");
  const to = spDate(params, "to");
  const page = spPage(params);

  const [result, supplierOptions] = await Promise.all([
    listPurchases(db, ctx, { status, supplierId, from, to, page, pageSize: PAGE_SIZE }),
    can(ctx.role, "supplier.read") ? listSupplierOptions(db, ctx) : Promise.resolve([]),
  ]);

  const canCreate = can(ctx.role, "purchase.create") && !ctx.readOnly;
  const values = { status, supplierId, from, to };
  const filtered = Object.values(values).some(Boolean);

  return (
    <div>
      <PageHeader
        title="Purchases"
        description={`${result.total} purchase${result.total === 1 ? "" : "s"}${filtered ? " matching" : ""}`}
        actions={
          canCreate ? (
            <Button asChild className="h-11 sm:h-9">
              <Link href="/purchases/new">
                <Plus /> New purchase
              </Link>
            </Button>
          ) : null
        }
      />
      <FilterBar
        basePath="/purchases"
        values={values}
        filters={[
          { name: "status", label: "Status", kind: "select", options: PURCHASE_STATUS_OPTIONS, allLabel: "All statuses" },
          ...(supplierOptions.length > 0
            ? [
                {
                  name: "supplierId",
                  label: "Supplier",
                  kind: "select" as const,
                  options: supplierOptions.map((s) => ({ value: s.id, label: s.name })),
                  allLabel: "All suppliers",
                },
              ]
            : []),
          { name: "from", label: "From", kind: "date" },
          { name: "to", label: "To", kind: "date" },
        ]}
      />
      {result.rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No purchases match these filters" : "No purchases yet"}
          description={filtered ? "Try a wider date range or clear the filters." : "Record your first purchase from the field."}
          action={
            canCreate && !filtered ? (
              <Button asChild className="h-11 sm:h-9">
                <Link href="/purchases/new">
                  <Plus /> New purchase
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <PurchasesTable
          rows={result.rows}
          hidePrices={ctx.restrictions.hidePrices}
          linkSuppliers={can(ctx.role, "supplier.read")}
        />
      )}
      <Pager basePath="/purchases" params={values} page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
