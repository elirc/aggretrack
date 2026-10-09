import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { parseReportParams, isReportKey, type SP } from "@/components/reports/definitions";
import { db } from "@/db/client";
import { organization } from "@/db/schema";
import { can } from "@/lib/authz/permissions";
import { resolveOrgContext } from "@/lib/authz/resolve";
import { formatDocDate } from "@/lib/domain/format";
import { isDomainError } from "@/lib/domain/errors";
import { buildReportWorkbook } from "@/lib/export/excel";
import { renderReportPdf } from "@/lib/export/renderReportPdf";
import { runReport } from "@/lib/services/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * GET /api/exports/<report>?format=xlsx|pdf&<report params>
 * Same params (and schema) as the /reports/<report> page. Money columns are
 * already stripped by the report service for hide-prices callers.
 */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const ctx = await resolveOrgContext();
  if (!ctx) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!can(ctx.role, "report.export")) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const { report } = await params;
  if (!isReportKey(report)) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "xlsx";
  if (format !== "xlsx" && format !== "pdf") {
    return NextResponse.json({ error: "VALIDATION", fieldErrors: { format: ["Use xlsx or pdf"] } }, { status: 400 });
  }

  const sp: SP = {};
  for (const [k, v] of url.searchParams) if (sp[k] === undefined) sp[k] = v;
  const parsed = parseReportParams(report, sp);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "VALIDATION", fieldErrors: parsed.fieldErrors, formErrors: parsed.formErrors },
      { status: 400 },
    );
  }

  try {
    const now = new Date();
    const [result, [org]] = await Promise.all([
      runReport(db, ctx, parsed.input),
      db.select({ name: organization.name }).from(organization).where(eq(organization.id, ctx.orgId)).limit(1),
    ]);
    const orgName = org?.name ?? "AggreTrack";
    const filename = `aggretrack-${report}-${formatDocDate(now)}.${format}`;

    const body =
      format === "xlsx"
        ? await buildReportWorkbook(result, { orgName, generatedAt: now })
        : await renderReportPdf({ org: { name: orgName }, report: result, generatedAt: now.toISOString() });

    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": format === "xlsx" ? XLSX_MIME : "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(body.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (isDomainError(err)) return NextResponse.json({ error: err.code }, { status: 400 });
    console.error("[api/exports]", err);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
