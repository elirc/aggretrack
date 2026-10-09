"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Shared body for each warehouse route's error.tsx. */
export function RouteError({ what, reset }: { what: string; reset: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 p-4">
      <p className="font-medium">Couldn&apos;t load {what}.</p>
      <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
      <Button className="h-11 sm:h-9" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}

/** Shared body for each warehouse route's loading.tsx. */
export function RouteLoading({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={`Loading ${label}`}>
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <Skeleton className="h-11 w-full" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
