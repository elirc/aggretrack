import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { naira, SUPPLIER_TYPE_LABELS } from "@/components/buying/format";
import { orNotFound, requireOrgContext, sp, uuidParamOr404, type RawSearchParams } from "@/components/buying/server";
import { NoAccess, ReadOnlyNotice } from "@/components/buying/states";
import { SupplierStatementButton } from "@/components/buying/statement-button";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/db/client";
import { can } from "@/lib/authz/permissions";
import { getSupplierDetail } from "@/lib/services/suppliers";
import { cn } from "@/lib/utils";

import { SupplierTabs } from "./_components/supplier-tabs";

export const metadata = { title: "Supplier · AggreTrack" };

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const ctx = await requireOrgContext();
  if (!can(ctx.role, "supplier.read")) {
    return (
      <div>
        <PageHeader title="Supplier" />
        <NoAccess what="suppliers" />
      </div>
    );
  }
  const id = uuidParamOr404((await params).id);
  const tab = sp(await searchParams, "tab");
  const d = await orNotFound(getSupplierDetail(db, ctx, id));
  const s = d.supplier;
  const b = d.balance;
  const hidePrices = ctx.restrictions.hidePrices;
  const writable = !ctx.readOnly;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/suppliers" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground">
          <ArrowLeft className="size-4" /> Suppliers
        </Link>
        <PageHeader
          title={s.name}
          description={[SUPPLIER_TYPE_LABELS[s.type], s.village, s.phone].filter(Boolean).join(" · ")}
          actions={<SupplierStatementButton supplierId={s.id} />}
        />
        {ctx.readOnly ? <ReadOnlyNotice /> : null}
      </div>

      {hidePrices ? null : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <BalanceTile label="We owe supplier" kobo={b.owedToSupplierKobo} hint="Received, not yet paid" />
          <BalanceTile label="Supplier owes us" kobo={b.owedBySupplierKobo} hint="Advances not recovered" />
          <BalanceTile label="Unallocated payments" kobo={b.unallocatedPaymentsKobo} hint="Credit on account" />
          <Card className={cn("gap-1 py-3", b.netKobo > 0 && "border-amber-300 dark:border-amber-800", b.netKobo < 0 && "border-emerald-300 dark:border-emerald-800")}>
            <CardContent className="px-3">
              <p className="text-xs text-muted-foreground">Net balance</p>
              <p className="text-lg font-semibold tabular-nums">{naira(Math.abs(b.netKobo))}</p>
              <p className="text-xs text-muted-foreground">
                {b.netKobo > 0 ? "We owe them" : b.netKobo < 0 ? "They owe us" : "Settled"}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <SupplierTabs
        initialTab={tab}
        supplier={{
          id: s.id,
          type: s.type,
          name: s.name,
          phone: s.phone,
          village: s.village,
          lga: s.lga,
          state: s.state,
          bankName: s.bankName,
          bankAccountNumber: s.bankAccountNumber,
          bankAccountName: s.bankAccountName,
          idNote: s.idNote,
          photoKey: s.photoKey,
          createdAt: s.createdAt,
        }}
        purchases={d.purchases}
        deductions={d.deductions}
        advances={can(ctx.role, "advance.read") ? d.advances : []}
        payments={can(ctx.role, "supplier-payment.read") ? d.payments : []}
        hidePrices={hidePrices}
        canEdit={writable && can(ctx.role, "supplier.write")}
        canRecordAdvance={writable && can(ctx.role, "advance.write")}
        canPay={writable && can(ctx.role, "supplier-payment.write")}
        canBuy={writable && can(ctx.role, "purchase.create")}
      />
    </div>
  );
}

function BalanceTile({ label, kobo, hint }: { label: string; kobo: number; hint: string }) {
  return (
    <Card className="gap-1 py-3">
      <CardContent className="px-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold tabular-nums">{naira(kobo)}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
