import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { requireOrgContext } from "@/components/buying/server";
import { NoAccess, ReadOnlyNotice } from "@/components/buying/states";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { can } from "@/lib/authz/permissions";

import { NewSupplier } from "./_components/new-supplier";

export const metadata = { title: "Add supplier · AggreTrack" };

export default async function NewSupplierPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "supplier.write")) {
    return (
      <div>
        <PageHeader title="Add supplier" />
        <NoAccess what="adding suppliers" />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/suppliers" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" /> Suppliers
      </Link>
      <PageHeader title="Add supplier" description="Only the name is required. Phone enables SMS receipts." />
      {ctx.readOnly ? <ReadOnlyNotice /> : null}
      <Card className="py-4">
        <CardContent className="px-4">
          <NewSupplier />
        </CardContent>
      </Card>
    </div>
  );
}
