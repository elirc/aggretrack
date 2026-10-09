import { FilterBar } from "@/components/buying/filter-bar";
import { requireOrgContext, spDate, spPage, spUuid, type RawSearchParams } from "@/components/buying/server";
import { EmptyState, NoAccess, Pager, ReadOnlyNotice } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { listSupplierPayments } from "@/lib/services/supplierPayments";
import { listSupplierOptions } from "@/lib/services/suppliers";

import { PaymentsTable, RecordPaymentPanel } from "./_components/payments-view";

export const metadata = { title: "Supplier payments · AggreTrack" };

const PAGE_SIZE = 25;

export default async function SupplierPaymentsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "supplier-payment.read")) {
    return (
      <div>
        <PageHeader title="Supplier payments" />
        <NoAccess what="supplier payments" />
      </div>
    );
  }
  const params = await searchParams;
  const supplierId = spUuid(params, "supplierId");
  const from = spDate(params, "from");
  const to = spDate(params, "to");
  const page = spPage(params);

  const [result, suppliers] = await Promise.all([
    listSupplierPayments(db, ctx, { supplierId, from, to, page, pageSize: PAGE_SIZE }),
    can(ctx.role, "supplier.read") ? listSupplierOptions(db, ctx) : Promise.resolve([]),
  ]);
  const canWrite = can(ctx.role, "supplier-payment.write") && !ctx.readOnly;
  const values = { supplierId, from, to };
  const filtered = !!(supplierId || from || to);
  const options = suppliers.map((s) => ({ id: s.id, name: s.name, phone: s.phone, village: s.village }));

  return (
    <div>
      <PageHeader title="Supplier payments" description="Record what you paid and which purchases it settles." />
      {ctx.readOnly ? <ReadOnlyNotice /> : null}
      {canWrite && options.length > 0 ? (
        <RecordPaymentPanel
          suppliers={options}
          initialSupplierId={supplierId}
          supplierPhones={Object.fromEntries(suppliers.map((s) => [s.id, !!s.phone]))}
          canOffset={canWrite}
        />
      ) : null}
      <FilterBar
        basePath="/supplier-payments"
        values={values}
        filters={[
          ...(options.length > 0
            ? [
                {
                  name: "supplierId",
                  label: "Supplier",
                  kind: "select" as const,
                  allLabel: "All suppliers",
                  options: options.map((s) => ({ value: s.id, label: s.name })),
                },
              ]
            : []),
          { name: "from", label: "From", kind: "date" },
          { name: "to", label: "To", kind: "date" },
        ]}
      />
      {result.rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No payments match" : "No supplier payments yet"}
          description={filtered ? "Try a wider date range or clear the filters." : "Payments you record appear here."}
        />
      ) : (
        <PaymentsTable
          rows={result.rows.map((r) => ({
            id: r.id,
            paymentNumber: r.paymentNumber,
            paymentDate: r.paymentDate,
            supplierId: r.supplierId,
            supplierName: r.supplierName,
            amountKobo: r.amountKobo,
            method: r.method,
            reference: r.reference,
            allocatedKobo: r.allocatedKobo,
            unallocatedKobo: r.unallocatedKobo,
          }))}
        />
      )}
      <Pager basePath="/supplier-payments" params={values} page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
