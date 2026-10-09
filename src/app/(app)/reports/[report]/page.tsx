import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import {
  REPORT_DEFS,
  isReportKey,
  parseReportParams,
  toQuery,
  type EntityKind,
  type SP,
} from "@/components/reports/definitions";
import { ExportButtons } from "@/components/reports/export-buttons";
import { formatReport } from "@/components/reports/format";
import { ReportFilters, type EntityOptions } from "@/components/reports/report-filters";
import { ReportTable } from "@/components/reports/report-table";
import { Button } from "@/components/ui/button";
import { EmptyState, NoAccess, Notice } from "@/components/warehouse/status";
import { runReportAction } from "@/actions/reports";
import { db } from "@/db/client";
import type { OrgContext } from "@/lib/authz/context";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { listCustomers } from "@/lib/services/customers";
import * as md from "@/lib/services/masterData";
import { listSupplierOptions } from "@/lib/services/suppliers";

type Params = Promise<{ report: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { report } = await params;
  return { title: `${isReportKey(report) ? REPORT_DEFS[report].title : "Report"} · AggreTrack` };
}

const ERRORS: Record<string, string> = {
  FORBIDDEN: "You don't have access to this report.",
  UNAUTHENTICATED: "Your session has expired. Sign in again.",
  VALIDATION: "Some filters are invalid.",
};

type Opt = { value: string; label: string };

async function loadOptions(ctx: OrgContext, entities: EntityKind[]): Promise<EntityOptions> {
  const loaders: Record<EntityKind, () => Promise<Opt[]>> = {
    supplier: async () => (await listSupplierOptions(db, ctx)).map((s) => ({ value: s.id, label: s.name })),
    customer: async () =>
      (await listCustomers(db, ctx, { pageSize: 1000 })).rows.map((c) => ({ value: c.id, label: c.name })),
    commodity: async () =>
      (await md.listCommodities(db, ctx, { includeInactive: true })).map((c) => ({ value: c.id, label: c.name })),
    warehouse: async () =>
      (await md.listWarehouses(db, ctx, { includeInactive: true })).map((w) => ({ value: w.id, label: w.name })),
    buyingPoint: async () =>
      (await md.listBuyingPoints(db, ctx, { includeInactive: true })).map((b) => ({ value: b.id, label: b.name })),
    vehicle: async () =>
      (await md.listVehicles(db, ctx)).map((v) => ({ value: v.id, label: v.plateNumber })),
    grade: async () =>
      (await md.listGrades(db, ctx)).map((g) => ({ value: g.id, label: `${g.commodityName} · ${g.name}` })),
  };
  const unique = [...new Set(entities)];
  const lists = await Promise.all(unique.map((e) => loaders[e]()));
  return Object.fromEntries(unique.map((e, i) => [e, lists[i]]));
}

export default async function ReportPage({ params, searchParams }: { params: Params; searchParams: Promise<SP> }) {
  const { report } = await params;
  if (!isReportKey(report)) notFound();

  const ctx = await resolveOrgContext();
  if (!ctx) redirect("/login");
  const def = REPORT_DEFS[report];
  if (!can(ctx.role, "report.read")) return <NoAccess title={def.title} what="reports" />;

  const sp = await searchParams;
  const parsed = parseReportParams(report, sp);
  const entities = def.fields.flatMap((f) => (f.kind === "entity" ? [f.entity] : []));

  const [options, result] = await Promise.all([
    loadOptions(ctx, entities),
    parsed.ok ? runReportAction({ report, params: parsed.raw } as Parameters<typeof runReportAction>[0]) : null,
  ]);

  const query = toQuery(parsed.raw);
  const canExport = can(ctx.role, "report.export");
  const data = result?.ok ? result.data : null;

  return (
    <div>
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1 h-9">
        <Link href="/reports">
          <ChevronLeft />
          Reports
        </Link>
      </Button>
      <PageHeader
        title={data?.title ?? def.title}
        description={data?.subtitle ?? def.description}
        actions={canExport && data ? <ExportButtons report={report} query={query} /> : undefined}
      />
      <ReportFilters
        key={query}
        report={report}
        current={parsed.raw}
        options={options}
        fieldErrors={parsed.ok ? undefined : parsed.fieldErrors}
      />
      {!parsed.ok ? (
        <Notice tone="warn">
          {parsed.formErrors[0] ?? Object.values(parsed.fieldErrors)[0]?.[0] ?? "Some filters are invalid."}
        </Notice>
      ) : result && !result.ok ? (
        <Notice tone="warn">{ERRORS[result.error] ?? `Couldn't run the report (${result.error}).`}</Notice>
      ) : data && data.rows.length === 0 ? (
        <EmptyState title="Nothing to report" description="No records match these dates and filters." />
      ) : data ? (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {data.rows.length.toLocaleString("en-NG")} row{data.rows.length === 1 ? "" : "s"}
            {ctx.restrictions.hidePrices ? " · prices hidden" : ""}
          </p>
          <ReportTable report={formatReport(data)} />
        </>
      ) : null}
    </div>
  );
}
