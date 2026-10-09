import Link from "next/link";
import { Bell, ClipboardCheck } from "lucide-react";

import { cn } from "@/lib/utils";

/** Pending approvals + unread alerts as count chips linking to their queues. */
export function StatusChips({
  approvals,
  unreadAlerts,
  approvalsHref,
}: {
  approvals: { purchases: number; adjustments: number; total: number };
  unreadAlerts: number;
  /** Where the approvals chip leads (the queue with the most pending). */
  approvalsHref: string | null;
}) {
  const chip = "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm";
  const parts = [
    approvals.purchases ? `${approvals.purchases} purchase${approvals.purchases === 1 ? "" : "s"}` : null,
    approvals.adjustments ? `${approvals.adjustments} adjustment${approvals.adjustments === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const approvalsBody = (
    <>
      <ClipboardCheck className="size-4" aria-hidden />
      <span className="font-semibold tabular-nums">{approvals.total}</span> pending approval
      {approvals.total === 1 ? "" : "s"}
      {parts.length > 0 ? <span className="hidden text-xs text-muted-foreground sm:inline">({parts.join(", ")})</span> : null}
    </>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {approvalsHref ? (
        <Link
          href={approvalsHref}
          className={cn(chip, approvals.total > 0 ? "border-foreground/30 bg-accent" : "text-muted-foreground")}
        >
          {approvalsBody}
        </Link>
      ) : (
        <span className={cn(chip, "text-muted-foreground")}>{approvalsBody}</span>
      )}
      <Link
        href="/alerts?show=unread"
        className={cn(chip, unreadAlerts > 0 ? "border-foreground/30 bg-accent" : "text-muted-foreground")}
      >
        <Bell className="size-4" aria-hidden />
        <span className="font-semibold tabular-nums">{unreadAlerts}</span> unread alert{unreadAlerts === 1 ? "" : "s"}
      </Link>
    </div>
  );
}
