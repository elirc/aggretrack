import Link from "next/link";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/db/client";
import { listOrganisations } from "@/lib/services/platform";
import { platformOrgQuery } from "@/lib/validation/masterData";

import { fmtDate, Pager, qs, requirePlatformAdmin, StatusBadge } from "../_components/shared";

export const metadata = { title: "Organisations · Platform" };

export default async function OrganisationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePlatformAdmin();
  const parsed = platformOrgQuery.safeParse(await searchParams);
  const query = parsed.success ? parsed.data : platformOrgQuery.parse({});
  const { rows, total, page, pageSize } = await listOrganisations(db, query);

  return (
    <div>
      <PageHeader title="Organisations" description="Every tenant, its members and subscription." />

      <form method="get" className="mb-4 flex gap-2">
        <Input name="q" defaultValue={query.q ?? ""} placeholder="Search name or slug" className="h-11 sm:h-9" />
        <Button type="submit" className="h-11 sm:h-9">
          Search
        </Button>
      </form>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {query.q ? "No organisations match your search." : "No organisations yet."}
        </div>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <Link href={`/platform/organisations/${o.id}`} className="font-medium hover:underline">
                        {o.name}
                      </Link>
                      {o.slug ? <div className="text-xs text-muted-foreground">{o.slug}</div> : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{o.memberCount}</TableCell>
                    <TableCell>{o.planName ?? "—"}</TableCell>
                    <TableCell className="flex items-center gap-1">
                      <StatusBadge status={o.subscriptionStatus} />
                      {o.readOnly ? <Badge variant="destructive">read only</Badge> : null}
                    </TableCell>
                    <TableCell>{fmtDate(o.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((o) => (
              <li key={o.id}>
                <Link href={`/platform/organisations/${o.id}`}>
                  <Card className="py-3">
                    <CardContent className="flex flex-col gap-1 px-3">
                      <span className="font-medium">{o.name}</span>
                      <span className="text-sm text-muted-foreground">
                        {o.memberCount} member{o.memberCount === 1 ? "" : "s"} · {o.planName ?? "no plan"} ·{" "}
                        {fmtDate(o.createdAt)}
                      </span>
                      <span className="flex gap-1">
                        <StatusBadge status={o.subscriptionStatus} />
                        {o.readOnly ? <Badge variant="destructive">read only</Badge> : null}
                      </span>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <Pager
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={(p) => `/platform/organisations${qs({ q: query.q, page: p })}`}
      />
    </div>
  );
}
