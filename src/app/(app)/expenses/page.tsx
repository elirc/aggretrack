import { redirect } from "next/navigation";
import { and, desc, eq, inArray, or } from "drizzle-orm";

import { PageHeader } from "@/components/layout/PageHeader";
import { ExpensesView, type ExpenseRow } from "@/components/logistics/ExpensesView";
import type { ExpenseOptions } from "@/components/logistics/ExpenseForm";
import { UrlSelect } from "@/components/logistics/UrlSelect";
import { money } from "@/components/logistics/utils";
import { db } from "@/db/client";
import { commodities, lots } from "@/db/schema";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { listExpenses } from "@/lib/services/expenses";
import { listExpenseCategories, listWarehouses } from "@/lib/services/masterData";
import { listTrips } from "@/lib/services/trips";

export const metadata = { title: "Expenses · AggreTrack" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOT_OPTIONS_LIMIT = 300;

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  if (!can(ctx.role, "expense.read")) {
    return (
      <div>
        <PageHeader title="Expenses" />
        <p className="text-sm text-muted-foreground">You don&apos;t have access to expenses.</p>
      </div>
    );
  }
  const { category } = await searchParams;
  const categoryId = category && UUID_RE.test(category) ? category : undefined;

  const [expenses, categories, warehouses, trips] = await Promise.all([
    listExpenses(db, ctx, { categoryId }),
    listExpenseCategories(db, ctx),
    listWarehouses(db, ctx, { includeInactive: true }),
    listTrips(db, ctx),
  ]);

  // Lot picker: most recent lots + any lot an existing expense already points at.
  const attachedLotIds = [...new Set(expenses.map((e) => e.lotId).filter((x): x is string => x !== null))];
  const lotRows = await db
    .select({ id: lots.id, lotNumber: lots.lotNumber, commodity: commodities.name })
    .from(lots)
    .innerJoin(commodities, eq(commodities.id, lots.commodityId))
    .where(
      and(
        eq(lots.organisationId, ctx.orgId),
        attachedLotIds.length > 0
          ? or(
              inArray(lots.id, attachedLotIds),
              inArray(
                lots.id,
                db
                  .select({ id: lots.id })
                  .from(lots)
                  .where(eq(lots.organisationId, ctx.orgId))
                  .orderBy(desc(lots.receivedAt))
                  .limit(LOT_OPTIONS_LIMIT),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(lots.receivedAt))
    .limit(LOT_OPTIONS_LIMIT + attachedLotIds.length);

  const options: ExpenseOptions = {
    categories: categories.map((c) => ({ value: c.id, label: c.name, affectsLandedCost: c.affectsLandedCost })),
    lots: lotRows.map((l) => ({ value: l.id, label: `${l.lotNumber} · ${l.commodity}` })),
    trips: trips.map((t) => ({
      value: t.id,
      label: `${t.tripNumber} · ${t.direction} · ${t.tripDate}`,
      direction: t.direction,
    })),
    warehouses: warehouses.map((w) => ({ value: w.id, label: w.name })),
  };

  const rows: ExpenseRow[] = expenses.map((e) => ({
    id: e.id,
    expenseNumber: e.expenseNumber,
    categoryId: e.categoryId,
    categoryName: e.categoryName,
    affectsLandedCost: e.affectsLandedCost,
    amountKobo: e.amountKobo,
    expenseDate: e.expenseDate,
    lotId: e.lotId,
    tripId: e.tripId,
    warehouseId: e.warehouseId,
    lotNumber: e.lotNumber,
    tripNumber: e.tripNumber,
    warehouseName: e.warehouseName,
    note: e.note,
  }));
  const total = rows.reduce((s, r) => s + r.amountKobo, 0);
  const canWrite = can(ctx.role, "expense.write") && !ctx.readOnly;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Expenses" description="Storage, fumigation, loading, bagging and other costs by category." />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <UrlSelect
          param="category"
          label="Filter by category"
          allLabel="All categories"
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        {rows.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {rows.length} expense{rows.length === 1 ? "" : "s"} · {money(total)}
          </p>
        ) : null}
      </div>
      <ExpensesView rows={rows} options={options} canWrite={canWrite} filtered={categoryId !== undefined} />
    </div>
  );
}
