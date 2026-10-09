import type { ReactNode } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * KPI tile: label, one headline value, optional secondary lines. `value` null
 * renders the price-locked state (em dash + lock) used when hidePrices is on.
 */
export function StatCard({
  label,
  value,
  sub,
  href,
  locked = false,
}: {
  label: string;
  value: string | null;
  sub?: ReactNode;
  href?: string;
  locked?: boolean;
}) {
  const isLocked = locked || value === null;
  const body = (
    <Card className={cn("h-full gap-1 py-3", href && "transition-colors hover:bg-accent/40")}>
      <CardContent className="flex flex-col gap-1 px-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {isLocked ? (
          <p className="flex items-center gap-1.5 text-xl font-semibold text-muted-foreground">
            <span aria-hidden>—</span>
            <Lock className="size-3.5" aria-hidden />
            <span className="sr-only">Hidden — prices are hidden for your role</span>
          </p>
        ) : (
          <p className="text-xl font-semibold tracking-tight tabular-nums">{value}</p>
        )}
        {sub ? <div className="text-xs text-muted-foreground tabular-nums">{sub}</div> : null}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {body}
    </Link>
  ) : (
    body
  );
}
