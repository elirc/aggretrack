import Link from "next/link";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Shown when the viewer's role lacks the read permission for a page. */
export function NoAccess({ title, what }: { title: string; what: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <p className="text-sm text-muted-foreground">You don&apos;t have access to {what}.</p>
    </div>
  );
}

export function ReadOnlyBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      Subscription inactive — this organisation is read only.
    </p>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-6">
      <p className="font-medium">{title}</p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      {action}
    </div>
  );
}

export function ListSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={label}>
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function DetailSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={label}>
      <Skeleton className="h-7 w-48" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/** Prev/next pager driven by ?page=. `params` are the other query params to keep. */
export function Pager({
  basePath,
  page,
  pageSize,
  total,
  params = {},
}: {
  basePath: string;
  page: number;
  pageSize: number;
  total: number;
  params?: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const href = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    q.set("page", String(p));
    return `${basePath}?${q.toString()}`;
  };
  return (
    <nav className="mt-4 flex items-center justify-between gap-2" aria-label="Pagination">
      {page > 1 ? (
        <Button asChild variant="outline" className="h-11 sm:h-9">
          <Link href={href(page - 1)}>Previous</Link>
        </Button>
      ) : (
        <Button variant="outline" className="h-11 sm:h-9" disabled>
          Previous
        </Button>
      )}
      <span className="text-sm text-muted-foreground">
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Button asChild variant="outline" className="h-11 sm:h-9">
          <Link href={href(page + 1)}>Next</Link>
        </Button>
      ) : (
        <Button variant="outline" className="h-11 sm:h-9" disabled>
          Next
        </Button>
      )}
    </nav>
  );
}

/** Horizontal, scrollable status filter chips (links). */
export function FilterChips({
  basePath,
  param = "status",
  current,
  options,
  keep = {},
}: {
  basePath: string;
  param?: string;
  current: string | undefined;
  options: { value: string | undefined; label: string }[];
  keep?: Record<string, string | undefined>;
}) {
  return (
    <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filter">
      {options.map((o) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
        if (o.value) q.set(param, o.value);
        const active = (current ?? undefined) === o.value;
        const qs = q.toString();
        return (
          <Link
            key={o.label}
            href={qs ? `${basePath}?${qs}` : basePath}
            role="tab"
            aria-selected={active}
            className={cn(
              "inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-sm whitespace-nowrap",
              active ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
            )}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

/** Small label/value stat tile for detail headers. */
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" | "good" | "bad" }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-base font-semibold tabular-nums",
          tone === "warn" && "text-amber-700 dark:text-amber-300",
          tone === "good" && "text-emerald-700 dark:text-emerald-300",
          tone === "bad" && "text-red-700 dark:text-red-300",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** Parse ?page= safely. */
export function pageParam(v: string | string[] | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** First value of a search param. */
export function sp(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length > 0 ? s : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v: string | undefined): v is string {
  return !!v && UUID_RE.test(v);
}
