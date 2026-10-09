import { RecordAdvanceDialog } from "@/components/buying/advance-dialogs";
import { FilterBar } from "@/components/buying/filter-bar";
import { naira } from "@/components/buying/format";
import { requireOrgContext, sp, spPage, spUuid, type RawSearchParams } from "@/components/buying/server";
import { EmptyState, NoAccess, Pager, ReadOnlyNotice } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { listAdvances } from "@/lib/services/advances";
import { listAdvanceBalances } from "@/lib/services/payables";
import { listSupplierOptions } from "@/lib/services/suppliers";

import { AdvancesTable } from "./_components/advances-table";

export const metadata = { title: "Advances · AggreTrack" };

const PAGE_SIZE = 25;

export default async function AdvancesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "advance.read")) {
    return (
      <div>
        <PageHeader title="Advances" />
        <NoAccess what="supplier advances" />
      </div>
    );
  }
  const params = await searchParams;
  const supplierId = spUuid(params, "supplierId");
  const outstanding = sp(params, "outstanding") === "1" ? "1" : undefined;
  const page = spPage(params);

  const [result, open, suppliers] = await Promise.all([
    listAdvances(db, ctx, { supplierId, outstandingOnly: !!outstanding, page, pageSize: PAGE_SIZE }),
    listAdvanceBalances(db, ctx, { supplierId, outstandingOnly: true }),
    can(ctx.role, "supplier.read") ? listSupplierOptions(db, ctx) : Promise.resolve([]),
  ]);
  const totalOutstanding = open.reduce((s, a) => s + a.outstandingKobo, 0);
  const canWrite = can(ctx.role, "advance.write") && !ctx.readOnly;
  const canOffset = can(ctx.role, "supplier-payment.write") && !ctx.readOnly;
  const values = { supplierId, outstanding };
  const filtered = !!(supplierId || outstanding);
  const supplierOptions = suppliers.map((s) => ({ id: s.id, name: s.name, phone: s.phone, village: s.village }));

  return (
    <div>
      <PageHeader
        title="Advances"
        description="Money paid to suppliers before delivery, recovered against later purchases."
        actions={canWrite ? <RecordAdvanceDialog suppliers={supplierOptions} /> : null}
      />
      {ctx.readOnly ? <ReadOnlyNotice /> : null}
      <Card className="mb-4 gap-1 py-3">
        <CardContent className="flex items-baseline justify-between gap-2 px-4">
          <div>
            <p className="text-xs text-muted-foreground">Outstanding{supplierId ? " (this supplier)" : ""}</p>
            <p className="text-xl font-semibold tabular-nums">{naira(totalOutstanding)}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {open.length} open advance{open.length === 1 ? "" : "s"}
          </p>
        </CardContent>
      </Card>
      <FilterBar
        basePath="/advances"
        values={values}
        filters={[
          ...(supplierOptions.length > 0
            ? [
                {
                  name: "supplierId",
                  label: "Supplier",
                  kind: "select" as const,
                  allLabel: "All suppliers",
                  options: supplierOptions.map((s) => ({ value: s.id, label: s.name })),
                },
              ]
            : []),
          { name: "outstanding", label: "Show", kind: "toggle", onLabel: "Outstanding only", offLabel: "All advances" },
        ]}
      />
      {result.rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No advances match" : "No advances yet"}
          description={filtered ? "Clear the filters to see every advance." : "Record an advance when you pay a supplier before delivery."}
        />
      ) : (
        <AdvancesTable rows={result.rows} canOffset={canOffset} />
      )}
      <Pager basePath="/advances" params={values} page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
