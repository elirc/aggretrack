import Link from "next/link";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/db/client";
import {
  listAuditLog,
  listAuditTableNames,
  listOrganisationOptions,
  type PlatformAuditRow,
} from "@/lib/services/platform";
import { platformAuditQuery } from "@/lib/validation/masterData";

import { fmtDateTime, Pager, qs, requirePlatformAdmin } from "../_components/shared";

export const metadata = { title: "Audit log · Platform" };

const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-9 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

function Diff({ row }: { row: PlatformAuditRow }) {
  if (row.before == null && row.after == null) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Before / after</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">
          {row.before == null ? "—" : JSON.stringify(row.before, null, 2)}
        </pre>
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">
          {row.after == null ? "—" : JSON.stringify(row.after, null, 2)}
        </pre>
      </div>
    </details>
  );
}

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePlatformAdmin();
  const parsed = platformAuditQuery.safeParse(await searchParams);
  const query = parsed.success ? parsed.data : platformAuditQuery.parse({});

  const [{ rows, total, page, pageSize }, tables, orgs] = await Promise.all([
    listAuditLog(db, query),
    listAuditTableNames(db),
    listOrganisationOptions(db),
  ]);

  const filters = {
    organisationId: query.organisationId,
    tableName: query.tableName,
    from: query.from,
    to: query.to,
  };

  return (
    <div>
      <PageHeader title="Audit log" description="Every create, update, cancel and approval across all organisations." />

      <form method="get" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <div className="flex flex-col gap-1">
          <Label htmlFor="organisationId">Organisation</Label>
          <select id="organisationId" name="organisationId" defaultValue={query.organisationId ?? ""} className={selectClass}>
            <option value="">All organisations</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tableName">Table</Label>
          <select id="tableName" name="tableName" defaultValue={query.tableName ?? ""} className={selectClass}>
            <option value="">All tables</option>
            {tables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" name="from" type="date" defaultValue={query.from ?? ""} className="h-11 sm:h-9" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="to">To</Label>
          <Input id="to" name="to" type="date" defaultValue={query.to ?? ""} className="h-11 sm:h-9" />
        </div>
        <div className="flex gap-2">
          <Button type="submit" className="h-11 flex-1 sm:h-9">
            Filter
          </Button>
          <Button asChild variant="outline" className="h-11 sm:h-9">
            <Link href="/platform/audit">Reset</Link>
          </Button>
        </div>
      </form>

      {!parsed.success ? (
        <p className="mb-3 text-sm text-destructive">Some filters were invalid and were ignored.</p>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No audit entries match these filters.
        </div>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When (Lagos)</TableHead>
                  <TableHead>Organisation</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Table / record</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</TableCell>
                    <TableCell>
                      <Link href={`/platform/organisations/${encodeURIComponent(r.organisationId)}`} className="hover:underline">
                        {r.organisationName ?? r.organisationId}
                      </Link>
                    </TableCell>
                    <TableCell>{r.userName ?? r.userId ?? "system"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.action}</Badge>
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      <div className="font-mono text-xs">
                        {r.tableName} · {r.recordId}
                      </div>
                      <Diff row={r} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => (
              <li key={r.id}>
                <Card className="py-3">
                  <CardContent className="flex min-w-0 flex-col gap-1 px-3">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline">{r.action}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                    </div>
                    <span className="text-sm font-medium">{r.organisationName ?? r.organisationId}</span>
                    <span className="text-xs text-muted-foreground">by {r.userName ?? r.userId ?? "system"}</span>
                    <span className="font-mono text-xs break-all">
                      {r.tableName} · {r.recordId}
                    </span>
                    <Diff row={r} />
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <Pager
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={(p) => `/platform/audit${qs({ ...filters, page: p })}`}
      />
    </div>
  );
}
