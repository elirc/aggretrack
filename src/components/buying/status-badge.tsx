import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type PurchaseStatusValue = "draft" | "pending_approval" | "approved" | "received" | "cancelled";

const LABELS: Record<PurchaseStatusValue, string> = {
  draft: "Draft",
  pending_approval: "Needs approval",
  approved: "Approved",
  received: "Received",
  cancelled: "Cancelled",
};

const TONES: Record<PurchaseStatusValue, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  pending_approval: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
  approved: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100",
  received: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  cancelled: "border-border bg-background text-muted-foreground line-through",
};

export const PURCHASE_STATUS_OPTIONS = (Object.keys(LABELS) as PurchaseStatusValue[]).map((value) => ({
  value,
  label: LABELS[value],
}));

export function purchaseStatusLabel(s: PurchaseStatusValue): string {
  return LABELS[s];
}

export function PurchaseStatusBadge({ status, className }: { status: PurchaseStatusValue; className?: string }) {
  return (
    <Badge variant="outline" className={cn(TONES[status], className)}>
      {LABELS[status]}
    </Badge>
  );
}
