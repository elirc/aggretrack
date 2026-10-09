import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { resolveOrgContext } from "@/lib/authz/resolve";
import { can } from "@/lib/authz/permissions";
import { IMPORT_MAX_ROWS, TEMPLATE_HEADERS } from "@/lib/validation/imports";
import { PageHeader } from "@/components/layout/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { ImportView } from "./_components/ImportView";

export const metadata: Metadata = { title: "CSV import" };

export default async function ImportPage() {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");

  if (!can(ctx.role, "import.write")) {
    return (
      <div>
        <PageHeader title="CSV import" />
        <Alert>
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>Only owners and managers can import data.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="CSV import"
        description={`Bring in suppliers, customers and opening stock. Preview first — up to ${IMPORT_MAX_ROWS} rows per file.`}
      />
      {ctx.readOnly ? (
        <Alert variant="destructive">
          <AlertTitle>Read only</AlertTitle>
          <AlertDescription>Subscription inactive — importing is paused until billing is resolved.</AlertDescription>
        </Alert>
      ) : (
        <ImportView
          templates={{
            suppliers: TEMPLATE_HEADERS.suppliers.join(","),
            customers: TEMPLATE_HEADERS.customers.join(","),
            opening_stock: TEMPLATE_HEADERS.opening_stock.join(","),
          }}
        />
      )}
    </div>
  );
}
