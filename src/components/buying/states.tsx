import Link from "next/link";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";

/** Server-safe presentational states shared by the buying pages (no hooks). */

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function NoAccess({ what }: { what: string }) {
  return (
    <div className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
      You don&apos;t have access to {what}.
    </div>
  );
}

export function ReadOnlyNotice() {
  return (
    <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      Subscription inactive — records are read only.
    </p>
  );
}

export function ListSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={label}>
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-11 w-32 sm:h-9" />
      </div>
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function FormSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={label}>
      <Skeleton className="h-7 w-48" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-12 w-full" />
        </div>
      ))}
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

/** Prev / next pager built from plain hrefs (usable in server components). */
export function Pager({
  basePath,
  params,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  pageSize: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    qs.set("page", String(p));
    return `${basePath}?${qs.toString()}`;
  };
  const cls =
    "inline-flex h-11 min-w-24 items-center justify-center rounded-lg border px-3 text-sm font-medium sm:h-9";
  return (
    <nav className="mt-4 flex items-center justify-between gap-2" aria-label="Pagination">
      {page > 1 ? (
        <Link className={cls} href={href(page - 1)}>
          Previous
        </Link>
      ) : (
        <span className={`${cls} pointer-events-none opacity-40`}>Previous</span>
      )}
      <span className="text-sm text-muted-foreground">
        Page {page} of {pages} · {total} total
      </span>
      {page < pages ? (
        <Link className={cls} href={href(page + 1)}>
          Next
        </Link>
      ) : (
        <span className={`${cls} pointer-events-none opacity-40`}>Next</span>
      )}
    </nav>
  );
}
