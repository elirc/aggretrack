import type { ReactNode } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Grams } from "@/lib/domain/units";

import { fmtSignedGrams, refDoc } from "./format";

/**
 * Presentational pieces shared by warehouse pages. No hooks — usable from
 * both server and client components.
 */

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground" },
  in_transit: {
    label: "In transit",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  },
  received: {
    label: "Received",
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground line-through" },
  posted: {
    label: "Posted",
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  },
  pending_approval: {
    label: "Pending approval",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  },
  rejected: { label: "Rejected", className: "bg-destructive/10 text-destructive" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return (
    <Badge variant="secondary" className={cn("border-transparent", s.className)}>
      {s.label}
    </Badge>
  );
}

/** +green / −red signed weight. */
export function SignedKg({ grams, className }: { grams: Grams; className?: string }) {
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        grams > 0 && "text-emerald-700 dark:text-emerald-400",
        grams < 0 && "text-red-700 dark:text-red-400",
        className,
      )}
    >
      {fmtSignedGrams(grams)}
    </span>
  );
}

export function RefDocLink({ refType, refId }: { refType: string | null; refId: string | null }) {
  const ref = refDoc(refType, refId);
  if (!ref) return <span className="text-muted-foreground">—</span>;
  const text = (
    <>
      {ref.label}
      {refId ? <span className="ml-1 font-mono text-xs text-muted-foreground">{refId.slice(0, 8)}</span> : null}
    </>
  );
  return ref.href ? (
    <Link href={ref.href} className="underline-offset-4 hover:underline">
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  );
}

export function EmptyState({
  title,
  description,
  href,
  actionLabel,
}: {
  title: string;
  description?: string;
  href?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {href && actionLabel ? (
        <Button asChild className="h-11 sm:h-9">
          <Link href={href}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <p
      className={cn(
        "mb-3 rounded-md border px-3 py-2 text-sm",
        tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          : "bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** Label/value pair for detail cards. */
export function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function NoAccess({ title, what }: { title: string; what: string }) {
  return (
    <div>
      <h1 className="mb-2 text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">You don&apos;t have access to {what}.</p>
    </div>
  );
}
