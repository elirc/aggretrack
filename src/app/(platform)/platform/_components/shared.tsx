import "server-only";

import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth/auth";

/**
 * Defence in depth: the (platform) layout already gates on is_platform_admin,
 * but layouts can be skipped on client navigation, so every page re-checks.
 */
export async function requirePlatformAdmin(): Promise<{ userId: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  if ((session.user as { isPlatformAdmin?: boolean }).isPlatformAdmin !== true) redirect("/");
  return { userId: session.user.id };
}

const lagos = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const lagosDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function fmtDateTime(d: Date | null | undefined): string {
  return d ? lagos.format(d) : "—";
}
export function fmtDate(d: Date | null | undefined): string {
  return d ? lagosDate.format(d) : "—";
}

export function fmtNaira(kobo: number): string {
  const naira = Math.trunc(kobo / 100);
  const k = Math.abs(kobo % 100);
  return `₦${naira.toLocaleString("en-NG")}${k ? `.${String(k).padStart(2, "0")}` : ""}`;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  trialing: "secondary",
  past_due: "destructive",
  cancelled: "outline",
};

export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline">no subscription</Badge>;
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{status.replace("_", " ")}</Badge>;
}

/** Prev/next pager over GET search params. */
export function Pager({
  page,
  pageSize,
  total,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="mt-4 flex items-center justify-between gap-2 text-sm" aria-label="Pagination">
      <span className="text-muted-foreground">
        Page {Math.min(page, pages)} of {pages} · {total} total
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page - 1)}>Previous</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Previous
          </Button>
        )}
        {page < pages ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page + 1)}>Next</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Next
          </Button>
        )}
      </div>
    </nav>
  );
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
